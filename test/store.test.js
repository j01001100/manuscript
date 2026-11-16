'use strict';
const { dir } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const store = require('../lib/store');

const bookPath = (id, ...rest) => path.join(store.ROOT, id, ...rest);

test('storage lives under BOOKS_ROOT, not the real books folder', () => {
  assert.ok(store.ROOT.startsWith(dir));
});

test('slug, hash and word count', () => {
  assert.equal(store.slug('  The Salt House!  '), 'the-salt-house');
  assert.equal(store.slug('Çà et là'), 'ca-et-la');
  assert.equal(store.slug('???'), 'untitled');
  assert.equal(store.slug('x'.repeat(100)).length, 40);
  assert.equal(store.hash('abc'), store.hash('abc'));
  assert.notEqual(store.hash('abc'), store.hash('abd'));
  assert.equal(store.hash('').length, 16);
  assert.equal(store.countWords(''), 0);
  assert.equal(store.countWords('She didn’t stop. Twenty-two years, 3 boats.'), 7);
  assert.equal(store.countWords('  —  …  '), 0);
});

test('ids that could escape the books folder are refused', () => {
  assert.throws(() => store.loadBook('../etc'), { status: 400 });
  const book = store.createBook({ title: 'Ids' });
  assert.equal(store.readChapter(book.id, '../../book'), '', 'reads nothing rather than following the path');
  assert.throws(() => store.snapshot(book.id, '../../x', 'label', 'text'), { status: 400 });
  assert.throws(() => store.writeChapter(book.id, '../../x', { text: 'no' }), { status: 404 }, 'not one of this book\'s chapters');
  assert.throws(() => store.readSnapshot(book.id, book.chapters[0].id, '../book.json'), { status: 400 });
});

test('a new book has one empty chapter, and saving counts words', () => {
  const book = store.createBook({ title: 'Counting' });
  assert.equal(book.chapters.length, 1);
  const cid = book.chapters[0].id;
  const r = store.writeChapter(book.id, cid, { text: 'One two three.', title: 'Opening' });
  assert.deepEqual([r.words, r.total, r.todayWords, r.title], [3, 3, 3, 'Opening']);
  assert.equal(r.hash, store.hash('One two three.'));
  assert.equal(fs.readFileSync(bookPath(book.id, 'chapters', `${cid}.md`), 'utf8'), 'One two three.');
  assert.deepEqual(fs.readdirSync(bookPath(book.id, 'chapters')).filter((n) => n.includes('.tmp-')), []);
});

test('a save based on a stale version is refused, and forcing it keeps the other text', () => {
  const book = store.createBook({ title: 'Conflict' });
  const cid = book.chapters[0].id;
  const first = store.writeChapter(book.id, cid, { text: 'Window A wrote this first sentence.', baseHash: store.hash('') });

  // Window B still holds the empty version it opened.
  assert.throws(
    () => store.writeChapter(book.id, cid, { text: 'Window B.', baseHash: store.hash('') }),
    (e) => e.status === 409 && e.data.hash === first.hash,
  );
  assert.equal(store.readChapter(book.id, cid), 'Window A wrote this first sentence.');

  // Saving the identical text is never a conflict, whatever the base.
  store.writeChapter(book.id, cid, { text: 'Window A wrote this first sentence.', baseHash: 'anything' });

  const forced = store.writeChapter(book.id, cid, { text: 'Window B.', baseHash: store.hash(''), force: true });
  assert.equal(forced.hash, store.hash('Window B.'));
  const kept = store.listSnapshots(book.id, cid).find((s) => s.label === 'overwritten');
  assert.equal(store.readSnapshot(book.id, cid, kept.name), 'Window A wrote this first sentence.');
});

test('an edit made to the file outside the app is detected too', () => {
  const book = store.createBook({ title: 'Outside' });
  const cid = book.chapters[0].id;
  const r = store.writeChapter(book.id, cid, { text: 'As saved by the app.' });
  fs.writeFileSync(bookPath(book.id, 'chapters', `${cid}.md`), 'Edited in another program.');
  assert.throws(() => store.writeChapter(book.id, cid, { text: 'From the app again.', baseHash: r.hash }), { status: 409 });
});

test('automatic versions are pruned; versions you asked for are not', () => {
  const book = store.createBook({ title: 'Versions' });
  const cid = book.chapters[0].id;
  const text = 'A chapter long enough to be worth keeping a version of. '.repeat(6);
  store.writeChapter(book.id, cid, { text });
  const snaps = bookPath(book.id, 'snapshots', cid);
  fs.mkdirSync(snaps, { recursive: true });
  for (let i = 0; i < 50; i++) fs.writeFileSync(path.join(snaps, `2020-01-01T00-${String(i).padStart(2, '0')}-00-000Z_auto.md`), `old ${i}`);
  fs.writeFileSync(path.join(snaps, '2019-06-01T00-00-00-000Z_kept.md'), 'kept on purpose');

  store.writeChapter(book.id, cid, { text: `${text} And one more sentence.` });
  const list = store.listSnapshots(book.id, cid);
  assert.equal(list.filter((s) => s.label === 'auto').length, store.AUTO_SNAPSHOT_KEEP);
  assert.ok(list.some((s) => s.label === 'kept'));
  assert.equal(store.readSnapshot(book.id, cid, list[0].name), text, 'the newest version is the text just replaced');

  // A second save straight away does not add another automatic version.
  store.writeChapter(book.id, cid, { text: `${text} And two.` });
  assert.equal(store.listSnapshots(book.id, cid).length, list.length);
});

test('emptying a chapter always keeps what was there, even seconds after the last version', () => {
  const book = store.createBook({ title: 'Slip' });
  const cid = book.chapters[0].id;
  const text = 'Two thousand words would be here in a real chapter, and they matter. '.repeat(8);
  store.writeChapter(book.id, cid, { text });
  store.writeChapter(book.id, cid, { text: `${text} More.` });          // takes the automatic version
  store.writeChapter(book.id, cid, { text: `${text} More still.` });    // too soon for another automatic one
  assert.equal(store.listSnapshots(book.id, cid).length, 1);

  store.writeChapter(book.id, cid, { text: '' });                        // select-all, delete, autosave
  const kept = store.listSnapshots(book.id, cid).find((s) => s.label === 'before-large-cut');
  assert.equal(store.readSnapshot(book.id, cid, kept.name), `${text} More still.`);
});

test('a book cannot be left without a title', () => {
  const book = store.createBook({ title: 'Named' });
  assert.equal(store.updateBook(book.id, { title: '   ', author: 'Someone' }).title, 'Named');
  assert.equal(store.getBook(book.id).author, 'Someone');
  assert.equal(store.updateBook(book.id, { title: 'Renamed' }).title, 'Renamed');
});

test('importing splits on chapter headings and does not count as words written today', () => {
  const book = store.createBook({ title: 'Import' });
  const n = store.importManuscript(book.id, [
    'Prologue', '', 'Before anything.', '',
    'Chapter One: The Ferry', '', 'It left twice a week.', 'She missed it.', '',
    '## The Pans', '', 'Raking and waiting.', '',
    'CHAPTER 3', '', 'Nine days.',
  ].join('\r\n'));
  assert.equal(n, 4);
  const after = store.getBook(book.id);
  assert.deepEqual(after.chapters.map((c) => c.title), ['Prologue', 'Chapter One: The Ferry', 'The Pans', 'CHAPTER 3']);
  assert.equal(store.readChapter(book.id, after.chapters[1].id), 'It left twice a week.\nShe missed it.');
  assert.equal(after.words, 15);
  assert.equal(after.todayWords, 0);
  assert.throws(() => store.importManuscript(book.id, '   \n  '), { status: 400 });

  // Text with no headings at all becomes one chapter, appended.
  store.importManuscript(book.id, 'Just a page of prose.');
  assert.equal(store.getBook(book.id).chapters.length, 5);
});

test('removing a chapter moves its text and versions to trash and never makes today negative', () => {
  const book = store.createBook({ title: 'Trash' });
  store.importManuscript(book.id, `Chapter 1\n\n${'word '.repeat(200)}\n\nChapter 2\n\n${'word '.repeat(50)}`);
  const [one, two] = store.getBook(book.id).chapters;
  store.snapshot(book.id, one.id, 'kept');
  store.writeChapter(book.id, two.id, { text: `${'word '.repeat(50)} and ten more words written on this very day today` });
  assert.equal(store.getBook(book.id).todayWords, 10);

  store.deleteChapter(book.id, one.id);
  const after = store.getBook(book.id);
  assert.equal(after.chapters.length, 1);
  assert.equal(after.todayWords, 10, 'the words written today still count');
  const trash = fs.readdirSync(bookPath(book.id, 'trash'));
  assert.equal(trash.filter((n) => n.endsWith('.md')).length, 1);
  const versions = trash.find((n) => n.endsWith('.versions'));
  assert.equal(fs.readdirSync(bookPath(book.id, 'trash', versions)).length, 1);
  assert.ok(!fs.existsSync(bookPath(book.id, 'snapshots', one.id)));
});

test('search finds a phrase in every chapter, ignoring case and quote style', () => {
  const book = store.createBook({ title: 'Search' });
  store.importManuscript(book.id, 'Chapter 1\n\nİstanbul first. She said “don’t burn it,” and he did not.\n\nChapter 2\n\nNothing here.\n\nChapter 3\n\nDON\'T BURN IT, he wrote. Then: don’t  burn\nit.');
  const r = store.search(book.id, "don't burn it");
  assert.equal(r.total, 3);
  assert.deepEqual(r.results.map((c) => [c.num, c.matches.length]), [[1, 1], [3, 2]]);
  const [ch1] = store.getBook(book.id).chapters;
  const m = r.results[0].matches[0];
  assert.equal(store.readChapter(book.id, ch1.id).slice(m.start, m.end), 'don’t burn it', 'offsets point at the real text');
  assert.equal(store.search(book.id, 'a').total, 0, 'one letter is not a search');
  assert.equal(store.search(book.id, 'it.)(').total, 0, 'punctuation is literal, not a pattern');
});

test('the story bible is cleaned on the way in', () => {
  const book = store.createBook({ title: 'Bible' });
  const saved = store.saveBible(book.id, [
    { name: ' Ines ', type: 'character', body: 'Thirty-four.' },
    { name: '', body: 'no name, dropped' },
    { name: 'Odd', type: 'weapon', id: '../../escape' },
  ]);
  assert.deepEqual(saved.map((e) => [e.name, e.type]), [['Ines', 'character'], ['Odd', 'note']]);
  assert.match(saved[1].id, /^b-[0-9a-f]{8}$/);
  assert.throws(() => store.saveBible(book.id, 'nope'), { status: 400 });
});
