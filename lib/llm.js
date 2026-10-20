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
  fallbacks: (process.env.LLM_FALLBACK_MODELS ?? 'gemini-3.5-flash-lite,gemini-3.1-flash-lite')
    .split(',').map(m => m.trim()).filter(Boolean)
});

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
  let out;
  try { out = await post(url, cfg.apiKey, body, timeoutMs); }
  catch (e) {
    if (e.status !== 400) throw e;
    // Some providers reject a named tool_choice or reasoning_effort: retry with the most portable form.
    const { reasoning_effort, ...rest } = body;
    out = await post(url, cfg.apiKey, { ...rest, tool_choice: 'required' }, timeoutMs);
  }

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
  const e = new Error(attempts.map(a => `${a.model}: ${a.status} ${a.message}`).join(' | ') || lastErr?.message || 'model call failed');
  e.status = lastErr?.status || 502;
  e.attempts = attempts;
  throw e;
}
