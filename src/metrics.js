// Analytics over enriched mentions: volume, sentiment, share of voice,
// narratives, influencers, sources, geography and keywords.
import { DAY, HOUR, round, pct, sum, countBy, topN } from './util.js';
import { keywords as extractKeywords, relevance } from './nlp.js';

const ts = (m) => m._ts ?? (m._ts = Date.parse(m.publishedAt));

export function inWindow(mentions, from, to) {
  // Inclusive of `to` so a mention stamped at exactly "now" is visible immediately.
  return mentions.filter((m) => ts(m) >= from && ts(m) <= to);
}

export function filterMentions(mentions, f = {}) {
  let out = mentions;
  if (f.from != null || f.to != null) out = inWindow(out, f.from ?? -Infinity, f.to ?? Infinity);
  if (f.entity) out = out.filter((m) => m.entity === f.entity);
  if (f.source) out = out.filter((m) => m.source === f.source);
  if (f.sentiment) out = out.filter((m) => m.sentiment.label === f.sentiment);
  if (f.narrative) out = out.filter((m) => (f.narrative === 'none' ? !m.narrativeId : m.narrativeId === f.narrative));
  if (f.query) out = out.filter((m) => m.queries.includes(f.query));
  if (f.location) out = out.filter((m) => m.location === f.location);
  if (f.author) out = out.filter((m) => m.authorId === f.author);
  if (f.q) {
    const q = String(f.q).toLowerCase();
    out = out.filter((m) => `${m.title || ''} ${m.text}`.toLowerCase().includes(q) || relevance(f.q, `${m.title || ''} ${m.text}`) >= 0.6);
  }
  return out;
}

export function net(list) {
  if (!list.length) return 0;
  let p = 0, n = 0;
  for (const m of list) { if (m.sentiment.label === 'positive') p++; else if (m.sentiment.label === 'negative') n++; }
  return round((p - n) / list.length, 3);
}

export function sentimentCounts(list) {
  const c = { positive: 0, neutral: 0, negative: 0 };
  for (const m of list) c[m.sentiment.label]++;
  return c;
}

export const engagementOf = (m) => m.engagement.likes + m.engagement.shares * 2 + m.engagement.comments * 1.5;

export function summary(list, prev = []) {
  const c = sentimentCounts(list);
  return {
    total: list.length,
    previous: prev.length,
    change: prev.length ? round(((list.length - prev.length) / prev.length) * 100, 1) : null,
    ...c,
    net: net(list),
    netPrevious: net(prev),
    reach: sum(list, (m) => m.reach),
    engagement: Math.round(sum(list, engagementOf)),
    avgScore: list.length ? round(sum(list, (m) => m.sentiment.score) / list.length, 3) : 0,
  };
}

/** Rolling buckets ending at `to`: bucket i covers [to-(i+1)*size, to-i*size). Oldest first. */
export function series(list, { from, to, size = DAY }) {
  const n = Math.max(1, Math.ceil((to - from) / size));
  const buckets = Array.from({ length: n }, (_, i) => ({ t: new Date(to - (n - i) * size).toISOString(), end: new Date(to - (n - i - 1) * size).toISOString(), total: 0, positive: 0, neutral: 0, negative: 0, reach: 0 }));
  for (const m of list) {
    const idx = n - 1 - Math.floor((to - ts(m)) / size);
    if (idx < 0 || idx >= n) continue;
    const b = buckets[idx];
    b.total++;
    b[m.sentiment.label]++;
    b.reach += m.reach;
  }
  for (const b of buckets) b.net = b.total ? round((b.positive - b.negative) / b.total, 3) : 0;
  return buckets;
}

export function shareOfVoice(list, entities) {
  const total = list.length;
  return entities.map((e) => {
    const mine = list.filter((m) => m.entity === e.id);
    return { entity: e.id, name: e.name, color: e.color, kind: e.kind, count: mine.length, share: pct(mine.length, total), net: net(mine), reach: sum(mine, (m) => m.reach), news: mine.filter((m) => m.source === 'news').length };
  });
}

export function narrativeStats(mentions, narratives, { now, days = 30 }) {
  const from = now - days * DAY;
  const out = [];
  for (const n of narratives) {
    if (!n.name) continue;
    const all = mentions.filter((m) => m.narrativeId === n.id);
    const win = inWindow(all, from, now);
    const last3 = inWindow(all, now - 3 * DAY, now);
    const prev3 = inWindow(all, now - 6 * DAY, now - 3 * DAY);
    const last24 = inWindow(all, now - DAY, now);
    const growth = prev3.length ? round(((last3.length - prev3.length) / prev3.length) * 100, 0) : last3.length ? null : 0;
    const authors = topN(countBy(win, (m) => m.authorId), 3).map(([id]) => id);
    out.push({
      id: n.id, name: n.name, entity: n.entity, summary: n.summary, polarity: n.polarity, team: n.team,
      count: win.length, last24h: last24.length, last3d: last3.length, prev3d: prev3.length, growth,
      momentum: last3.length >= 5 && (growth == null || growth >= 50) ? 'rising' : last3.length < prev3.length * 0.6 ? 'fading' : 'steady',
      net: net(win), sentiment: sentimentCounts(win), reach: sum(win, (m) => m.reach),
      firstSeen: all.length ? all.reduce((a, m) => (ts(m) < a ? ts(m) : a), Infinity) : null,
      spark: series(win, { from, to: now, size: DAY }).map((b) => b.total),
      topAuthorIds: authors,
      signals: n.signals,
    });
  }
  return out.sort((a, b) => b.last3d - a.last3d || b.count - a.count);
}

/** Influence = reach (log scale) × engagement × volume; split by sentiment for "who is driving it". */
export function influencers(list, authorsById, limit = 15) {
  const by = new Map();
  for (const m of list) {
    const a = authorsById[m.authorId];
    if (!a) continue;
    const row = by.get(a.id) || { author: a, mentions: 0, engagement: 0, positive: 0, negative: 0, neutral: 0, latest: null, mentionIds: [] };
    row.mentions++;
    row.engagement += engagementOf(m);
    row[m.sentiment.label]++;
    if (!row.latest || ts(m) > Date.parse(row.latest)) row.latest = m.publishedAt;
    row.mentionIds.push(m.id);
    by.set(a.id, row);
  }
  return [...by.values()]
    .map((r) => ({
      ...r,
      engagement: Math.round(r.engagement),
      impact: round(Math.log10(r.author.followers + 10) * Math.log10(r.engagement + 10) * (1 + Math.log2(r.mentions)), 1),
      stance: r.negative > r.positive ? 'negative' : r.positive > r.negative ? 'positive' : 'neutral',
      mentionIds: r.mentionIds.slice(-5),
    }))
    .sort((a, b) => b.impact - a.impact)
    .slice(0, limit);
}

export function breakdown(list, key) {
  return topN(countBy(list, key), 20).map(([k, count]) => {
    const sub = list.filter((m) => key(m) === k);
    return { key: k, count, share: pct(count, list.length), net: net(sub) };
  });
}

export function topHashtags(list, n = 12) {
  const c = new Map();
  for (const m of list) for (const h of m.hashtags) c.set(h, (c.get(h) || 0) + 1);
  return topN(c, n).map(([tag, count]) => ({ tag, count }));
}

export function topKeywords(list, entities, n = 15) {
  const exclude = entities.flatMap((e) => e.aliases.flatMap((a) => a.split(/\s+/)));
  return extractKeywords(list.map((m) => `${m.title || ''} ${m.text}`), { exclude: [...exclude, 'mobile', 'connect', 'wireless'], n });
}

export function hourly(list, now, hours = 72) {
  return series(list, { from: now - hours * HOUR, to: now, size: HOUR });
}
