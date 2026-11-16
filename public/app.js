'use strict';
/* Manuscript: front end. Plain JavaScript, no build step. */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const h = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => Number(n || 0).toLocaleString();
const countWords = (s) => (s.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []).length;
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

const S = {
  book: null, chapterId: null, hash: undefined, dirty: false, conflict: false, saveTimer: null, saving: Promise.resolve(),
  cursorSet: false, chat: [], running: new Map(), note: '', words: 0, wordsStale: true, resize: false,
};
const F = { open: false, matches: [], at: -1 };   // find
const app = $('#app');
const editor = $('#editor');
const titleEl = $('#chapterTitle');
const wrap = $('#pageWrap');

async function api(method, url, body) {
  const r = await fetch(`/api${url}`, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(j.error || `Request failed (${r.status})`);
    e.status = r.status;
    e.data = j;
    throw e;
  }
  return j;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

// ---------- tiny Markdown renderer for the editor's replies ----------
function inline(s) {
  return h(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>');
}
function md(text) {
  const out = [];
  let list = null;
  let para = [];
  let quote = [];
  const flush = () => {
    if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; }
    if (quote.length) { out.push(`<blockquote>${inline(quote.join(' '))}</blockquote>`); quote = []; }
  };
  const endList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  const item = (kind, body) => { flush(); if (list !== kind) { endList(); out.push(`<${kind}>`); list = kind; } out.push(`<li>${inline(body)}</li>`); };
  for (const raw of String(text).replace(/\r/g, '').split('\n')) {
    const line = raw.trim();
    let m;
    if (!line) { flush(); endList(); }
    else if ((m = line.match(/^#{1,4}\s+(.*)$/))) { flush(); endList(); out.push(`<h3>${inline(m[1])}</h3>`); }
    else if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) { flush(); endList(); out.push('<hr>'); }
    else if ((m = line.match(/^[-*•]\s+(.*)$/))) item('ul', m[1]);
    else if ((m = line.match(/^\d+[.)]\s+(.*)$/))) item('ol', m[1]);
    else if ((m = line.match(/^>\s?(.*)$/))) { endList(); if (para.length) flush(); quote.push(m[1]); }
    else { endList(); if (quote.length) flush(); para.push(line); }
  }
  flush(); endList();
  return out.join('');
}

// ---------- word-level diff for revisions ----------
function diffHTML(a, b) {
  const tok = (s) => s.match(/\s+|[\p{L}\p{N}'’]+|[^\s\p{L}\p{N}]/gu) || [];
  const ta = tok(a);
  const tb = tok(b);
  const n = ta.length;
  const m = tb.length;
  if (n * m > 16e6) return null;
  const w = m + 1;
  const dp = new Uint16Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i * w + j] = ta[i] === tb[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
  const ops = [];
  const push = (type, t) => { const last = ops[ops.length - 1]; if (last && last.type === type) last.text += t; else ops.push({ type, text: t }); };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (ta[i] === tb[j]) { push('same', ta[i]); i++; j++; }
    else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) push('del', ta[i++]);
    else push('ins', tb[j++]);
  }
  while (i < n) push('del', ta[i++]);
  while (j < m) push('ins', tb[j++]);
  // A lone space between two changes belongs to the change: show "old phrase → new phrase", not word confetti.
  const merged = [];
  for (let k = 0; k < ops.length; k++) {
    const o = ops[k];
    const prev = merged[merged.length - 1];
    if (o.type === 'same' && /^\s+$/.test(o.text) && !o.text.includes('\n') && prev && prev.type === 'change' && ops[k + 1] && ops[k + 1].type !== 'same') {
      prev.del += o.text; prev.ins += o.text;
    } else if (o.type === 'same') merged.push(o);
    else if (prev && prev.type === 'change') prev[o.type] += o.text;
    else merged.push({ type: 'change', del: o.type === 'del' ? o.text : '', ins: o.type === 'ins' ? o.text : '' });
  }
  return merged.map((o) => (o.type === 'same' ? h(o.text) : `${o.del ? `<del>${h(o.del)}</del>` : ''}${o.ins ? `<ins>${h(o.ins)}</ins>` : ''}`)).join('');
}

// ---------- talking to the model (server-sent events) ----------
async function runAI(key, url, body, on = {}) {
  await save();
  S.running.get(key)?.abort();
  const ac = new AbortController();
  S.running.set(key, ac);
  let text = '';
  try {
    const r = await fetch(`/api/books/${S.book.id}/${url}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chapterId: S.chapterId, ...body }), signal: ac.signal,
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Request failed (${r.status})`);
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let at;
      while ((at = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, at);
        buf = buf.slice(at + 2);
        const ev = (block.match(/^event: (.*)$/m) || [])[1];
        const data = JSON.parse((block.match(/^data: (.*)$/m) || [])[1] || '{}');
        if (ev === 'delta') { text += data.text; on.delta?.(text); }
        else if (ev === 'error') throw new Error(data.message);
        else on[ev]?.(data);
      }
    }
    return text;
  } finally {
    if (S.running.get(key) === ac) S.running.delete(key);
  }
}

function receiptHTML(r, usage) {
  if (!r) return '';
  const rows = r.items.map((i) => `<tr class="${i.recalled ? 'recalled' : ''}"><td>${h(i.label)}</td><td>${h(i.how)}</td><td>${fmt(i.tokens)}</td></tr>`).join('');
  const whole = r.bookTokens > r.tokens * 1.3 ? `, instead of ≈${fmt(r.bookTokens)} for the whole book` : '';
  const cached = usage?.cached ? `<tr><td colspan="3">${fmt(usage.cached)} of those tokens were reused from the model's cache.</td></tr>` : '';
  return `<details class="receipt"><summary>Read ≈${fmt(r.tokens)} tokens${whole}: ${h(r.items.map((i) => i.label).join(', '))} ▾</summary><table>${rows}${cached}</table></details>`;
}

// A result card with a live status line, a Stop button, and a receipt of what was read.
function outBox(el, key) {
  el.innerHTML = '<div class="card"><div class="working"><span>Gathering what I need to read…</span><button class="ghost stop">Stop</button></div><div class="body"></div></div>';
  const card = $('.card', el);
  const working = $('.working', el);
  let receipt = null;
  $('.stop', el).onclick = () => S.running.get(key)?.abort();
  return {
    el, card, body: $('.body', el),
    on: {
      status: (d) => { $('span', working).textContent = d.text; },
      receipt: (d) => { receipt = d; },
    },
    show(html) { $('span', working).textContent = 'Writing…'; this.body.innerHTML = html; },
    finish(usage) { working.remove(); card.insertAdjacentHTML('beforeend', receiptHTML(receipt, usage)); },
    fail(e) {
      if (e.name === 'AbortError') { working.remove(); if (!this.body.innerHTML) el.innerHTML = ''; return; }
      el.innerHTML = `<div class="error">${h(e.message)}</div>`;
    },
  };
}
function actions(card, buttons) {
  const row = document.createElement('div');
  row.className = 'actions';
  for (const [label, fn, cls = 'ghost'] of buttons) {
    const b = document.createElement('button');
    b.className = cls;
    b.textContent = label;
    b.onclick = () => fn(b);
    row.append(b);
  }
  const receipt = $('.receipt', card);
  if (receipt) card.insertBefore(row, receipt); else card.append(row);
}
async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Some web views refuse the clipboard API; the older route still works there.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    if (!ok) return toast('Could not copy');
  }
  toast('Copied');
}

// ---------- the editor ----------
const chapter = () => S.book?.chapters.find((c) => c.id === S.chapterId);
const chapterNum = () => S.book.chapters.findIndex((c) => c.id === S.chapterId) + 1;

// ---- keeping typing cheap in long chapters ----
// Where the browser can size a textarea to its text, it does so natively and no script runs per key.
// Otherwise: grow as needed while typing, and measure properly (a full reflow) only once the keys stop.
const NATIVE_SIZING = !!(window.CSS && CSS.supports && CSS.supports('field-sizing', 'content'));
let sizeTimer;
function autosize() {
  if (NATIVE_SIZING) return;
  const y = wrap.scrollTop;
  editor.style.height = 'auto';
  editor.style.height = `${editor.scrollHeight + 4}px`;
  wrap.scrollTop = y;
}
function autosizeSoon() {
  if (NATIVE_SIZING) return;
  if (editor.scrollHeight > editor.clientHeight) editor.style.height = `${editor.scrollHeight + 4}px`;
  clearTimeout(sizeTimer);
  sizeTimer = setTimeout(autosize, 400);
}

// The chapter's word count is cached; a long chapter is recounted when typing pauses, not on every key.
const LONG_CHAPTER_CHARS = 60000;
let countTimer;
function chapterWords() {
  if (!S.wordsStale) return S.words;
  if (editor.value.length <= LONG_CHAPTER_CHARS) {
    S.words = countWords(editor.value);
    S.wordsStale = false;
  } else {
    clearTimeout(countTimer);
    countTimer = setTimeout(() => { S.words = countWords(editor.value); S.wordsStale = false; setStatus(); }, 350);
  }
  return S.words;
}

// Everything the interface recomputes after a key or a click happens once per frame, not once per event.
let uiQueued = false;
function refreshSoon() {
  if (uiQueued) return;
  uiQueued = true;
  const run = () => {
    uiQueued = false;
    if (S.resize) { S.resize = false; autosizeSoon(); }
    updateSelectionUI();
  };
  if (document.hidden) setTimeout(run, 0); else requestAnimationFrame(run);
}

function setStatus(note) {
  if (note !== undefined) S.note = note;
  if (!S.book || !S.chapterId) return;
  const sel = editor.selectionEnd - editor.selectionStart;
  const parts = [`Chapter ${chapterNum()}`, `${fmt(chapterWords())} words`];
  if (sel > 0 && document.activeElement === editor) parts.push(`${fmt(countWords(editor.value.slice(editor.selectionStart, editor.selectionEnd)))} selected`);
  parts.push(S.conflict ? 'Changed in another window' : S.dirty ? 'Editing…' : S.note || 'Saved');
  $('#status').textContent = parts.join('  ·  ');
}

function onEdit() {
  S.dirty = true;
  S.wordsStale = true;
  S.resize = true;
  S.note = '';
  refreshSoon();
  if (F.open) findSoon();
  clearTimeout(S.saveTimer);
  S.saveTimer = setTimeout(save, 900);
}

function applySaved(cid, r) {
  if (cid === S.chapterId) S.hash = r.hash;
  const ch = S.book.chapters.find((c) => c.id === cid);
  if (ch) { ch.words = r.words; ch.title = r.title; }
  S.book.words = r.total;
  S.book.todayWords = r.todayWords;
  renderSidebar();
  setStatus('Saved');
}

function save() {
  clearTimeout(S.saveTimer);
  S.saving = S.saving.then(async () => {
    if (!S.dirty || !S.book || !S.chapterId || S.conflict) return;
    const cid = S.chapterId;
    S.dirty = false;
    try {
      // baseHash is the version this window started from; the server refuses the save if the file has moved on.
      applySaved(cid, await api('PUT', `/books/${S.book.id}/chapters/${cid}`, { text: editor.value, title: titleEl.value, baseHash: S.hash }));
    } catch (e) {
      S.dirty = true;
      if (e.status === 409) { S.conflict = true; setStatus(); conflictModal(); } else setStatus(`Not saved: ${e.message}`);
    }
  });
  return S.saving;
}

// Two windows (the app and a browser tab, say) had the same chapter open and both changed it.
// Nothing is lost either way: the version not chosen goes into History.
function conflictModal() {
  const url = `/books/${S.book.id}/chapters/${S.chapterId}`;
  const m = openModal(`<h2>This chapter was changed somewhere else</h2>
    <p class="sub">“${h(chapter().title)}” was saved from another window, or edited outside Manuscript, after you opened it here. Your changes on this screen have not been saved yet. Which version should the chapter be? The other one is kept in History.</p>
    <div class="foot"><button class="ghost" data-theirs>Load the other version</button><button class="primary" data-mine>Keep what is on this screen</button></div>`);
  const done = () => { S.conflict = false; closeModal(); };
  $('[data-mine]', m).onclick = async () => {
    try {
      const r = await api('PUT', url, { text: editor.value, title: titleEl.value, baseHash: S.hash, force: true });
      S.dirty = false;
      done();
      applySaved(S.chapterId, r);
    } catch (e) { toast(e.message); }
  };
  $('[data-theirs]', m).onclick = async () => {
    try {
      await api('POST', `${url}/snapshots`, { label: 'this window', text: editor.value });
      S.dirty = false;
      done();
      await loadChapterText();
      toast('Loaded the other version. Yours is in History.');
    } catch (e) { toast(e.message); }
  };
}

// Put the chapter's text as it is on disk into the editor, keeping the cursor where it was.
async function loadChapterText() {
  const { text, hash } = await api('GET', `/books/${S.book.id}/chapters/${S.chapterId}`);
  if (S.dirty) return false;
  const changed = hash !== S.hash || text !== editor.value;
  if (changed) {
    const at = Math.min(editor.selectionStart, text.length);
    editor.value = text;
    editor.setSelectionRange(at, at);
    S.words = countWords(text);
    S.wordsStale = false;
    $('#marks').innerHTML = '';
    autosize();
    if (F.open) runFind({ scroll: false, search: false });
  }
  S.hash = hash;
  setStatus('Saved');
  return changed;
}

// Coming back to this window: if nothing here is unsaved, quietly pick up what another window did.
async function refreshFromDisk() {
  if (!S.book || !S.chapterId || S.dirty || S.conflict || !$('#modalBack').hidden) return;
  try {
    const book = await api('GET', `/books/${S.book.id}`);
    if (S.dirty || S.conflict || book.id !== S.book.id) return;
    S.book = book;
    if (!chapter()) return openChapter(book.chapters[0].id);   // the open chapter was removed elsewhere
    renderSidebar();
    if (!$('.entry-form')) renderBible();
    if (document.activeElement !== titleEl) titleEl.value = chapter().title;
    if (await loadChapterText()) toast('Updated: this chapter was changed in another window');
  } catch { /* server not reachable right now; the next save will say so */ }
}

// ---- measuring where text sits on the page, using a hidden copy laid out the same way ----
function rangeRects(start, end) {
  const v = editor.value;
  const mirror = document.createElement('div');
  const cs = getComputedStyle(editor);
  Object.assign(mirror.style, {
    position: 'absolute', visibility: 'hidden', left: '-9999px', top: '0', whiteSpace: 'pre-wrap', overflowWrap: 'break-word',
    font: cs.font, lineHeight: cs.lineHeight, letterSpacing: cs.letterSpacing, tabSize: cs.tabSize, width: `${editor.clientWidth}px`,
  });
  const span = document.createElement('span');
  span.textContent = v.slice(start, end) || '​';
  mirror.append(v.slice(0, start), span, v.slice(end, end + 200));
  document.body.append(mirror);
  const base = mirror.getBoundingClientRect();
  const rects = [...span.getClientRects()].map((r) => ({ left: r.left - base.left, top: r.top - base.top, width: r.width, height: r.height }));
  mirror.remove();
  return rects;
}
function scrollToOffset(pos) {
  const top = editor.getBoundingClientRect().top - wrap.getBoundingClientRect().top + wrap.scrollTop;
  const y = (rangeRects(pos, pos)[0] || { top: 0 }).top;
  const to = Math.max(0, top + y - wrap.clientHeight * 0.4);
  // Glide for a short hop; jump when the place is pages away.
  wrap.scrollTo({ top: to, behavior: Math.abs(to - wrap.scrollTop) > wrap.clientHeight * 3 ? 'auto' : 'smooth' });
}
function reveal(start, end) {
  editor.focus({ preventScroll: true });
  editor.setSelectionRange(start, end);
  S.cursorSet = true;
  scrollToOffset(start);
  updateSelectionUI();
}

// ---- find: in this chapter, or across the whole book ----
// The match is drawn behind the text, so it shows while the cursor stays in the Find box.
const findPattern = (q) => new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  .replace(/['’]/g, "['’]").replace(/["“”]/g, '["“”]').replace(/\s+/g, '\\s+'), 'giu');
let findTimer;
let searchTimer;

function openFind() {
  if (!S.book || !$('#modalBack').hidden) return;
  F.open = true;
  $('#findBar').hidden = false;
  const input = $('#findInput');
  const sel = selection();
  if (sel && sel.end - sel.start <= 80 && !editor.value.slice(sel.start, sel.end).includes('\n')) input.value = editor.value.slice(sel.start, sel.end);
  input.focus();
  input.select();
  runFind();
}
function closeFind() {
  if (!F.open) return;
  F.open = false;
  $('#findBar').hidden = true;
  $('#marks').innerHTML = '';
  const m = F.matches[F.at];
  editor.focus({ preventScroll: true });
  if (m) { editor.setSelectionRange(m.start, m.end); S.cursorSet = true; }
  refreshSoon();
}
function runFind({ from, scroll = true, search = true } = {}) {
  const q = $('#findInput').value;
  const prev = F.matches[F.at];
  F.matches = [];
  F.at = -1;
  if (q.trim()) {
    const re = findPattern(q);
    let m;
    while ((m = re.exec(editor.value)) && F.matches.length < 5000) {
      F.matches.push({ start: m.index, end: m.index + m[0].length });
      if (!m[0].length) re.lastIndex++;
    }
  }
  if (F.matches.length) {
    const start = from ?? (prev ? prev.start : editor.selectionStart);
    F.at = Math.max(0, F.matches.findIndex((x) => x.start >= start));
  }
  showMatch(scroll);
  if (search) { clearTimeout(searchTimer); searchTimer = setTimeout(searchBook, 250); }
}
const findSoon = () => { clearTimeout(findTimer); findTimer = setTimeout(() => F.open && runFind({ scroll: false, search: false }), 300); };
function showMatch(scroll = true) {
  const n = F.matches.length;
  $('#findCount').textContent = !$('#findInput').value.trim() ? '' : n ? `${fmt(F.at + 1)} of ${fmt(n)}` : 'Not in this chapter';
  const m = F.matches[F.at];
  $('#marks').innerHTML = m ? rangeRects(m.start, m.end).map((r) => `<i style="left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px"></i>`).join('') : '';
  if (m && scroll) scrollToOffset(m.start);
}
function findStep(dir) {
  if (!F.open) return openFind();
  const n = F.matches.length;
  if (!n) return;
  F.at = (F.at + dir + n) % n;
  showMatch();
}
async function searchBook() {
  const box = $('#findResults');
  const q = $('#findInput').value.trim();
  if (!F.open || !$('#findAll').checked || q.length < 2) { box.hidden = true; return; }
  try {
    await save();
    const r = await api('POST', `/books/${S.book.id}/search`, { q });
    if (q !== $('#findInput').value.trim() || !F.open) return;
    box.hidden = false;
    box.innerHTML = !r.total ? '<p class="hint">Nowhere in this book.</p>'
      : `<p class="hint">${fmt(r.total)} in ${r.results.length} chapter${r.results.length === 1 ? '' : 's'}</p>${r.results.map((c) => `
        <div class="find-ch"><b>${c.num}. ${h(c.title)}</b><small>${fmt(c.matches.length)}</small></div>
        ${c.matches.map((m) => `<button data-ch="${c.id}" data-at="${m.start}">${h(m.before)}<mark>${h(m.match)}</mark>${h(m.after)}</button>`).join('')}`).join('')}`;
  } catch (e) { box.hidden = false; box.innerHTML = `<p class="hint">${h(e.message)}</p>`; }
}

// The real selection, trimmed of surrounding whitespace.
function selection() {
  let { selectionStart: a, selectionEnd: b } = editor;
  const v = editor.value;
  while (a < b && /\s/.test(v[a])) a++;
  while (b > a && /\s/.test(v[b - 1])) b--;
  return b > a ? { start: a, end: b } : null;
}
// The selection, or failing that the paragraph the cursor is in.
function passage() {
  const sel = selection();
  if (sel) return { ...sel, kind: 'selection' };
  if (!S.cursorSet) return null;
  const v = editor.value;
  const at = editor.selectionStart;
  let a = v.lastIndexOf('\n', at - 1) + 1;
  let b = v.indexOf('\n', at);
  if (b < 0) b = v.length;
  while (a < b && /\s/.test(v[a])) a++;
  while (b > a && /\s/.test(v[b - 1])) b--;
  return b > a ? { start: a, end: b, kind: 'paragraph' } : null;
}

const blankFrom = (v, pos) => {
  for (let i = pos; i < v.length; i++) { const c = v.charCodeAt(i); if (c !== 32 && c !== 10 && c !== 13 && c !== 9 && c !== 160) return false; }
  return true;
};

// Refresh the hints that depend on where the cursor is. Only the visible tab is worked out.
function updateSelectionUI() {
  setStatus();
  if (!S.book) return;
  const v = editor.value;
  const tab = $('.tabs .on').dataset.tab;
  if (tab === 'next') {
    const atEnd = !S.cursorSet || blankFrom(v, editor.selectionEnd);
    $('#nextWhere').textContent = !v.trim() ? 'This chapter is empty. Suggestions will pick up from the previous chapter.'
      : atEnd ? 'Suggestions pick up from the end of this chapter.'
      : `Suggestions pick up from your cursor, about ${Math.round((editor.selectionEnd / v.length) * 100)}% of the way through this chapter. Put the cursor at the end to continue the chapter.`;
  } else if (tab === 'revise') {
    const p = passage();
    const ex = $('#reviseExcerpt');
    if (p) {
      const text = v.slice(p.start, p.end);
      $('#reviseWhat').textContent = `${p.kind === 'selection' ? 'Selected passage' : 'Paragraph at your cursor'} · ${fmt(countWords(text))} words`;
      ex.textContent = text.length > 320 ? `${text.slice(0, 320)}…` : text;
      ex.hidden = false;
    } else {
      $('#reviseWhat').textContent = 'Select a passage in the manuscript, or leave the cursor in a paragraph.';
      ex.hidden = true;
    }
  } else if (tab === 'critique') {
    const sel = selection();
    const n = sel ? countWords(v.slice(sel.start, sel.end)) : 0;
    $('#critiqueScope').textContent = n >= 30 ? `the ${fmt(n)} selected words` : 'the whole chapter';
  }
}

function insertText(start, end, text) {
  editor.focus({ preventScroll: true });
  editor.setSelectionRange(start, end);
  // execCommand keeps the change on the undo stack, so Cmd+Z works.
  if (!document.execCommand('insertText', false, text)) editor.setRangeText(text, start, end, 'end');
  onEdit();
}

// ---------- sidebar ----------
function renderSidebar() {
  const b = S.book;
  $('#bookTitle').textContent = b.title;
  document.title = `${b.title} · Manuscript`;
  $('#bookMeta').textContent = `${b.author ? `${b.author} · ` : ''}${fmt(b.words)} words`;
  const goal = b.goal || 0;
  const today = Math.max(0, b.todayWords || 0);
  $('#goalFill').style.width = goal ? `${Math.min(100, (today / goal) * 100)}%` : '0';
  $('#goalText').textContent = goal ? `${fmt(today)} of ${fmt(goal)} words today` : `${fmt(today)} words today`;
  $('#chapters').innerHTML = b.chapters.map((c, i) => `
    <li data-id="${c.id}" class="${c.id === S.chapterId ? 'on' : ''}" title="${h(c.logline || c.title)}">
      <span class="num">${i + 1}</span><span class="name">${h(c.title)}</span>
      <span class="wc">${c.words ? fmt(c.words) : ''}</span>
      <span class="tools"><button data-act="up" title="Move up">↑</button><button data-act="down" title="Move down">↓</button><button data-act="del" title="Move to trash">✕</button></span>
    </li>`).join('');
}

async function openBook(id) {
  await save();
  S.book = await api('GET', `/books/${id}`);
  S.chapterId = null;
  resetChat();
  store.set('ms.book', id);
  const want = store.get(`ms.ch.${id}`);
  const ch = S.book.chapters.find((c) => c.id === want) || [...S.book.chapters].reverse().find((c) => c.words) || S.book.chapters[0];
  renderBible();
  if (ch) await openChapter(ch.id); else renderSidebar();
}

// A conversation belongs to the chapter it was held in: its questions were answered from that
// chapter's context, so it is not carried into another one.
function resetChat() {
  S.running.get('chat')?.abort();
  S.chat = [];
  $('#chatLog').innerHTML = '<p class="hint">Ask anything about the book: “Has this character\'s age been consistent?”, “What does this chapter still owe the reader?”</p>';
}

async function openChapter(cid) {
  await save();
  if (S.conflict) return;
  const { text, hash } = await api('GET', `/books/${S.book.id}/chapters/${cid}`);
  for (const ac of S.running.values()) ac.abort();
  if (cid !== S.chapterId) resetChat();
  S.chapterId = cid;
  S.hash = hash;
  S.cursorSet = false;
  S.dirty = false;
  S.words = countWords(text);
  S.wordsStale = false;
  $('#marks').innerHTML = '';
  editor.value = text;
  titleEl.value = chapter().title;
  editor.setSelectionRange(text.length, text.length);
  store.set(`ms.ch.${S.book.id}`, cid);
  for (const id of ['nextOut', 'reviseOut', 'critiqueOut', 'continuityOut', 'diagOut', 'bibleProposals']) $(`#${id}`).innerHTML = '';
  renderSidebar();
  autosize();
  wrap.scrollTop = 0;
  setStatus('Saved');
  updateSelectionUI();
  if ($('.tabs .on').dataset.tab === 'check') runDiagnostics();
  if (F.open) runFind({ from: 0, scroll: false, search: false });
}

async function reorder(cid, dir) {
  const ids = S.book.chapters.map((c) => c.id);
  const i = ids.indexOf(cid);
  const j = i + dir;
  if (j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  await save();
  S.book = { ...(await api('PUT', `/books/${S.book.id}`, { order: ids })) };
  renderSidebar();
  setStatus();
}

// ---------- modals ----------
function openModal(html, { wide = false } = {}) {
  const m = $('#modal');
  m.className = `modal${wide ? ' wide' : ''}`;
  m.innerHTML = html;
  $('#modalBack').hidden = false;
  const first = $('input, textarea, button.primary', m);
  if (first) first.focus();
  return m;
}
const closeModal = () => { $('#modalBack').hidden = true; $('#modal').innerHTML = ''; };

function confirmModal(title, text, yes, fn) {
  const m = openModal(`<h2>${h(title)}</h2><p class="sub">${h(text)}</p><div class="foot"><button class="ghost" data-x>Cancel</button><button class="primary" data-ok>${h(yes)}</button></div>`);
  $('[data-x]', m).onclick = closeModal;
  $('[data-ok]', m).onclick = async () => { closeModal(); await fn(); };
}

const BOOK_FORM = (b = {}) => `
  <label>Title</label><input class="field" name="title" value="${h(b.title || '')}" placeholder="Working title">
  <div class="grid2">
    <div><label>Author</label><input class="field" name="author" value="${h(b.author || '')}"></div>
    <div><label>Form <small>novel, memoir, history, essays…</small></label><input class="field" name="form" value="${h(b.form || '')}" placeholder="literary novel"></div>
  </div>
  <label>Point of view and tense</label><input class="field" name="pov" value="${h(b.pov || '')}" placeholder="close third person, past tense">
  <label>What the book is <small>a few sentences; your editor reads this every time</small></label>
  <textarea class="field" name="premise" rows="3" placeholder="What it is about, and what it is really about.">${h(b.premise || '')}</textarea>
  <label>Voice and ambition <small>what you are reaching for, what to protect, what to avoid</small></label>
  <textarea class="field" name="style" rows="3" placeholder="Spare, dry, no interior monologue. Sentences that withhold. Never sentimental.">${h(b.style || '')}</textarea>`;
const formData = (m) => Object.fromEntries($$('[name]', m).map((el) => [el.name, el.value]));

function newBookModal(first) {
  const m = openModal(`<h2>${first ? 'Start your book' : 'New book'}</h2>
    <p class="sub">Only the title is needed now. The rest helps your editor read the way you want to be read, and you can change it any time.</p>
    ${BOOK_FORM()}
    <div class="foot">${first ? '' : '<button class="ghost" data-x>Cancel</button>'}<button class="primary" data-ok>Create book</button></div>`);
  if (!first) $('[data-x]', m).onclick = closeModal;
  $('[data-ok]', m).onclick = async () => {
    const data = formData(m);
    if (!data.title.trim()) return $('[name=title]', m).focus();
    const book = await api('POST', '/books', data);
    closeModal();
    await openBook(book.id);
    editor.focus();
  };
}

function bookModal() {
  const b = S.book;
  const m = openModal(`<h2>Book details</h2><p class="sub">Your editor reads these with every request.</p>
    ${BOOK_FORM(b)}
    <label>Daily word goal</label><input class="field" name="goal" type="number" min="0" step="50" value="${b.goal || 0}" style="width:140px">
    <div class="foot">
      <span class="left">
        <a class="ghost" href="/api/books/${b.id}/export?format=docx" download>Export .docx</a>
        <a class="ghost" href="/api/books/${b.id}/export?format=md" download>Export Markdown</a>
        <button class="ghost" data-import>Import text…</button>
      </span>
      <button class="ghost" data-x>Cancel</button><button class="primary" data-ok>Save</button>
    </div>`);
  $('[data-x]', m).onclick = closeModal;
  $('[data-import]', m).onclick = importModal;
  $$('a.ghost', m).forEach((a) => { a.style.textDecoration = 'none'; a.onclick = () => save(); });
  $('[data-ok]', m).onclick = async () => {
    await save();
    S.book = await api('PUT', `/books/${b.id}`, formData(m));
    closeModal();
    renderSidebar();
  };
}

function importModal() {
  const m = openModal(`<h2>Import a manuscript</h2>
    <p class="sub">Paste text or choose a .txt or .md file. Lines like “Chapter 3” or “# Title” start a new chapter. Imported chapters are added after the ones you have.</p>
    <input type="file" accept=".txt,.md,.markdown,text/plain" class="field">
    <label>Or paste</label><textarea class="field" rows="10" name="text" placeholder="Chapter One&#10;&#10;It began…"></textarea>
    <div class="foot"><button class="ghost" data-x>Cancel</button><button class="primary" data-ok>Import</button></div>`);
  $('[data-x]', m).onclick = closeModal;
  $('input[type=file]', m).onchange = async (e) => { const f = e.target.files[0]; if (f) $('[name=text]', m).value = await f.text(); };
  $('[data-ok]', m).onclick = async () => {
    const text = $('[name=text]', m).value;
    if (!text.trim()) return;
    try {
      await save();
      const r = await api('POST', `/books/${S.book.id}/import`, { text });
      closeModal();
      await openBook(S.book.id);
      toast(`Imported ${r.chapters} chapter${r.chapters === 1 ? '' : 's'}`);
    } catch (e) { toast(e.message); }
  };
}

async function booksModal() {
  const books = await api('GET', '/books');
  const m = openModal(`<h2>Your books</h2><p class="sub">Each book is a folder of plain text files inside this app's “books” folder.</p>
    ${books.map((b) => `<div class="list-item ${b.id === S.book?.id ? 'on' : ''}" data-id="${b.id}"><span><b>${h(b.title)}</b><br><small>${b.author ? `${h(b.author)} · ` : ''}${b.chapters} chapters · ${fmt(b.words)} words</small></span><small>${b.updated ? new Date(b.updated).toLocaleDateString() : ''}</small></div>`).join('')}
    <div class="foot"><button class="ghost" data-x>Close</button><button class="primary" data-new>New book</button></div>`);
  $('[data-x]', m).onclick = closeModal;
  $('[data-new]', m).onclick = () => newBookModal(false);
  $$('.list-item', m).forEach((el) => { el.onclick = async () => { closeModal(); await openBook(el.dataset.id); }; });
}

async function outlineModal() {
  await save();
  const m = openModal('<h2>Outline</h2><p class="sub">What your editor remembers of each chapter. This is what later chapters are checked against, so it is worth a glance.</p><div data-body></div><div class="foot"><span class="left hint inline" data-status></span><button class="ghost" data-x>Close</button><button class="primary" data-ok>Read every chapter that has changed</button></div>', { wide: true });
  $('[data-x]', m).onclick = () => { S.running.get('outline')?.abort(); closeModal(); };
  const load = async () => {
    const rows = await api('GET', `/books/${S.book.id}/outline`);
    $('[data-body]', m).innerHTML = rows.map((c) => `<div class="outline-ch"><h3><span>${c.num}. ${h(c.title)}</span><small>${fmt(c.words)} words</small></h3>
      ${c.summary ? `<pre>${h(c.summary)}</pre>` : `<span class="hint">${c.words ? 'Not read yet.' : 'Empty.'}</span>`}
      ${c.summary && !c.fresh ? '<div class="stale">Changed since this was written.</div>' : ''}</div>`).join('');
  };
  await load();
  $('[data-ok]', m).onclick = async (e) => {
    e.target.disabled = true;
    try {
      await runAI('outline', 'summarize', {}, { status: (d) => { $('[data-status]', m).textContent = d.text; } });
      $('[data-status]', m).textContent = 'Up to date.';
      await load();
      S.book = await api('GET', `/books/${S.book.id}`);
      renderSidebar();
    } catch (err) { if (err.name !== 'AbortError') $('[data-status]', m).textContent = err.message; }
    e.target.disabled = false;
  };
}

async function historyModal() {
  await save();
  const base = `/books/${S.book.id}/chapters/${S.chapterId}/snapshots`;
  const snaps = await api('GET', base);
  const m = openModal(`<h2>History: ${h(chapter().title)}</h2><p class="sub">A version is kept automatically every ten minutes while you write, and before every revision you accept. Restoring keeps your current text as a version too.</p>
    <div class="split"><div class="snaps">${snaps.length ? snaps.map((s) => `<div class="list-item" data-name="${h(s.name)}"><span>${new Date(s.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}<br><small>${h(s.label.replace(/-/g, ' '))} · ${fmt(s.words)} words</small></span></div>`).join('') : '<p class="hint">No earlier versions yet.</p>'}</div>
    <div class="preview" data-preview><span class="hint">Choose a version to read it.</span></div></div>
    <div class="foot"><span class="left"><button class="ghost" data-keep>Keep a version now</button></span><button class="ghost" data-x>Close</button><button class="primary" data-ok disabled>Restore this version</button></div>`, { wide: true });
  let chosen = null;
  $('[data-x]', m).onclick = closeModal;
  $('[data-keep]', m).onclick = async () => { await api('POST', base, { label: 'kept' }); historyModal(); };
  $$('.list-item', m).forEach((el) => {
    el.onclick = async () => {
      $$('.list-item', m).forEach((x) => x.classList.toggle('on', x === el));
      chosen = (await api('GET', `${base}/${encodeURIComponent(el.dataset.name)}`)).text;
      $('[data-preview]', m).textContent = chosen;
      $('[data-ok]', m).disabled = false;
    };
  });
  $('[data-ok]', m).onclick = async () => {
    await api('POST', base, { label: 'before restore' });
    closeModal();
    insertText(0, editor.value.length, chosen);
    await save();
    toast('Restored');
  };
}

async function modelModal() {
  const [cfg, health] = await Promise.all([api('GET', '/config'), api('GET', '/health')]);
  const m = openModal(`<h2>Model</h2><p class="sub">${health.ok ? `Connected to <b>${h(health.model)}</b>.` : h(health.error || 'Not connected.')} Everything runs on this computer; nothing you write leaves it.</p>
    <label>Server address <small>any OpenAI-compatible endpoint</small></label><input class="field" name="endpoint" value="${h(cfg.endpoint)}">
    <label>Model name</label><input class="field" name="model" value="${h(cfg.model)}" list="modelList">
    <datalist id="modelList">${(health.models || []).map((id) => `<option value="${h(id)}">`).join('')}</datalist>
    <label>API key <small>only if your server asks for one</small></label><input class="field" name="apiKey" type="password" value="${h(cfg.apiKey || '')}" autocomplete="off">
    <div class="foot"><button class="ghost" data-x>Cancel</button><button class="primary" data-ok>Save</button></div>`);
  $('[data-x]', m).onclick = closeModal;
  $('[data-ok]', m).onclick = async () => { showHealth(await api('PUT', '/config', formData(m))); closeModal(); };
}

function showHealth(hl) {
  $('#modelDot').className = `dot ${hl.ok ? 'ok' : 'bad'}`;
  $('#modelName').textContent = hl.ok ? hl.model : 'model offline';
  $('#openModel').title = hl.ok ? `${hl.model} at ${hl.endpoint}` : hl.error || 'Model offline';
}
const checkHealth = () => api('GET', '/health').then(showHealth).catch(() => showHealth({ ok: false }));

// ---------- Next ----------
async function runNext(task) {
  const out = $('#nextOut');
  const box = outBox(out, 'next');
  const v = editor.value;
  const mid = S.cursorSet && v.slice(editor.selectionEnd).trim();
  const at = mid ? editor.selectionEnd : v.length;
  let usage;
  try {
    const text = await runAI('next', 'ai', { task, steer: $('#nextSteer').value, cursor: mid ? at : undefined }, {
      ...box.on,
      delta: (t) => box.show(task === 'continue' ? `<div class="prose">${h(t)}</div>` : `<div class="md">${md(t)}</div>`),
      done: (u) => { usage = u; },
    });
    box.finish(usage);
    if (task === 'continue') {
      const draft = text.trim();
      actions(box.card, [
        ['Insert into chapter', (btn) => {
          const before = editor.value.slice(0, at);
          const lead = !before || /\s$/.test(before) ? '' : /[.!?…”"’']$/.test(before) && /^[A-Z“"]/.test(draft) && draft.includes('\n') ? '\n\n' : ' ';
          insertText(at, at, lead + draft);
          btn.disabled = true;
          btn.textContent = 'Inserted';
          toast('Inserted. It is a draft: make it yours.');
        }, 'primary'],
        ['Copy', () => copy(draft)],
        ['Another', () => runNext(task)],
      ]);
    } else {
      actions(box.card, [['Other directions', () => runNext(task)], ['Copy', () => copy(text)]]);
    }
  } catch (e) { box.fail(e); }
}

// ---------- Revise ----------
function parseRevised(t) {
  const a = t.indexOf('<revised>');
  let revised = a >= 0 ? t.slice(a + 9) : t;
  let notes = '';
  const b = revised.indexOf('</revised>');
  if (b >= 0) { notes = revised.slice(b + 10); revised = revised.slice(0, b); }
  return { revised: revised.trim(), notes: notes.replace(/<\/?notes>/g, '').trim() };
}

async function runRevise() {
  const p = passage();
  if (!p) return toast('Select a passage first, or click into a paragraph');
  const original = editor.value.slice(p.start, p.end);
  const box = outBox($('#reviseOut'), 'revise');
  let usage;
  try {
    const text = await runAI('revise', 'ai', {
      task: 'revise', selection: { start: p.start, end: p.end },
      mode: $('#reviseModes .on').dataset.mode, instruction: $('#reviseInstruction').value,
    }, { ...box.on, delta: (t) => box.show(`<div class="prose">${h(parseRevised(t).revised)}</div>`), done: (u) => { usage = u; } });
    const { revised, notes } = parseRevised(text);
    if (!revised) throw new Error('The model returned nothing. Try again.');
    const diff = diffHTML(original, revised);
    const before = countWords(original);
    const after = countWords(revised);
    box.body.innerHTML = `
      <div class="seg"><button data-v="diff" class="on">Changes</button><button data-v="clean">Clean</button></div>
      <div class="prose" data-view></div>
      <p class="hint" style="margin:10px 0 0">${fmt(before)} → ${fmt(after)} words${revised === original ? ' · no changes: the model left it alone' : ''}</p>
      ${notes ? `<div class="md" style="margin-top:10px">${md(notes)}</div>` : ''}`;
    const view = $('[data-view]', box.body);
    const show = (v) => {
      $$('.seg button', box.body).forEach((b) => b.classList.toggle('on', b.dataset.v === v));
      if (v === 'diff' && diff) view.innerHTML = diff; else view.textContent = revised;
    };
    $$('.seg button', box.body).forEach((b) => { b.onclick = () => show(b.dataset.v); });
    show('diff');
    box.finish(usage);
    actions(box.card, [
      ['Replace in manuscript', async (btn) => {
        let start = p.start;
        if (editor.value.slice(start, start + original.length) !== original) start = editor.value.indexOf(original);
        if (start < 0) return toast('That passage has changed since. Revise it again.');
        await save();
        await api('POST', `/books/${S.book.id}/chapters/${S.chapterId}/snapshots`, { label: 'before revision' });
        insertText(start, start + original.length, revised);
        editor.setSelectionRange(start, start + revised.length);
        btn.disabled = true;
        btn.textContent = 'Replaced';
        toast('Replaced. Cmd+Z undoes it, and History has the earlier version.');
      }, 'primary'],
      ['Copy', () => copy(revised)],
      ['Try again', () => { reveal(p.start, p.end); runRevise(); }],
    ]);
  } catch (e) { box.fail(e); }
}

// ---------- Critique, continuity ----------
async function runReading(key, outEl, body) {
  const box = outBox(outEl, key);
  let usage;
  try {
    const text = await runAI(key, 'ai', body, { ...box.on, delta: (t) => box.show(`<div class="md">${md(t)}</div>`), done: (u) => { usage = u; } });
    box.finish(usage);
    actions(box.card, [['Copy', () => copy(text)]]);
  } catch (e) { box.fail(e); }
}
function runCritique() {
  if (!editor.value.trim()) return toast('Nothing to read yet');
  const sel = selection();
  const useSel = sel && countWords(editor.value.slice(sel.start, sel.end)) >= 30;
  runReading('critique', $('#critiqueOut'), { task: 'critique', lens: $('#critiqueLens .on').dataset.lens, selection: useSel ? sel : undefined });
}

// ---------- Check: diagnostics ----------
function runDiagnostics() {
  const out = $('#diagOut');
  const sel = selection();
  const useSel = sel && countWords(editor.value.slice(sel.start, sel.end)) >= 50;
  const offset = useSel ? sel.start : 0;
  const text = useSel ? editor.value.slice(sel.start, sel.end) : editor.value;
  $('#diagScope').textContent = `Prose diagnostics for ${useSel ? 'the selection' : 'this chapter'}: instant, no model.`;
  if (countWords(text) < 20) { out.innerHTML = '<p class="hint">Write a little more and there will be something to measure.</p>'; return; }
  const d = window.Diagnostics.analyze(text);
  const max = Math.max(...d.lens, 1);
  const per = (n) => (d.words ? ((n / d.words) * 1000).toFixed(1) : '0');
  out.innerHTML = `
    <div class="stats">
      <div class="stat"><b>${fmt(d.words)}</b><span>words · ${d.minutes} min read</span></div>
      <div class="stat"><b>${d.avg.toFixed(1)}</b><span>words per sentence</span></div>
      <div class="stat"><b>±${d.sd.toFixed(1)}</b><span>sentence variety</span></div>
      <div class="stat"><b>${d.dialoguePct}%</b><span>in dialogue</span></div>
    </div>
    <div class="rhythm"><div class="rhythm-bars">${d.sents.map((s, i) => `<i data-i="${i}" class="${s.words >= 45 ? 'long' : ''}" style="height:${Math.max(4, (s.words / max) * 100)}%" title="${s.words} words"></i>`).join('')}</div>
      <p>Rhythm: one bar per sentence, by length. Look for flat stretches. Click a bar to go to the sentence.</p></div>
    ${d.groups.map((g) => (g.items.length ? `<details class="finding"><summary><b>${g.label}</b><span>${g.items.length}${g.per1000 ? ` · ${per(g.items.length)} per 1,000` : ''}</span></summary>
      <p class="note">${g.note}</p><div class="hits">${g.items.slice(0, 80).map((it, i) => `<button data-g="${g.key}" data-i="${i}">${h(it.text)}</button>`).join('')}</div></details>`
    : `<div class="finding none"><summary><b>${g.label}</b><span>none</span></summary></div>`)).join('')}
    ${d.top.length ? `<p class="topwords"><b>Words you lean on:</b> ${d.top.map(([w, c]) => `${h(w)} ×${c}`).join(' · ')}</p>` : ''}`;
  out.onclick = (e) => {
    const bar = e.target.closest('.rhythm-bars i');
    const hit = e.target.closest('.hits button');
    if (bar) { const s = d.sents[+bar.dataset.i]; reveal(offset + s.start, offset + s.end); }
    if (hit) { const it = d.groups.find((g) => g.key === hit.dataset.g).items[+hit.dataset.i]; reveal(offset + it.start, offset + it.end); }
  };
}

// ---------- Bible ----------
const TYPES = [['character', 'People'], ['place', 'Places'], ['thread', 'Open threads'], ['theme', 'Themes'], ['note', 'Notes']];

async function saveBible(entries) {
  S.book.bible = await api('PUT', `/books/${S.book.id}/bible`, { entries });
  renderBible();
}
function entryForm(e = {}) {
  return `<div class="entry-form" data-id="${h(e.id || '')}">
    <div class="row"><input class="field" name="name" placeholder="Name" value="${h(e.name || '')}" style="flex:1">
      <select class="field" name="type" style="width:auto">${TYPES.map(([t]) => `<option ${t === (e.type || 'character') ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
    <input class="field" name="aliases" placeholder="Also called (comma separated)" value="${h(e.aliases || '')}">
    <textarea class="field" name="body" rows="4" placeholder="What is established: appearance, age, history, what they want, what they know.">${h(e.body || '')}</textarea>
    <div class="row">${e.id ? '<button class="ghost danger" data-del>Delete</button>' : ''}<span class="spacer"></span><button class="ghost" data-cancel>Cancel</button><button class="primary" data-save>Save</button></div>
  </div>`;
}
function renderBible(editing) {
  const list = $('#bibleList');
  const bible = S.book.bible || [];
  let html = editing === 'new' ? entryForm() : '';
  for (const [type, label] of TYPES) {
    const items = bible.filter((e) => e.type === type);
    if (!items.length) continue;
    html += `<div class="bible-group"><h4>${label}</h4>${items.map((e) => (e.id === editing ? entryForm(e)
      : `<div class="entry" data-id="${e.id}"><b>${h(e.name)}</b>${e.aliases ? ` <small>${h(e.aliases)}</small>` : ''}<p>${h(e.body)}</p></div>`)).join('')}</div>`;
  }
  list.innerHTML = html || '<p class="hint" style="margin-top:14px">Nothing here yet. Add entries yourself, or let your editor propose them from the chapter you are in.</p>';
  const form = $('.entry-form', list);
  if (form) {
    $('[name=name]', form).focus();
    $('[data-cancel]', form).onclick = () => renderBible();
    $('[data-save]', form).onclick = () => {
      const data = { ...formData(form), id: form.dataset.id || undefined };
      if (!data.name.trim()) return;
      saveBible(data.id ? bible.map((e) => (e.id === data.id ? data : e)) : [...bible, data]);
    };
    const del = $('[data-del]', form);
    if (del) del.onclick = () => saveBible(bible.filter((e) => e.id !== form.dataset.id));
  }
}

async function runBibleExtract() {
  if (!editor.value.trim()) return toast('Nothing to read yet');
  const out = $('#bibleProposals');
  const box = outBox(out, 'bible');
  try {
    const text = await runAI('bible', 'ai', { task: 'bible' }, { ...box.on, delta: () => box.show('') });
    let entries = [];
    try { entries = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)).entries || []; } catch { throw new Error('The model did not return a usable list. Try again.'); }
    entries = entries.filter((e) => e && e.name && e.body);
    if (!entries.length) { out.innerHTML = '<div class="card hint">Nothing new for the bible in this chapter.</div>'; return; }
    const bible = S.book.bible || [];
    const find = (name) => bible.find((b) => b.name.toLowerCase() === String(name).toLowerCase());
    box.body.innerHTML = entries.map((e, i) => `<label class="proposal"><input type="checkbox" checked data-i="${i}"><span><span class="tag">${find(e.name) ? 'update' : 'new'} ${h(e.type || 'note')}</span><br><b>${h(e.name)}</b>${e.aliases ? ` <small>${h(e.aliases)}</small>` : ''}<p>${h(e.body)}</p></span></label>`).join('');
    box.finish();
    actions(box.card, [
      ['Add checked to bible', async () => {
        const next = bible.map((b) => ({ ...b }));
        for (const cb of $$('input:checked', box.body)) {
          const e = entries[+cb.dataset.i];
          const cur = next.find((b) => b.name.toLowerCase() === String(e.name).toLowerCase());
          if (cur) { cur.body = e.body; if (e.aliases) cur.aliases = e.aliases; } else next.push({ type: e.type, name: e.name, aliases: e.aliases || '', body: e.body });
        }
        await saveBible(next);
        out.innerHTML = '';
        toast('Story bible updated');
      }, 'primary'],
      ['Dismiss', () => { out.innerHTML = ''; }],
    ]);
  } catch (e) { box.fail(e); }
}

// ---------- Ask ----------
async function sendChat() {
  const input = $('#chatInput');
  const q = input.value.trim();
  if (!q || S.running.has('chat')) return;
  input.value = '';
  const log = $('#chatLog');
  if (!S.chat.length) log.innerHTML = '';
  S.chat.push({ role: 'user', content: q });
  log.insertAdjacentHTML('beforeend', `<div class="msg user">${h(q)}</div><div class="msg out"></div>`);
  const slot = log.lastElementChild;
  const box = outBox(slot, 'chat');
  log.scrollTop = log.scrollHeight;
  let usage;
  try {
    const text = await runAI('chat', 'ai', { task: 'chat', messages: S.chat }, {
      ...box.on,
      delta: (t) => { const stick = log.scrollHeight - log.scrollTop - log.clientHeight < 80; box.show(`<div class="md">${md(t)}</div>`); if (stick) log.scrollTop = log.scrollHeight; },
      done: (u) => { usage = u; },
    });
    box.finish(usage);
    S.chat.push({ role: 'assistant', content: text });
  } catch (e) {
    box.fail(e);
    if (e.name !== 'AbortError') S.chat.pop();
  }
}

// ---------- read aloud ----------
function readAloud() {
  const synth = window.speechSynthesis;
  if (!synth) return toast('This browser cannot read aloud');
  if (synth.speaking) { synth.cancel(); $('#readAloud').textContent = 'Read aloud'; return; }
  const sel = selection();
  const text = sel ? editor.value.slice(sel.start, sel.end) : editor.value.slice(S.cursorSet ? editor.selectionStart : 0);
  const paras = text.split(/\n+/).map((p) => p.trim()).filter(Boolean);
  if (!paras.length) return;
  paras.forEach((p, i) => {
    const u = new SpeechSynthesisUtterance(p);
    u.rate = 0.95;
    if (i === paras.length - 1) u.onend = () => { $('#readAloud').textContent = 'Read aloud'; };
    synth.speak(u);
  });
  $('#readAloud').textContent = 'Stop reading';
}

// ---------- wiring ----------
function setTheme(t) {
  document.documentElement.dataset.theme = t;
  store.set('ms.theme', t);
}
function togglePane(which) {
  const wide = which === 'sidebar' ? window.innerWidth > 1100 : window.innerWidth > 760;
  app.classList.toggle(wide ? `no-${which}` : `show-${which}`);
}
function chips(sel) {
  $(sel).onclick = (e) => {
    const b = e.target.closest('button');
    if (b) $$('button', $(sel)).forEach((x) => x.classList.toggle('on', x === b));
  };
}

function bind() {
  editor.addEventListener('input', onEdit);
  titleEl.addEventListener('input', () => { S.dirty = true; setStatus(''); clearTimeout(S.saveTimer); S.saveTimer = setTimeout(save, 900); });
  window.addEventListener('focus', refreshFromDisk);
  titleEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); editor.focus(); } });
  for (const ev of ['keyup', 'mouseup', 'select', 'focus']) editor.addEventListener(ev, () => { S.cursorSet = true; refreshSoon(); });
  window.addEventListener('resize', () => { autosize(); if (F.open) showMatch(false); });
  window.addEventListener('beforeunload', (e) => { if (S.dirty) { save(); e.preventDefault(); } });
  document.addEventListener('visibilitychange', () => { if (document.hidden) save(); });

  document.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key === 's') { e.preventDefault(); save().then(() => { if (!S.conflict) toast('Saved'); }); }
    if (mod && e.key.toLowerCase() === 'f' && !e.altKey) { e.preventDefault(); openFind(); }
    if (mod && e.key.toLowerCase() === 'g') { e.preventDefault(); findStep(e.shiftKey ? -1 : 1); }
    if (e.key === 'Escape') {
      if (!$('#modalBack').hidden) { if ($('[data-x]', $('#modal'))) $('[data-x]', $('#modal')).click(); }
      else if (F.open) closeFind();
      else app.classList.remove('focus');
    }
  });
  $('#modalBack').addEventListener('mousedown', (e) => { if (e.target.id === 'modalBack') $('[data-x]', $('#modal'))?.click(); });

  $('#tabs').onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    $$('#tabs button').forEach((x) => x.classList.toggle('on', x === b));
    $$('.panel').forEach((p) => p.classList.toggle('on', p.dataset.panel === b.dataset.tab));
    if (b.dataset.tab === 'check') runDiagnostics();
    updateSelectionUI();
  };
  chips('#reviseModes');
  chips('#critiqueLens');

  $('#chapters').onclick = (e) => {
    const li = e.target.closest('li');
    if (!li) return;
    const act = e.target.closest('button')?.dataset.act;
    const ch = S.book.chapters.find((c) => c.id === li.dataset.id);
    if (act === 'up') reorder(ch.id, -1);
    else if (act === 'down') reorder(ch.id, 1);
    else if (act === 'del') {
      confirmModal(`Remove “${ch.title}”?`, 'It moves to this book\'s trash folder on disk; nothing is erased.', 'Move to trash', async () => {
        await save();
        await api('DELETE', `/books/${S.book.id}/chapters/${ch.id}`);
        const wasOpen = ch.id === S.chapterId;
        if (wasOpen) { S.chapterId = null; S.dirty = false; }
        S.book = await api('GET', `/books/${S.book.id}`);
        if (!S.book.chapters.length) { await api('POST', `/books/${S.book.id}/chapters`, {}); S.book = await api('GET', `/books/${S.book.id}`); }
        if (wasOpen) await openChapter(S.book.chapters[0].id); else renderSidebar();
      });
    } else if (ch.id !== S.chapterId) openChapter(ch.id);
  };
  $('#addChapter').onclick = async () => {
    await save();
    const ch = await api('POST', `/books/${S.book.id}/chapters`, {});
    S.book = await api('GET', `/books/${S.book.id}`);
    await openChapter(ch.id);
    titleEl.select();
  };

  $('#openFind').onclick = () => (F.open ? closeFind() : openFind());
  $('#findInput').addEventListener('input', () => runFind());
  $('#findInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); findStep(e.shiftKey ? -1 : 1); } });
  $('#findNext').onclick = () => findStep(1);
  $('#findPrev').onclick = () => findStep(-1);
  $('#findClose').onclick = closeFind;
  $('#findAll').onchange = () => { $('#findResults').hidden = true; searchBook(); };
  $('#findResults').onclick = async (e) => {
    const b = e.target.closest('button[data-ch]');
    if (!b) return;
    if (b.dataset.ch !== S.chapterId) await openChapter(b.dataset.ch);
    runFind({ from: Number(b.dataset.at), search: false });
  };

  $('#bookHead').onclick = bookModal;
  $('#openBooks').onclick = booksModal;
  $('#openOutline').onclick = outlineModal;
  $('#openModel').onclick = modelModal;
  $('#openHistory').onclick = historyModal;
  $('#readAloud').onclick = readAloud;
  $('#toggleSidebar').onclick = () => togglePane('sidebar');
  $('#toggleAssistant').onclick = () => togglePane('assistant');
  $('#toggleFocus').onclick = () => { app.classList.toggle('focus'); editor.focus(); };
  $('#toggleTheme').onclick = () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');

  $('#nextSuggest').onclick = () => runNext('next');
  $('#nextDraft').onclick = () => runNext('continue');
  $('#nextSteer').addEventListener('keydown', (e) => { if (e.key === 'Enter') runNext('next'); });
  $('#reviseRun').onclick = runRevise;
  $('#reviseInstruction').addEventListener('keydown', (e) => { if (e.key === 'Enter') runRevise(); });
  $('#critiqueRun').onclick = runCritique;
  $('#diagRun').onclick = runDiagnostics;
  $('#continuityRun').onclick = () => (editor.value.trim() ? runReading('continuity', $('#continuityOut'), { task: 'continuity' }) : toast('Nothing to check yet'));
  $('#bibleExtract').onclick = runBibleExtract;
  $('#bibleAdd').onclick = () => renderBible('new');
  $('#bibleList').onclick = (e) => { const el = e.target.closest('.entry'); if (el) renderBible(el.dataset.id); };
  $('#chatForm').onsubmit = (e) => { e.preventDefault(); sendChat(); };
  $('#chatInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); } });
}

async function init() {
  setTheme(store.get('ms.theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  bind();
  checkHealth();
  setInterval(checkHealth, 30000);
  try {
    const books = await api('GET', '/books');
    if (!books.length) return newBookModal(true);
    const last = store.get('ms.book');
    await openBook((books.find((b) => b.id === last) || books[0]).id);
  } catch (e) {
    toast(e.message);
  }
}
init();
