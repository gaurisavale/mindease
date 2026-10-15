import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { completeWithTool } from '../lib/llm.js';
import { RESPOND_TOOL } from '../lib/prompt.js';

const cfg = { apiKey: 'k', baseURL: 'https://api.cerebras.ai/v1', model: 'gpt-oss-120b' };
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
const respond = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });

test('sends an OpenAI-compatible request with a forced named tool and parses tool_calls', async () => {
  let seen;
  globalThis.fetch = async (url, init) => { seen = { url, init, body: JSON.parse(init.body) }; return respond(200, {
    model: 'gpt-oss-120b', usage: { prompt_tokens: 120, completion_tokens: 40 },
    choices: [{ message: { tool_calls: [{ type: 'function', function: { name: 'respond', arguments: '{"reply":"hi","intent":"greeting","risk_level":"none"}' } }] } }] }); };
  const out = await completeWithTool({ system: 'sys', messages: [{ role: 'user', content: 'hey' }], tool: RESPOND_TOOL, cfg });
  assert.equal(seen.url, 'https://api.cerebras.ai/v1/chat/completions');
  assert.equal(seen.init.headers.Authorization, 'Bearer k');
  assert.equal(seen.body.messages[0].role, 'system');
  assert.deepEqual(seen.body.tool_choice, { type: 'function', function: { name: 'respond' } });
  assert.equal(seen.body.tools[0].function.name, 'respond');
  assert.equal(seen.body.reasoning_effort, 'low');
  assert.equal(out.input.reply, 'hi');
  assert.deepEqual(out.usage, { input: 120, output: 40 });
});

test('retries with tool_choice "required" when a named choice is rejected', async () => {
  const choices = [];
  globalThis.fetch = async (url, init) => {
    const b = JSON.parse(init.body); choices.push(b.tool_choice);
    if (typeof b.tool_choice === 'object') return respond(400, { error: { message: 'unsupported tool_choice' } });
    return respond(200, { choices: [{ message: { tool_calls: [{ function: { name: 'respond', arguments: '{"reply":"ok","intent":"x","risk_level":"low"}' } }] } }] });
  };
  const out = await completeWithTool({ system: 's', messages: [{ role: 'user', content: 'x' }], tool: RESPOND_TOOL, cfg });
  assert.equal(choices[1], 'required');
  assert.equal(out.input.reply, 'ok');
});

test('recovers JSON from plain content when the model skips the tool', async () => {
  globalThis.fetch = async () => respond(200, { choices: [{ message: { content: 'Sure!\n```json\n{"reply":"hey there","intent":"greeting","risk_level":"none"}\n```' } }] });
  const out = await completeWithTool({ system: 's', messages: [{ role: 'user', content: 'x' }], tool: RESPOND_TOOL, cfg });
  assert.equal(out.input.reply, 'hey there');
});

test('missing key fails fast with 503', async () => {
  await assert.rejects(() => completeWithTool({ system: 's', messages: [], tool: RESPOND_TOOL, cfg: { ...cfg, apiKey: '' } }), e => e.status === 503);
});

test('auth errors surface their status', async () => {
  globalThis.fetch = async () => respond(401, { error: { message: 'bad key' } });
  await assert.rejects(() => completeWithTool({ system: 's', messages: [{ role: 'user', content: 'x' }], tool: RESPOND_TOOL, cfg }), e => e.status === 401);
});
