'use strict';
// The context engine: decides what the model reads for each request.
//
// Everything is budgeted in tokens against the model's context window (lib/window.js), so the
// same rules fit an 8K model and a 128K one, and no request is ever sent that the model cannot hold.
//
// Two shapes of prompt:
//
//   Writing view (Next, Draft, Revise, Critique, Bible). Working in chapter N:
//     the book's brief → a summary of each chapter before N-1 → chapter N-1 in full → chapter N
//   Older summaries shrink to one line only if the window is tight. The model reaches further
//   back only when a name on the page has not been seen since an earlier chapter: the passages
//   where it first and last appeared are pulled in by text search, with no model call.
//
//   Book view (Ask, Continuity). These are questions about the whole book, so when every earlier
//   chapter fits, every earlier chapter is sent in full and nothing has to be guessed. When they do
//   not fit, the summaries stand in, and the model is shown them first and picks which chapters
//   to re-read in full.
//
// Order matters as much as size. Model servers keep a cache of the prompt they last read and
// only process what changed after the first difference. Blocks run from least to most likely
// to change (book → earlier chapters → previous chapter → current chapter → anything specific
// to this one request), so while you write chapter N only the current chapter is re-read; the
// rest comes from the cache. Every writing task sizes the shared blocks identically, so switching
// between tools reuses the cache too. In Ask, anything chosen for a particular question goes with
// that question, not into the shared opening, so follow-up questions do not invalidate it.
const store = require('./store');
const llm = require('./llm');
const P = require('./prompts');
const win = require('./window');

// How each task uses the window.
//   view:  'writing' or 'book' (see above)
//   whole: the task reads the entire current chapter, so it may grow past the shared size
//   share: the fraction of the room left after the answer that this task may fill
const TASKS = {
  next: { view: 'writing' },
  continue: { view: 'writing' },
  revise: { view: 'writing' },
  critique: { view: 'writing', whole: true, share: 0.5 },
  bible: { view: 'writing', whole: true, share: 0.4 },
  chat: { view: 'book', share: 0.85 },
  continuity: { view: 'book', whole: true, share: 0.85 },
};

// Turn a window into token budgets for one request.
//   cap:    the most this prompt may hold (window − answer − safety margin)
//   shared: the size of the blocks every writing task has in common
//   total:  what this task may actually use
function plan(task, window, reserve = 3000) {
  const t = TASKS[task] || TASKS.next;
  const margin = Math.max(768, Math.round(window * 0.03));        // template tokens and estimation error
  const cap = Math.max(1024, window - reserve - margin);
  const shared = Math.min(cap, Math.round(Math.max(Math.min(6000, cap * 0.7), 0.45 * (window - margin - 6000))));
  const extras = Math.min(12000, Math.round(window * 0.08));      // bible, recalled passages, what follows
  const total = Math.min(cap, Math.max(shared + extras, Math.round((t.share || 0) * cap)));
  return { task, window, reserve, margin, cap, shared, total, view: t.view, whole: !!t.whole };
}

const est = (s) => win.tokens(s);
const wc = store.countWords;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordRe = (term, flags = 'u') => new RegExp(`(?<![\\p{L}\\p{N}])${esc(term)}(?![\\p{L}\\p{N}])`, flags);

function wordStarts(text) {
  const out = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(text))) out.push(m.index);
  return out;
}
// Last n words, starting at a paragraph break when one is close.
function tail(text, n) {
  const starts = wordStarts(text);
  if (starts.length <= n) return text.trim();
  let cut = starts[starts.length - n];
  const nl = text.indexOf('\n', cut);
  if (nl >= 0 && nl - cut < 600) cut = nl + 1;
  return text.slice(cut).trim();
}
function head(text, n) {
  const starts = wordStarts(text);
  if (starts.length <= n) return text.trim();
  let cut = starts[n];
  const nl = text.lastIndexOf('\n', cut);
  if (nl >= 0 && cut - nl < 600) cut = nl;
  return text.slice(0, cut).trim();
}

// ---------- chapter summaries (generated once, reused until the chapter changes) ----------
const SHORT_CHAPTER_WORDS = 180;   // below this the text is its own summary
const inflight = new Map();        // one request per chapter version, shared by whoever needs it

async function summaryFor(bookId, ch, text, { emit, signal } = {}) {
  const h = store.hash(text);
  const saved = store.readSummary(bookId, ch.id);
  if (saved && saved.hash === h) return saved.text;
  if (wc(text) < SHORT_CHAPTER_WORDS) {
    const out = `LOGLINE: (a short fragment, given whole)\n${text.trim()}`;
    store.writeSummary(bookId, ch.id, out, h);
    return out;
  }
  if (emit) emit('status', { text: `Reading Chapter ${ch.num} so I can remember it…` });
  const key = `${bookId}/${ch.id}/${h}`;
  if (!inflight.has(key)) {
    // A chapter longer than the model can read is summarised from its opening and its ending.
    const room = Math.max(2000, (await win.current()).tokens - 2500);
    const maxChars = Math.floor(room * 3.6 / win.factor());
    let body = text;
    if (body.length > maxChars) body = `${body.slice(0, maxChars / 2)}\n\n[…]\n\n${body.slice(-maxChars / 2)}`;
    const job = llm.complete({
      messages: [
        { role: 'system', content: P.SUMMARY },
        { role: 'user', content: `Chapter ${ch.num}: ${ch.title}\n\n${body}` },
      ],
      effort: 'none', maxTokens: 450, temperature: 0.2,
    }, signal).then((out) => {
      if (!out) throw new Error(`The model returned nothing for the summary of Chapter ${ch.num}`);
      store.writeSummary(bookId, ch.id, out, h);
      return out;
    }).finally(() => inflight.delete(key));
    inflight.set(key, job);
  }
  return inflight.get(key);
}

// ---------- background summaries ----------
// Summaries used to be written the moment a request needed them, so the first request after
// editing an early chapter sat waiting. Now they are refreshed in the background shortly after
// you stop touching a chapter; a request only waits if it gets there first.
const timers = new Map();
const sweeping = new Set();
let foreground = 0;                 // editor requests in progress; the background yields to them
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms).unref(); });

function scheduleSummaries(bookId, { except, delay = 30000 } = {}) {
  clearTimeout(timers.get(bookId));
  const t = setTimeout(() => {
    timers.delete(bookId);
    sweepSummaries(bookId, except).catch(() => { /* model offline or busy: the next save tries again */ });
  }, delay);
  t.unref();
  timers.set(bookId, t);
}

async function sweepSummaries(bookId, except) {
  if (sweeping.has(bookId)) return;
  sweeping.add(bookId);
  try {
    const book = store.loadBook(bookId);
    for (let i = 0; i < book.chapters.length; i++) {
      const c = { ...book.chapters[i], num: i + 1 };
      if (c.id === except) continue;                 // still being written; its summary would be stale at once
      while (foreground > 0) await sleep(400);
      const text = store.readChapter(bookId, c.id);
      if (text.trim()) await summaryFor(bookId, c, text);
    }
  } finally {
    sweeping.delete(bookId);
  }
}

// Wrap an editor request so background work stays out of its way.
async function asForeground(fn) {
  foreground++;
  try { return await fn(); } finally { foreground--; }
}

// ---------- recall by name: no model call ----------
const COMMON = new Set(`The And But Nor Yet She They You His Her Their Our Your Its Him Them Mrs Sir
Madam Monday Tuesday Wednesday Thursday Friday Saturday Sunday January February March April May June July
August September October November December God Lord Yes Not All One Two Three Chapter Part Then There This
That These Those What When Where Why How Who Well`.split(/\s+/));

// Capitalised words that appear mid-sentence: names of people, places, things.
function properNouns(text) {
  const set = new Set();
  const re = /[\p{Ll},;:]\s+([A-Z][\p{L}]{2,})/gu;
  let m;
  while ((m = re.exec(text))) if (!COMMON.has(m[1])) set.add(m[1]);
  return set;
}

function around(para, term, n) {
  const words = para.split(/\s+/);
  if (words.length <= n) return para.trim();
  const at = Math.max(0, words.findIndex((w) => w.includes(term)));
  const start = Math.max(0, Math.min(words.length - n, at - Math.floor(n / 3)));
  return `${start > 0 ? '… ' : ''}${words.slice(start, start + n).join(' ')}${start + n < words.length ? ' …' : ''}`;
}

// Names in the focus text that the model would otherwise know nothing recent about.
function recallByName({ focus, looseFocus = '', earlier, prevText, bibleNames, skipChapters, maxTerms = 3, words = 160 }) {
  if (!earlier.length || !(focus + looseFocus).trim()) return [];
  const earlierText = earlier.map((c) => c.text).join('\n');
  const terms = [];
  for (const term of properNouns(earlierText)) {
    if (bibleNames.has(term.toLowerCase())) continue;          // the bible entry covers it
    if (wordRe(term).test(prevText)) continue;                 // the previous chapter covers it
    let hit = wordRe(term).test(focus) || wordRe(term).test(looseFocus);
    // A typed question may not capitalise names; accept that unless the word is also an ordinary one.
    if (!hit && looseFocus && wordRe(term, 'iu').test(looseFocus)) hit = !wordRe(term.toLowerCase()).test(earlierText);
    if (hit) terms.push(term);
    if (terms.length >= maxTerms) break;
  }
  const out = [];
  for (const term of terms) {
    const re = wordRe(term);
    const found = [];
    for (const c of earlier) {
      if (skipChapters.has(c.num)) continue;
      for (const para of c.text.split(/\n+/)) if (re.test(para)) found.push({ num: c.num, para });
    }
    if (!found.length) continue;
    const picks = found.length === 1 ? [found[0]] : [found[0], found[found.length - 1]];
    for (const f of picks) {
      out.push({ term, num: f.num, text: around(f.para, term, words), intro: f === found[0] });
    }
  }
  return out;
}

// ---------- story bible: only the entries this passage touches ----------
const fmtEntry = (e) => `- ${e.name} (${e.type}${e.aliases ? `; also called ${e.aliases}` : ''}): ${e.body}`;
const entryNames = (e) => [e.name, ...String(e.aliases || '').split(',')].map((s) => s.trim()).filter((s) => s.length > 1);

// A small bible is sent whole; a larger one sends the open threads and themes, and the people and
// places the passage mentions, up to `cap` tokens. `wantAll` (continuity) sends everything that fits.
function pickBible(bible, zone, wantAll, { cap = 2000, whole = 1200 } = {}) {
  if (!bible.length) return [];
  const all = est(bible.map(fmtEntry).join('\n'));
  if (all <= Math.min(whole, cap) || (wantAll && all <= cap)) return bible;
  const relevant = (e) => wantAll || e.type === 'thread' || e.type === 'theme' || entryNames(e).some((n) => wordRe(n, 'iu').test(zone));
  const picked = [];
  let tokens = 0;
  for (const e of bible.filter(relevant)) {
    tokens += est(fmtEntry(e));
    if (tokens > cap) break;
    picked.push(e);
  }
  return picked;
}

// ---------- model-chosen re-reading, for open questions and continuity ----------
async function route(sums, doing, signal, most = 2) {
  const list = sums.map((s) => `Chapter ${s.num} (${s.title}): ${s.summary}`).join('\n\n');
  try {
    const out = await llm.complete({
      messages: [
        { role: 'system', content: P.router(most) },
        { role: 'user', content: `EARLIER CHAPTERS\n${list}\n\nWHAT THE AUTHOR IS DOING NOW\n${doing}` },
      ],
      effort: 'none', maxTokens: 80, temperature: 0, json: true,
    }, signal);
    const j = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1));   // tolerate a server without JSON mode
    const need = [...new Set((j.need || []).map(Number))].filter((n) => sums.some((s) => s.num === n)).slice(0, most);
    return { need, why: String(j.why || '').slice(0, 140) };
  } catch (e) {
    if (signal?.aborted) throw e;
    return { need: [], why: '' };   // routing is an optimisation; never let it block the request
  }
}

function range(nums) {
  if (!nums.length) return '';
  return nums.length === 1 ? `Chapter ${nums[0]}` : `Chapters ${nums[0]}–${nums[nums.length - 1]}`;
}

// ---------- assemble ----------
const line = (summary) => store.logline(summary) || summary.split('\n')[0];
const fullBlock = (c) => `## Chapter ${c.num}: ${c.title} (full text)\n\n${c.text.trim()}`;
const summaryBlock = (c, detailed) => `## Chapter ${c.num}: ${c.title} (${detailed ? 'summary' : 'one line'})\n${detailed ? c.summary : line(c.summary)}`;

// Cut a text to about `budget` tokens: its opening and its end, with the middle marked as omitted.
function headAndTail(text, budget, { headShare = 0.06 } = {}) {
  const words = wc(text);
  const perWord = Math.max(0.5, est(text) / Math.max(1, words));
  const keep = Math.max(80, Math.floor(budget / perWord) - 20);
  const first = Math.min(400, Math.floor(keep * headShare));
  return { text: `${head(text, first)}\n\n[… the middle is omitted here …]\n\n${tail(text, keep - first)}`, words: keep };
}

// Summaries of earlier chapters within `budget` tokens: the nearest in full, older ones as one line,
// and if even that is too much, the oldest left out with a note saying so.
function fitSummaries(chs, budget) {
  const out = chs.map((c) => ({ c, mode: 'line' }));
  let used = out.reduce((n, o) => n + est(summaryBlock(o.c, false)), 0);
  while (used > budget && out.length && out[0].mode === 'line') used -= est(summaryBlock(out.shift().c, false));
  for (let i = out.length - 1; i >= 0; i--) {
    const more = est(summaryBlock(out[i].c, true)) - est(summaryBlock(out[i].c, false));
    if (used + more > budget) break;
    out[i].mode = 'summary';
    used += more;
  }
  return { items: out, dropped: chs.length - out.length, used };
}

function range(nums) {
  if (!nums.length) return '';
  const sorted = [...nums].sort((a, b) => a - b);
  const contiguous = sorted.every((n, i) => !i || n === sorted[i - 1] + 1);
  if (sorted.length === 1) return `Chapter ${sorted[0]}`;
  return contiguous ? `Chapters ${sorted[0]}–${sorted[sorted.length - 1]}` : `Chapters ${sorted.join(', ')}`;
}

async function build({
  bookId, chapterId, task, passage = '', cursor, query = '', recentQuestions = '', emit, signal,
  window: W, reserve = 3000, historyTokens = 0,
}) {
  if (!W) W = (await win.current()).tokens;
  const pl = plan(task, W, reserve);
  const book = store.loadBook(bookId);
  const bible = store.getBible(bookId);
  const idx = book.chapters.findIndex((c) => c.id === chapterId);
  if (idx < 0) throw new store.HttpError(404, 'Chapter not found');
  const all = book.chapters.map((c, i) => ({ id: c.id, title: c.title, num: i + 1 }));
  const cur = all[idx];
  let curText = store.readChapter(bookId, cur.id);
  let after = '';
  if ((task === 'next' || task === 'continue') && Number.isInteger(cursor) && cursor >= 0 && curText.slice(cursor).trim()) {
    after = curText.slice(cursor);
    curText = curText.slice(0, cursor);
  }
  const before = all.slice(0, idx).map((c) => ({ ...c, text: store.readChapter(bookId, c.id) })).filter((c) => c.text.trim());
  const prev = before.pop() || null;
  const earlier = before;
  // What was read, listed in the order the model reads it.
  const parts = { earlier: [], prev: [], cur: [], ref: [] };
  let receipt = parts.cur;
  const summarise = async (c) => { c.summary = c.summary || await summaryFor(bookId, c, c.text, { emit, signal }); return c; };

  const briefBlock = `# THE BOOK\n${P.brief(book)}`;
  const afterBlock = after ? `# AFTER THE CURSOR (already written; suggestions must be able to lead into this)\n\n${head(after, 250)}` : '';
  const fixed = est(briefBlock) + est(afterBlock) + 40;

  // ---- the current and previous chapter: sized the same way in every task, so their cache is shared ----
  const curHeader = `# CURRENT CHAPTER: Chapter ${cur.num}, "${cur.title}" (in progress)\n\n`;
  const curFull = est(curHeader + (curText.trim() || '(nothing written yet)'));
  const prevHeader = prev ? `# PREVIOUS CHAPTER: Chapter ${prev.num}, "${prev.title}"` : '';
  const prevFull = prev ? est(`${prevHeader} (full text)\n\n${prev.text.trim()}`) : 0;
  const room = Math.max(600, pl.shared - fixed);
  const earlierFloor = Math.min(30 * earlier.length, Math.round(room * 0.25));         // room for one line per earlier chapter
  const prevFloor = prev ? Math.min(prevFull, Math.max(400, Math.round(room * 0.15)))  : 0;
  const curShared = Math.min(curFull, room - earlierFloor - prevFloor);
  const prevSize = prev ? Math.min(prevFull, room - curShared - earlierFloor) : 0;
  // A task that reads the whole chapter may let it grow into the rest of its own budget.
  const curSize = pl.whole ? Math.min(curFull, Math.max(curShared, pl.total - fixed - earlierFloor - prevSize - Math.round(pl.total * 0.1))) : curShared;

  let curBlock;
  if (!curText.trim()) {
    curBlock = `${curHeader}(nothing written yet)`;
    receipt.push({ label: `Chapter ${cur.num}`, how: 'empty so far', tokens: est(curBlock), current: true });
  } else if (curSize >= curFull) {
    curBlock = curHeader + curText.trim();
    receipt.push({ label: `Chapter ${cur.num}`, how: after ? 'up to your cursor' : 'full text', tokens: est(curBlock), current: true });
  } else {
    const cut = headAndTail(curText, curSize - est(curHeader));
    curBlock = curHeader + cut.text;
    receipt.push({ label: `Chapter ${cur.num}`, how: `opening + last ${cut.words.toLocaleString()} words (too long for the window)`, tokens: est(curBlock), current: true });
  }

  receipt = parts.prev;
  let prevBlock = '';
  if (prev) {
    if (prevSize >= prevFull) {
      prevBlock = `${prevHeader} (full text)\n\n${prev.text.trim()}`;
      receipt.push({ label: `Chapter ${prev.num}`, how: 'full text', tokens: est(prevBlock) });
    } else {
      await summarise(prev);
      const top = `${prevHeader} (its summary, then its ending in full)\n\n${prev.summary}\n\n[…]\n\n`;
      const left = prevSize - est(top);
      if (left > 200) {
        const words = Math.max(60, Math.floor(left / Math.max(0.5, est(prev.text) / Math.max(1, wc(prev.text)))) - 10);
        prevBlock = top + tail(prev.text, words);
        receipt.push({ label: `Chapter ${prev.num}`, how: `summary + last ${words.toLocaleString()} words`, tokens: est(prevBlock) });
      } else {
        prevBlock = `${prevHeader} (summary)\n\n${prev.summary}`;
        receipt.push({ label: `Chapter ${prev.num}`, how: 'summary', tokens: est(prevBlock) });
      }
    }
  }

  // ---- earlier chapters ----
  receipt = parts.earlier;
  const inFull = new Set();
  let earlierBlock = '';
  let book_view = false;
  // Worked out from the planned sizes, not the actual blocks, so every writing task gets the same summaries.
  const writingRoom = Math.max(0, room - Math.min(curFull, curShared) - prevSize);
  const renderSummaries = (fit) => fit.items.map((o) => summaryBlock(o.c, o.mode === 'summary')).join('\n\n');
  const noteSummaries = (fit) => {
    const lines = fit.items.filter((o) => o.mode === 'line').map((o) => o.c.num);
    const full = fit.items.filter((o) => o.mode === 'summary').map((o) => o.c.num);
    if (fit.dropped) receipt.push({ label: range(earlier.slice(0, fit.dropped).map((c) => c.num)), how: 'left out: no room in the window', tokens: 0 });
    if (lines.length) receipt.push({ label: range(lines), how: 'one line each', tokens: est(fit.items.filter((o) => o.mode === 'line').map((o) => summaryBlock(o.c, false)).join('\n')) });
    if (full.length) receipt.push({ label: range(full), how: full.length > 1 ? 'summaries' : 'summary', tokens: est(fit.items.filter((o) => o.mode === 'summary').map((o) => o.c.summary).join('\n')) });
  };

  if (earlier.length) {
    const fullCost = earlier.reduce((n, c) => n + est(fullBlock(c)), 0);
    const bookRoom = pl.total - fixed - est(curBlock) - est(prevBlock) - Math.min(Math.round(pl.total * 0.12), 12000) - historyTokens;
    if (pl.view === 'book' && fullCost <= bookRoom) {
      // The whole book so far fits: send it all, and nothing needs choosing.
      book_view = true;
      earlier.forEach((c) => inFull.add(c.num));
      earlierBlock = `# THE BOOK SO FAR\nEvery earlier chapter, in full.\n\n${earlier.map(fullBlock).join('\n\n\n')}`;
      receipt.push({ label: range(earlier.map((c) => c.num)), how: 'full text (the whole book so far fits)', tokens: fullCost });
    } else {
      for (const c of earlier) await summarise(c);
      if (task === 'continuity' && pl.view === 'book') {
        // Not everything fits: summaries for all, then the chapters most worth re-reading in full.
        let fit = fitSummaries(earlier, Math.max(0, bookRoom));
        let spare = Math.max(0, bookRoom) - fit.used;
        const order = [];
        if (spare > 2000) {
          if (emit) emit('status', { text: 'Choosing which earlier chapters to re-read in full…' });
          const { need } = await route(earlier, `Checking Chapter ${cur.num} ("${cur.title}") for continuity errors. It begins:\n${head(curText, 350)}`, signal, 4);
          order.push(...need, ...earlier.map((c) => c.num).reverse());
        }
        for (const n of [...new Set(order)]) {
          const o = fit.items.find((x) => x.c.num === n);
          if (!o) continue;
          const extra = est(fullBlock(o.c)) - est(summaryBlock(o.c, o.mode === 'summary'));
          if (extra > spare) continue;
          o.mode = 'full';
          spare -= extra;
          inFull.add(n);
        }
        earlierBlock = `# THE BOOK SO FAR\nEarlier chapters: some in full, the rest as summaries (you have not seen their full text).\n\n${
          fit.items.map((o) => (o.mode === 'full' ? fullBlock(o.c) : summaryBlock(o.c, o.mode === 'summary'))).join('\n\n')}`;
        const fulls = fit.items.filter((o) => o.mode === 'full');
        if (fulls.length) receipt.push({ label: range(fulls.map((o) => o.c.num)), how: 're-read in full', tokens: est(fulls.map((o) => fullBlock(o.c)).join('\n')), recalled: true });
        fit = { ...fit, items: fit.items.filter((o) => o.mode !== 'full') };
        noteSummaries(fit);
      } else {
        const fit = fitSummaries(earlier, Math.max(earlierFloor, writingRoom));
        earlierBlock = `# THE STORY SO FAR\nSummaries of earlier chapters. You have not been shown their full text.\n\n${
          fit.dropped ? `[Chapters 1–${fit.dropped} are left out for lack of room.]\n\n` : ''}${renderSummaries(fit)}`;
        noteSummaries(fit);
      }
    }
  }

  const stable = [briefBlock, earlierBlock, prevBlock, curBlock, afterBlock].filter(Boolean);
  let used = est(stable.join('\n\n\n'));
  receipt = parts.ref;

  // ---- reference for this request, added only while it fits ----
  const ref = [];
  const attach = [];                     // Ask: material chosen for this question, sent with the question
  const add = (list, text, item, limit = pl.total) => {
    const t = est(text) + 4;
    if (used + t > limit) return false;
    list.push(text);
    used += t;
    if (item) receipt.push(item);
    return true;
  };
  const extrasRoom = Math.max(0, pl.total - used - historyTokens);
  const big = extrasRoom >= 8000;

  const focus = task === 'revise' || (task === 'critique' && passage) ? passage
    : task === 'chat' ? tail(curText, 300)
    : pl.whole ? curText : tail(curText, 500);
  const zone = `${passage}\n${pl.whole ? curText : tail(curText, 1500)}`;
  const bibleCap = Math.max(400, Math.round(extrasRoom * (task === 'continuity' || task === 'bible' ? 0.8 : 0.35)));
  const picked = pickBible(bible, zone, task === 'bible' || task === 'continuity', { cap: bibleCap });
  if (picked.length) {
    const text = picked.map(fmtEntry).join('\n');
    add(ref, `## Story bible\n${text}`, { label: 'Story bible', how: picked.length === bible.length ? `all ${picked.length} entries` : picked.map((e) => e.name).join(', '), tokens: est(text) });
  }

  // If later chapters are already written, a suggestion should not contradict what follows.
  const following = all.slice(idx + 1).map((c) => ({ ...c, text: store.readChapter(bookId, c.id) })).find((c) => c.text.trim());
  if (following && (task === 'next' || task === 'continue' || task === 'chat')) {
    await summarise(following);
    add(ref, `## What follows (Chapter ${following.num} is already written)\n${following.summary}`, { label: `Chapter ${following.num}`, how: 'summary of what follows', tokens: est(following.summary) });
  }

  const recall = (text, loose, list) => {
    const bibleNames = new Set(picked.flatMap(entryNames).map((x) => x.toLowerCase()));
    const passages = recallByName({
      focus: text, looseFocus: loose, earlier, prevText: prev ? prev.text : '', bibleNames, skipChapters: inFull,
      maxTerms: big ? 6 : 3, words: big ? 220 : 160,
    });
    for (const term of new Set(passages.map((x) => x.term))) {
      const ps = passages.filter((x) => x.term === term);
      const body = ps.map((x) => `From Chapter ${x.num} (${x.intro ? 'where' : 'the last time'} "${term}" ${x.intro ? 'first appears' : 'appeared'}):\n${x.text}`).join('\n\n');
      add(list, `## Recalled because the text mentions "${term}"\n\n${body}`, { label: `“${term}”`, how: `passages from ${range([...new Set(ps.map((x) => x.num))])}`, tokens: est(body), recalled: true }, pl.total - historyTokens);
    }
  };
  if (task !== 'chat') recall(focus, '', ref);

  // Ask: what this particular question needs goes with the question.
  if (task === 'chat' && query.trim()) {
    const askZone = `${recentQuestions}\n${query}`;
    const more = pickBible(bible, askZone, false, { cap: Math.round(bibleCap / 2), whole: 0 }).filter((e) => !picked.includes(e));
    if (more.length) add(attach, `## Story bible entries for this question\n${more.map(fmtEntry).join('\n')}`, { label: 'Story bible', how: more.map((e) => e.name).join(', '), tokens: est(more.map(fmtEntry).join('\n')) }, pl.total - historyTokens);
    if (!book_view && earlier.length) {
      const limit = pl.total - historyTokens;
      const most = Math.max(1, Math.min(4, Math.floor((limit - used) / 6000)));
      if (limit - used > 1500) {
        if (emit) emit('status', { text: 'Deciding whether to re-read earlier chapters…' });
        const { need, why } = await route(earlier, `Answering this question from the author, who is working on Chapter ${cur.num}: "${query}"${recentQuestions ? `\n(Earlier in the conversation: ${recentQuestions})` : ''}`, signal, most);
        for (const n of need) {
          const c = earlier.find((e) => e.num === n);
          const left = limit - used - 50;
          if (left < 800) break;
          const body = est(c.text) <= left ? c.text.trim() : headAndTail(c.text, left).text;
          if (add(attach, `## Chapter ${c.num}, "${c.title}", re-read in full for this question\n\n${body}`, { label: `Chapter ${c.num}`, how: `re-read for this question${why ? `: ${why}` : ''}`, tokens: est(body), recalled: true }, limit)) inFull.add(n);
        }
      }
    }
    recall(tail(curText, 300), `${recentQuestions}\n${query}`, attach);
  }

  if (ref.length) stable.push(`# REFERENCE\n\n${ref.join('\n\n')}`);
  const context = stable.join('\n\n\n');
  const attachments = attach.length ? `# REFERENCE FOR THIS QUESTION\n\n${attach.join('\n\n')}` : '';
  // What sending the whole manuscript would have cost, for comparison in the UI.
  const bookTokens = Math.round(book.chapters.reduce((n, c) => n + (c.words || 0), 0) * 1.35 * win.factor());
  return {
    context, attachments, receipt: [...parts.earlier, ...parts.prev, ...parts.cur, ...parts.ref], tokens: est(context) + est(attachments), bookTokens, plan: pl,
    bookView: book_view, hasAfter: !!after, cur, bible,
  };
}

// Summarise every chapter whose text has changed since it was last read.
async function summarizeAll(bookId, { emit, signal }) {
  const book = store.loadBook(bookId);
  let done = 0;
  for (let i = 0; i < book.chapters.length; i++) {
    const c = { ...book.chapters[i], num: i + 1 };
    const text = store.readChapter(bookId, c.id);
    if (!text.trim()) continue;
    await summaryFor(bookId, c, text, { emit, signal });
    done++;
  }
  return done;
}

module.exports = {
  build, plan, summarizeAll, scheduleSummaries, asForeground, est, fmtEntry,
  tail, head, headAndTail, fitSummaries, pickBible, recallByName, properNouns, TASKS,
};
