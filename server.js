'use strict';
// Manuscript: a local writing desk. No dependencies; run with `node server.js`.
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 20 || (major === 20 && minor < 15)) {
  console.error(`Manuscript needs Node.js 20.15 or newer (this is ${process.versions.node}). Get it from nodejs.org.`);
  process.exit(1);
}
const http = require('http');
const fs = require('fs');
const path = require('path');
const store = require('./lib/store');
const llm = require('./lib/llm');
const context = require('./lib/context');
const assistant = require('./lib/assistant');
const win = require('./lib/window');
const P = require('./lib/prompts');
const exporter = require('./lib/export');

const PORT = Number(process.env.PORT) || 4747;
const PUBLIC = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
const LOCAL = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);

function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > 30e6) { reject(new store.HttpError(413, 'Too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new store.HttpError(400, 'Bad JSON')); }
    });
    req.on('error', reject);
  });
}

// Server-sent events for anything that talks to the model.
async function sse(req, res, work) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
  const ac = new AbortController();
  res.on('close', () => ac.abort());
  const emit = (event, data) => { if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
  try {
    await work(emit, ac.signal);
  } catch (e) {
    if (!ac.signal.aborted) {
      const down = e.cause?.code === 'ECONNREFUSED' || /fetch failed/.test(e.message);
      emit('error', { message: down ? `Could not reach the model at ${llm.getConfig().endpoint}. Is it running?` : e.message });
    }
  }
  res.end();
}

const routes = [
  ['GET', /^\/api\/health$/, async () => withWindow(await llm.health())],
  ['GET', /^\/api\/config$/, async () => { const { calibration, ...cfg } = llm.getConfig(); return cfg; }],
  ['PUT', /^\/api\/config$/, async (m, body) => { llm.setConfig(body); win.reset(); return withWindow(await llm.health()); }],
  ['GET', /^\/api\/window$/, async () => windowReport()],
  ['POST', /^\/api\/window\/check$/, async () => windowReport(true)],

  ['GET', /^\/api\/books$/, async () => store.listBooks()],
  ['POST', /^\/api\/books$/, async (m, body) => store.createBook(body)],
  ['GET', /^\/api\/books\/([^/]+)$/, async (m) => store.getBook(m[1])],
  ['PUT', /^\/api\/books\/([^/]+)$/, async (m, body) => store.updateBook(m[1], body)],
  ['PUT', /^\/api\/books\/([^/]+)\/bible$/, async (m, body) => store.saveBible(m[1], body.entries)],
  ['POST', /^\/api\/books\/([^/]+)\/import$/, async (m, body) => ({ chapters: store.importManuscript(m[1], body.text) })],
  ['GET', /^\/api\/books\/([^/]+)\/outline$/, async (m) => {
    const book = store.loadBook(m[1]);
    return book.chapters.map((c, i) => {
      const s = store.readSummary(m[1], c.id);
      return { id: c.id, num: i + 1, title: c.title, words: c.words || 0, summary: s ? s.text : '', fresh: !!s && s.hash === c.hash };
    });
  }],

  ['POST', /^\/api\/books\/([^/]+)\/chapters$/, async (m, body) => store.addChapter(m[1], body)],
  ['POST', /^\/api\/books\/([^/]+)\/search$/, async (m, body) => store.search(m[1], body.q)],
  ['GET', /^\/api\/books\/([^/]+)\/chapters\/([^/]+)$/, async (m) => {
    const text = store.readChapter(m[1], m[2]);
    // Opening a chapter means the others have stopped moving: bring their summaries up to date quietly.
    context.scheduleSummaries(m[1], { except: m[2], delay: 1500 });
    return { text, hash: store.hash(text) };
  }],
  ['PUT', /^\/api\/books\/([^/]+)\/chapters\/([^/]+)$/, async (m, body) => {
    const saved = store.writeChapter(m[1], m[2], body);
    context.scheduleSummaries(m[1], { except: m[2], delay: 30000 });
    return saved;
  }],
  ['DELETE', /^\/api\/books\/([^/]+)\/chapters\/([^/]+)$/, async (m) => { store.deleteChapter(m[1], m[2]); return { ok: true }; }],
  ['GET', /^\/api\/books\/([^/]+)\/chapters\/([^/]+)\/snapshots$/, async (m) => store.listSnapshots(m[1], m[2])],
  ['POST', /^\/api\/books\/([^/]+)\/chapters\/([^/]+)\/snapshots$/, async (m, body) => ({
    name: store.snapshot(m[1], m[2], body.label || 'manual', typeof body.text === 'string' ? body.text : undefined),
  })],
  ['GET', /^\/api\/books\/([^/]+)\/chapters\/([^/]+)\/snapshots\/([^/]+)$/, async (m) => ({ text: store.readSnapshot(m[1], m[2], decodeURIComponent(m[3])) })],
];

// The context window and what each tool may read from it.
async function windowReport(refresh = false) {
  const w = await win.current({ refresh });
  const budgets = {};
  for (const task of Object.keys(context.TASKS)) {
    let spec = P.TASKS[task]({ passage: 'x'.repeat(4000) });
    if (w.tokens < 32768 && spec.effort === 'medium') spec = { ...spec, effort: 'low' };
    const pl = context.plan(task, w.tokens, llm.allowance(spec, w.tokens));
    budgets[task] = { reads: pl.total, writes: pl.reserve };
  }
  return { ...w, budgets, reviseWords: assistant.maxReviseWords(w.tokens) };
}
async function withWindow(h) {
  if (!h.ok) return h;
  const w = await win.current();
  return { ...h, window: w.tokens, windowSource: w.source, windowGuess: w.guess };
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  // Only this machine's browser, on this app's own page, may talk to the server.
  if (!LOCAL.has(req.headers.host)) return json(res, 403, { error: 'Forbidden' });
  if (req.headers.origin && !LOCAL.has(req.headers.origin.replace(/^https?:\/\//, ''))) return json(res, 403, { error: 'Forbidden' });

  if (url.pathname.startsWith('/api/')) {
    let m;
    if (req.method === 'POST' && (m = url.pathname.match(/^\/api\/books\/([^/]+)\/ai$/))) {
      const body = await readBody(req);
      return sse(req, res, (emit, signal) => assistant.run({ bookId: m[1], body, emit, signal }));
    }
    if (req.method === 'POST' && (m = url.pathname.match(/^\/api\/books\/([^/]+)\/summarize$/))) {
      return sse(req, res, async (emit, signal) => {
        const n = await context.summarizeAll(m[1], { emit, signal });
        emit('done', { chapters: n });
      });
    }
    if (req.method === 'GET' && (m = url.pathname.match(/^\/api\/books\/([^/]+)\/export$/))) {
      const book = store.loadBook(m[1]);
      const name = encodeURIComponent(book.title.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'manuscript');
      const docx = url.searchParams.get('format') === 'docx';
      const data = docx ? exporter.docx(m[1]) : Buffer.from(exporter.markdown(m[1]));
      res.writeHead(200, {
        'Content-Type': docx ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'text/markdown; charset=utf-8',
        'Content-Disposition': `attachment; filename*=UTF-8''${name}.${docx ? 'docx' : 'md'}`,
        'Content-Length': data.length,
      });
      return res.end(data);
    }
    for (const [method, re, fn] of routes) {
      if (req.method !== method) continue;
      m = url.pathname.match(re);
      if (!m) continue;
      const body = method === 'GET' || method === 'DELETE' ? {} : await readBody(req);
      return json(res, 200, await fn(m, body));
    }
    return json(res, 404, { error: 'Not found' });
  }

  if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
  const file = path.normalize(path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!file.startsWith(PUBLIC + path.sep)) return json(res, 403, { error: 'Forbidden' });
  fs.readFile(file, (err, data) => {
    if (err) return json(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    if (!e.status) console.error(e);
    if (!res.headersSent) json(res, e.status || 500, { error: e.message || 'Server error', ...(e.data || {}) });
    else res.end();
  });
});
server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  Manuscript is open at  http://localhost:${PORT}\n  Your books are saved in ${store.ROOT}\n  Press Ctrl+C to quit.\n`);
});
server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is busy. Manuscript may already be running: http://localhost:${PORT}` : e);
  process.exit(1);
});
