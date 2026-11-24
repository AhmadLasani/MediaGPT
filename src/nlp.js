// Explainable NLP: lexicon sentiment (with negation and intensifiers), entity
// detection, narrative classification and keyword extraction. Every result
// carries the evidence that produced it, so analysts can audit the AI.
import { tokenize, round } from './util.js';

// Valence lexicon, scored -4..+4 (AFINN-style), tuned for brand and media text.
const LEXICON = {
  // positive
  love: 3, loving: 3, loved: 3, great: 3, excellent: 3, amazing: 4, awesome: 4, fantastic: 4, brilliant: 3, impressive: 3,
  impressed: 3, good: 2, nice: 2, happy: 3, glad: 2, pleased: 2, thanks: 2, thank: 2, thankful: 2, grateful: 3, fast: 2,
  faster: 2, fastest: 3, reliable: 3, smooth: 2, seamless: 3, solid: 2, best: 3, better: 2, improved: 2, improvement: 2,
  recommend: 2, recommended: 2, win: 3, wins: 3, winner: 3, praise: 3, praised: 3, applaud: 3, kudos: 3, helpful: 2,
  friendly: 2, quick: 1, quickly: 1, resolved: 2, fixed: 2, restored: 2, affordable: 2, fair: 1, generous: 2, innovative: 3,
  leading: 1, strong: 2, stronger: 2, clean: 1, green: 1, sustainable: 2, proud: 2, exciting: 3, excited: 3, finally: 1,
  wow: 3, perfect: 3, flawless: 4, stellar: 4, superb: 4, worth: 2, value: 1, savings: 2, save: 1, transparent: 2,
  responsive: 2, upgrade: 1, upgraded: 1, boost: 2, praiseworthy: 3, delighted: 3, enjoy: 2, enjoying: 2, beautiful: 3,
  // negative
  bad: -3, terrible: -3, awful: -3, horrible: -3, worst: -4, worse: -3, hate: -3, hated: -3, angry: -3, furious: -4,
  annoyed: -2, annoying: -2, frustrated: -2, frustrating: -2, frustration: -2, disappointed: -2, disappointing: -2,
  disappointment: -2, useless: -3, broken: -2, fail: -2, fails: -2, failed: -2, failure: -3, failing: -2, outage: -3,
  outages: -3, down: -1, dead: -3, slow: -2, slower: -2, unusable: -3, unreliable: -3, unacceptable: -3, ridiculous: -3,
  scam: -4, ripoff: -4, rip: -1, greedy: -3, greed: -3, overpriced: -3, expensive: -2, hike: -2, hikes: -2, gouging: -4,
  cancel: -2, cancelled: -2, cancelling: -2, leaving: -1, painless: 2, saved: 2, deal: 1, smart: 2, lost: -2, losing: -2, nightmare: -4, chaos: -3,
  mess: -3, problem: -2, problems: -2, issue: -1, issues: -1, complaint: -2, complaints: -2, complain: -2, wait: -1,
  waiting: -2, hold: -1, ignored: -2, rude: -3, worried: -2, worry: -2, concern: -2, concerns: -2, concerning: -2,
  breach: -3, leak: -3, leaked: -3, sharing: 0, sold: -1, selling: -1, creepy: -3, invasive: -3, lawsuit: -3, sue: -3,
  boycott: -3, apology: -1, sorry: -1, misleading: -3, hidden: -2, fees: -1, error: -2, errors: -2, wrong: -2,
  overcharged: -3, refund: -1, stranded: -3, emergency: -2, blackout: -3, crisis: -3, backlash: -3, outrage: -4,
  dropped: -2, drops: -2, dropping: -2, glitch: -2, glitches: -2, crash: -3, crashed: -3, struggle: -2, struggling: -2,
  shame: -3, shameful: -3, joke: -2, pathetic: -3, embarrassing: -3, fed: -1, nope: -1, avoid: -2, never: -1,
};

const EMOJI = { '😍': 3, '🔥': 2, '👏': 2, '🙌': 2, '❤️': 3, '😊': 2, '👍': 2, '🎉': 3, '😡': -3, '🤬': -4, '😤': -2, '👎': -2, '😩': -2, '😢': -2, '🙄': -2, '💀': -1 };
const NEGATORS = new Set(['not', 'no', 'never', "isn't", "wasn't", "aren't", "don't", "doesn't", "didn't", "can't", 'cannot', "won't", 'without', 'hardly', 'nothing']);
const BOOSTERS = { very: 1.3, really: 1.3, extremely: 1.5, so: 1.2, totally: 1.3, absolutely: 1.5, super: 1.3, incredibly: 1.5, completely: 1.4, utterly: 1.5 };
const ALPHA = 15; // normalisation constant (VADER-style)

// Domain phrases scored as a unit (and masked so their words are not re-scored).
const PHRASES = {
  'no signal': -3, 'no service': -3, 'sos only': -3, 'still down': -3, 'not working': -3, 'no updates': -2, 'no apology': -2,
  'dropped calls': -2, 'on hold': -1, 'class action': -3, 'price lock promise': -1, 'credit where it is due': 2, 'fair play': 2,
  'the real deal': 3, 'not even close': 2, 'deserves more than': -2, 'so much for': -2, 'thinking about cancelling': -3,
};
const PHRASE_LIST = Object.keys(PHRASES).sort((a, b) => b.length - a.length);

/**
 * Score text sentiment. Returns { label, score (-1..1), terms: [{term, weight}] }.
 * The `terms` array is the explanation: which words and phrases moved the score.
 * Rules: negation applies within a clause (3-word window), boosters amplify,
 * "but"/"still" shift weight to the clause after them, questions are damped.
 */
export function sentiment(text = '') {
  let lower = ` ${String(text).toLowerCase().replace(/[’`]/g, "'")} `;
  const hits = [];
  for (const p of PHRASE_LIST) {
    const re = new RegExp(`([^a-z0-9])${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[^a-z0-9])`, 'g');
    lower = lower.replace(re, (all, pre, offset) => {
      hits.push({ term: p, w: PHRASES[p], pos: offset });
      return pre + ' '.repeat(p.length);
    });
  }
  // Tokens with their position, plus clause-ending punctuation as separate tokens.
  const toks = [...lower.matchAll(/[a-z0-9#@']+|[.!?;]/g)].map((m) => ({ t: m[0], pos: m.index }));
  const scored = hits.map((h) => ({ term: h.term, w: h.w, pos: h.pos }));
  let clauseStart = 0;
  toks.forEach((tok, i) => {
    if (/^[.!?;]$/.test(tok.t)) { clauseStart = i + 1; return; }
    const base = LEXICON[tok.t];
    if (base === undefined || base === 0) return;
    let w = base;
    const prev = toks.slice(Math.max(clauseStart, i - 3), i).map((x) => x.t);
    const boost = BOOSTERS[prev[prev.length - 1]];
    if (boost) w *= boost;
    const negated = prev.some((p) => NEGATORS.has(p));
    if (negated) w *= -0.75;
    scored.push({ term: (negated ? 'not ' : '') + tok.t, w, pos: tok.pos });
  });
  // Sentence-level adjustments: contrast ("but", "still") and questions.
  const ends = toks.filter((x) => /^[.!?;]$/.test(x.t));
  const sentenceOf = (pos) => { const e = ends.find((x) => x.pos >= pos); return { end: e ? e.pos : Infinity, q: e?.t === '?' }; };
  const contrast = toks.filter((x) => x.t === 'but' || x.t === 'still' || x.t === 'though');
  let raw = 0;
  const terms = [];
  for (const s of scored) {
    let w = s.w;
    const sen = sentenceOf(s.pos);
    const c = contrast.find((x) => sentenceOf(x.pos).end === sen.end);
    if (c) w *= s.pos < c.pos ? 0.5 : 1.5;
    if (sen.q) w *= 0.2;
    raw += w;
    terms.push({ term: s.term, weight: round(w, 2) });
  }
  for (const [e, v] of Object.entries(EMOJI)) {
    const n = String(text).split(e).length - 1;
    if (n) { raw += v * n; terms.push({ term: e, weight: v * n }); }
  }
  // Exclamation marks amplify whichever direction the text already leans.
  const bangs = Math.min(3, (String(text).match(/!/g) || []).length);
  if (bangs && raw) raw += Math.sign(raw) * 0.3 * bangs;
  const score = round(raw / Math.sqrt(raw * raw + ALPHA), 3);
  const label = score >= 0.15 ? 'positive' : score <= -0.15 ? 'negative' : 'neutral';
  return { label, score, terms: terms.sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight)).slice(0, 6) };
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const termRe = new Map();
function hasTerm(lower, term) {
  let re = termRe.get(term);
  if (!re) {
    re = new RegExp(`(^|[^a-z0-9])${escapeRe(term.toLowerCase())}($|[^a-z0-9])`);
    termRe.set(term, re);
  }
  return re.test(lower);
}

/** Detect which tracked entities (brand / competitors) a text mentions, via aliases. */
export function detectEntities(text, entities) {
  const lower = String(text).toLowerCase();
  return entities.filter((e) => e.aliases.some((a) => hasTerm(lower, a))).map((e) => e.id);
}

/**
 * Classify a mention into the best-matching narrative for its entity.
 * Each narrative has weighted signal terms; the explanation lists the matches.
 */
export function classifyNarrative(text, entityId, narratives) {
  const lower = String(text).toLowerCase();
  let best = null;
  for (const n of narratives) {
    if (n.entity !== entityId) continue;
    const matched = n.signals.filter((s) => hasTerm(lower, s));
    const score = matched.length;
    if (score && (!best || score > best.score)) best = { id: n.id, score, matched };
  }
  if (!best || best.score < 1) return { id: null, score: 0, matched: [] };
  return best;
}

/** Match a text against saved monitoring queries (any-term match, with optional exclusions). */
export function matchQueries(text, queries) {
  const lower = String(text).toLowerCase();
  return queries
    .filter((q) => q.active !== false && q.terms.some((t) => hasTerm(lower, t)) && !(q.exclude || []).some((t) => hasTerm(lower, t)))
    .map((q) => q.id);
}

export function hashtags(text) {
  return [...new Set((String(text).match(/#[a-z0-9_]+/gi) || []).map((h) => h.toLowerCase()))];
}

/** Top keywords across a set of texts, ignoring entity aliases and hashtags. */
export function keywords(texts, { exclude = [], n = 15 } = {}) {
  const ex = new Set(exclude.map((x) => x.toLowerCase()));
  const counts = new Map();
  for (const t of texts) {
    for (const w of new Set(tokenize(t))) {
      if (w.startsWith('#') || w.startsWith('@') || ex.has(w)) continue;
      counts.set(w, (counts.get(w) || 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([term, count]) => ({ term, count }));
}

/** Simple lexical overlap used by search and the Copilot fallback. */
export function relevance(query, text) {
  const q = new Set(tokenize(query));
  if (!q.size) return 0;
  const t = new Set(tokenize(text));
  let hit = 0;
  for (const w of q) if (t.has(w) || [...t].some((x) => x.length > 4 && (x.startsWith(w) || w.startsWith(x)))) hit++;
  return hit / q.size;
}
