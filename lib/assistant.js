'use strict';
// Runs one editorial task: build the context, send it, stream the answer back.
const store = require('./store');
const llm = require('./llm');
const P = require('./prompts');
const context = require('./context');

const MAX_REVISE_WORDS = 1500;

const run = (args) => context.asForeground(() => runTask(args));

async function runTask({ bookId, body, emit, signal }) {
  const task = body.task;
  if (!P.TASKS[task]) throw new store.HttpError(400, 'Unknown task');
  const chapterText = store.readChapter(bookId, body.chapterId);

  let passage = '';
  const sel = body.selection;
  if (sel && Number.isInteger(sel.start) && Number.isInteger(sel.end) && sel.end > sel.start) {
    passage = chapterText.slice(sel.start, sel.end).trim();
  }
  if (task === 'revise') {
    if (!passage) throw new store.HttpError(400, 'Select the passage you want revised, or put your cursor in a paragraph.');
    if (store.countWords(passage) > MAX_REVISE_WORDS) {
      throw new store.HttpError(400, `That is ${store.countWords(passage).toLocaleString()} words. Revise up to ${MAX_REVISE_WORDS.toLocaleString()} at a time, or use Critique for a longer read.`);
    }
  }

  const history = Array.isArray(body.messages) ? body.messages.slice(-12)
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string') : [];
  const query = task === 'chat' ? (history.filter((m) => m.role === 'user').pop() || {}).content || '' : '';
  if (task === 'chat' && !query.trim()) throw new store.HttpError(400, 'Ask a question first.');

  const ctx = await context.build({
    bookId, chapterId: body.chapterId, task, passage, cursor: body.cursor, query, emit, signal,
  });
  emit('receipt', { items: ctx.receipt, tokens: ctx.tokens, bookTokens: ctx.bookTokens });

  const spec = P.TASKS[task]({
    steerText: body.steer, hasAfter: ctx.hasAfter, passage, mode: body.mode,
    instruction: body.instruction, lens: body.lens,
    existing: ctx.bible.map(context.fmtEntry).join('\n'),
  });

  const messages = [{ role: 'system', content: P.SYSTEM }];
  if (task === 'chat') {
    messages.push(
      { role: 'user', content: `${ctx.context}\n\n\nThe author is working on Chapter ${ctx.cur.num} and will now talk with you about the book. Answer from what you have been shown, and say when you would need to read more.` },
      { role: 'assistant', content: 'Ready.' },
      ...history,
    );
  } else {
    messages.push({ role: 'user', content: `${ctx.context}\n\n\n# YOUR TASK\n${spec.prompt}` });
  }

  emit('status', { text: 'Thinking…' });
  let usage = null;
  for await (const ev of llm.stream({ messages, ...spec }, signal)) {
    if (ev.type === 'delta') emit('delta', { text: ev.text });
    else if (ev.type === 'usage') usage = ev.usage;
  }
  emit('done', usage ? {
    prompt: usage.prompt_tokens, cached: usage.prompt_tokens_details?.cached_tokens || 0, output: usage.completion_tokens,
  } : {});
}

module.exports = { run };
