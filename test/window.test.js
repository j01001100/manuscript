'use strict';
const { words } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const llm = require('../lib/llm');
const win = require('../lib/window');
const store = require('../lib/store');
const assistant = require('../lib/assistant');

// A stand-in model server that answers a given set of paths.
async function server(routes) {
  const seen = [];
  const s = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const path = req.url.split('?')[0];
      seen.push({ method: req.method, path, body: raw ? JSON.parse(raw) : null });
      const route = routes[`${req.method} ${path}`];
      if (!route) { res.writeHead(404); return res.end(); }
      const [status, body] = typeof route === 'function' ? route(raw ? JSON.parse(raw) : null) : [200, route];
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    });
  });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${s.address().port}`;
  return { url, seen, close: () => new Promise((r) => { s.closeAllConnections(); s.close(r); }) };
}
const use = (url, model = 'm', more = {}) => { llm.setConfig({ endpoint: `${url}/v1`, model, contextWindow: '', ...more }); win.reset(); };

test('reads the window from wherever each kind of server reports it', async (t) => {
  const cases = [
    ['Splash / vLLM-style model list', { 'GET /v1/models': { data: [{ id: 'other', context_length: 4096 }, { id: 'm', context_length: 131072, max_model_len: 131072 }] } }, 131072, /model server/],
    ['vLLM max_model_len', { 'GET /v1/models': { data: [{ id: 'm', max_model_len: 32768 }] } }, 32768, /model server/],
    ['llama.cpp /props', { 'GET /v1/models': { data: [{ id: 'm', meta: { n_ctx_train: 262144 } }] }, 'GET /props': { default_generation_settings: { n_ctx: 16384 } } }, 16384, /llama\.cpp/],
    ['LM Studio, loaded', { 'GET /v1/models': { data: [{ id: 'm' }] }, 'GET /api/v0/models/m': { max_context_length: 131072, loaded_context_length: 8192, state: 'loaded' } }, 8192, /LM Studio/],
    ['Ollama with num_ctx', { 'GET /v1/models': { data: [{ id: 'm' }] }, 'POST /api/show': { parameters: 'temperature 0.7\nnum_ctx 24576', model_info: { 'qwen.context_length': 262144 } } }, 24576, /num_ctx/],
    ['Ollama default', { 'GET /v1/models': { data: [{ id: 'm' }] }, 'POST /api/show': { parameters: '', model_info: { 'qwen.context_length': 262144 } } }, 4096, /Ollama default/],
    ['nothing reported', { 'GET /v1/models': { data: [{ id: 'm' }] } }, win.FALLBACK, /cautious guess/],
  ];
  for (const [name, routes, tokens, source] of cases) {
    await t.test(name, async () => {
      const s = await server(routes);
      try {
        use(s.url);
        const w = await win.current();
        assert.equal(w.tokens, tokens);
        assert.match(w.source, source);
      } finally { await s.close(); }
    });
  }
});

test('a size you set wins; clearing it goes back to asking', async () => {
  const s = await server({ 'GET /v1/models': { data: [{ id: 'm', context_length: 131072 }] } });
  try {
    use(s.url, 'm', { contextWindow: '65536' });
    assert.deepEqual([(await win.current()).tokens, (await win.current()).source], [65536, 'set by you']);
    use(s.url, 'm', { contextWindow: '' });
    assert.equal((await win.current()).tokens, 131072);
  } finally { await s.close(); }
});

test('detection is cached, and checking again asks the server again', async () => {
  let size = 131072;
  const s = await server({ 'GET /v1/models': () => [200, { data: [{ id: 'm', context_length: size }] }] });
  try {
    use(s.url);
    await win.current();
    await win.current();
    assert.equal(s.seen.length, 1, 'asked once');
    size = 65536;   // the server was restarted with a smaller window
    assert.equal((await win.current()).tokens, 131072, 'cached until checked');
    assert.equal((await win.current({ refresh: true })).tokens, 65536);
  } finally { await s.close(); }
});

test('a refusal for length teaches the real size', () => {
  const err = (status, detail) => Object.assign(new Error(detail), { status, detail });
  win.reset();
  assert.equal(win.learnFromError(err(400, "This model's maximum context length is 32768 tokens. However, you requested 40000 tokens."), 131072), 32768);
  assert.equal(win.learnFromError(err(400, 'request (9000 tokens) exceeds the available context size (8192 tokens), try increasing it'), 131072), 8192);
  assert.equal(win.learnFromError(err(400, 'the model is loaded with context length of only 4096 tokens'), 131072), 4096);
  assert.equal(win.learnFromError(err(400, 'context length exceeded'), 100000), 75000, 'no number given: shrink by a quarter');
  assert.equal(win.learnFromError(err(400, 'temperature must be positive'), 131072), null, 'other errors are not about length');
  assert.equal(win.learnFromError(err(503, 'context length exceeded'), 131072), null);
});

test('token estimates are corrected by the counts the server reports', () => {
  llm.setConfig({ endpoint: 'http://127.0.0.1:9/v1', model: 'calibrated' });
  win.reset();
  const text = 'word '.repeat(3800);
  assert.equal(win.tokens(text), 5000);
  win.calibrate(3900, [{ role: 'user', content: text }]);   // the real tokenizer packs it tighter
  assert.ok(win.tokens(text) < 4000, `now ${win.tokens(text)}`);
  win.reset();
  assert.ok(win.tokens(text) < 4000, 'remembered across restarts');
  win.calibrate(100, [{ role: 'user', content: 'tiny' }]);   // too small to learn from
  assert.ok(win.tokens(text) < 4000);
});

test('the server refuses a prompt as too long: the request is rebuilt smaller and succeeds', async () => {
  const limit = 9000;
  const s = await server({
    'GET /v1/models': { data: [{ id: 'm', context_length: 131072 }] },   // says 128K, actually holds 9K
    'POST /v1/chat/completions': (body) => {
      const sent = body.messages.reduce((n, m) => n + m.content.length / 3.8, 0) + body.max_tokens;
      if (sent > limit) return [400, { error: { message: `This model's maximum context length is ${limit} tokens.` } }];
      return [200, `data: ${JSON.stringify({ choices: [{ delta: { content: 'Fits now.' } }] })}\n\ndata: [DONE]\n\n`];
    },
  });
  try {
    use(s.url);
    const book = store.createBook({ title: 'Too long' });
    store.importManuscript(book.id, `Chapter 1\n\n${words(3000)}\n\nChapter 2\n\n${words(20000)}`);
    const ch = store.getBook(book.id).chapters[1];
    store.writeSummary(book.id, store.getBook(book.id).chapters[0].id, 'LOGLINE: x.', store.hash(store.readChapter(book.id, store.getBook(book.id).chapters[0].id)));
    const events = [];
    await assistant.run({ bookId: book.id, body: { task: 'next', chapterId: ch.id }, emit: (ev, d) => events.push([ev, d]), signal: undefined });
    const chats = s.seen.filter((r) => r.path === '/v1/chat/completions');
    assert.equal(chats.length, 2, 'one refusal, one retry');
    assert.ok(events.some(([ev, d]) => ev === 'status' && /Trimming and trying again/.test(d.text)));
    assert.deepEqual(events.filter(([ev]) => ev === 'delta').map(([, d]) => d.text), ['Fits now.']);
    assert.equal((await win.current()).tokens, limit, 'and the next request starts at the right size');
  } finally { await s.close(); win.reset(); }
});
