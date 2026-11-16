'use strict';
require('./helpers');
process.env.LLM_IDLE_MS = '250';
process.env.LLM_FIRST_BYTE_MS = '2000';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const llm = require('../lib/llm');

// A stand-in model server. `handler(body, res)` decides how to answer each chat request.
async function fakeModel(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      seen.push({ url: req.url, auth: req.headers.authorization, body });
      handler(body, res, req);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  llm.setConfig({ endpoint: `http://127.0.0.1:${server.address().port}/v1/`, model: `m-${server.address().port}`, apiKey: '' });
  return { seen, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) };
}
const ok = (res, content) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content } }] })); };
const sse = (res, events) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); for (const e of events) res.write(`data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`); };

test('settings are written for your eyes only and the address is tidied', () => {
  const cfg = llm.setConfig({ endpoint: 'http://127.0.0.1:1/v1///', model: ' m ', apiKey: 'secret', nonsense: 'ignored' });
  assert.deepEqual(cfg, { endpoint: 'http://127.0.0.1:1/v1', model: 'm', apiKey: 'secret' });
  assert.equal(fs.statSync(process.env.MANUSCRIPT_CONFIG).mode & 0o777, 0o600);
});

test('a strict server that rejects the extra parameters is retried without them, once', async () => {
  const model = await fakeModel((body, res) => {
    const extra = ['reasoning_effort', 'response_format'].filter((k) => k in body);
    if (extra.length) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { message: `Unrecognized request argument supplied: ${extra[0]}` } })); }
    ok(res, ' {"entries":[]} ');
  });
  try {
    assert.equal(await llm.complete({ messages: [{ role: 'user', content: 'hi' }], effort: 'none', json: true, maxTokens: 100 }), '{"entries":[]}');
    assert.deepEqual(model.seen.map((s) => ['reasoning_effort' in s.body, 'response_format' in s.body]), [[true, true], [false, true], [false, false]]);
    assert.equal(model.seen[2].body.max_tokens, 1600, 'with no way to switch thinking off, room is left for it');

    await llm.complete({ messages: [{ role: 'user', content: 'again' }], json: true });
    assert.equal(model.seen.length, 4, 'the second request goes straight through');
    assert.ok(!('reasoning_effort' in model.seen[3].body) && !('response_format' in model.seen[3].body));
  } finally { await model.close(); }
});

test('other errors are reported, not retried', async () => {
  const model = await fakeModel((body, res) => { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'out of memory' } })); });
  try {
    await assert.rejects(llm.complete({ messages: [] }), /Model error 500: out of memory/);
    assert.equal(model.seen.length, 1);
  } finally { await model.close(); }
});

test('streaming yields text, notes thinking, and passes usage through', async () => {
  const model = await fakeModel((body, res) => {
    sse(res, [
      { choices: [{ delta: { reasoning_content: 'hm' } }] },
      { choices: [{ delta: { content: 'Hello' } }] },
      'not json',
      { choices: [{ delta: { content: ' there' } }] },
      { choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } },
      '[DONE]',
    ]);
    res.end();
  });
  try {
    const events = [];
    for await (const ev of llm.stream({ messages: [], effort: 'low' })) events.push(ev);
    assert.deepEqual(events.map((e) => e.type), ['thinking', 'delta', 'delta', 'usage']);
    assert.equal(events.filter((e) => e.type === 'delta').map((e) => e.text).join(''), 'Hello there');
    assert.equal(model.seen[0].body.stream, true);
    assert.equal(model.seen[0].body.reasoning_effort, 'low');
  } finally { await model.close(); }
});

test('a model that goes silent mid-answer is given up on, with a plain message', async () => {
  const model = await fakeModel((body, res) => sse(res, [{ choices: [{ delta: { content: 'Starting' } }] }]));   // ...and never finishes
  try {
    const got = [];
    const started = Date.now();
    await assert.rejects(async () => { for await (const ev of llm.stream({ messages: [] })) got.push(ev); }, /went quiet for 0 seconds/);
    assert.deepEqual(got, [{ type: 'delta', text: 'Starting' }]);
    assert.ok(Date.now() - started < 1500);
  } finally { await model.close(); }
});

test('stopping a request is not mistaken for a stall', async () => {
  const model = await fakeModel((body, res) => sse(res, [{ choices: [{ delta: { content: 'x' } }] }]));
  try {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 60);
    await assert.rejects(async () => { for await (const ev of llm.stream({ messages: [] }, ac.signal)) void ev; }, (e) => e.name === 'AbortError');
  } finally { await model.close(); }
});

test('health reports a missing server and a missing model differently', async () => {
  const model = await fakeModel((body, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: 'some-other-model' }] })); });
  try {
    const h = await llm.health();
    assert.equal(h.ok, false);
    assert.match(h.error, /is not being served there/);
    assert.deepEqual(h.models, ['some-other-model']);
  } finally { await model.close(); }
  assert.match((await llm.health()).error, /No model server at/);
});
