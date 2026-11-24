// Detection engine: conversation spikes, sentiment shifts, emerging narratives,
// influencer activity, competitive movement and priority keyword alerts.
// Every alert explains itself (metrics + the mentions behind it).
import { DAY, HOUR, round, mean, std, iso } from './util.js';
import { inWindow, net, engagementOf } from './metrics.js';

export const STEP = 6 * HOUR; // detection windows are aligned to 6h UTC boundaries so alert keys are stable
const LOOKBACK = 72 * HOUR;

const ts = (m) => m._ts ?? (m._ts = Date.parse(m.publishedAt));
const align = (t) => Math.floor(t / STEP) * STEP;
const topIds = (list, n = 8) => [...list].sort((a, b) => engagementOf(b) - engagementOf(a)).slice(0, n).map((m) => m.id);

/** Evaluate `fn(windowEnd)` at each aligned boundary in the lookback and group consecutive hits into episodes. */
function episodes(now, fn) {
  const out = [];
  let cur = null;
  for (let end = align(now - LOOKBACK) + STEP; end <= align(now) + STEP; end += STEP) {
    const e = Math.min(end, now);
    const r = fn(e);
    if (r) {
      if (!cur) cur = { start: end, at: e, peak: r, first: r };
      else if (r.value > cur.peak.value) cur.peak = r;
      cur.last = e;
    } else if (cur) { out.push(cur); cur = null; }
  }
  if (cur) out.push(cur);
  return out;
}

const severityFromZ = (z) => (z >= 8 ? 'critical' : z >= 5 ? 'high' : 'medium');

export function detect({ mentions, entities, narratives, authorsById, rules, settings, now }) {
  const cfg = settings.detection;
  const brand = settings.brand;
  const alerts = [];
  const byEntity = Object.fromEntries(entities.map((e) => [e.id, mentions.filter((m) => m.entity === e.id)]));
  const nameOf = Object.fromEntries(entities.map((e) => [e.id, e.name]));

  // 1) Conversation spike: 24h volume vs the 14 prior days.
  for (const e of entities) {
    const list = byEntity[e.id];
    const eps = episodes(now, (end) => {
      const cur = inWindow(list, end - DAY, end);
      const base = Array.from({ length: 14 }, (_, i) => inWindow(list, end - (i + 4) * DAY, end - (i + 3) * DAY).length);
      const m = mean(base), s = Math.max(std(base), 2);
      const z = (cur.length - m) / s;
      return z >= cfg.spikeZ && cur.length >= 15 ? { value: z, count: cur.length, baseline: round(m, 1), z: round(z, 1), list: cur } : null;
    });
    for (const ep of eps) {
      const p = ep.peak;
      alerts.push({
        key: `spike:${e.id}:${ep.start - DAY}`, keyTs: ep.start - DAY, type: 'spike', entity: e.id, severity: e.id === brand ? severityFromZ(p.z) : 'low',
        title: `Conversation spike: ${nameOf[e.id]}`,
        detail: `${p.count} mentions in 24h vs a baseline of ${p.baseline}/day (z = ${p.z}).`,
        detectedAt: iso(ep.at), metrics: { count: p.count, baseline: p.baseline, z: p.z }, mentionIds: topIds(p.list),
        narrativeId: dominantNarrative(p.list),
      });
    }
  }

  // 2) Sentiment shift for the brand: net sentiment over 24h vs the prior 14 days.
  {
    const list = byEntity[brand] || [];
    const eps = episodes(now, (end) => {
      const cur = inWindow(list, end - DAY, end);
      const base = inWindow(list, end - 17 * DAY, end - 3 * DAY);
      if (cur.length < 15 || base.length < 30) return null;
      const drop = net(base) - net(cur);
      return Math.abs(drop) >= cfg.sentimentDrop ? { value: Math.abs(drop), drop: round(drop, 2), cur: net(cur), base: net(base), list: cur.filter((m) => m.sentiment.label === (drop > 0 ? 'negative' : 'positive')) } : null;
    });
    for (const ep of eps) {
      const p = ep.peak;
      const down = p.drop > 0;
      alerts.push({
        key: `sentiment:${brand}:${ep.start - DAY}`, keyTs: ep.start - DAY, type: 'sentiment_shift', entity: brand, severity: down ? (p.drop >= 0.5 ? 'critical' : 'high') : 'low',
        title: down ? `Sentiment drop: ${nameOf[brand]}` : `Sentiment improving: ${nameOf[brand]}`,
        detail: `Net sentiment moved from ${fmtNet(p.base)} (14-day baseline) to ${fmtNet(p.cur)} in 24h.`,
        detectedAt: iso(ep.at), metrics: { baseline: p.base, current: p.cur, change: -p.drop }, mentionIds: topIds(p.list), narrativeId: dominantNarrative(p.list),
      });
    }
  }

  // 3) Emerging narratives: 72h volume at least `emergingRatio`x the previous 72h.
  for (const n of narratives) {
    if (!n.name) continue;
    const list = mentions.filter((m) => m.narrativeId === n.id);
    const cur = inWindow(list, now - 3 * DAY, now);
    const prev = inWindow(list, now - 6 * DAY, now - 3 * DAY);
    const ratio = cur.length / Math.max(prev.length, 1);
    if (cur.length >= cfg.emergingMin && ratio >= cfg.emergingRatio) {
      const first = cur.reduce((a, m) => Math.min(a, ts(m)), Infinity);
      alerts.push({
        key: `narrative:${n.id}`, keyTs: null, type: 'emerging_narrative', entity: n.entity, narrativeId: n.id,
        severity: n.entity !== brand ? 'low' : n.polarity === 'negative' ? (cur.length >= 40 ? 'high' : 'medium') : 'low',
        title: `Narrative gaining momentum: ${n.name}`,
        detail: `${cur.length} mentions in the last 72h vs ${prev.length} in the 72h before (${round(ratio, 1)}x). Net sentiment ${fmtNet(net(cur))}.`,
        detectedAt: iso(Math.max(first, now - 3 * DAY + HOUR)), metrics: { last72h: cur.length, prev72h: prev.length, ratio: round(ratio, 1), net: net(cur) }, mentionIds: topIds(cur),
      });
    }
  }

  // 4) Influencer activity: high-reach voices that are negative about the brand in the last 72h (one alert per account).
  {
    const recent = inWindow(byEntity[brand] || [], now - LOOKBACK, now).filter((m) => m.reach >= cfg.influencerFollowers);
    const groups = new Map();
    for (const m of recent) {
      if (!groups.has(m.authorId)) groups.set(m.authorId, []);
      groups.get(m.authorId).push(m);
    }
    for (const [authorId, list] of groups) {
      const a = authorsById[authorId];
      const neg = list.filter((m) => m.sentiment.label === 'negative');
      if (neg.length * 2 < list.length || !neg.length) continue;
      const narrativeId = dominantNarrative(neg);
      const nar = narratives.find((n) => n.id === narrativeId);
      neg.sort((x, y) => ts(x) - ts(y));
      alerts.push({
        key: `influencer:${authorId}`, keyTs: null, type: 'influencer', entity: brand, narrativeId, authorId,
        severity: a.followers >= 1e6 ? 'high' : 'medium',
        title: `${a.type === 'journalist' ? 'Journalist' : 'Influencer'} activity: ${a.name || a.handle}${a.outlet ? ` (${a.outlet})` : ''}`,
        detail: `${a.handle} (${fmtFollowers(a.followers)} audience) published ${neg.length} negative mention${neg.length > 1 ? 's' : ''}${nar ? ` about "${nar.name}"` : ''} in the last 72h.`,
        detectedAt: neg[0].publishedAt, metrics: { followers: a.followers, mentions: list.length, negative: neg.length, engagement: Math.round(list.reduce((s, m) => s + engagementOf(m), 0)) }, mentionIds: neg.map((m) => m.id),
      });
    }
  }

  // 5) Competitive movement: competitor share of voice over 72h vs the prior 14 days.
  for (const e of entities.filter((x) => x.kind === 'competitor')) {
    const eps = episodes(now, (end) => {
      const all = inWindow(mentions, end - 3 * DAY, end);
      const base = inWindow(mentions, end - 17 * DAY, end - 3 * DAY);
      if (all.length < 30) return null;
      const cur = all.filter((m) => m.entity === e.id);
      const sovNow = (cur.length / all.length) * 100;
      const sovBase = (base.filter((m) => m.entity === e.id).length / Math.max(base.length, 1)) * 100;
      const shift = sovNow - sovBase;
      return shift >= cfg.sovShiftPts ? { value: shift, shift: round(shift, 1), sovNow: round(sovNow, 1), sovBase: round(sovBase, 1), list: cur } : null;
    });
    for (const ep of eps) {
      const p = ep.peak;
      alerts.push({
        key: `competitive:${e.id}:${ep.start - DAY}`, keyTs: ep.start - DAY, type: 'competitive', entity: e.id, severity: p.shift >= 10 ? 'high' : 'medium',
        title: `Competitive movement: ${nameOf[e.id]} share of voice +${p.shift} pts`,
        detail: `${nameOf[e.id]} share of voice rose to ${p.sovNow}% over 72h (baseline ${p.sovBase}%).`,
        detectedAt: iso(ep.at), metrics: { sov: p.sovNow, baseline: p.sovBase, shift: p.shift }, mentionIds: topIds(p.list), narrativeId: dominantNarrative(p.list),
      });
    }
  }

  // 6) Priority keyword rules: matches within 24h of each other form one episode.
  for (const rule of rules.filter((r) => r.active !== false)) {
    const hits = inWindow(rule.entity ? byEntity[rule.entity] || [] : mentions, now - 7 * DAY, now).filter((m) => ruleMatches(rule, m)).sort((a, b) => ts(a) - ts(b));
    const clusters = [];
    for (const m of hits) {
      const last = clusters[clusters.length - 1];
      if (last && ts(m) - ts(last[last.length - 1]) <= DAY) last.push(m);
      else clusters.push([m]);
    }
    for (const list of clusters) {
      const d = align(ts(list[0]));
      alerts.push({
        key: `keyword:${rule.id}:${d}`, keyTs: d, type: 'keyword', entity: rule.entity || null, ruleId: rule.id, severity: rule.severity,
        title: `Priority keyword: ${rule.name}`,
        detail: `${list.length} mention${list.length > 1 ? 's' : ''} matched "${matchedTerms(rule, list).join('", "')}".`,
        detectedAt: list[0].publishedAt, metrics: { matches: list.length }, mentionIds: list.map((m) => m.id).slice(0, 10), narrativeId: dominantNarrative(list),
      });
    }
  }

  return alerts.sort((a, b) => Date.parse(b.detectedAt) - Date.parse(a.detectedAt));
}

export function ruleMatches(rule, m) {
  const t = `${m.title || ''} ${m.text}`.toLowerCase();
  return rule.terms.some((term) => new RegExp(`(^|[^a-z0-9])${term.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`).test(t));
}

function matchedTerms(rule, list) {
  return rule.terms.filter((term) => list.some((m) => ruleMatches({ terms: [term] }, m)));
}

function dominantNarrative(list) {
  const c = new Map();
  for (const m of list) if (m.narrativeId) c.set(m.narrativeId, (c.get(m.narrativeId) || 0) + 1);
  let best = null;
  for (const [k, v] of c) if (!best || v > best[1]) best = [k, v];
  return best ? best[0] : null;
}

const fmtNet = (n) => `${n > 0 ? '+' : ''}${Math.round(n * 100)}`;
const fmtFollowers = (n) => (n >= 1e6 ? `${round(n / 1e6, 1)}M` : n >= 1e3 ? `${round(n / 1e3, 0)}K` : String(n));
