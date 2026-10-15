// Rule-based safety layer. Runs before any model call, on the server and in the browser.
// Deterministic by design: a crisis message never depends on a model being up or behaving.

export const HELPLINES = [
  { who: 'Tele-MANAS', where: 'India · Govt. of India · 24/7 · 20+ languages', num: '14416' },
  { who: 'iCall (TISS)', where: 'India · Mon–Sat, 10am–8pm', num: '9152987821' },
  { who: 'Emergency services', where: 'India · police, ambulance, fire', num: '112' },
  { who: '988 Lifeline', where: 'United States · call or text · 24/7', num: '988' }
];

const CRISIS_PATTERNS = [
  // English
  /\b(kill(ing)?\s+my\s?self|suicid\w*|end(ing)?\s+(it\s+all|my\s+life|everything)|want\s+to\s+die|wanna\s+die|wish\s+i\s+(was|were)\s+dead|better\s+off\s+dead|take\s+my\s+(own\s+)?life|hurt(ing)?\s+my\s?self|harm(ing)?\s+my\s?self|self[\s-]?harm\w*|cut(ting)?\s+my\s?self|no\s+reason\s+to\s+live|dont\s+want\s+to\s+(live|be\s+alive|exist|wake\s+up)|cant\s+go\s+on|overdos\w*|not\s+worth\s+living)\b/,
  // Hindi, Marathi (Devanagari) and Hinglish
  /(आत्महत्या|मरना\s*चाहत|मर\s*जाना\s*चाहत|जीना\s*नहीं\s*चाहत|खुद\s*को\s*(चोट|नुकसान)|मरायचं|मरायचे|जगायचं\s*नाही|जगायचे\s*नाही|marna\s+chaht|mar\s+jaana|jeena\s+nahi|khud\s+ko\s+(hurt|nuksan))/
];

export function normalize(s) {
  return String(s).toLowerCase().replace(/[’‘`]/g, "'")
    .replace(/\bcan't\b/g, 'cant').replace(/\bwon't\b/g, 'wont').replace(/n't\b/g, 'nt').replace(/\bi'm\b/g, 'im').replace(/'/g, '')
    .replace(/\s+/g, ' ').trim();
}

export function detectCrisis(text) {
  const n = normalize(text);
  return CRISIS_PATTERNS.some(rx => rx.test(n));
}

export const CRISIS_REPLY = "I'm really glad you told me, and I'm so sorry you're carrying this. You deserve support from a real person right now. Please reach out to one of these, they're free and confidential. If you're in immediate danger, call 112 (India) or your local emergency number, or go to the nearest hospital. I'm still here, and we can keep talking while you reach out.";
