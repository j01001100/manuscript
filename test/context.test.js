'use strict';
const { words } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const store = require('../lib/store');
const context = require('../lib/context');

// No test here may reach a model: point the client at a port nothing listens on.
fs.writeFileSync(process.env.MANUSCRIPT_CONFIG, JSON.stringify({ endpoint: 'http://127.0.0.1:9/v1' }));

const { tail, head, est } = context;
const wc = store.countWords;
const K128 = 131072;

test('tail and head keep about the requested number of words and prefer paragraph breaks', () => {
  const paras = Array.from({ length: 40 }, (_, i) => `Para${i} ${words(49)}`);
  const text = paras.join('\n\n');
  assert.equal(tail('short text', 100), 'short text');
  assert.equal(head('short text', 100), 'short text');

  const t = tail(text, 500);
  assert.ok(wc(t) <= 500 && wc(t) >= 400, `tail kept ${wc(t)} words`);
  assert.ok(t.endsWith(paras[39]));
  assert.match(t, /^Para\d+ /, 'starts at the top of a paragraph');

  const h = head(text, 500);
  assert.ok(wc(h) <= 500 && wc(h) >= 400, `head kept ${wc(h)} words`);
  assert.ok(h.startsWith(paras[0]));
  assert.ok(paras.includes(h.split('\n\n').pop()), 'ends at the bottom of a paragraph');
  assert.equal(wc(tail(words(3000), 500)), 500);
});

test('budgets scale with the window and always leave room for the answer', () => {
  for (const window of [4096, 8192, 32768, K128]) {
    for (const task of Object.keys(context.TASKS)) {
      const pl = context.plan(task, window, Math.min(5800, Math.floor(window * 0.4)));
      assert.ok(pl.total <= pl.cap, `${task} @${window}`);
      assert.ok(pl.total + pl.reserve + pl.margin <= window, `${task} @${window}: ${pl.total}+${pl.reserve}+${pl.margin}`);
      assert.ok(pl.shared <= pl.total);
    }
  }
  const at = (task, w) => context.plan(task, w, 2400);
  assert.ok(at('next', K128).shared > 30000, 'a 128K window gives the writing tools room for long chapters');
  assert.ok(at('chat', K128).total > 100000, 'and Ask most of the window');
  assert.ok(at('next', 8192).total < 6000);
  assert.equal(at('next', K128).shared, at('revise', K128).shared, 'writing tools size the shared blocks identically');
});

test('a small bible is sent whole; a large one sends only what the passage touches', () => {
  const small = [{ name: 'Ines', type: 'character', aliases: '', body: 'Thirty-four.' }, { name: 'Kvale', type: 'place', aliases: '', body: 'The hospital town.' }];
  assert.equal(context.pickBible(small, 'nothing relevant', false).length, 2);

  const big = Array.from({ length: 60 }, (_, i) => ({ name: `Person${i}`, type: 'character', aliases: i === 7 ? 'the Clerk' : '', body: words(60) }));
  big.push({ name: 'The inspection', type: 'thread', aliases: '', body: 'Thirty days.' });
  const picked = context.pickBible(big, 'Then Person3 spoke to the clerk about it.', false);
  assert.deepEqual(picked.map((e) => e.name).sort(), ['Person3', 'Person7', 'The inspection']);

  const capped = context.pickBible(big, big.map((e) => e.name).join(' '), false, { cap: 2000 });
  assert.ok(capped.length < big.length && est(capped.map(context.fmtEntry).join('\n')) <= 2000);
  assert.equal(context.pickBible(big, '', true, { cap: 1e6 }).length, big.length, 'continuity gets all of it when there is room');
});

test('a name not seen since an early chapter pulls in where it first and last appeared', () => {
  const earlier = [
    { num: 1, text: `She met a clerk called Signe at the office.\n\n${words(30)}\n\nLater that day Signe laughed.` },
    { num: 2, text: 'Nobody of note. But then Teodor came down the path.' },
  ];
  const base = { earlier, prevText: 'Only Teodor was there.', bibleNames: new Set(), skipChapters: new Set() };
  const got = context.recallByName({ ...base, focus: 'She walked to find Signe, and Teodor followed.' });
  assert.deepEqual(got.map((p) => [p.term, p.num, p.intro]), [['Signe', 1, true], ['Signe', 1, false]]);
  assert.deepEqual(context.recallByName({ ...base, focus: 'She walked on alone.' }), []);
  assert.deepEqual(context.recallByName({ ...base, focus: 'Signe again.', bibleNames: new Set(['signe']) }), []);
  assert.deepEqual(context.recallByName({ ...base, focus: 'Signe again.', skipChapters: new Set([1]) }), [], 'that chapter is already there in full');
  assert.equal(context.recallByName({ ...base, focus: '', looseFocus: 'what did signe say?' }).length, 2);
});

// A book whose summaries already exist, so assembling context needs no model.
function bookWith(chapters) {
  const book = store.createBook({ title: 'Context', premise: 'A woman inherits a salt works.' });
  store.importManuscript(book.id, chapters.map((text, i) => `Chapter ${i + 1}\n\n${text}`).join('\n\n'));
  const saved = store.getBook(book.id);
  saved.chapters.forEach((c, i) => {
    const text = store.readChapter(book.id, c.id);
    store.writeSummary(book.id, c.id, `LOGLINE: Logline of chapter ${i + 1}.\nEVENTS: Summary body of chapter ${i + 1}. ${words(150, 'evt')}`, store.hash(text));
  });
  return saved;
}
const novel = (n, size = 3000) => bookWith(Array.from({ length: n }, (_, i) => `Unique sentence of chapter ${i + 1}. ${words(size)}`));
const build = (book, i, task, extra = {}) => context.build({ bookId: book.id, chapterId: book.chapters[i].id, task, window: K128, reserve: 3000, ...extra });

test('writing in chapter 5 with 128K: chapters 4 and 5 in full, 1 to 3 as summaries, nothing else', async () => {
  const book = novel(5, 300);
  const ctx = await build(book, 4, 'next');
  assert.deepEqual(ctx.receipt.map((r) => [r.label, r.how]), [
    ['Chapters 1–3', 'summaries'], ['Chapter 4', 'full text'], ['Chapter 5', 'full text'],
  ]);
  for (const n of [4, 5]) assert.ok(ctx.context.includes(`Unique sentence of chapter ${n}.`));
  for (const n of [1, 2, 3]) {
    assert.ok(!ctx.context.includes(`Unique sentence of chapter ${n}.`), `chapter ${n} must not be sent in full`);
    assert.ok(ctx.context.includes(`Summary body of chapter ${n}.`));
  }
  const order = ['# THE BOOK', '# THE STORY SO FAR', '# PREVIOUS CHAPTER', '# CURRENT CHAPTER'].map((s) => ctx.context.indexOf(s));
  assert.ok(order.every((i, k) => i >= 0 && (!k || i > order[k - 1])), 'stable blocks first, for the cache');
});

test('a 128K window keeps long chapters whole that a small one must cut', async () => {
  const book = bookWith([words(500), `Prev opening line. ${words(12000)} Prev closing line.`, `Current opening line. ${words(16000)} Current closing line.`]);
  const big = await build(book, 2, 'next');
  assert.ok(big.context.includes('Prev opening line.') && big.context.includes('Current opening line.'), 'nothing cut at 128K');

  const small = await build(book, 2, 'next', { window: 16384 });
  const how = Object.fromEntries(small.receipt.map((r) => [r.label, r.how]));
  assert.match(how['Chapter 2'], /^summary/);
  assert.match(how['Chapter 3'], /^opening \+ last/);
  assert.ok(small.context.includes('Current opening line.') && small.context.includes('Current closing line.'));
  assert.ok(!small.context.includes('Prev opening line.'));
  assert.ok(small.tokens <= context.plan('next', 16384, 3000).total);
});

test('summaries shrink to one line, then drop out, only when the window is tight', async () => {
  const book = novel(40, 200);
  const roomy = await build(book, 39, 'next');
  assert.ok(roomy.receipt.some((r) => r.label === 'Chapters 1–38' && r.how === 'summaries'), 'all detailed at 128K');

  const tight = await build(book, 39, 'next', { window: 8192, reserve: 2400 });
  const hows = tight.receipt.map((r) => r.how);
  assert.ok(hows.includes('one line each') || hows.some((h) => h.startsWith('left out')));
  assert.ok(tight.context.includes('Summary body of chapter 38.'), 'the nearest keep their detail');
  assert.ok(tight.tokens <= context.plan('next', 8192, 2400).total);
});

test('no request is ever larger than its budget, at any window, for any task', async () => {
  const book = bookWith([words(9000), words(200), `${words(15000)} Signe`, words(14000), `Then Signe came back. ${words(20000)}`]);
  for (const window of [4096, 8192, 16384, 32768, K128]) {
    for (const task of ['next', 'continue', 'revise', 'critique', 'bible', 'chat', 'continuity']) {
      const reserve = Math.min(5800, Math.floor(window * 0.4));
      const ctx = await build(book, 4, task, { window, reserve, passage: task === 'revise' ? 'Then Signe came back.' : '', query: task === 'chat' ? 'Where did Signe go?' : '' });
      const pl = context.plan(task, window, reserve);
      assert.ok(ctx.tokens <= pl.total, `${task} @${window}: ${ctx.tokens} > ${pl.total}`);
    }
  }
});

test('Ask and Continuity read every earlier chapter in full when the book fits, with no model call', async () => {
  const book = store.createBook({ title: 'Whole' });
  store.importManuscript(book.id, Array.from({ length: 8 }, (_, i) => `Chapter ${i + 1}\n\nUnique sentence of chapter ${i + 1}. ${words(4000)}`).join('\n\n'));
  const saved = store.getBook(book.id);
  // No summaries exist and the model is unreachable: if anything needed one, this would throw.
  for (const task of ['chat', 'continuity']) {
    const ctx = await build(saved, 7, task, { query: task === 'chat' ? 'Is the ledger consistent?' : '' });
    assert.equal(ctx.bookView, true);
    for (let n = 1; n <= 8; n++) assert.ok(ctx.context.includes(`Unique sentence of chapter ${n}.`), `${task}: chapter ${n}`);
    assert.equal(ctx.receipt[0].how, 'full text (the whole book so far fits)');
  }
  // The writing tools still read only the previous chapter in full.
  for (const c of saved.chapters.slice(0, 6)) store.writeSummary(book.id, c.id, 'LOGLINE: x.', store.hash(store.readChapter(book.id, c.id)));
  const next = await build(saved, 7, 'next');
  assert.ok(!next.context.includes('Unique sentence of chapter 1.'));
});

test('when the whole book does not fit, Ask falls back to summaries and keeps the opening fixed', async () => {
  const book = novel(12, 9000);   // ~140K tokens: more than any window here
  const a = await build(book, 11, 'chat', { query: 'Where is the ledger hidden?' });
  const b = await build(book, 11, 'chat', { query: 'And who else has seen it, and when?', recentQuestions: 'Where is the ledger hidden?' });
  assert.equal(a.bookView, false);
  assert.ok(a.context.includes('Summary body of chapter 3.'));
  assert.equal(a.context, b.context, 'the shared opening does not depend on the question, so it stays cached');
});

test('the writing tools share their opening, so switching tools reuses the cache', async () => {
  const book = novel(6, 2500);
  const next = await build(book, 5, 'next');
  const revise = await build(book, 5, 'revise', { passage: 'Unique sentence of chapter 6.' });
  const critique = await build(book, 5, 'critique');
  const opening = (c) => c.context.slice(0, c.context.indexOf('# REFERENCE') >= 0 ? c.context.indexOf('# REFERENCE') : undefined);
  assert.equal(opening(next), opening(revise));
  assert.equal(opening(next), opening(critique));
});

test('suggesting from mid-chapter splits the text at the cursor', async () => {
  const book = bookWith([words(300), `Before the cursor. ${words(200)} AFTER-MARKER and the rest. ${words(100)}`]);
  const text = store.readChapter(book.id, book.chapters[1].id);
  const ctx = await build(book, 1, 'next', { cursor: text.indexOf('AFTER-MARKER') });
  assert.equal(ctx.hasAfter, true);
  const cur = ctx.context.slice(ctx.context.indexOf('# CURRENT CHAPTER'), ctx.context.indexOf('# AFTER THE CURSOR'));
  assert.ok(cur.includes('Before the cursor.') && !cur.includes('AFTER-MARKER'));
  assert.ok(ctx.context.slice(ctx.context.indexOf('# AFTER THE CURSOR')).includes('AFTER-MARKER'));
});

test('a short chapter is its own summary, with no model involved', async () => {
  const book = store.createBook({ title: 'Short' });
  store.importManuscript(book.id, 'Chapter 1\n\nA fragment of forty words or so.\n\nChapter 2\n\nSecond.\n\nChapter 3\n\nThird.');
  const saved = store.getBook(book.id);
  const ctx = await build(saved, 2, 'next');
  assert.ok(ctx.context.includes('A fragment of forty words or so.'));
  assert.ok(store.readSummary(book.id, saved.chapters[0].id));
});
