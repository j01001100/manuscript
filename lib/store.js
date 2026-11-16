'use strict';
// Plain-file storage. Every book is a folder you can read without this app:
//   books/<book-id>/book.json            title, brief, chapter order
//   books/<book-id>/chapters/<id>.md     the manuscript, one file per chapter
//   books/<book-id>/chapters/<id>.summary.json   the model's memory of that chapter
//   books/<book-id>/bible.json           characters, places, threads
//   books/<book-id>/snapshots/<id>/      earlier versions of each chapter
// Set BOOKS_ROOT to keep books somewhere else (the tests use a scratch folder).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = process.env.BOOKS_ROOT ? path.resolve(process.env.BOOKS_ROOT) : path.join(__dirname, '..', 'books');
const ID = /^[a-z0-9][a-z0-9-]{0,80}$/;
const AUTO_SNAPSHOT_MS = 10 * 60 * 1000;
const AUTO_SNAPSHOT_KEEP = 40;

class HttpError extends Error {
  constructor(status, message, data) { super(message); this.status = status; this.data = data; }
}

const ensure = (dir) => fs.mkdirSync(dir, { recursive: true });
const readJSON = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
};
function writeAtomic(file, data) {
  // Unique per write, so two processes (the app and a browser tab's server) never share a temp file.
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}
const writeJSON = (file, obj) => writeAtomic(file, JSON.stringify(obj, null, 2));
const checkId = (id) => { if (!ID.test(id || '')) throw new HttpError(400, 'Bad id'); return id; };
const slug = (s) => (s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '').slice(0, 40) || 'untitled';
const uid = () => crypto.randomBytes(4).toString('hex');
const hash = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);
const countWords = (s) => ((s || '').match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []).length;
const today = () => new Date().toLocaleDateString('en-CA');
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

const bookDir = (id) => path.join(ROOT, checkId(id));
const chapterFile = (b, c) => path.join(bookDir(b), 'chapters', `${checkId(c)}.md`);
const summaryFile = (b, c) => path.join(bookDir(b), 'chapters', `${checkId(c)}.summary.json`);
const snapDir = (b, c) => path.join(bookDir(b), 'snapshots', checkId(c));

function loadBook(id) {
  const book = readJSON(path.join(bookDir(id), 'book.json'), null);
  if (!book) throw new HttpError(404, 'Book not found');
  return book;
}
function saveBook(book) {
  book.updated = new Date().toISOString();
  writeJSON(path.join(bookDir(book.id), 'book.json'), book);
}

function listBooks() {
  ensure(ROOT);
  return fs.readdirSync(ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && ID.test(d.name))
    .map((d) => readJSON(path.join(ROOT, d.name, 'book.json'), null))
    .filter(Boolean)
    .map((b) => ({
      id: b.id, title: b.title, author: b.author, updated: b.updated,
      chapters: b.chapters.length, words: b.chapters.reduce((n, c) => n + (c.words || 0), 0),
    }))
    .sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));
}

function createBook(fields = {}) {
  const title = (fields.title || 'Untitled').trim();
  const id = `${slug(title)}-${uid()}`;
  ensure(path.join(bookDir(id), 'chapters'));
  const book = {
    id, title,
    author: fields.author || '', form: fields.form || '', pov: fields.pov || '',
    premise: fields.premise || '', style: fields.style || '',
    goal: 500, chapters: [], created: new Date().toISOString(),
  };
  saveBook(book);
  writeJSON(path.join(bookDir(id), 'bible.json'), []);
  addChapter(id, { title: 'Chapter 1' });
  return getBook(id);
}

function getBook(id) {
  const book = loadBook(id);
  const total = book.chapters.reduce((n, c) => n + (c.words || 0), 0);
  const day = readJSON(path.join(bookDir(id), 'progress.json'), {})[today()];
  return {
    ...book,
    chapters: book.chapters.map((c) => {
      const s = readSummary(id, c.id);
      return { ...c, logline: s ? logline(s.text) : '', summaryFresh: !!s && s.hash === c.hash };
    }),
    words: total,
    todayWords: day ? Math.max(0, total - day.start) : 0,
    bible: getBible(id),
  };
}

const BOOK_FIELDS = ['title', 'author', 'form', 'pov', 'premise', 'style', 'goal'];
function updateBook(id, patch) {
  const book = loadBook(id);
  const before = book.title;
  for (const k of BOOK_FIELDS) if (k in patch) book[k] = k === 'goal' ? Math.max(0, Number(patch[k]) || 0) : String(patch[k]);
  if (!book.title.trim()) book.title = before || 'Untitled';   // a book always has a name
  if (Array.isArray(patch.order)) {
    const byId = new Map(book.chapters.map((c) => [c.id, c]));
    const next = patch.order.map((cid) => byId.get(cid)).filter(Boolean);
    if (next.length === book.chapters.length && new Set(patch.order).size === next.length) book.chapters = next;
  }
  saveBook(book);
  return getBook(id);
}

function addChapter(bookId, { title, afterId, text = '' } = {}) {
  const book = loadBook(bookId);
  const ch = { id: `ch-${uid()}`, title: title || `Chapter ${book.chapters.length + 1}`, words: countWords(text), hash: hash(text) };
  const at = afterId ? book.chapters.findIndex((c) => c.id === afterId) + 1 : book.chapters.length;
  book.chapters.splice(at || book.chapters.length, 0, ch);
  ensure(path.join(bookDir(bookId), 'chapters'));
  writeAtomic(chapterFile(bookId, ch.id), text);
  saveBook(book);
  return ch;
}

function readChapter(bookId, cid) {
  try { return fs.readFileSync(chapterFile(bookId, cid), 'utf8'); } catch { return ''; }
}

function trackProgress(bookId, before, after) {
  const file = path.join(bookDir(bookId), 'progress.json');
  const p = readJSON(file, {});
  const d = today();
  if (!p[d]) p[d] = { start: before };
  p[d].end = after;
  writeJSON(file, p);
  return Math.max(0, after - p[d].start);
}

// baseHash is the hash of the text the writer started from. If the file has changed since
// (another window, or an edit made outside the app), the write is refused with 409 rather
// than silently replacing it. force overwrites anyway, keeping the other text as a version.
function writeChapter(bookId, cid, { text, title, baseHash, force }) {
  const book = loadBook(bookId);
  const ch = book.chapters.find((c) => c.id === cid);
  if (!ch) throw new HttpError(404, 'Chapter not found');
  const before = book.chapters.reduce((n, c) => n + (c.words || 0), 0);
  if (typeof text === 'string') {
    const old = readChapter(bookId, cid);
    if (old !== text) {
      const current = hash(old);
      if (typeof baseHash === 'string' && baseHash !== current) {
        if (!force) throw new HttpError(409, 'This chapter was changed somewhere else since you opened it.', { hash: current });
        snapshot(bookId, cid, 'overwritten', old);
      } else if (countWords(old) >= 30 && text.length < old.length / 2) {
        // Most of the chapter is about to disappear (a slip of select-all, say): always keep what was there,
        // without waiting for the ten-minute rhythm of automatic versions.
        snapshot(bookId, cid, 'before large cut', old);
      } else autoSnapshot(bookId, cid, old);
      writeAtomic(chapterFile(bookId, cid), text);
      ch.words = countWords(text);
      ch.hash = hash(text);
    }
  }
  if (typeof title === 'string') ch.title = title.trim() || ch.title;
  saveBook(book);
  const after = book.chapters.reduce((n, c) => n + (c.words || 0), 0);
  return { words: ch.words, total: after, todayWords: trackProgress(bookId, before, after), title: ch.title, hash: hash(readChapter(bookId, cid)) };
}

function deleteChapter(bookId, cid) {
  const book = loadBook(bookId);
  const i = book.chapters.findIndex((c) => c.id === cid);
  if (i < 0) throw new HttpError(404, 'Chapter not found');
  // Nothing is destroyed: the text and its earlier versions move to the book's trash folder.
  const trash = path.join(bookDir(bookId), 'trash');
  ensure(trash);
  const name = `${stamp()}-${slug(book.chapters[i].title)}`;
  try { fs.renameSync(chapterFile(bookId, cid), path.join(trash, `${name}.md`)); } catch { /* already gone */ }
  try { fs.renameSync(snapDir(bookId, cid), path.join(trash, `${name}.versions`)); } catch { /* it had none */ }
  try { fs.rmSync(summaryFile(bookId, cid)); } catch { /* none */ }
  const removed = book.chapters[i].words || 0;
  book.chapters.splice(i, 1);
  saveBook(book);
  // Removing a chapter is not "writing minus N words": move today's starting line down with it.
  const file = path.join(bookDir(bookId), 'progress.json');
  const p = readJSON(file, {});
  const d = today();
  if (p[d]) {
    p[d].start = Math.max(0, p[d].start - removed);
    p[d].end = book.chapters.reduce((n, c) => n + (c.words || 0), 0);
    writeJSON(file, p);
  }
}

// Find a phrase in every chapter. Case-insensitive; straight quotes also match curly ones.
function search(bookId, query, limit = 300) {
  const q = String(query || '').trim();
  if (q.length < 2) return { total: 0, results: [] };
  const re = searchPattern(q);
  const book = loadBook(bookId);
  const results = [];
  let total = 0;
  book.chapters.forEach((c, i) => {
    const text = readChapter(bookId, c.id);
    const matches = [];
    let m;
    while ((m = re.exec(text))) {
      total++;
      if (total <= limit) {
        const end = m.index + m[0].length;
        matches.push({
          start: m.index, end, match: m[0],
          before: text.slice(Math.max(0, m.index - 40), m.index).replace(/\s+/g, ' '),
          after: text.slice(end, end + 60).replace(/\s+/g, ' '),
        });
      }
      if (!m[0].length) re.lastIndex++;
    }
    if (matches.length) results.push({ id: c.id, num: i + 1, title: c.title, matches });
  });
  return { total, results };
}
const searchPattern = (q) => new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  .replace(/['’]/g, "['’]").replace(/["“”]/g, '["“”]').replace(/\s+/g, '\\s+'), 'giu');

// ---- summaries: the model's compact memory of each chapter ----
const logline = (text) => ((text || '').match(/^LOGLINE:\s*(.+)$/m) || [])[1] || '';
const readSummary = (b, c) => readJSON(summaryFile(b, c), null);
const writeSummary = (b, c, text, h) => writeJSON(summaryFile(b, c), { hash: h, text, at: new Date().toISOString() });

// ---- snapshots ----
function snapshot(bookId, cid, label = 'manual', text = readChapter(bookId, cid)) {
  if (!text.trim()) return null;
  const dir = snapDir(bookId, cid);
  ensure(dir);
  const name = `${stamp()}_${slug(label)}.md`;
  writeAtomic(path.join(dir, name), text);
  return name;
}
const snapTime = (name) => name.split('_')[0].replace(/T(\d\d)-(\d\d)-(\d\d)-(\d+)Z/, 'T$1:$2:$3.$4Z');
const snapLabel = (name) => name.replace(/\.md$/, '').split('_')[1] || 'manual';
function snapNames(bookId, cid) {
  try { return fs.readdirSync(snapDir(bookId, cid)).filter((n) => n.endsWith('.md')).sort().reverse(); } catch { return []; }
}
function listSnapshots(bookId, cid) {
  return snapNames(bookId, cid).map((name) => ({
    name, label: snapLabel(name), at: snapTime(name),
    words: countWords(fs.readFileSync(path.join(snapDir(bookId, cid), name), 'utf8')),
  }));
}
function readSnapshot(bookId, cid, name) {
  if (!/^[\w.-]+\.md$/.test(name)) throw new HttpError(400, 'Bad snapshot name');
  return fs.readFileSync(path.join(snapDir(bookId, cid), name), 'utf8');
}
function autoSnapshot(bookId, cid, oldText) {
  if (countWords(oldText) < 30) return;
  const names = snapNames(bookId, cid);
  if (names[0] && Date.now() - new Date(snapTime(names[0])).getTime() < AUTO_SNAPSHOT_MS) return;
  snapshot(bookId, cid, 'auto', oldText);
  const autos = names.filter((n) => snapLabel(n) === 'auto');
  for (const n of autos.slice(AUTO_SNAPSHOT_KEEP - 1)) {
    try { fs.rmSync(path.join(snapDir(bookId, cid), n)); } catch { /* fine */ }
  }
}

// ---- story bible ----
const BIBLE_TYPES = ['character', 'place', 'thread', 'theme', 'note'];
const getBible = (bookId) => readJSON(path.join(bookDir(bookId), 'bible.json'), []);
function saveBible(bookId, entries) {
  if (!Array.isArray(entries)) throw new HttpError(400, 'Bible must be a list');
  const clean = entries.filter((e) => e && String(e.name || '').trim()).map((e) => ({
    id: ID.test(e.id || '') ? e.id : `b-${uid()}`,
    type: BIBLE_TYPES.includes(e.type) ? e.type : 'note',
    name: String(e.name).trim().slice(0, 120),
    aliases: String(e.aliases || '').slice(0, 300),
    body: String(e.body || '').slice(0, 6000),
  }));
  loadBook(bookId);
  writeJSON(path.join(bookDir(bookId), 'bible.json'), clean);
  return clean;
}

// ---- import an existing manuscript, split on chapter headings ----
function importManuscript(bookId, raw) {
  const text = String(raw || '').replace(/\r\n?/g, '\n');
  const heading = /^(?:#{1,2}\s+(.+)|((?:chapter|part|prologue|epilogue)\b[^\n]{0,80}))$/i;
  const parts = [];
  let cur = { title: '', lines: [] };
  for (const line of text.split('\n')) {
    const m = line.trim().match(heading);
    if (m) {
      if (cur.lines.join('').trim() || cur.title) parts.push(cur);
      cur = { title: (m[1] || m[2]).trim(), lines: [] };
    } else cur.lines.push(line);
  }
  if (cur.lines.join('').trim() || cur.title) parts.push(cur);
  if (!parts.length) throw new HttpError(400, 'Nothing to import');

  let book = loadBook(bookId);
  // A brand-new book has one empty chapter; fill it rather than leave it blank at the top.
  const only = book.chapters.length === 1 && !readChapter(bookId, book.chapters[0].id).trim() ? book.chapters[0] : null;
  parts.forEach((p, i) => {
    const body = p.lines.join('\n').trim();
    if (i === 0 && only) writeChapter(bookId, only.id, { text: body, title: p.title || only.title });
    else addChapter(bookId, { title: p.title, text: body });
  });
  // Imported words are not "written today".
  book = loadBook(bookId);
  const total = book.chapters.reduce((n, c) => n + (c.words || 0), 0);
  const file = path.join(bookDir(bookId), 'progress.json');
  const p = readJSON(file, {});
  p[today()] = { start: total, end: total };
  writeJSON(file, p);
  return parts.length;
}

module.exports = {
  HttpError, ROOT, hash, countWords, logline, slug, search, searchPattern,
  AUTO_SNAPSHOT_KEEP,
  listBooks, createBook, getBook, loadBook, updateBook,
  addChapter, readChapter, writeChapter, deleteChapter,
  readSummary, writeSummary,
  snapshot, listSnapshots, readSnapshot,
  getBible, saveBible, importManuscript,
};
