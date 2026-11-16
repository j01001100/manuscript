'use strict';
const { words } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const store = require('../lib/store');
const context = require('../lib/context');

// No test here may reach a model: point the client at a port nothing listens on.
fs.writeFileSync(process.env.MANUSCRIPT_CONFIG, JSON.stringify({ endpoint: 'http://127.0.0.1:9/v1' }));

const { BUDGET, tail, head } = context;
const wc = store.countWords;

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

  // One enormous paragraph has no break to prefer: cut on a word instead.
  assert.equal(wc(tail(words(3000), 500)), 500);
});

test('a small bible is sent whole; a large one sends only what the passage touches', () => {
  const small = [{ name: 'Ines', type: 'character', aliases: '', body: 'Thirty-four.' }, { name: 'Kvale', type: 'place', aliases: '', body: 'The hospital town.' }];
  assert.equal(context.pickBible(small, 'nothing relevant', false).length, 2);

  const big = Array.from({ length: 60 }, (_, i) => ({ name: `Person${i}`, type: 'character', aliases: i === 7 ? 'the Clerk' : '', body: words(60) }));
  big.push({ name: 'The inspection', type: 'thread', aliases: '', body: 'Thirty days.' });
  const picked = context.pickBible(big, 'Then Person3 spoke to the clerk about it.', false);
  assert.deepEqual(picked.map((e) => e.name).sort(), ['Person3', 'Person7', 'The inspection']);
  assert.equal(context.pickBible(big, '', true).length, big.length, 'continuity checks get all of it');

  const everyone = big.map((e) => e.name).join(' ');
  const capped = context.pickBible(big, everyone, false);
  assert.ok(capped.length < big.length);
  assert.ok(context.est(capped.map(context.fmtEntry).join('\n')) <= BUDGET.bibleTokens);
});

test('a name not seen since an early chapter pulls in where it first and last appeared', () => {
  const earlier = [
    { num: 1, text: `She met a clerk called Signe at the office.\n\n${words(30)}\n\nLater that day Signe laughed.` },
    { num: 2, text: `Nobody of note. But then Teodor came down the path.` },
  ];
  const base = { earlier, prevText: 'Only Teodor was there.', bibleNames: new Set(), skipChapters: new Set() };

  const got = context.recallByName({ ...base, focus: 'She walked to find Signe, and Teodor followed.' });
  assert.deepEqual(got.map((p) => [p.term, p.num, p.intro]), [['Signe', 1, true], ['Signe', 1, false]]);
  assert.match(got[0].text, /clerk called Signe/);
  assert.match(got[1].text, /Signe laughed/);

  assert.deepEqual(context.recallByName({ ...base, focus: 'She walked on alone.' }), []);
  assert.deepEqual(context.recallByName({ ...base, focus: 'Signe again.', bibleNames: new Set(['signe']) }), [], 'the bible entry covers it');
  assert.deepEqual(context.recallByName({ ...base, focus: 'Signe again.', skipChapters: new Set([1]) }), [], 'that chapter is being re-read in full anyway');
  // A question typed in lower case still finds the name.
  assert.equal(context.recallByName({ ...base, focus: '', looseFocus: 'what did signe say?' }).length, 2);
});

// Build a book whose summaries already exist, so assembling context needs no model.
function bookWith(chapters) {
  const book = store.createBook({ title: 'Context', premise: 'A woman inherits a salt works.' });
  store.importManuscript(book.id, chapters.map((text, i) => `Chapter ${i + 1}\n\n${text}`).join('\n\n'));
  const saved = store.getBook(book.id);
  saved.chapters.forEach((c, i) => {
    const text = store.readChapter(book.id, c.id);
    store.writeSummary(book.id, c.id, `LOGLINE: Logline of chapter ${i + 1}.\nEVENTS: Summary body of chapter ${i + 1}.`, store.hash(text));
  });
  return saved;
}

test('in chapter 5: chapters 4 and 5 in full, 1 to 3 as summaries, nothing else', async () => {
  const book = bookWith([1, 2, 3, 4, 5].map((n) => `Unique sentence of chapter ${n}. ${words(300)}`));
  const ctx = await context.build({ bookId: book.id, chapterId: book.chapters[4].id, task: 'next' });

  assert.deepEqual(ctx.receipt.map((r) => [r.label, r.how]), [
    ['Chapters 1–3', 'summaries'], ['Chapter 4', 'full text'], ['Chapter 5', 'full text'],
  ]);
  for (const n of [4, 5]) assert.ok(ctx.context.includes(`Unique sentence of chapter ${n}.`));
  for (const n of [1, 2, 3]) {
    assert.ok(!ctx.context.includes(`Unique sentence of chapter ${n}.`), `chapter ${n} must not be sent in full`);
    assert.ok(ctx.context.includes(`Summary body of chapter ${n}.`));
  }
  assert.ok(ctx.context.includes('A woman inherits a salt works.'));
  assert.ok(ctx.tokens < ctx.bookTokens, 'cheaper than sending the book');
  // Stable material comes first so the model server can reuse its cache.
  const order = ['# THE BOOK', '# THE STORY SO FAR', '# PREVIOUS CHAPTER', '# CURRENT CHAPTER'].map((s) => ctx.context.indexOf(s));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  assert.ok(order.every((i) => i >= 0));
});

test('chapters far behind shrink to one line each', async () => {
  const book = bookWith(Array.from({ length: 12 }, (_, i) => `Unique sentence of chapter ${i + 1}. ${words(200)}`));
  const ctx = await context.build({ bookId: book.id, chapterId: book.chapters[11].id, task: 'next' });
  const far = 10 - BUDGET.detailedSummaries;   // ten earlier chapters; the nearest six keep full summaries
  assert.deepEqual(ctx.receipt.slice(0, 2).map((r) => [r.label, r.how]), [[`Chapters 1–${far}`, 'one line each'], [`Chapters ${far + 1}–10`, 'summaries']]);
  assert.ok(ctx.context.includes('Logline of chapter 1.'));
  assert.ok(!ctx.context.includes('Summary body of chapter 1.'));
  assert.ok(ctx.context.includes('Summary body of chapter 10.'));
});

test('very long chapters are trimmed to their budgets', async () => {
  const longPrev = `Prev opening line. ${words(BUDGET.prevFullWords + 2000)} Prev closing line.`;
  const longCur = `Current opening line. ${words(BUDGET.curFullWords + 4000)} Current closing line.`;
  const book = bookWith([words(300), longPrev, longCur]);

  const ctx = await context.build({ bookId: book.id, chapterId: book.chapters[2].id, task: 'next' });
  const how = Object.fromEntries(ctx.receipt.map((r) => [r.label, r.how]));
  assert.match(how['Chapter 2'], /^summary \+ last/);
  assert.match(how['Chapter 3'], /^opening \+ last/);
  assert.ok(!ctx.context.includes('Prev opening line.'));
  assert.ok(ctx.context.includes('Prev closing line.'));
  assert.ok(ctx.context.includes('Summary body of chapter 2.'));
  assert.ok(ctx.context.includes('Current opening line.') && ctx.context.includes('Current closing line.'));
  assert.ok(ctx.context.includes('the middle of the chapter is omitted'));
  const budget = BUDGET.prevTailWords + BUDGET.curTailWords + BUDGET.curHeadWords + 1500;
  assert.ok(wc(ctx.context) < budget, `${wc(ctx.context)} words sent, budget ${budget}`);

  // A whole-chapter read (critique) is allowed the full current chapter.
  const deep = await context.build({ bookId: book.id, chapterId: book.chapters[2].id, task: 'critique' });
  assert.equal(deep.receipt.find((r) => r.label === 'Chapter 3').how, 'full text');
});

test('suggesting from mid-chapter splits the text at the cursor', async () => {
  const book = bookWith([words(300), `Before the cursor. ${words(200)} AFTER-MARKER and the rest. ${words(100)}`]);
  const text = store.readChapter(book.id, book.chapters[1].id);
  const cursor = text.indexOf('AFTER-MARKER');
  const ctx = await context.build({ bookId: book.id, chapterId: book.chapters[1].id, task: 'next', cursor });
  assert.equal(ctx.hasAfter, true);
  const cur = ctx.context.slice(ctx.context.indexOf('# CURRENT CHAPTER'), ctx.context.indexOf('# AFTER THE CURSOR'));
  assert.ok(cur.includes('Before the cursor.') && !cur.includes('AFTER-MARKER'));
  assert.ok(ctx.context.slice(ctx.context.indexOf('# AFTER THE CURSOR')).includes('AFTER-MARKER'));
});

test('a short chapter is its own summary, with no model involved', async () => {
  const book = store.createBook({ title: 'Short' });
  store.importManuscript(book.id, 'Chapter 1\n\nA fragment of forty words or so.\n\nChapter 2\n\nSecond.\n\nChapter 3\n\nThird.');
  const saved = store.getBook(book.id);
  const ctx = await context.build({ bookId: book.id, chapterId: saved.chapters[2].id, task: 'next' });
  assert.ok(ctx.context.includes('A fragment of forty words or so.'));
  assert.ok(store.readSummary(book.id, saved.chapters[0].id));
});
