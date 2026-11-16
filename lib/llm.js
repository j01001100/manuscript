'use strict';
// Client for the local model. Anything that speaks the OpenAI chat API works.
const fs = require('fs');
const path = require('path');

const CONFIG_FILE = process.env.MANUSCRIPT_CONFIG || path.join(__dirname, '..', 'config.json');
const DEFAULTS = {
  endpoint: 'http://127.0.0.1:8002/v1',
  model: 'qwen3.8-flash-next',
  apiKey: '',
};
// How long to wait on a silent model before giving up. The first token can be slow
// (a model that was unloaded has to come back into memory); after that, silence means it is stuck.
const TIMEOUT = {
  firstByteMs: Number(process.env.LLM_FIRST_BYTE_MS) || 300000,
  idleMs: Number(process.env.LLM_IDLE_MS) || 90000,
};

function getConfig() {
  try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) }; } catch { return { ...DEFAULTS }; }
}
function setConfig(patch) {
  const cfg = getConfig();
  for (const k of Object.keys(DEFAULTS)) if (typeof patch[k] === 'string') cfg[k] = patch[k].trim();
  cfg.endpoint = cfg.endpoint.replace(/\/+$/, '');
  // The file can hold an API key: readable by you only.
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.chmodSync(CONFIG_FILE, 0o600);
  return cfg;
}
const headers = (cfg) => ({
  'Content-Type': 'application/json',
  ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
});

async function health() {
  const cfg = getConfig();
  try {
    const r = await fetch(`${cfg.endpoint}/models`, { headers: headers(cfg), signal: AbortSignal.timeout(4000) });
    if (!r.ok) return { ok: false, error: `Model server answered ${r.status}`, endpoint: cfg.endpoint, model: cfg.model };
    const ids = ((await r.json()).data || []).map((m) => m.id);
    return { ok: ids.includes(cfg.model), models: ids, endpoint: cfg.endpoint, model: cfg.model,
      error: ids.includes(cfg.model) ? undefined : `"${cfg.model}" is not being served there` };
  } catch (e) {
    return { ok: false, error: `No model server at ${cfg.endpoint}`, endpoint: cfg.endpoint, model: cfg.model };
  }
}

// reasoning_effort and response_format are extensions some servers reject outright.
// What a server refuses is remembered, so only the first request pays for finding out.
const unsupported = new Map();   // "endpoint|model" -> Set of parameter names
const quirks = (cfg) => {
  const key = `${cfg.endpoint}|${cfg.model}`;
  if (!unsupported.has(key)) unsupported.set(key, new Set());
  return unsupported.get(key);
};
const OPTIONAL = ['reasoning_effort', 'response_format', 'stream_options'];

function body(cfg, { messages, effort = 'low', maxTokens = 1200, temperature = 0.7, json = false, stream }) {
  const skip = quirks(cfg);
  const thinks = effort !== 'none' || skip.has('reasoning_effort');
  const b = {
    model: cfg.model, messages, temperature, stream,
    // Thinking tokens come out of the same allowance, so leave room for them.
    max_tokens: maxTokens + (!thinks ? 0 : effort === 'medium' ? 4000 : 1500),
  };
  if (!skip.has('reasoning_effort')) b.reasoning_effort = effort;
  if (json && !skip.has('response_format')) b.response_format = { type: 'json_object' };
  if (stream && !skip.has('stream_options')) b.stream_options = { include_usage: true };
  return b;
}

async function errorText(r) {
  const text = await r.text().catch(() => '');
  try { const j = JSON.parse(text); return String(j.error?.message || j.error || j.detail || text).slice(0, 400); } catch { return text.slice(0, 400); }
}

// POST the request; if the server rejects an optional parameter, drop it and try again.
async function post(opts, stream, signal) {
  const cfg = getConfig();
  for (let attempt = 0; ; attempt++) {
    const sent = body(cfg, { ...opts, stream });
    const r = await fetch(`${cfg.endpoint}/chat/completions`, {
      method: 'POST', headers: headers(cfg), body: JSON.stringify(sent), signal,
    });
    if (r.ok) return r;
    const msg = await errorText(r);
    const present = OPTIONAL.filter((k) => k in sent);
    if ((r.status === 400 || r.status === 422) && present.length && attempt < 3) {
      const named = present.filter((k) => msg.includes(k));
      for (const k of named.length ? named : present) quirks(cfg).add(k);
      continue;
    }
    throw new Error(`Model error ${r.status}: ${msg}`);
  }
}

// Abort when the caller does, or when the model goes quiet for too long.
function watchdog(signal) {
  const ac = new AbortController();
  let timer;
  let stalled = false;
  const onAbort = () => ac.abort();
  if (signal) { if (signal.aborted) ac.abort(); else signal.addEventListener('abort', onAbort, { once: true }); }
  return {
    signal: ac.signal,
    get stalled() { return stalled; },
    arm(ms) { clearTimeout(timer); timer = setTimeout(() => { stalled = true; ac.abort(); }, ms); },
    stop() { clearTimeout(timer); if (signal) signal.removeEventListener('abort', onAbort); },
  };
}
const stallError = (ms) => new Error(`The model went quiet for ${Math.round(ms / 1000)} seconds, so I stopped waiting. Check that it is still running, then try again.`);

// Yields { type: 'thinking' } | { type: 'delta', text } | { type: 'usage', usage }
async function* stream(opts, signal) {
  const dog = watchdog(signal);
  let waitedFor = TIMEOUT.firstByteMs;
  try {
    dog.arm(TIMEOUT.firstByteMs);
    const r = await post(opts, true, dog.signal);
    const dec = new TextDecoder();
    let buf = '';
    for await (const chunk of r.body) {
      waitedFor = TIMEOUT.idleMs;
      dog.arm(TIMEOUT.idleMs);
      buf += dec.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') return;
        let j;
        try { j = JSON.parse(data); } catch { continue; }
        if (j.error) throw new Error(j.error.message || String(j.error));
        const d = j.choices?.[0]?.delta;
        if (d?.content) yield { type: 'delta', text: d.content };
        else if (d?.reasoning_content || d?.reasoning) yield { type: 'thinking' };
        if (j.usage) yield { type: 'usage', usage: j.usage };
      }
    }
  } catch (e) {
    if (dog.stalled) throw stallError(waitedFor);
    throw e;
  } finally {
    dog.stop();
  }
}

async function complete(opts, signal) {
  const dog = watchdog(signal);
  try {
    dog.arm(TIMEOUT.firstByteMs);
    const r = await post(opts, false, dog.signal);
    const j = await r.json();
    return (j.choices?.[0]?.message?.content || '').trim();
  } catch (e) {
    if (dog.stalled) throw stallError(TIMEOUT.firstByteMs);
    throw e;
  } finally {
    dog.stop();
  }
}

module.exports = { getConfig, setConfig, health, stream, complete, TIMEOUT };
