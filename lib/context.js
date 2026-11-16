'use strict';
// The context engine: decides what the model reads for each request.
//
// The model never gets the whole book. Working in chapter N it reads:
//   - the current chapter and the one before it, in full
//   - a ~200-word summary of each earlier chapter (older ones shrink to one line)
//   - story-bible entries for whatever the passage in front of it mentions
// and it reaches further back only when there is a reason:
//   - a name on the page that has not appeared since an earlier chapter pulls in
//     the passages where it was introduced and last seen (no model call needed)
//   - for open questions and continuity checks, the model is shown the summaries
//     and asked which earlier chapters, if any, it must re-read in full
//
// Blocks are ordered stable-first (book, summaries, previous chapter, current
// chapter, then per-request reference) so the model server's prefix cache is
// reused from one request to the next while you keep writing.
const store = require('./store');
const llm = require('./llm');
const P = require('./prompts');

const BUDGET = {
  prevFullWords: 6000,      // previous chapter is read whole up to this length...
  prevTailWords: 2500,      // ...past it: its summary plus this much of its ending
  curFullWords: 9000,       // current chapter, for writing and revising
  curFullWordsDeep: 30000,  // current chapter, for whole-chapter reads (critique, continuity)
  curTailWords: 6000,
  curHeadWords: 300,
  detailedSummaries: 6,     // this many chapters back keep a full summary; older get one line
  summaryTokens: 6000,
  summaryTokensDeep: 20000,
  bibleWholeTokens: 1200,   // a bible this small is sent whole...
  bibleTokens: 2000,        // ...a larger one sends only the entries the passage touches, up to this
  recallTerms: 3,
  recallWords: 160,
  routedChapterWords: 5000,
};
const WHOLE_CHAPTER_TASKS = new Set(['critique', 'continuity', 'bible']);
const ROUTED_TASKS = new Set(['chat', 'continuity']);

const est = (s) => Math.ceil((s || '').length / 3.8);
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
    let body = text;
    if (body.length > 300000) body = `${body.slice(0, 150000)}\n\n[…]\n\n${body.slice(-150000)}`;
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
function recallByName({ focus, looseFocus = '', earlier, prevText, bibleNames, skipChapters }) {
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
    if (terms.length >= BUDGET.recallTerms) break;
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
      out.push({ term, num: f.num, text: around(f.para, term, BUDGET.recallWords), intro: f === found[0] });
    }
  }
  return out;
}

// ---------- story bible: only the entries this passage touches ----------
const fmtEntry = (e) => `- ${e.name} (${e.type}${e.aliases ? `; also called ${e.aliases}` : ''}): ${e.body}`;
const entryNames = (e) => [e.name, ...String(e.aliases || '').split(',')].map((s) => s.trim()).filter((s) => s.length > 1);

function pickBible(bible, zone, wantAll) {
  if (!bible.length) return [];
  if (wantAll || est(bible.map(fmtEntry).join('\n')) <= BUDGET.bibleWholeTokens) return bible;
  const picked = [];
  let tokens = 0;
  const relevant = (e) => e.type === 'thread' || e.type === 'theme' || entryNames(e).some((n) => wordRe(n, 'iu').test(zone));
  for (const e of bible.filter(relevant)) {
    tokens += est(fmtEntry(e));
    if (tokens > BUDGET.bibleTokens) break;
    picked.push(e);
  }
  return picked;
}

// ---------- model-chosen re-reading, for open questions and continuity ----------
async function route(sums, doing, signal) {
  const list = sums.map((s) => `Chapter ${s.num} (${s.title}): ${s.summary}`).join('\n\n');
  try {
    const out = await llm.complete({
      messages: [
        { role: 'system', content: P.ROUTER },
        { role: 'user', content: `EARLIER CHAPTERS\n${list}\n\nWHAT THE AUTHOR IS DOING NOW\n${doing}` },
      ],
      effort: 'none', maxTokens: 80, temperature: 0, json: true,
    }, signal);
    const j = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1));   // tolerate a server without JSON mode
    const need = [...new Set((j.need || []).map(Number))].filter((n) => sums.some((s) => s.num === n)).slice(0, 2);
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
async function build({ bookId, chapterId, task, passage = '', cursor, query = '', emit, signal }) {
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
  const deep = WHOLE_CHAPTER_TASKS.has(task);
  const receipt = [];
  const blocks = [`# THE BOOK\n${P.brief(book)}`];

  // Earlier chapters: summaries, shrinking to a line each as they recede.
  const sums = [];
  for (const c of earlier) sums.push({ ...c, summary: await summaryFor(bookId, c, c.text, { emit, signal }) });
  if (sums.length) {
    const cap = task === 'continuity' ? BUDGET.summaryTokensDeep : BUDGET.summaryTokens;
    let detailed = task === 'continuity' ? sums.length : Math.min(sums.length, BUDGET.detailedSummaries);
    const render = () => sums.map((s, i) => {
      const full = i >= sums.length - detailed;
      return `## Chapter ${s.num}: ${s.title}\n${full ? s.summary : store.logline(s.summary) || s.summary.split('\n')[0]}`;
    }).join('\n\n');
    let text = render();
    while (est(text) > cap && detailed > 0) { detailed--; text = render(); }
    blocks.push(`# THE STORY SO FAR\nSummaries of earlier chapters. You have not been shown their full text.\n\n${text}`);
    const brief = sums.slice(0, sums.length - detailed).map((s) => s.num);
    const full = sums.slice(sums.length - detailed).map((s) => s.num);
    if (brief.length) receipt.push({ label: range(brief), how: 'one line each', tokens: est(brief.map((n) => store.logline(sums.find((s) => s.num === n).summary)).join('\n')) });
    if (full.length) receipt.push({ label: range(full), how: full.length > 1 ? 'summaries' : 'summary', tokens: est(sums.filter((s) => full.includes(s.num)).map((s) => s.summary).join('\n')) });
  }

  // Previous chapter: whole, or its summary and ending if it is very long.
  if (prev) {
    const w = wc(prev.text);
    let block;
    if (w <= BUDGET.prevFullWords) {
      block = `# PREVIOUS CHAPTER: Chapter ${prev.num}, "${prev.title}" (full text)\n\n${prev.text.trim()}`;
      receipt.push({ label: `Chapter ${prev.num}`, how: 'full text', tokens: est(block) });
    } else {
      const s = await summaryFor(bookId, prev, prev.text, { emit, signal });
      block = `# PREVIOUS CHAPTER: Chapter ${prev.num}, "${prev.title}" (its summary, then its ending in full)\n\n${s}\n\n[…]\n\n${tail(prev.text, BUDGET.prevTailWords)}`;
      receipt.push({ label: `Chapter ${prev.num}`, how: `summary + last ${BUDGET.prevTailWords.toLocaleString()} words`, tokens: est(block) });
    }
    blocks.push(block);
  }

  // Current chapter.
  {
    const w = wc(curText);
    const limit = deep ? BUDGET.curFullWordsDeep : BUDGET.curFullWords;
    let body;
    let how;
    if (!curText.trim()) { body = '(nothing written yet)'; how = 'empty so far'; }
    else if (w <= limit) { body = curText.trim(); how = after ? 'up to your cursor' : 'full text'; }
    else {
      body = `${head(curText, BUDGET.curHeadWords)}\n\n[… the middle of the chapter is omitted here …]\n\n${tail(curText, BUDGET.curTailWords)}`;
      how = `opening + last ${BUDGET.curTailWords.toLocaleString()} words`;
    }
    const block = `# CURRENT CHAPTER: Chapter ${cur.num}, "${cur.title}" (in progress)\n\n${body}`;
    blocks.push(block);
    receipt.push({ label: `Chapter ${cur.num}`, how, tokens: est(block), current: true });
  }
  if (after) blocks.push(`# AFTER THE CURSOR (already written; suggestions must be able to lead into this)\n\n${head(after, 250)}`);

  // ---- per-request reference material ----
  const ref = [];
  const focus = task === 'revise' || (task === 'critique' && passage) ? passage
    : task === 'chat' ? tail(curText, 300)
    : deep ? curText : tail(curText, 500);

  const zone = `${query}\n${passage}\n${deep ? curText : tail(curText, 1500)}`;
  const picked = pickBible(bible, zone, task === 'bible' || task === 'continuity');
  if (picked.length) {
    const text = picked.map(fmtEntry).join('\n');
    ref.push(`## Story bible\n${text}`);
    receipt.push({ label: 'Story bible', how: picked.length === bible.length ? `all ${picked.length} entries` : picked.map((e) => e.name).join(', '), tokens: est(text) });
  }

  const routed = new Set();
  if (ROUTED_TASKS.has(task) && sums.length) {
    if (emit) emit('status', { text: 'Deciding whether to re-read earlier chapters…' });
    const doing = task === 'chat'
      ? `Answering this question from the author, who is working on Chapter ${cur.num}: "${query}"`
      : `Checking Chapter ${cur.num} ("${cur.title}") for continuity errors. It begins:\n${head(curText, 350)}`;
    const { need, why } = await route(sums, doing, signal);
    for (const n of need) {
      const c = earlier.find((e) => e.num === n);
      const w = wc(c.text);
      const body = w <= BUDGET.routedChapterWords ? c.text.trim()
        : `${head(c.text, BUDGET.routedChapterWords / 2)}\n\n[…]\n\n${tail(c.text, BUDGET.routedChapterWords / 2)}`;
      ref.push(`## Chapter ${c.num}, "${c.title}", re-read in full\n\n${body}`);
      receipt.push({ label: `Chapter ${c.num}`, how: `re-read in full${why ? `: ${why}` : ''}`, tokens: est(body), recalled: true });
      routed.add(n);
    }
  }

  const bibleNames = new Set(picked.flatMap(entryNames).map((s) => s.toLowerCase()));
  const passages = recallByName({
    focus, looseFocus: query, earlier, prevText: prev ? prev.text : '', bibleNames, skipChapters: routed,
  });
  if (passages.length) {
    ref.push(`## Passages from earlier chapters, recalled because the current text mentions these names\n\n${
      passages.map((p) => `From Chapter ${p.num} (${p.intro ? 'where' : 'the last time'} "${p.term}" ${p.intro ? 'first appears' : 'appeared'}):\n${p.text}`).join('\n\n')}`);
    for (const term of new Set(passages.map((p) => p.term))) {
      const ps = passages.filter((p) => p.term === term);
      receipt.push({ label: `“${term}”`, how: `passages from ${range([...new Set(ps.map((p) => p.num))])}`, tokens: est(ps.map((p) => p.text).join('\n')), recalled: true });
    }
  }

  // If later chapters are already written, a suggestion should not contradict what follows.
  const following = all.slice(idx + 1).map((c) => ({ ...c, text: store.readChapter(bookId, c.id) })).find((c) => c.text.trim());
  if (following && (task === 'next' || task === 'continue' || task === 'chat')) {
    const s = await summaryFor(bookId, following, following.text, { emit, signal });
    ref.push(`## What follows (Chapter ${following.num} is already written)\n${s}`);
    receipt.push({ label: `Chapter ${following.num}`, how: 'summary of what follows', tokens: est(s) });
  }

  if (ref.length) blocks.push(`# REFERENCE\n\n${ref.join('\n\n')}`);
  const context = blocks.join('\n\n\n');
  // What sending the whole manuscript would have cost, for comparison in the UI.
  const bookTokens = Math.round(book.chapters.reduce((n, c) => n + (c.words || 0), 0) * 1.35);
  return { context, receipt, tokens: est(context), bookTokens, hasAfter: !!after, cur, bible };
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
  build, summarizeAll, scheduleSummaries, asForeground, est, fmtEntry,
  BUDGET, tail, head, pickBible, recallByName, properNouns,
};
