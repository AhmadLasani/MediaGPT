// MediaGPT core service: data store, enrichment pipeline, detection,
// response-management workflow, RBAC and audit trail.
import fs from 'node:fs';
import path from 'node:path';
import { DAY, HOUR, iso, csvEscape, HttpError, rng } from './util.js';
import { sentiment, detectEntities, classifyNarrative, matchQueries, hashtags } from './nlp.js';
import { detect, STEP } from './detect.js';
import * as M from './metrics.js';
import { ENTITIES, NARRATIVES, USERS, TEAMS, SOURCES, DEFAULT_QUERIES, DEFAULT_ALERT_RULES, DEFAULT_SETTINGS, BRAND, generate, seedCases, makeRawMention } from './seed.js';
import { answer as copilotAnswer, SUGGESTED_QUESTIONS } from './copilot.js';
import { suggest } from './respond.js';
import { executiveBrief, prReport, newsletter, digest, renderHtml } from './reports.js';

export { HttpError };

const DB_VERSION = 1;
const STATUSES = ['open', 'in_progress', 'awaiting_approval', 'approved', 'responded', 'resolved'];
const PRIORITIES = ['P1', 'P2', 'P3', 'P4'];
const SEV_RANK = { critical: 0, high: 1, medium: 2, low: 3 };

const PERMISSIONS = {
  analyst: ['read', 'copilot', 'alert.triage', 'case.create', 'case.edit', 'case.submit', 'case.publish', 'case.resolve', 'mention.ingest', 'report.generate', 'query.edit'],
  manager: ['read', 'copilot', 'alert.triage', 'case.create', 'case.edit', 'case.submit', 'case.publish', 'case.resolve', 'case.assign', 'case.escalate', 'case.approve', 'mention.ingest', 'report.generate', 'query.edit', 'rule.edit'],
  executive: ['read', 'copilot', 'alert.triage', 'case.escalate', 'case.approve', 'report.generate'],
  admin: ['*'],
};

const stripPrivate = (k, v) => (k.startsWith('_') ? undefined : v);

export class MediaGPT {
  /**
   * @param {object} o
   * @param {string|null} o.file  JSON file for persistence (null = in-memory)
   * @param {() => number} [o.clock]  injectable clock for tests
   */
  constructor({ file = null, clock = null, seed = 7 } = {}) {
    this.file = file;
    this.clock = clock;
    this.seed = seed;
    this.narratives = NARRATIVES;
    this.narrativeById = Object.fromEntries(NARRATIVES.map((n) => [n.id, n]));
    let loaded = null;
    if (file && fs.existsSync(file)) {
      try { loaded = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { loaded = null; }
    }
    if (loaded?.version === DB_VERSION) {
      this.db = loaded;
      this.index();
      this.rebase();
    } else {
      this.reset({ persist: true });
    }
  }

  now() { return this.clock ? this.clock() : Date.now(); }

  // ---------------- persistence ----------------
  save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.db, stripPrivate));
    fs.renameSync(tmp, this.file);
  }

  index() {
    this.authorsById = Object.fromEntries(this.db.authors.map((a) => [a.id, a]));
    this.usersById = Object.fromEntries(this.db.users.map((u) => [u.id, u]));
    this.mentionById = new Map(this.db.mentions.map((m) => [m.id, m]));
  }

  reset({ persist = true } = {}) {
    const now = this.now();
    const { authors, raws } = generate({ now, seed: this.seed });
    this.db = {
      version: DB_VERSION,
      anchor: now,
      seq: { mention: 0, alert: 0, case: 1003, audit: 0 },
      entities: ENTITIES,
      authors,
      users: USERS,
      queries: structuredClone(DEFAULT_QUERIES),
      rules: structuredClone(DEFAULT_ALERT_RULES),
      settings: structuredClone(DEFAULT_SETTINGS),
      mentions: [],
      alerts: [],
      cases: seedCases(now),
      copilot: [],
      audit: [],
    };
    this.index();
    for (const raw of raws) this.addMention(raw);
    // Seed cases reference real mentions from their narratives.
    for (const c of this.db.cases) {
      c.mentionIds = this.db.mentions.filter((m) => m.narrativeId === c.narrativeId).slice(-4).map((m) => m.id);
      c.dueAt = iso(Date.parse(c.createdAt) + this.db.settings.slaHours[c.priority] * HOUR);
      c.updatedAt = c.resolvedAt || c.createdAt;
      c.timeline = [{ at: c.createdAt, by: c.ownerId, action: 'created', note: 'Case opened from narrative monitoring.' }];
      if (c.status === 'awaiting_approval') {
        c.submittedBy = c.ownerId;
        c.approvals = this.db.settings.approvals[c.priority].map((s) => ({ ...s, decision: 'pending' }));
        c.timeline.push({ at: iso(Date.parse(c.createdAt) + HOUR), by: c.ownerId, action: 'submitted', note: 'Draft submitted for approval.' });
      }
      if (c.status === 'resolved') c.timeline.push({ at: c.resolvedAt, by: c.ownerId, action: 'resolved', note: 'FAQ published and replies sent.' });
    }
    this.refreshAlerts();
    // Older alerts were already triaged by the team.
    for (const a of this.db.alerts) if (Date.parse(a.detectedAt) < now - 4 * DAY) { a.status = 'acknowledged'; a.triagedBy = 'u-aisha'; }
    this.log('system', 'workspace.seeded', null, `Demo workspace generated with ${this.db.mentions.length} mentions.`);
    if (persist) this.save();
    return { ok: true, mentions: this.db.mentions.length };
  }

  /**
   * Keep the demo story current: if the stored data is older than one
   * detection step, shift every timestamp forward by whole steps.
   */
  rebase() {
    const delta = Math.floor((this.now() - this.db.anchor) / STEP) * STEP;
    if (delta < STEP) return 0;
    const shift = (v) => (v ? iso(Date.parse(v) + delta) : v);
    for (const m of this.db.mentions) { m.publishedAt = shift(m.publishedAt); delete m._ts; }
    for (const a of this.db.alerts) {
      a.detectedAt = shift(a.detectedAt);
      if (a.keyTs != null) { a.key = a.key.replace(new RegExp(`${a.keyTs}$`), String(a.keyTs + delta)); a.keyTs += delta; }
    }
    for (const c of this.db.cases) {
      for (const k of ['createdAt', 'updatedAt', 'resolvedAt', 'dueAt', 'respondedAt']) c[k] = shift(c[k]);
      for (const t of c.timeline || []) t.at = shift(t.at);
      for (const a of c.approvals || []) a.at = shift(a.at);
    }
    for (const e of this.db.audit) e.at = shift(e.at);
    for (const q of this.db.copilot) q.at = shift(q.at);
    this.db.anchor += delta;
    this.refreshAlerts();
    this.save();
    return delta;
  }

  // ---------------- RBAC & audit ----------------
  user(id) {
    const u = this.usersById[id || 'u-aisha'];
    if (!u) throw new HttpError(401, `Unknown user "${id}"`);
    return u;
  }

  can(user, perm) {
    const p = PERMISSIONS[user.role] || [];
    return p.includes('*') || p.includes(perm);
  }

  require(user, perm) {
    if (!this.can(user, perm)) throw new HttpError(403, `${user.name} (${user.role}) does not have the "${perm}" permission`);
  }

  log(actor, action, target, detail = '') {
    this.db.audit.push({ id: `AUD-${++this.db.seq.audit}`, at: iso(this.now()), actor: actor?.id || actor, action, target, detail });
    if (this.db.audit.length > 2000) this.db.audit.splice(0, this.db.audit.length - 2000);
  }

  // ---------------- enrichment pipeline ----------------
  enrich(raw) {
    const text = `${raw.title ? `${raw.title}. ` : ''}${raw.text}`;
    const entities = raw.entity ? [raw.entity] : detectEntities(text, this.db.entities);
    // Primary entity: explicit > the seed storyline's entity > whichever detected
    // entity has the strongest narrative match (ties go to the first detected).
    const seedEntity = raw.seedNarrative ? this.narrativeById[raw.seedNarrative]?.entity : null;
    const candidates = raw.entity ? [raw.entity] : seedEntity ? [seedEntity] : entities;
    let entity = null;
    let nar = { id: null, score: 0, matched: [] };
    for (const e of candidates) {
      const c = classifyNarrative(text, e, this.narratives);
      if (!entity || c.score > nar.score) { entity = e; nar = c; }
    }
    const s = sentiment(text);
    return {
      entity,
      entities: [...new Set([...(entity ? [entity] : []), ...entities])],
      narrativeId: nar.id,
      narrativeMatch: nar.matched,
      sentiment: s,
      queries: matchQueries(text, this.db.queries),
      hashtags: hashtags(text),
    };
  }

  addMention(raw) {
    if (!raw || typeof raw.text !== 'string' || !raw.text.trim()) throw new HttpError(400, 'Each mention needs a non-empty "text"');
    if (raw.source && !SOURCES[raw.source]) throw new HttpError(400, `Unknown source "${raw.source}". Use one of: ${Object.keys(SOURCES).join(', ')}`);
    let authorId = raw.authorId;
    if (!authorId || !this.authorsById[authorId]) {
      const handle = String(raw.author || raw.handle || '@anonymous').slice(0, 60);
      const existing = this.db.authors.find((a) => a.handle.toLowerCase() === handle.toLowerCase());
      if (existing) authorId = existing.id;
      else {
        const a = { id: `a-x${this.db.authors.length}`, handle, name: raw.authorName || null, type: raw.authorType || 'consumer', source: raw.source || 'x', followers: Math.max(0, Number(raw.followers) || 100), verified: false };
        this.db.authors.push(a);
        this.authorsById[a.id] = a;
        authorId = a.id;
      }
    }
    const author = this.authorsById[authorId];
    const m = {
      id: `M-${String(++this.db.seq.mention).padStart(5, '0')}`,
      source: raw.source || author.source || 'x',
      authorId,
      title: raw.title || null,
      text: raw.text.trim().slice(0, 4000),
      url: raw.url || null,
      publishedAt: raw.publishedAt ? iso(Date.parse(raw.publishedAt)) : iso(this.now()),
      location: raw.location || null,
      mediaType: raw.mediaType || 'text',
      lang: raw.lang || 'en',
      reach: Number(raw.reach) || author.followers,
      engagement: { likes: 0, shares: 0, comments: 0, ...(raw.engagement || {}) },
      ...(raw.seedNarrative ? { seedNarrative: raw.seedNarrative } : {}),
    };
    if (Number.isNaN(Date.parse(m.publishedAt))) throw new HttpError(400, 'Invalid publishedAt');
    Object.assign(m, this.enrich({ ...raw, text: m.text, title: m.title }));
    this.db.mentions.push(m);
    this.mentionById.set(m.id, m);
    return m;
  }

  /** Ingest one or many mentions from a connector/webhook, then re-run detection. */
  ingest(body, actorId) {
    const actor = this.user(actorId);
    this.require(actor, 'mention.ingest');
    const items = Array.isArray(body) ? body : Array.isArray(body?.mentions) ? body.mentions : [body];
    if (!items.length || items.length > 500) throw new HttpError(400, 'Send between 1 and 500 mentions');
    const created = items.map((r) => this.addMention(r));
    this.db.mentions.sort((a, b) => Date.parse(a.publishedAt) - Date.parse(b.publishedAt));
    const fresh = this.refreshAlerts();
    this.log(actor, 'mention.ingested', null, `${created.length} mention(s) ingested; ${fresh.length} new alert(s).`);
    this.save();
    return { created, newAlerts: fresh };
  }

  /** "Always-on listening" demo: synthesise a burst of new live mentions from the current story mix. */
  simulate(n = 8, actorId) {
    const actor = this.user(actorId);
    this.require(actor, 'mention.ingest');
    n = Math.min(Math.max(1, Number(n) || 8), 50);
    const r = rng(this.db.seq.mention + 99);
    const now = this.now();
    const live = M.inWindow(this.db.mentions, now - 6 * HOUR, now);
    const mix = live.length ? live : this.db.mentions.slice(-50);
    const pool = this.db.authors.filter((a) => a.type === 'consumer' || a.type === 'creator');
    const raws = [];
    for (let i = 0; i < n; i++) {
      const sample = mix[Math.floor(r() * mix.length)];
      const nar = this.narrativeById[sample.narrativeId || sample.seedNarrative] || this.narratives.find((x) => x.entity === sample.entity) || this.narratives[0];
      const author = pool[Math.floor(r() * pool.length)];
      raws.push(makeRawMention(r, { narrative: nar, ts: now - Math.floor(r() * 5 * 60e3), author }));
    }
    const res = this.ingest(raws.map((x) => ({ ...x, seedNarrative: undefined })), actor.id);
    return res;
  }

  // ---------------- alerts ----------------
  ctx() {
    return {
      mentions: this.db.mentions,
      entities: this.db.entities,
      narratives: this.narratives,
      authorsById: this.authorsById,
      usersById: this.usersById,
      now: this.now(),
      brand: this.db.settings.brand,
      alerts: this.db.alerts,
      cases: this.db.cases,
      settings: this.db.settings,
    };
  }

  refreshAlerts() {
    const found = detect({ mentions: this.db.mentions, entities: this.db.entities, narratives: this.narratives, authorsById: this.authorsById, rules: this.db.rules, settings: this.db.settings, now: this.now() });
    const byKey = new Map(this.db.alerts.map((a) => [a.key, a]));
    const fresh = [];
    for (const f of found) {
      const ex = byKey.get(f.key);
      if (ex) Object.assign(ex, { ...f, id: ex.id, status: ex.status, caseId: ex.caseId, triagedBy: ex.triagedBy, detectedAt: ex.detectedAt < f.detectedAt ? ex.detectedAt : f.detectedAt });
      else {
        const a = { id: `ALT-${String(++this.db.seq.alert).padStart(4, '0')}`, status: 'new', caseId: null, ...f };
        this.db.alerts.push(a);
        fresh.push(a);
      }
    }
    this.db.alerts.sort((a, b) => Date.parse(b.detectedAt) - Date.parse(a.detectedAt));
    return fresh;
  }

  listAlerts(q = {}) {
    let list = this.db.alerts;
    if (q.status) list = list.filter((a) => (q.status === 'open' ? ['new', 'acknowledged'].includes(a.status) : a.status === q.status));
    if (q.severity) list = list.filter((a) => a.severity === q.severity);
    if (q.type) list = list.filter((a) => a.type === q.type);
    if (q.entity) list = list.filter((a) => a.entity === q.entity);
    return list.map((a) => this.viewAlert(a));
  }

  alert(id) {
    const a = this.db.alerts.find((x) => x.id === id);
    if (!a) throw new HttpError(404, `Alert ${id} not found`);
    return a;
  }

  viewAlert(a, full = false) {
    const v = { ...a, narrativeName: this.narrativeById[a.narrativeId]?.name || null, entityName: this.db.entities.find((e) => e.id === a.entity)?.name || null };
    if (full) v.mentions = a.mentionIds.map((id) => this.viewMention(this.mentionById.get(id))).filter(Boolean);
    return v;
  }

  triageAlert(id, { status, note } = {}, actorId) {
    const actor = this.user(actorId);
    this.require(actor, 'alert.triage');
    const a = this.alert(id);
    if (!['acknowledged', 'dismissed', 'new'].includes(status)) throw new HttpError(400, 'status must be acknowledged, dismissed or new');
    a.status = status;
    a.triagedBy = actor.id;
    this.log(actor, `alert.${status}`, id, note || '');
    this.save();
    return this.viewAlert(a);
  }

  // ---------------- mentions ----------------
  viewMention(m) {
    if (!m) return null;
    const a = this.authorsById[m.authorId];
    return { ...m, author: a ? { id: a.id, handle: a.handle, name: a.name, type: a.type, followers: a.followers, verified: a.verified, outlet: a.outlet || null } : null, narrativeName: this.narrativeById[m.narrativeId]?.name || null };
  }

  listMentions(q = {}) {
    const now = this.now();
    const days = Number(q.days) || null;
    const f = { ...q, from: q.from ? Date.parse(q.from) : days ? now - days * DAY : undefined, to: q.to ? Date.parse(q.to) : undefined };
    let list = M.filterMentions(this.db.mentions, f);
    if (q.ids) { const ids = new Set(String(q.ids).split(',')); list = this.db.mentions.filter((m) => ids.has(m.id)); }
    const sort = q.sort || 'recent';
    list = [...list].sort(sort === 'engagement' ? (a, b) => M.engagementOf(b) - M.engagementOf(a) : sort === 'reach' ? (a, b) => b.reach - a.reach : (a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
    const limit = Math.min(Number(q.limit) || 50, 500);
    const offset = Number(q.offset) || 0;
    return { total: list.length, offset, limit, items: list.slice(offset, offset + limit).map((m) => this.viewMention(m)) };
  }

  mention(id) {
    const m = this.mentionById.get(id);
    if (!m) throw new HttpError(404, `Mention ${id} not found`);
    const v = this.viewMention(m);
    v.explanation = {
      sentiment: `Scored ${m.sentiment.score} from ${m.sentiment.terms.length ? m.sentiment.terms.map((t) => `"${t.term}" (${t.weight > 0 ? '+' : ''}${t.weight})`).join(', ') : 'no sentiment-bearing terms'}.`,
      narrative: m.narrativeId ? `Matched narrative signals: ${m.narrativeMatch.join(', ')}.` : 'No narrative signals matched; filed as general conversation.',
      entities: `Detected entities: ${m.entities.map((e) => this.db.entities.find((x) => x.id === e)?.name).join(', ') || 'none'}.`,
      queries: m.queries.map((q) => this.db.queries.find((x) => x.id === q)?.name).filter(Boolean),
    };
    v.cases = this.db.cases.filter((c) => c.mentionIds.includes(id)).map((c) => ({ id: c.id, title: c.title, status: c.status }));
    return v;
  }

  // ---------------- analytics ----------------
  window(q) {
    const now = this.now();
    const days = Math.min(Math.max(Number(q.days) || 7, 1), 30);
    return { now, days, from: now - days * DAY };
  }

  overview(q = {}) {
    const { now, days, from } = this.window(q);
    const entity = q.entity || this.db.settings.brand;
    const all = this.db.mentions;
    const mine = all.filter((m) => m.entity === entity);
    const cur = M.inWindow(mine, from, now);
    const prev = M.inWindow(mine, from - days * DAY, from);
    const size = days <= 2 ? HOUR : days <= 7 ? 6 * HOUR : DAY;
    return {
      entity, days, generatedAt: iso(now),
      kpis: M.summary(cur, prev),
      series: M.series(cur, { from, to: now, size }),
      bucket: size === HOUR ? 'hour' : size === DAY ? 'day' : '6h',
      shareOfVoice: M.shareOfVoice(M.inWindow(all, from, now), this.db.entities),
      narratives: M.narrativeStats(all, this.narratives.filter((n) => n.entity === entity), { now, days }).slice(0, 6),
      sources: M.breakdown(cur, (m) => m.source).map((s) => ({ ...s, name: SOURCES[s.key]?.name || s.key })),
      locations: M.breakdown(cur.filter((m) => m.location), (m) => m.location).slice(0, 8),
      influencers: M.influencers(cur, this.authorsById, 6).map(slimInfluencer),
      hashtags: M.topHashtags(cur, 10),
      keywords: M.topKeywords(cur, this.db.entities, 18),
      alerts: this.db.alerts.filter((a) => a.status === 'new').sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity] || Date.parse(b.detectedAt) - Date.parse(a.detectedAt)).slice(0, 6).map((a) => this.viewAlert(a)),
      openCases: this.db.cases.filter((c) => c.status !== 'resolved').length,
      latest: [...cur].sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt)).slice(0, 6).map((m) => this.viewMention(m)),
    };
  }

  narrativesView(q = {}) {
    const { now, days } = this.window({ days: q.days || 30 });
    const list = this.narratives.filter((n) => !q.entity || n.entity === q.entity);
    return M.narrativeStats(this.db.mentions, list, { now, days }).map((s) => ({ ...s, entityName: this.db.entities.find((e) => e.id === s.entity)?.name, topAuthors: s.topAuthorIds.map((id) => this.authorsById[id]?.handle), openCase: this.db.cases.find((c) => c.narrativeId === s.id && c.status !== 'resolved')?.id || null }));
  }

  narrative(id, q = {}) {
    const n = this.narrativeById[id];
    if (!n || !n.name) throw new HttpError(404, `Narrative ${id} not found`);
    const { now, days, from } = this.window({ days: q.days || 14 });
    const all = this.db.mentions.filter((m) => m.narrativeId === id);
    const cur = M.inWindow(all, from, now);
    const stat = M.narrativeStats(this.db.mentions, [n], { now, days })[0];
    return {
      ...stat,
      entityName: this.db.entities.find((e) => e.id === n.entity)?.name,
      playbook: n.playbook || null,
      series: M.series(cur, { from, to: now, size: days <= 3 ? HOUR : days <= 7 ? 6 * HOUR : DAY }),
      sources: M.breakdown(cur, (m) => m.source),
      locations: M.breakdown(cur.filter((m) => m.location), (m) => m.location).slice(0, 6),
      influencers: M.influencers(cur, this.authorsById, 8).map(slimInfluencer),
      keywords: M.topKeywords(cur, this.db.entities, 12),
      mentions: [...cur].sort((a, b) => M.engagementOf(b) - M.engagementOf(a)).slice(0, 12).map((m) => this.viewMention(m)),
      cases: this.db.cases.filter((c) => c.narrativeId === id).map((c) => ({ id: c.id, title: c.title, status: c.status, priority: c.priority })),
      alerts: this.db.alerts.filter((a) => a.narrativeId === id).sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity] || Date.parse(b.detectedAt) - Date.parse(a.detectedAt)).slice(0, 6).map((a) => this.viewAlert(a)),
    };
  }

  competitors(q = {}) {
    const { now, days, from } = this.window(q);
    const cur = M.inWindow(this.db.mentions, from, now);
    const prev = M.inWindow(this.db.mentions, from - days * DAY, from);
    const size = days <= 7 ? 6 * HOUR : DAY;
    const prevSov = Object.fromEntries(M.shareOfVoice(prev, this.db.entities).map((s) => [s.entity, s]));
    return {
      days,
      shareOfVoice: M.shareOfVoice(cur, this.db.entities).map((s) => ({ ...s, shareChange: Math.round((s.share - (prevSov[s.entity]?.share || 0)) * 10) / 10, netChange: Math.round((s.net - (prevSov[s.entity]?.net || 0)) * 100) / 100 })),
      series: this.db.entities.map((e) => ({ entity: e.id, name: e.name, color: e.color, points: M.series(cur.filter((m) => m.entity === e.id), { from, to: now, size }).map((b) => ({ t: b.end, total: b.total, net: b.net })) })),
      narratives: this.db.entities.map((e) => ({ entity: e.id, top: M.narrativeStats(this.db.mentions, this.narratives.filter((n) => n.entity === e.id), { now, days }).slice(0, 3).map(({ id, name, count, net, growth }) => ({ id, name, count, net, growth })) })),
      sources: this.db.entities.map((e) => ({ entity: e.id, sources: M.breakdown(cur.filter((m) => m.entity === e.id), (m) => m.source).slice(0, 5) })),
      alerts: this.db.alerts.filter((a) => a.type === 'competitive').map((a) => this.viewAlert(a)),
    };
  }

  influencersView(q = {}) {
    const { now, from } = this.window(q);
    let list = M.inWindow(this.db.mentions, from, now);
    if (q.entity) list = list.filter((m) => m.entity === q.entity);
    if (q.narrative) list = list.filter((m) => m.narrativeId === q.narrative);
    if (q.sentiment) list = list.filter((m) => m.sentiment.label === q.sentiment);
    let rows = M.influencers(list, this.authorsById, 200);
    if (q.type) rows = rows.filter((r) => r.author.type === q.type);
    return rows.slice(0, Number(q.limit) || 25).map(slimInfluencer);
  }

  author(id) {
    const a = this.authorsById[id];
    if (!a) throw new HttpError(404, `Author ${id} not found`);
    const list = this.db.mentions.filter((m) => m.authorId === id);
    return { ...a, stats: M.summary(list), mentions: [...list].reverse().slice(0, 20).map((m) => this.viewMention(m)) };
  }

  // ---------------- copilot ----------------
  async ask(question, actorId) {
    const actor = this.user(actorId);
    this.require(actor, 'copilot');
    if (!question || !String(question).trim()) throw new HttpError(400, 'Ask a question');
    const res = await copilotAnswer(String(question).slice(0, 500), this.ctx());
    this.db.copilot.push({ at: iso(this.now()), by: actor.id, question: res.question, intent: res.intent, engine: res.engine });
    if (this.db.copilot.length > 200) this.db.copilot.shift();
    this.log(actor, 'copilot.asked', null, res.question);
    this.save();
    return res;
  }

  // ---------------- cases (response management) ----------------
  case(id) {
    const c = this.db.cases.find((x) => x.id === id);
    if (!c) throw new HttpError(404, `Case ${id} not found`);
    return c;
  }

  viewCase(c, full = false) {
    const v = {
      ...c,
      ownerName: this.usersById[c.ownerId]?.name || null,
      narrativeName: this.narrativeById[c.narrativeId]?.name || null,
      overdue: !['resolved', 'responded'].includes(c.status) && c.dueAt && Date.parse(c.dueAt) < this.now(),
      pendingStep: (c.approvals || []).find((a) => a.decision === 'pending') || null,
    };
    if (full) {
      v.mentions = c.mentionIds.map((id) => this.viewMention(this.mentionById.get(id))).filter(Boolean);
      v.timeline = (c.timeline || []).map((t) => ({ ...t, byName: this.usersById[t.by]?.name || t.by }));
      v.approvals = (c.approvals || []).map((a) => ({ ...a, byName: this.usersById[a.by]?.name || null }));
      v.playbook = this.narrativeById[c.narrativeId]?.playbook || null;
    }
    return v;
  }

  listCases(q = {}) {
    let list = this.db.cases;
    if (q.status) list = list.filter((c) => c.status === q.status);
    if (q.owner) list = list.filter((c) => c.ownerId === q.owner);
    if (q.priority) list = list.filter((c) => c.priority === q.priority);
    return [...list].sort((a, b) => PRIORITIES.indexOf(a.priority) - PRIORITIES.indexOf(b.priority) || Date.parse(b.createdAt) - Date.parse(a.createdAt)).map((c) => this.viewCase(c));
  }

  touch(c, actor, action, note = '') {
    const at = iso(this.now());
    c.updatedAt = at;
    c.timeline = c.timeline || [];
    c.timeline.push({ at, by: actor.id, action, note });
    this.log(actor, `case.${action}`, c.id, note);
  }

  createCase(body = {}, actorId) {
    const actor = this.user(actorId);
    this.require(actor, 'case.create');
    const alert = body.alertId ? this.alert(body.alertId) : null;
    const mentionIds = [...new Set([...(body.mentionIds || []), ...(alert?.mentionIds || [])])].filter((id) => this.mentionById.has(id));
    const narrativeId = body.narrativeId || alert?.narrativeId || this.mentionById.get(mentionIds[0])?.narrativeId || null;
    const nar = this.narrativeById[narrativeId];
    const priority = body.priority || (alert ? { critical: 'P1', high: 'P2', medium: 'P3', low: 'P4' }[alert.severity] : 'P3');
    if (!PRIORITIES.includes(priority)) throw new HttpError(400, 'priority must be P1-P4');
    const title = String(body.title || (alert ? alert.title : nar ? `Respond: ${nar.name}` : '')).trim();
    if (!title) throw new HttpError(400, 'A case needs a title (or an alert / narrative to derive one from)');
    const ownerId = body.ownerId || actor.id;
    if (!this.usersById[ownerId]) throw new HttpError(400, `Unknown owner ${ownerId}`);
    const now = this.now();
    const c = {
      id: `CASE-${++this.db.seq.case}`,
      title: title.slice(0, 160),
      narrativeId, alertId: alert?.id || null, mentionIds, priority, status: 'open',
      ownerId, team: body.team || nar?.team || this.usersById[ownerId].team,
      createdAt: iso(now), updatedAt: iso(now), dueAt: iso(now + this.db.settings.slaHours[priority] * HOUR),
      escalated: false, approvals: [], draft: null, timeline: [],
    };
    this.db.cases.push(c);
    this.touch(c, actor, 'created', body.note || (alert ? `Opened from alert ${alert.id}.` : ''));
    if (alert) { alert.status = 'case_opened'; alert.caseId = c.id; alert.triagedBy = actor.id; }
    this.save();
    return this.viewCase(c, true);
  }

  updateCase(id, body = {}, actorId) {
    const actor = this.user(actorId);
    const c = this.case(id);
    this.require(actor, 'case.edit');
    const changes = [];
    if (body.title) { c.title = String(body.title).slice(0, 160); changes.push('title'); }
    if (body.priority && body.priority !== c.priority) {
      if (!PRIORITIES.includes(body.priority)) throw new HttpError(400, 'priority must be P1-P4');
      changes.push(`priority ${c.priority} → ${body.priority}`);
      c.priority = body.priority;
      c.dueAt = iso(Date.parse(c.createdAt) + this.db.settings.slaHours[c.priority] * HOUR);
    }
    if (body.ownerId || body.team) {
      const newOwner = body.ownerId || c.ownerId;
      if (!this.usersById[newOwner]) throw new HttpError(400, `Unknown owner ${newOwner}`);
      if (newOwner !== actor.id || body.team) this.require(actor, 'case.assign');
      if (newOwner !== c.ownerId) changes.push(`owner → ${this.usersById[newOwner].name}`);
      c.ownerId = newOwner;
      if (body.team) { if (!TEAMS.includes(body.team)) throw new HttpError(400, `Unknown team ${body.team}`); c.team = body.team; changes.push(`team → ${body.team}`); }
    }
    if (body.status) {
      if (!['open', 'in_progress'].includes(body.status)) throw new HttpError(400, 'Use the workflow actions (submit, approve, publish, resolve) for other statuses');
      if (['awaiting_approval', 'approved'].includes(c.status)) throw new HttpError(409, `Case is ${c.status.replace('_', ' ')}; it cannot be moved back manually`);
      c.status = body.status;
      changes.push(`status → ${body.status}`);
    }
    if (Array.isArray(body.addMentionIds)) {
      for (const mid of body.addMentionIds) if (this.mentionById.has(mid) && !c.mentionIds.includes(mid)) c.mentionIds.push(mid);
      changes.push('mentions linked');
    }
    if (!changes.length && !body.comment) throw new HttpError(400, 'Nothing to update');
    this.touch(c, actor, body.comment && !changes.length ? 'commented' : 'updated', [changes.join(', '), body.comment].filter(Boolean).join('. '));
    this.save();
    return this.viewCase(c, true);
  }

  async suggestDraft(id, { mentionId, channel } = {}, actorId) {
    const actor = this.user(actorId);
    this.require(actor, 'case.edit');
    const c = this.case(id);
    if (['awaiting_approval', 'approved', 'responded', 'resolved'].includes(c.status)) throw new HttpError(409, `Draft is locked while the case is ${c.status.replace('_', ' ')}`);
    const target = this.mentionById.get(mentionId) || [...c.mentionIds].map((x) => this.mentionById.get(x)).filter(Boolean).sort((a, b) => b.reach - a.reach)[0] || null;
    const s = await suggest({ narrative: this.narrativeById[c.narrativeId], mention: target, author: target ? this.authorsById[target.authorId] : null, channel, brandName: this.db.entities.find((e) => e.id === this.db.settings.brand).name });
    c.draft = { text: s.text, channel: s.channel, generatedBy: s.generatedBy, editedBy: null, version: (c.draft?.version || 0) + 1, replyTo: target?.id || null, rationale: s.rationale };
    if (c.status === 'open') c.status = 'in_progress';
    this.touch(c, actor, 'draft_generated', `Suggested ${s.channel} response (${s.generatedBy}).`);
    this.save();
    return { ...this.viewCase(c, true), suggestion: s };
  }

  saveDraft(id, { text, channel } = {}, actorId) {
    const actor = this.user(actorId);
    this.require(actor, 'case.edit');
    const c = this.case(id);
    if (['awaiting_approval', 'approved', 'responded', 'resolved'].includes(c.status)) throw new HttpError(409, `Draft is locked while the case is ${c.status.replace('_', ' ')}`);
    if (!text || !String(text).trim()) throw new HttpError(400, 'Draft text is required');
    c.draft = { ...(c.draft || { generatedBy: 'human', version: 0 }), text: String(text).slice(0, 4000), channel: channel || c.draft?.channel || 'x', editedBy: actor.id, version: (c.draft?.version || 0) + 1 };
    if (c.status === 'open') c.status = 'in_progress';
    this.touch(c, actor, 'draft_edited', `Draft v${c.draft.version} saved.`);
    this.save();
    return this.viewCase(c, true);
  }

  submit(id, actorId) {
    const actor = this.user(actorId);
    this.require(actor, 'case.submit');
    const c = this.case(id);
    if (!c.draft?.text) throw new HttpError(409, 'Write or generate a draft before submitting for approval');
    if (!['open', 'in_progress'].includes(c.status)) throw new HttpError(409, `Case is ${c.status.replace('_', ' ')}`);
    const chain = this.db.settings.approvals[c.priority] || [];
    c.approvals = chain.map((s) => ({ ...s, decision: 'pending', by: null, at: null, note: null }));
    c.submittedBy = actor.id;
    c.status = chain.length ? 'awaiting_approval' : 'approved';
    this.touch(c, actor, 'submitted', chain.length ? `Approval chain: ${chain.map((s) => s.step).join(' → ')}.` : 'No approval required for this priority.');
    this.save();
    return this.viewCase(c, true);
  }

  decide(id, { decision, note } = {}, actorId) {
    const actor = this.user(actorId);
    this.require(actor, 'case.approve');
    const c = this.case(id);
    if (c.status !== 'awaiting_approval') throw new HttpError(409, 'Case is not awaiting approval');
    const step = c.approvals.find((a) => a.decision === 'pending');
    if (actor.role !== 'admin' && actor.role !== step.role) throw new HttpError(403, `"${step.step}" requires the ${step.role} role`);
    if (actor.role !== 'admin' && c.submittedBy === actor.id) throw new HttpError(403, 'Segregation of duties: the submitter cannot approve their own draft');
    if (!['approve', 'reject'].includes(decision)) throw new HttpError(400, 'decision must be approve or reject');
    Object.assign(step, { decision: decision === 'approve' ? 'approved' : 'rejected', by: actor.id, at: iso(this.now()), note: note || null });
    if (decision === 'reject') {
      c.status = 'in_progress';
      this.touch(c, actor, 'rejected', `${step.step}: ${note || 'changes requested'}`);
    } else if (c.approvals.every((a) => a.decision === 'approved')) {
      c.status = 'approved';
      this.touch(c, actor, 'approved', `${step.step} approved. Ready to publish.`);
    } else {
      this.touch(c, actor, 'step_approved', `${step.step} approved${note ? `: ${note}` : ''}.`);
    }
    this.save();
    return this.viewCase(c, true);
  }

  publish(id, actorId) {
    const actor = this.user(actorId);
    this.require(actor, 'case.publish');
    const c = this.case(id);
    if (c.status !== 'approved') throw new HttpError(409, 'Only approved drafts can be published');
    c.status = 'responded';
    c.respondedAt = iso(this.now());
    this.touch(c, actor, 'responded', `Response published to ${c.draft.channel}${c.draft.replyTo ? ` in reply to ${c.draft.replyTo}` : ''}.`);
    this.save();
    return this.viewCase(c, true);
  }

  escalate(id, { to, note } = {}, actorId) {
    const actor = this.user(actorId);
    this.require(actor, 'case.escalate');
    const c = this.case(id);
    const target = this.usersById[to] || this.db.users.find((u) => u.role === 'executive');
    c.escalated = true;
    c.escalatedTo = target.id;
    const before = c.priority;
    if (c.priority !== 'P1') c.priority = PRIORITIES[PRIORITIES.indexOf(c.priority) - 1];
    c.dueAt = iso(Math.min(Date.parse(c.dueAt), this.now() + this.db.settings.slaHours[c.priority] * HOUR));
    this.touch(c, actor, 'escalated', `Escalated to ${target.name}${before !== c.priority ? ` (priority ${before} → ${c.priority})` : ''}${note ? `: ${note}` : ''}.`);
    this.save();
    return this.viewCase(c, true);
  }

  resolve(id, { note } = {}, actorId) {
    const actor = this.user(actorId);
    this.require(actor, 'case.resolve');
    const c = this.case(id);
    if (c.status === 'awaiting_approval') throw new HttpError(409, 'Finish or withdraw the approval first');
    c.status = 'resolved';
    c.resolvedAt = iso(this.now());
    this.touch(c, actor, 'resolved', note || '');
    if (c.alertId) { const a = this.db.alerts.find((x) => x.id === c.alertId); if (a) a.status = 'resolved'; }
    this.save();
    return this.viewCase(c, true);
  }

  // ---------------- configuration ----------------
  upsertQuery(body = {}, actorId) {
    const actor = this.user(actorId);
    this.require(actor, 'query.edit');
    const terms = (body.terms || []).map((t) => String(t).trim().toLowerCase()).filter(Boolean);
    if (!body.name || !terms.length) throw new HttpError(400, 'A query needs a name and at least one term');
    let q = body.id && this.db.queries.find((x) => x.id === body.id);
    if (q) Object.assign(q, { name: body.name, terms, exclude: body.exclude || [], kind: body.kind || q.kind, active: body.active !== false });
    else { q = { id: `q-${Date.now().toString(36)}`, name: String(body.name).slice(0, 80), kind: body.kind || 'topic', terms, exclude: (body.exclude || []).map((t) => String(t).toLowerCase()), active: body.active !== false }; this.db.queries.push(q); }
    for (const m of this.db.mentions) m.queries = matchQueries(`${m.title ? `${m.title}. ` : ''}${m.text}`, this.db.queries);
    this.log(actor, 'query.saved', q.id, `${q.name}: ${q.terms.join(', ')}`);
    this.save();
    return { ...q, matches: this.db.mentions.filter((m) => m.queries.includes(q.id)).length };
  }

  deleteQuery(id, actorId) {
    const actor = this.user(actorId);
    this.require(actor, 'query.edit');
    const i = this.db.queries.findIndex((q) => q.id === id);
    if (i < 0) throw new HttpError(404, 'Query not found');
    this.db.queries.splice(i, 1);
    for (const m of this.db.mentions) m.queries = m.queries.filter((q) => q !== id);
    this.log(actor, 'query.deleted', id);
    this.save();
    return { ok: true };
  }

  upsertRule(body = {}, actorId) {
    const actor = this.user(actorId);
    this.require(actor, 'rule.edit');
    const terms = (body.terms || []).map((t) => String(t).trim().toLowerCase()).filter(Boolean);
    if (!body.name || !terms.length) throw new HttpError(400, 'A rule needs a name and at least one term');
    if (body.severity && !['critical', 'high', 'medium', 'low'].includes(body.severity)) throw new HttpError(400, 'Invalid severity');
    let r = body.id && this.db.rules.find((x) => x.id === body.id);
    if (r) Object.assign(r, { name: body.name, terms, severity: body.severity || r.severity, active: body.active !== false });
    else { r = { id: `rule-${Date.now().toString(36)}`, name: String(body.name).slice(0, 80), terms, severity: body.severity || 'high', entity: body.entity || this.db.settings.brand, active: body.active !== false }; this.db.rules.push(r); }
    const fresh = this.refreshAlerts();
    this.log(actor, 'rule.saved', r.id, `${r.name}: ${r.terms.join(', ')}`);
    this.save();
    return { ...r, newAlerts: fresh.length };
  }

  updateSettings(body = {}, actorId) {
    const actor = this.user(actorId);
    this.require(actor, 'settings.edit');
    const s = this.db.settings;
    if (body.detection) for (const [k, v] of Object.entries(body.detection)) if (k in s.detection && Number.isFinite(Number(v))) s.detection[k] = Number(v);
    if (body.approvals) {
      for (const [p, chain] of Object.entries(body.approvals)) {
        if (!PRIORITIES.includes(p) || !Array.isArray(chain)) throw new HttpError(400, 'approvals must map P1-P4 to arrays of {step, role}');
        for (const st of chain) if (!st.step || !['manager', 'executive', 'admin'].includes(st.role)) throw new HttpError(400, 'Each approval step needs a name and a role of manager, executive or admin');
        s.approvals[p] = chain.map((x) => ({ step: String(x.step), role: x.role }));
      }
    }
    if (body.slaHours) for (const [p, v] of Object.entries(body.slaHours)) if (PRIORITIES.includes(p) && Number(v) > 0) s.slaHours[p] = Number(v);
    if (body.digest) Object.assign(s.digest, body.digest);
    const fresh = this.refreshAlerts();
    this.log(actor, 'settings.updated', null, Object.keys(body).join(', '));
    this.save();
    return { settings: s, newAlerts: fresh.length };
  }

  // ---------------- reports & export ----------------
  report(type, q = {}, actorId) {
    const actor = this.user(actorId);
    this.require(actor, 'report.generate');
    const ctx = this.ctx();
    const days = Math.min(Math.max(Number(q.days) || (type === 'brief' ? 1 : 7), 1), 30);
    const r = type === 'brief' ? executiveBrief(ctx, days) : type === 'pr' ? prReport(ctx, days) : type === 'newsletter' ? newsletter(ctx, days) : type === 'digest' ? digest(ctx) : null;
    if (!r) throw new HttpError(404, `Unknown report type ${type}`);
    this.log(actor, 'report.generated', type, `${days} day(s)`);
    return r;
  }

  reportHtml(type, q, actorId) {
    return renderHtml(this.report(type, q, actorId));
  }

  exportCsv(q = {}) {
    const { items } = this.listMentions({ ...q, limit: 500 });
    const cols = ['id', 'publishedAt', 'source', 'entity', 'author', 'followers', 'title', 'text', 'sentiment', 'score', 'narrative', 'location', 'reach', 'likes', 'shares', 'comments'];
    const rows = items.map((m) => [m.id, m.publishedAt, m.source, m.entity, m.author?.handle, m.author?.followers, m.title, m.text, m.sentiment.label, m.sentiment.score, m.narrativeName, m.location, m.reach, m.engagement.likes, m.engagement.shares, m.engagement.comments]);
    return [cols, ...rows].map((r) => r.map(csvEscape).join(',')).join('\n');
  }

  meta() {
    return {
      workspace: this.db.settings.workspace,
      brand: this.db.settings.brand,
      entities: this.db.entities.map(({ aliases, ...e }) => ({ ...e, aliases })),
      narratives: this.narratives.filter((n) => n.name).map(({ id, name, entity, polarity, team }) => ({ id, name, entity, polarity, team })),
      sources: SOURCES,
      users: this.db.users,
      teams: TEAMS,
      permissions: PERMISSIONS,
      queries: this.db.queries,
      rules: this.db.rules,
      settings: this.db.settings,
      suggestedQuestions: SUGGESTED_QUESTIONS,
      counts: { mentions: this.db.mentions.length, alerts: this.db.alerts.filter((a) => a.status === 'new').length, cases: this.db.cases.filter((c) => c.status !== 'resolved').length },
      statuses: STATUSES,
    };
  }

  auditLog(q = {}) {
    let list = this.db.audit;
    if (q.actor) list = list.filter((e) => e.actor === q.actor);
    return list.slice(-Number(q.limit || 200)).reverse().map((e) => ({ ...e, actorName: this.usersById[e.actor]?.name || e.actor }));
  }
}

function slimInfluencer(r) {
  return { author: r.author, mentions: r.mentions, engagement: r.engagement, impact: r.impact, stance: r.stance, positive: r.positive, negative: r.negative, neutral: r.neutral, latest: r.latest, mentionIds: r.mentionIds };
}

export { BRAND };
