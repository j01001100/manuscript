'use strict';
// Runs one editorial task: work out the budget, build the context, send it, stream the answer back.
const store = require('./store');
const llm = require('./llm');
const P = require('./prompts');
const context = require('./context');
const win = require('./window');

// The longest passage Revise takes at once: what the window leaves room to rewrite, up to 3,000 words
// (beyond that a single answer gets slow, and a scene is better revised in parts).
const maxReviseWords = (window) => Math.max(200, Math.min(3000, Math.floor((window * 0.4 - 2000) / 1.15 / 1.35)));

const run = (args) => context.asForeground(() => runTask(args));

async function runTask({ bookId, body, emit, signal }) {
  const task = body.task;
  if (!P.TASKS[task]) throw new store.HttpError(400, 'Unknown task');
  const chapterText = store.readChapter(bookId, body.chapterId);
  let { tokens: window } = await win.current();

  let passage = '';
  const sel = body.selection;
  if (sel && Number.isInteger(sel.start) && Number.isInteger(sel.end) && sel.end > sel.start) {
    passage = chapterText.slice(sel.start, sel.end).trim();
  }
  if (task === 'revise') {
    if (!passage) throw new store.HttpError(400, 'Select the passage you want revised, or put your cursor in a paragraph.');
    const most = maxReviseWords(window);
    if (store.countWords(passage) > most) {
      throw new store.HttpError(400, `That is ${store.countWords(passage).toLocaleString()} words. Revise up to ${most.toLocaleString()} at a time, or use Critique for a longer read.`);
    }
  }

  let history = Array.isArray(body.messages) ? body.messages.slice(-20)
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string') : [];
  const query = task === 'chat' ? (history.filter((m) => m.role === 'user').pop() || {}).content || '' : '';
  if (task === 'chat' && !query.trim()) throw new store.HttpError(400, 'Ask a question first.');

  // At most two tries: the second only if the server says the prompt was longer than it can hold.
  for (let attempt = 0; ; attempt++) {
    const args = {
      steerText: body.steer, passage, mode: body.mode, instruction: body.instruction, lens: body.lens,
      existing: store.getBible(bookId).map(context.fmtEntry).join('\n'),
    };
    let spec = P.TASKS[task]({ ...args, hasAfter: false });
    if (window < 32768 && spec.effort === 'medium') spec = { ...spec, effort: 'low' };   // keep thinking from crowding a small window
    const reserve = llm.allowance(spec, window);

    // A long conversation keeps its latest turns; the oldest go first.
    if (task === 'chat') {
      const keep = Math.round(context.plan(task, window, reserve).cap * 0.25);
      while (history.length > 1 && win.tokens(history.map((m) => m.content).join('\n')) > keep) history = history.slice(2);
    }
    const earlierTurns = history.slice(0, -1);
    const historyTokens = task === 'chat' ? win.tokens(history.map((m) => m.content).join('\n')) + history.length * 6 : 0;
    const recentQuestions = earlierTurns.filter((m) => m.role === 'user').slice(-2).map((m) => m.content).join(' / ');

    const ctx = await context.build({
      bookId, chapterId: body.chapterId, task, passage, cursor: body.cursor, query, recentQuestions,
      emit, signal, window, reserve, historyTokens,
    });
    emit('receipt', { items: ctx.receipt, tokens: ctx.tokens + historyTokens, bookTokens: ctx.bookTokens, window, bookView: ctx.bookView });
    spec = { ...P.TASKS[task]({ ...args, hasAfter: ctx.hasAfter }), effort: spec.effort };

    const messages = [{ role: 'system', content: P.SYSTEM }];
    if (task === 'chat') {
      // The opening holds only what does not depend on the question, so it stays cached across the conversation.
      messages.push(
        { role: 'user', content: `${ctx.context}\n\n\nThe author is working on Chapter ${ctx.cur.num} and will now talk with you about the book. Answer from what you have been shown, and say when you would need to read more.` },
        { role: 'assistant', content: 'Ready.' },
        ...earlierTurns,
        { role: 'user', content: ctx.attachments ? `${ctx.attachments}\n\n\n# THE AUTHOR ASKS\n${query}` : query },
      );
    } else {
      messages.push({ role: 'user', content: `${ctx.context}\n\n\n# YOUR TASK\n${spec.prompt}` });
    }

    // Never ask for more output than the window has left after the prompt.
    const promptTokens = messages.reduce((n, m) => n + win.tokens(m.content) + 6, 0);
    const pl = context.plan(task, window, reserve);
    const maxTotal = Math.max(256, Math.min(reserve, window - promptTokens - Math.round(pl.margin / 2)));

    let usage = null;
    let started = false;
    emit('status', { text: 'Thinking…' });
    try {
      for await (const ev of llm.stream({ messages, ...spec, maxTotal }, signal)) {
        started = true;
        if (ev.type === 'delta') emit('delta', { text: ev.text });
        else if (ev.type === 'usage') usage = ev.usage;
      }
    } catch (e) {
      const smaller = !started && attempt === 0 ? win.learnFromError(e, window) : null;
      if (!smaller) throw e;
      emit('status', { text: `The model can read less than expected (${smaller.toLocaleString()} tokens). Trimming and trying again…` });
      window = smaller;
      continue;
    }
    if (usage?.prompt_tokens) win.calibrate(usage.prompt_tokens, messages);
    emit('done', usage ? {
      prompt: usage.prompt_tokens, cached: usage.prompt_tokens_details?.cached_tokens || 0, output: usage.completion_tokens, window,
    } : { window });
    return;
  }
}

module.exports = { run, maxReviseWords };
