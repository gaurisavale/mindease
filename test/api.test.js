import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { detectCrisis } from '../lib/safety.js';
import { createHandler, validate, sanitise } from '../api/chat.js';

// ---------- safety layer ----------
const crisis = [
  'I want to kill myself', "i don't want to live anymore", 'thinking about suicide', 'I keep cutting myself',
  "I can't go on like this", "I'd be better off dead", 'self-harm again', 'मैं आत्महत्या के बारे में सोच रहा हूँ',
  'मला मरायचं आहे', 'mujhe marna chahta hu', 'I want to end my life'
];
const safe = [
  "I'm feeling anxious", 'exams are killing me lol', 'I need help with stress', 'my phone died', 'I cut my hair today',
  "I'm dying to see the new movie", 'मैं तनाव में हूँ', 'I hurt my knee playing football'
];
for (const t of crisis) test(`crisis: ${t}`, () => assert.equal(detectCrisis(t), true));
for (const t of safe) test(`not crisis: ${t}`, () => assert.equal(detectCrisis(t), false));

// ---------- validation ----------
test('validate rejects empty and non-user-last', () => {
  assert.ok(validate({}).error);
  assert.ok(validate({ messages: [{ role: 'assistant', content: 'hi' }] }).error);
});
test('validate merges same-role turns, drops leading assistant, caps length', () => {
  const v = validate({ lang: 'hi', messages: [
    { role: 'assistant', content: 'greeting' }, { role: 'user', content: 'a' }, { role: 'user', content: 'x'.repeat(5000) }] });
  assert.equal(v.messages.length, 1);
  assert.equal(v.messages[0].role, 'user');
  assert.ok(v.messages[0].content.length <= 1002);
  assert.equal(v.lang, 'hi');
});
test('sanitise whitelists actions and caps suggestions', () => {
  const r = sanitise({ reply: 'ok', risk_level: 'weird', suggestions: [
    { label: 'Breathe', action: 'breathe:box' }, { label: 'Hack', action: 'eval:alert(1)' }, { label: 'More', send: 'tell me more' }, { label: 'extra' }] });
  assert.equal(r.risk_level, 'low');
  assert.deepEqual(r.suggestions[0], { label: 'Breathe', action: 'breathe:box' });
  assert.deepEqual(r.suggestions[1], { label: 'Hack', send: 'Hack' });
  assert.equal(r.suggestions.length, 3);
});

// ---------- handler ----------
function call(handler, body, method = 'POST') {
  return new Promise(resolve => {
    const req = Readable.from([JSON.stringify(body)]);
    Object.assign(req, { method, headers: { 'x-forwarded-for': 'test-' + Math.random() } });
    const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(s) { resolve({ status: this.statusCode, body: JSON.parse(s) }); } };
    handler(req, res);
  });
}
const fake = (input, spy = {}) => async args => { spy.args = args; return { model: 'fake', input }; };

test('crisis message short-circuits before the model', async () => {
  const spy = {};
  const h = createHandler({ complete: fake({ reply: 'x', intent: 'x', risk_level: 'none' }, spy) });
  const r = await call(h, { messages: [{ role: 'user', content: 'I want to die' }] });
  assert.equal(r.body.type, 'crisis');
  assert.equal(r.body.source, 'rules');
  assert.ok(r.body.helplines.length >= 3);
  assert.equal(spy.args, undefined, 'model must not be called');
});
test('normal message goes to the model with the respond tool and language', async () => {
  const spy = {};
  const h = createHandler({ complete: fake({ reply: 'Hello there', intent: 'greeting', risk_level: 'none', suggestions: [] }, spy) });
  const r = await call(h, { lang: 'mr', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(r.status, 200);
  assert.equal(r.body.reply, 'Hello there');
  assert.equal(r.body.source, 'llm');
  assert.equal(spy.args.tool.name, 'respond');
  assert.match(spy.args.system, /Marathi/);
});
test('model-flagged high risk attaches helplines', async () => {
  const h = createHandler({ complete: fake({ reply: 'I hear you.', intent: 'hopelessness', risk_level: 'high' }) });
  const r = await call(h, { messages: [{ role: 'user', content: 'everyone would be better without me' }] });
  assert.equal(r.body.type, 'crisis-soft');
  assert.ok(r.body.helplines);
});
test('model failure returns 502', async () => {
  const h = createHandler({ complete: async () => { throw new Error('boom'); } });
  const r = await call(h, { messages: [{ role: 'user', content: 'hello' }] });
  assert.equal(r.status, 502);
});
test('GET is rejected', async () => {
  const r = await call(createHandler({ complete: fake({}) }), {}, 'GET');
  assert.equal(r.status, 405);
});
