// Local dev server: serves public/ and routes /api/chat to the same handler Vercel runs.
//   npm run dev          -> real model (needs LLM_API_KEY in .env, Cerebras by default)
//   npm run dev:mock     -> canned replies, no key needed (UI work and tests)
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// tiny .env loader (no dependency)
if (existsSync(path.join(root, '.env'))) {
  for (const line of readFileSync(path.join(root, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const { createHandler } = await import('../api/chat.js');
const mock = process.env.MINDEASE_MOCK === '1';

const mockComplete = async ({ messages }) => {
      const last = messages[messages.length - 1].content.toLowerCase();
      await new Promise(r => setTimeout(r, 300));
      const anxious = /anx|worr|panic|overthink/.test(last);
      const hopeless = /pointless|disappear|no one would care/.test(last);
      return {
        model: 'mock-model',
        usage: { input: 0, output: 0 },
        input: {
          reply: hopeless ? "(mock) That sounds incredibly heavy, and I'm glad you said it out loud. You matter, and you don't have to hold this alone. Is there someone you trust you could reach out to today?"
            : anxious ? "(mock) That on-edge feeling is exhausting. Let's slow your body down with a few rounds of box breathing first. What's the worry that keeps coming back?"
            : "(mock) Thanks for sharing that with me. I'm listening. How has it been affecting you?",
          intent: anxious ? 'anxiety' : hopeless ? 'hopelessness' : 'general',
          risk_level: hopeless ? 'high' : 'none',
          suggestions: anxious ? [{ label: 'Guide my breathing', action: 'breathe:box' }, { label: 'Reframe the worry', action: 'reframe' }] : [{ label: 'Tell you more', send: 'Can I tell you more about it?' }]
        }
      };
};

const { config } = await import('../lib/llm.js');
const handler = createHandler(mock ? { complete: mockComplete } : {});
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/chat') return handler(req, res);
  const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const file = path.join(root, 'public', path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404); res.end('Not found'); }
}).listen(process.env.PORT || 3000, () => {
  const c = config();
  console.log(`MindEase running at http://localhost:${process.env.PORT || 3000} (${mock ? 'mock replies' : c.model + ' via ' + c.baseURL})`);
  if (!mock && !c.apiKey) console.log('  LLM_API_KEY is not set: the chat will use offline rules. Add it to .env or run npm run dev:mock.');
});
