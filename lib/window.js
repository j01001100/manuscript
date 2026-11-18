'use strict';
// The context window: how many tokens the model can read and write in one request.
//
// It is asked of the model server, not assumed. Servers report it in different places:
//   - in the model list (/v1/models): Splash, vLLM, SGLang, OpenRouter and others
//   - llama.cpp:  /props
//   - LM Studio:  /api/v0/models/<model>
//   - Ollama:     /api/ps, /api/show
// The answer is re-checked every ten minutes, whenever the model or address changes, and
// whenever the server refuses a prompt for being too long. A size typed into the settings
// wins over all of that.
//
// Token counts are estimated from characters, then corrected against the counts the server
// reports after each request, so budgets track the real tokenizer.
const llm = require('./llm');

const FALLBACK = 8192;             // when the server will not say: small enough to be safe almost anywhere
const OLLAMA_FALLBACK = 4096;      // Ollama's /v1 endpoint ignores the model's full size unless you raise num_ctx
const RECHECK_MS = 10 * 60 * 1000;
const RECHECK_GUESS_MS = 30 * 1000;
const CHARS_PER_TOKEN = 3.8;       // English prose, before correction

const state = { detected: null, learned: null, factor: null, inflight: null };
const keyOf = (cfg) => `${cfg.endpoint}|${cfg.model}`;
const serverRoot = (endpoint) => endpoint.replace(/\/v\d+$/, '');
const positive = (n) => (Number.isFinite(Number(n)) && Number(n) >= 512 ? Math.floor(Number(n)) : 0);

async function getJSON(url, cfg, init = {}) {
  try {
    const r = await fetch(url, { ...init, headers: llm.headers(cfg), signal: AbortSignal.timeout(3000) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

// Find the configured model in an OpenAI-style model list and read its window, if the server put it there.
function fromModelList(list, model) {
  const entries = Array.isArray(list?.data) ? list.data : Array.isArray(list) ? list : [];
  const m = entries.find((e) => e && (e.id === model || e.name === model || e.root === model)) || (entries.length === 1 ? entries[0] : null);
  if (!m) return null;
  for (const k of ['context_length', 'max_model_len', 'context_window', 'loaded_context_length', 'n_ctx', 'max_context_length']) {
    const n = positive(m[k] ?? m.meta?.[k]);
    if (n) return { tokens: n, source: 'reported by the model server' };
  }
  return null;
}

async function detect(cfg = llm.getConfig()) {
  const root = serverRoot(cfg.endpoint);

  const listed = fromModelList(await getJSON(`${cfg.endpoint}/models`, cfg), cfg.model);
  if (listed) return listed;

  const props = await getJSON(`${root}/props`, cfg);   // llama.cpp: the size per request slot
  const nctx = positive(props?.default_generation_settings?.n_ctx ?? props?.n_ctx);
  if (nctx) return { tokens: nctx, source: 'reported by llama.cpp' };

  const lms = await getJSON(`${root}/api/v0/models/${encodeURIComponent(cfg.model)}`, cfg);
  const loaded = positive(lms?.loaded_context_length);
  if (loaded) return { tokens: loaded, source: 'reported by LM Studio (as loaded)' };
  if (positive(lms?.max_context_length)) {
    return { tokens: Math.min(positive(lms.max_context_length), 32768), source: 'LM Studio: model not loaded yet, so a cautious guess', guess: true };
  }

  const ps = await getJSON(`${root}/api/ps`, cfg);
  const running = (ps?.models || []).find((m) => m.name === cfg.model || m.model === cfg.model);
  if (positive(running?.context_length)) return { tokens: positive(running.context_length), source: 'reported by Ollama (as loaded)' };
  const show = await getJSON(`${root}/api/show`, cfg, { method: 'POST', body: JSON.stringify({ model: cfg.model }) });
  if (show) {
    const numCtx = positive((String(show.parameters || '').match(/num_ctx\s+(\d+)/) || [])[1]);
    if (numCtx) return { tokens: numCtx, source: 'Ollama model setting (num_ctx)' };
    return { tokens: OLLAMA_FALLBACK, source: 'Ollama default; raise it with num_ctx or OLLAMA_CONTEXT_LENGTH, then enter it here', guess: true };
  }

  return { tokens: FALLBACK, source: 'not reported by the server, so a cautious guess', guess: true };
}

// The window to plan with right now.
async function current({ refresh = false } = {}) {
  const cfg = llm.getConfig();
  const key = keyOf(cfg);
  const d = state.detected;
  const stale = !d || d.key !== key || Date.now() - d.at > (d.guess ? RECHECK_GUESS_MS : RECHECK_MS);
  if (refresh || stale) {
    if (!state.inflight || state.inflight.key !== key) {
      state.inflight = { key, job: detect(cfg).finally(() => { state.inflight = null; }) };
    }
    const found = await state.inflight.job;
    state.detected = { key, at: Date.now(), ...found };
    if (refresh && state.learned?.key === key) state.learned = null;   // a fresh check starts over
  }
  const det = state.detected;
  const override = positive(cfg.contextWindow);
  let tokens = det.tokens;
  let source = det.source;
  if (override) { tokens = override; source = 'set by you'; }
  if (state.learned?.key === key && state.learned.tokens < tokens) {
    tokens = state.learned.tokens;
    source = 'the server refused a longer prompt, so it is treated as this size';
  }
  return { tokens, source, detected: det.tokens, detectedSource: det.source, guess: !override && !!det.guess, override: override || null };
}

// A refusal like "maximum context length is 32768 tokens" teaches us the real size.
// Returns the size to retry with, or null if the error was about something else.
const OVERFLOW = /context|too long|too many tokens|maximum.{0,30}length|exceed/i;
function learnFromError(err, triedWith) {
  const msg = String(err?.detail || err?.message || '');
  if (![400, 413, 422, 500].includes(err?.status) || !OVERFLOW.test(msg)) return null;
  const said = positive(
    (msg.match(/maximum context length is (\d+)/i) || [])[1]
    || (msg.match(/n_ctx["'\s:=]+(\d+)/i) || [])[1]
    || (msg.match(/context (?:size|length|window)[^\d]{0,40}(\d{3,7})/i) || [])[1],
  );
  const tokens = Math.max(2048, said && said < triedWith ? said : Math.floor(triedWith * 0.75));
  if (tokens >= triedWith) return null;
  state.learned = { key: keyOf(llm.getConfig()), tokens };
  return tokens;
}

// ---- token estimates ----
function factor() {
  const cfg = llm.getConfig();
  const key = keyOf(cfg);
  if (state.factor?.key !== key) state.factor = { key, value: Number(cfg.calibration?.[key]) || 1 };
  return state.factor.value;
}
const rawTokens = (text) => (text || '').length / CHARS_PER_TOKEN;
const tokens = (text) => Math.ceil(rawTokens(text) * factor());

// After each request: compare our estimate for what was sent with the server's count.
function calibrate(promptTokens, messages) {
  const raw = messages.reduce((n, m) => n + rawTokens(m.content) + 6, 0);
  if (!(promptTokens > 400) || raw <= 0) return;
  const ratio = Math.min(2, Math.max(0.5, promptTokens / raw));
  const cfg = llm.getConfig();
  const key = keyOf(cfg);
  const seen = Number(cfg.calibration?.[key]);
  const value = Math.round((seen ? seen * 0.6 + ratio * 0.4 : ratio) * 1000) / 1000;
  state.factor = { key, value };
  llm.remember('calibration', { ...(cfg.calibration || {}), [key]: value });
}

function reset() { state.detected = null; state.learned = null; state.factor = null; state.inflight = null; }

module.exports = { current, detect, learnFromError, tokens, calibrate, factor, reset, fromModelList, FALLBACK };
