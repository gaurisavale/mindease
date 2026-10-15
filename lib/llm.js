// Provider-agnostic model call over the OpenAI-compatible Chat Completions API.
// Default: Google Gemini free tier (Google account, no card). Works with Cerebras, Groq, OpenRouter, Ollama, OpenAI by changing env vars.
//
//   LLM_API_KEY   (or GEMINI_API_KEY)  required, free at https://aistudio.google.com/apikey
//   LLM_BASE_URL  default https://generativelanguage.googleapis.com/v1beta/openai
//   LLM_MODEL     default gemini-3.8-flash

export const config = () => ({
  apiKey: process.env.LLM_API_KEY || process.env.GEMINI_API_KEY || '',
  baseURL: (process.env.LLM_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai').replace(/\/+$/, ''),
  model: process.env.LLM_MODEL || 'gemini-3.8-flash'
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

/**
 * Ask the model to answer by calling `tool`. Returns { input, model, usage }.
 * Falls back from a named tool_choice to "required" for providers that don't support naming.
 */
export async function completeWithTool({ system, messages, tool, cfg = config(), timeoutMs = 25000 }) {
  if (!cfg.apiKey) { const e = new Error('LLM_API_KEY is not set on the server'); e.status = 503; throw e; }
  const body = {
    model: cfg.model,
    messages: [{ role: 'system', content: system }, ...messages],
    tools: [toOpenAITool(tool)],
    tool_choice: { type: 'function', function: { name: tool.name } },
    temperature: 0.6,
    max_tokens: 1500
  };
  if (/gpt-oss/.test(cfg.model)) body.reasoning_effort = 'low';   // keep latency down on reasoning models

  const url = `${cfg.baseURL}/chat/completions`;
  let out;
  try { out = await post(url, cfg.apiKey, body, timeoutMs); }
  catch (e) {
    if (e.status !== 400) throw e;
    out = await post(url, cfg.apiKey, { ...body, tool_choice: 'required' }, timeoutMs);
  }

  const msg = out?.choices?.[0]?.message || {};
  const call = (msg.tool_calls || []).find(c => c.function?.name === tool.name) || msg.tool_calls?.[0];
  const input = parseArgs(call ? call.function.arguments : msg.content) || { reply: msg.content };
  return {
    input,
    model: out?.model || cfg.model,
    usage: out?.usage ? { input: out.usage.prompt_tokens, output: out.usage.completion_tokens } : undefined
  };
}
