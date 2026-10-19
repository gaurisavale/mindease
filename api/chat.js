// POST /api/chat  (Vercel serverless function, also used by scripts/dev.js)
// Pipeline: validate -> rate limit -> rule-based crisis check -> LLM (forced tool call) -> sanitise -> respond

import { detectCrisis, CRISIS_REPLY, HELPLINES } from '../lib/safety.js';
import { systemPrompt, RESPOND_TOOL, ACTIONS } from '../lib/prompt.js';
import { completeWithTool } from '../lib/llm.js';

const MAX_TURNS = 16;          // messages of history sent to the model
const MAX_CHARS = 1000;        // per message
const RATE = { windowMs: 60_000, max: 20 };
const hits = new Map();        // best-effort, per warm instance

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body);
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > 64_000) throw new Error('too large'); }
  return raw ? JSON.parse(raw) : {};
}

function rateLimited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter(t => now - t < RATE.windowMs);
  list.push(now); hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return list.length > RATE.max;
}

export function validate(body) {
  const { messages, lang } = body || {};
  if (!Array.isArray(messages) || messages.length === 0) return { error: 'messages must be a non-empty array' };
  const clean = [];
  for (const m of messages.slice(-MAX_TURNS)) {
    if (!m || !['user', 'assistant'].includes(m.role) || typeof m.content !== 'string') return { error: 'each message needs role user|assistant and string content' };
    const content = m.content.trim().slice(0, MAX_CHARS);
    if (!content) continue;
    // merge consecutive same-role turns so the API always alternates
    if (clean.length && clean[clean.length - 1].role === m.role) clean[clean.length - 1].content += '\n' + content;
    else clean.push({ role: m.role, content });
  }
  while (clean.length && clean[0].role !== 'user') clean.shift();
  if (!clean.length || clean[clean.length - 1].role !== 'user') return { error: 'last message must be from the user' };
  return { messages: clean, lang: ['en', 'hi', 'mr'].includes(lang) ? lang : 'en' };
}

export function sanitise(input) {
  const reply = String(input?.reply || '').trim();
  const risk = ['none', 'low', 'elevated', 'high'].includes(input?.risk_level) ? input.risk_level : 'low';
  const suggestions = (Array.isArray(input?.suggestions) ? input.suggestions : []).slice(0, 3).map(s => {
    const label = String(s?.label || '').slice(0, 40).trim();
    if (!label) return null;
    if (s.action && ACTIONS.has(s.action)) return { label, action: s.action };
    const text = String(s.send || label).slice(0, 200).trim();
    return text ? { label, send: text } : null;
  }).filter(Boolean);
  return { reply, intent: String(input?.intent || 'general').slice(0, 40), risk_level: risk, suggestions };
}

export function createHandler({ complete = completeWithTool } = {}) {
  return async function handler(req, res) {
    if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
    const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'local').toString().split(',')[0].trim();
    if (rateLimited(ip)) return send(res, 429, { error: 'Too many messages. Take a breath and try again in a minute.' });

    let body;
    try { body = await readBody(req); } catch { return send(res, 400, { error: 'invalid JSON' }); }
    const v = validate(body);
    if (v.error) return send(res, 400, { error: v.error });

    const last = v.messages[v.messages.length - 1].content;
    const t0 = Date.now();

    // 1. Deterministic safety layer: never waits on the model.
    if (detectCrisis(last)) {
      return send(res, 200, { type: 'crisis', reply: CRISIS_REPLY, helplines: HELPLINES, risk_level: 'high', source: 'rules', latency_ms: Date.now() - t0 });
    }

    // 2. Model layer.
    try {
      const out = await complete({ system: systemPrompt(v.lang), messages: v.messages, tool: RESPOND_TOOL });
      const r = sanitise(out.input);
      if (!r.reply) throw new Error('empty reply');
      const flagged = r.risk_level === 'high' || r.risk_level === 'elevated';
      const helplineStyle = r.risk_level === 'high' ? 'full' : r.risk_level === 'elevated' ? 'compact' : undefined;
      return send(res, 200, {
        type: r.risk_level === 'high' ? 'crisis-soft' : 'reply', ...r,
        helplines: flagged ? HELPLINES : undefined, helpline_style: helplineStyle,
        source: 'llm', model: out.model, latency_ms: Date.now() - t0, usage: out.usage
      });
    } catch (e) {
      console.error('[mindease] model error:', e?.status || '', e?.message);
      if (e?.status === 503) return send(res, 503, { error: e.message });
      return send(res, 502, { error: 'The AI service is unavailable right now.' });
    }
  };
}

export default createHandler();
