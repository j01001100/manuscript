'use strict';
const { words } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const store = require('../lib/store');
const llm = require('../lib/llm');
const context = require('../lib/context');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 3000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error('timed out waiting'); await sleep(20); } };

// A stand-in model that "summarises" by echoing the chapter heading, slowly enough to overlap.
let requests = [];
let delay = 40;
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const body = JSON.parse(raw);
    const heading = body.messages[1].content.split('\n')[0];
    requests.push(heading);
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: `LOGLINE: About ${heading}.\nEVENTS: Things.` } }] }));
    }, delay);
  });
});
test.before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  llm.setConfig({ endpoint: `http://127.0.0.1:${server.address().port}/v1`, model: 'fake' });
});
test.after(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));

function book(n) {
  const b = store.createBook({ title: 'Background' });
  store.importManuscript(b.id, Array.from({ length: n }, (_, i) => `Chapter ${i + 1}\n\n${words(250, `w${i}`)}`).join('\n\n'));
  return store.getBook(b.id);
}
const fresh = (b) => store.getBook(b.id).chapters.map((c) => c.summaryFresh);

test('after a pause, every chapter but the one being written is summarised in the background', async () => {
  requests = [];
  const b = book(4);
  context.scheduleSummaries(b.id, { except: b.chapters[3].id, delay: 10 });
  await until(() => fresh(b).filter(Boolean).length === 3);
  assert.deepEqual(fresh(b), [true, true, true, false]);
  assert.equal(requests.length, 3);
  assert.equal(store.getBook(b.id).chapters[0].logline, 'About Chapter 1: Chapter 1.');

  // Nothing changed, so the next sweep asks the model for nothing.
  context.scheduleSummaries(b.id, { except: b.chapters[3].id, delay: 10 });
  await sleep(150);
  assert.equal(requests.length, 3);

  // Edit chapter 2, move on to chapter 4: only chapter 2 is read again.
  store.writeChapter(b.id, b.chapters[1].id, { text: words(260, 'changed') });
  assert.deepEqual(fresh(b), [true, false, true, false]);
  context.scheduleSummaries(b.id, { except: b.chapters[3].id, delay: 10 });
  await until(() => fresh(b)[1]);
  assert.equal(requests.length, 4);
});

test('saves in quick succession are debounced into one sweep', async () => {
  requests = [];
  const b = book(2);
  for (let i = 0; i < 5; i++) { context.scheduleSummaries(b.id, { except: b.chapters[1].id, delay: 40 }); await sleep(10); }
  assert.equal(requests.length, 0, 'nothing runs while saves keep coming');
  await until(() => fresh(b)[0]);
  assert.equal(requests.length, 1);
});

test('a request that needs a summary already being written waits for it instead of asking twice', async () => {
  requests = [];
  delay = 150;
  const b = book(3);
  context.scheduleSummaries(b.id, { except: b.chapters[2].id, delay: 0 });
  await until(() => requests.length === 1);            // the sweep is now waiting on chapter 1
  const ctx = await context.build({ bookId: b.id, chapterId: b.chapters[2].id, task: 'next' });
  assert.ok(ctx.context.includes('About Chapter 1: Chapter 1.'));
  await until(() => fresh(b)[1]);
  assert.deepEqual(requests.sort(), ['Chapter 1: Chapter 1', 'Chapter 2: Chapter 2'], 'one request per chapter');
  delay = 40;
});

test('the background stands aside while an editor request is in progress', async () => {
  requests = [];
  const b = book(3);
  let release;
  const busy = context.asForeground(() => new Promise((r) => { release = r; }));
  context.scheduleSummaries(b.id, { delay: 0 });
  await sleep(200);
  assert.equal(requests.length, 0, 'waits for the foreground');
  release();
  await busy;
  await until(() => fresh(b).every(Boolean));
  assert.equal(requests.length, 3);
});

test('a model that is down does not break anything; the next sweep tries again', async () => {
  const b = book(2);
  const good = llm.getConfig().endpoint;
  llm.setConfig({ endpoint: 'http://127.0.0.1:9/v1' });
  context.scheduleSummaries(b.id, { delay: 0 });
  await sleep(150);
  assert.deepEqual(fresh(b), [false, false]);
  llm.setConfig({ endpoint: good });
  context.scheduleSummaries(b.id, { delay: 0 });
  await until(() => fresh(b).every(Boolean));
});
