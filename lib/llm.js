// Provider-agnostic model call over the OpenAI-compatible Chat Completions API.
// Default: Google Gemini free tier (Google account, no card). Works with Cerebras, Groq, OpenRouter, Ollama, OpenAI by changing env vars.
//
//   LLM_API_KEY   (or GEMINI_API_KEY)  required, free at https://aistudio.google.com/apikey
//   LLM_BASE_URL  default https://generativelanguage.googleapis.com/v1beta/openai
//   LLM_MODEL     default gemini-3.8-flash
//   LLM_REASONING default low  (thinking effort on reasoning models: none | minimal | low | medium | high)
//   LLM_FALLBACK_MODELS default gemini-3.5-flash-lite,gemini-3.1-flash-lite  (set empty to disable)

export const config = () => ({
  apiKey: process.env.LLM_API_KEY || process.env.GEMINI_API_KEY || '',
  baseURL: (process.env.LLM_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai').replace(/\/+$/, ''),
  model: process.env.LLM_MODEL || 'gemini-3.8-flash',
  reasoning: process.env.LLM_REASONING || 'low',
  // Comma-separated models to try if the main one is out of quota or unavailable.
  fallbacks: (process.env.LLM_FALLBACK_MODELS ?? defaultFallbacks(process.env.LLM_BASE_URL))
    .split(',').map(m => m.trim()).filter(Boolean)
});

// Sensible backups per provider, so switching LLM_BASE_URL doesn't leave Gemini model names behind.
function defaultFallbacks(baseURL = '') {
  if (!baseURL || /googleapis/.test(baseURL)) return 'gemini-3.5-flash-lite,gemini-3.1-flash-lite';
  if (/models\.github\.ai/.test(baseURL)) return 'openai/gpt-4o-mini,openai/gpt-4.1-nano';
  return '';
}

function toOpenAITool(tool) {
  return { type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.input_schema } };
}

async function post(url, apiKey, body, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST', signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body)
    });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = null; }
    if (!res.ok) { const e = new Error(json?.error?.message || json?.message || `HTTP ${res.status}`); e.status = res.status; throw e; }
    return json;
  } finally { clearTimeout(t); }
}

function parseArgs(raw) {
  if (raw && typeof raw === 'object') return raw;
  const s = String(raw || '').trim();
  try { return JSON.parse(s); } catch {}
  const m = s.match(/\{[\s\S]*\}/);            // model wrapped JSON in prose or fences
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}

const RETRYABLE = new Set([400, 404, 408, 429, 500, 502, 503, 504]);

async function callOnce({ system, messages, tool, cfg, model, timeoutMs }) {
  const body = {
    model,
    messages: [{ role: 'system', content: system }, ...messages],
    tools: [toOpenAITool(tool)],
    tool_choice: { type: 'function', function: { name: tool.name } },
    temperature: 0.8,
    max_tokens: 1500
  };
  // Reasoning models think before answering; a chat reply doesn't need much of that, and it costs seconds.
  if (/gpt-oss|gemini|o\d|qwen/i.test(model) && cfg.reasoning) body.reasoning_effort = cfg.reasoning;

  const url = `${cfg.baseURL}/chat/completions`;
  // Progressively more portable request shapes: some providers/models reject a named
  // tool_choice, reasoning_effort, a non-default temperature, or max_tokens.
  const { reasoning_effort, temperature, max_tokens, ...core } = body;
  const shapes = [
    body,
    { ...core, temperature, max_tokens, tool_choice: 'required' },
    { ...core, tool_choice: 'required' }
  ];
  let out, err;
  for (const shape of shapes) {
    try { out = await post(url, cfg.apiKey, shape, timeoutMs); err = null; break; }
    catch (e) { err = e; if (e.status !== 400 || /(unknown|invalid|unsupported)\s+model|model[^.]{0,40}(not.?found|does not exist|unavailable|not supported)/i.test(e.message)) break; }
  }
  if (err) throw err;

  const msg = out?.choices?.[0]?.message || {};
  const call = (msg.tool_calls || []).find(c => c.function?.name === tool.name) || msg.tool_calls?.[0];
  const input = parseArgs(call ? call.function.arguments : msg.content) || { reply: msg.content };
  return {
    input,
    model: out?.model || model,
    usage: out?.usage ? { input: out.usage.prompt_tokens, output: out.usage.completion_tokens } : undefined
  };
}

/**
 * Ask the model to answer by calling `tool`. Returns { input, model, usage, attempts }.
 * Tries cfg.model, then each fallback model, on quota/availability/bad-model errors.
 * Free tiers have per-model quotas, so a fallback model often still has capacity.
 */
export async function completeWithTool({ system, messages, tool, cfg = config(), budgetMs = 26000 }) {
  if (!cfg.apiKey) { const e = new Error('LLM_API_KEY is not set on the server'); e.status = 503; throw e; }
  const models = [cfg.model, ...(cfg.fallbacks || [])].filter((m, i, a) => m && a.indexOf(m) === i);
  const start = Date.now();
  const attempts = [];
  let lastErr;
  for (const model of models) {
    const left = budgetMs - (Date.now() - start);
    if (left < 3000) break;
    try {
      const r = await callOnce({ system, messages, tool, cfg, model, timeoutMs: Math.min(left, 15000) });
      return { ...r, attempts };
    } catch (e) {
      lastErr = e;
      attempts.push({ model, status: e.status || (e.name === 'AbortError' ? 'timeout' : 'error'), message: String(e.message || '').slice(0, 160) });
      if (e.status === 401 || e.status === 403) break;           // bad key: other models won't help
      if (e.status && !RETRYABLE.has(e.status) && e.name !== 'AbortError') break;
    }
  }
  // GitHub Models: if every configured name was rejected, ask the catalog what this token can use.
  if (/models\.github\.ai/.test(cfg.baseURL) && attempts.length && attempts.every(a => a.status === 400 || a.status === 404)
      && budgetMs - (Date.now() - start) > 5000) {
    const discovered = await discoverGitHubModel(cfg).catch(() => null);
    if (discovered && !models.includes(discovered)) {
      try {
        const r = await callOnce({ system, messages, tool, cfg, model: discovered, timeoutMs: Math.min(budgetMs - (Date.now() - start), 15000) });
        return { ...r, attempts: [...attempts, { model: discovered, status: 'auto-selected', message: 'picked from GitHub catalog' }] };
      } catch (e) { lastErr = e; attempts.push({ model: discovered, status: e.status || 'error', message: String(e.message || '').slice(0, 160) }); }
    }
  }
  const e = new Error(attempts.map(a => `${a.model}: ${a.status} ${a.message}`).join(' | ') || lastErr?.message || 'model call failed');
  e.status = lastErr?.status || 502;
  e.attempts = attempts;
  throw e;
}

// Pick a small, tool-capable chat model from the GitHub Models catalog.
export async function discoverGitHubModel(cfg) {
  const res = await fetch('https://models.github.ai/catalog/models', {
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${cfg.apiKey}` }
  });
  if (!res.ok) return null;
  const list = await res.json();
  const items = (Array.isArray(list) ? list : list?.models || []).filter(m => m && m.id);
  const toolable = items.filter(m => JSON.stringify(m.capabilities || m.supported_input_modalities || '').includes('tool'));
  const pool = toolable.length ? toolable : items;
  const score = m => (/mini/i.test(m.id) ? 3 : /nano/i.test(m.id) ? 2 : 0) + (/^openai\//.test(m.id) ? 2 : 0) + (m.rate_limit_tier === 'low' ? 1 : 0) - (/embed|whisper|tts|image|vision-only/i.test(m.id) ? 10 : 0);
  return pool.sort((a, b) => score(b) - score(a))[0]?.id || null;
}
