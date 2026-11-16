'use strict';
const { dir } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

let port;
let child;
const call = async (method, url, body, headers = {}) => {
  const r = await fetch(`http://127.0.0.1:${port}${url}`, {
    method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null), headers: r.headers };
};

test.before(async () => {
  port = await new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  fs.writeFileSync(process.env.MANUSCRIPT_CONFIG, JSON.stringify({ endpoint: 'http://127.0.0.1:9/v1' }));
  child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve, reject) => { child.stdout.on('data', (d) => /is open at/.test(d) && resolve()); child.on('exit', () => reject(new Error('server exited'))); });
});
test.after(() => child.kill());

test('the server keeps its books where BOOKS_ROOT says', async () => {
  assert.deepEqual((await call('GET', '/api/books')).body, []);
  const { body: book } = await call('POST', '/api/books', { title: 'Over HTTP' });
  assert.ok(fs.existsSync(path.join(dir, 'books', book.id, 'book.json')));
});

test('two windows on one chapter: the second save gets 409 and can choose', async () => {
  const { body: book } = await call('POST', '/api/books', { title: 'Two windows' });
  const url = `/api/books/${book.id}/chapters/${book.chapters[0].id}`;
  const a = (await call('GET', url)).body;
  const b = (await call('GET', url)).body;
  assert.equal(a.hash, b.hash);

  const savedA = await call('PUT', url, { text: 'Window A.', baseHash: a.hash });
  assert.equal(savedA.status, 200);
  const savedB = await call('PUT', url, { text: 'Window B.', baseHash: b.hash });
  assert.equal(savedB.status, 409);
  assert.equal(savedB.body.hash, savedA.body.hash, 'the refusal says what version is on disk');
  assert.equal((await call('GET', url)).body.text, 'Window A.');

  // B keeps its own copy as a version, then loads A's.
  await call('POST', `${url}/snapshots`, { label: 'this window', text: 'Window B.' });
  const snaps = (await call('GET', `${url}/snapshots`)).body;
  assert.deepEqual(snaps.map((s) => s.label), ['this-window']);
  assert.equal((await call('GET', `${url}/snapshots/${encodeURIComponent(snaps[0].name)}`)).body.text, 'Window B.');

  // A carries on from the hash its save returned.
  assert.equal((await call('PUT', url, { text: 'Window A, continued.', baseHash: savedA.body.hash })).status, 200);
});

test('search, export and the request guards', async () => {
  const { body: book } = await call('POST', '/api/books', { title: 'Guards' });
  await call('POST', `/api/books/${book.id}/import`, { text: 'Chapter 1\n\nThe green ink.\n\nChapter 2\n\nGreen again.' });
  assert.equal((await call('POST', `/api/books/${book.id}/search`, { q: 'green' })).body.total, 2);

  const docx = await fetch(`http://127.0.0.1:${port}/api/books/${book.id}/export?format=docx`);
  assert.match(docx.headers.get('content-disposition'), /Guards\.docx/);
  assert.equal(Buffer.from(await docx.arrayBuffer()).readUInt32LE(0), 0x04034b50);

  assert.equal((await call('POST', '/api/books', { title: 'x' }, { Origin: 'http://evil.example' })).status, 403, 'other sites cannot post');
  // A page on another site that resolves its own name to this machine still sends its own Host.
  const rebound = await new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port, path: '/api/books', headers: { Host: 'evil.example' } }, (res) => { res.resume(); resolve(res.statusCode); });
  });
  assert.equal(rebound, 403, 'only localhost is answered');
  assert.equal((await call('GET', '/api/books/..%2F..%2Fetc')).status, 400);
  assert.equal((await call('GET', '/api/nope')).status, 404);
  const outside = await fetch(`http://127.0.0.1:${port}/..%2Fserver.js`);
  assert.equal(outside.status, 404);
});

test('with no model running, a request fails quickly and says why', async () => {
  const { body: book } = await call('POST', '/api/books', { title: 'Offline' });
  await call('PUT', `/api/books/${book.id}/chapters/${book.chapters[0].id}`, { text: 'A sentence to revise.' });
  const r = await fetch(`http://127.0.0.1:${port}/api/books/${book.id}/ai`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task: 'revise', chapterId: book.chapters[0].id, selection: { start: 0, end: 21 }, mode: 'line' }),
  });
  const text = await r.text();
  assert.match(text, /event: receipt/);
  assert.match(text, /event: error\ndata: .*Could not reach the model/);
});
