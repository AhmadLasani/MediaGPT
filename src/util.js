// Shared helpers: tokenization, deterministic RNG, time constants, formatting.

export const STOPWORDS = new Set(
  `a an the and or but if then so to of in on at for from by with without into onto over under is are was were be been
   being am i me my we our you your he she it its they them their this that these those there here can could would should
   will do does did done have has had just also very really any some all as up out about after before again get got
   since when what which who whom how why than too more most other such only own same s t now via us im ive dont
   rt amp new one two get gets going still even much many lot lots ever every`.split(/\s+/)
);

export function words(text = '') {
  return String(text)
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^a-z0-9#@'\s-]/g, ' ')
    .split(/[\s-]+/)
    .map((w) => w.replace(/^'+|'+$/g, ''))
    .filter(Boolean);
}

export function tokenize(text = '') {
  return words(text).filter((t) => t.length > 2 && !STOPWORDS.has(t) && !/^\d+$/.test(t));
}

// Mulberry32: deterministic PRNG so seed data is reproducible.
export function rng(seed = 42) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const pick = (r, arr) => arr[Math.floor(r() * arr.length)];
export const between = (r, lo, hi) => Math.floor(lo + r() * (hi - lo + 1));

export const MIN = 60 * 1000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

export const iso = (ts) => (ts == null ? null : new Date(ts).toISOString());
export const toTs = (v) => (v == null ? null : typeof v === 'number' ? v : Date.parse(v));
export const startOfDay = (ts) => { const d = new Date(ts); d.setUTCHours(0, 0, 0, 0); return d.getTime(); };
export const dayKey = (ts) => new Date(ts).toISOString().slice(0, 10);

export function round(n, d = 1) {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

export const sum = (arr, f = (x) => x) => arr.reduce((a, x) => a + f(x), 0);
export const mean = (arr) => (arr.length ? sum(arr) / arr.length : 0);
export function std(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(sum(arr, (x) => (x - m) ** 2) / (arr.length - 1));
}

export function pct(part, whole, d = 1) {
  return whole ? round((part / whole) * 100, d) : 0;
}

export function compact(n) {
  if (n >= 1e6) return `${round(n / 1e6, 1)}M`;
  if (n >= 1e3) return `${round(n / 1e3, 1)}K`;
  return String(Math.round(n));
}

export function csvEscape(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function htmlEscape(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function countBy(arr, f) {
  const m = new Map();
  for (const x of arr) {
    const k = f(x);
    if (k == null) continue;
    m.set(k, (m.get(k) || 0) + 1);
  }
  return m;
}

export function topN(map, n = 10) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
