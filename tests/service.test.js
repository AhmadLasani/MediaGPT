import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeApp, NOW } from './helpers.js';

const status = (fn) => { try { fn(); return 200; } catch (e) { return e.status; } };

test('case workflow: alert → case → AI draft → two-step approval → publish → resolve', async () => {
  const app = makeApp();
  const alert = app.db.alerts.find((a) => a.type === 'spike' && a.entity === 'halvia');
  const c = app.createCase({ alertId: alert.id }, 'u-aisha');
  assert.equal(c.priority, 'P1');
  assert.equal(c.narrativeId, 'n-outage');
  assert.equal(alert.status, 'case_opened');
  assert.equal(Date.parse(c.dueAt) - NOW, 2 * 3600e3, 'P1 SLA is 2h');

  const drafted = await app.suggestDraft(c.id, { channel: 'media-statement' }, 'u-aisha');
  assert.equal(drafted.status, 'in_progress');
  assert.match(drafted.draft.text, /Statement from Halvia Mobile/);

  const sub = app.submit(c.id, 'u-aisha');
  assert.equal(sub.status, 'awaiting_approval');
  assert.deepEqual(sub.approvals.map((a) => a.role), ['manager', 'executive']);

  assert.equal(status(() => app.decide(c.id, { decision: 'approve' }, 'u-sam')), 403, 'analysts cannot approve');
  assert.equal(status(() => app.decide(c.id, { decision: 'approve' }, 'u-rebecca')), 403, 'executive cannot take the manager step');
  app.decide(c.id, { decision: 'approve' }, 'u-daniel');
  const done = app.decide(c.id, { decision: 'approve' }, 'u-rebecca');
  assert.equal(done.status, 'approved');
  assert.equal(app.publish(c.id, 'u-aisha').status, 'responded');
  const resolved = app.resolve(c.id, { note: 'stable' }, 'u-aisha');
  assert.equal(resolved.status, 'resolved');
  assert.equal(alert.status, 'resolved');
  assert.deepEqual(resolved.timeline.map((t) => t.action), ['created', 'draft_generated', 'submitted', 'step_approved', 'approved', 'responded', 'resolved']);
});

test('approval rejection sends the case back and locks drafts while in review', async () => {
  const app = makeApp();
  const c = app.createCase({ narrativeId: 'n-price', priority: 'P2' }, 'u-aisha');
  assert.equal(status(() => app.submit(c.id, 'u-aisha')), 409, 'needs a draft first');
  app.saveDraft(c.id, { text: 'Hi there', channel: 'x' }, 'u-aisha');
  app.submit(c.id, 'u-aisha');
  assert.equal(status(() => app.saveDraft(c.id, { text: 'sneaky edit' }, 'u-aisha')), 409);
  const back = app.decide(c.id, { decision: 'reject', note: 'Add the plan facts' }, 'u-daniel');
  assert.equal(back.status, 'in_progress');
  assert.equal(back.approvals[0].decision, 'rejected');
  app.saveDraft(c.id, { text: 'Revised', channel: 'x' }, 'u-aisha');
  assert.equal(app.submit(c.id, 'u-aisha').approvals[0].decision, 'pending', 'resubmission restarts the chain');
});

test('segregation of duties, RBAC and escalation', () => {
  const app = makeApp();
  assert.equal(status(() => app.decide('CASE-1003', { decision: 'approve' }, 'u-nora')), 403, 'submitter cannot self-approve');
  assert.equal(app.decide('CASE-1003', { decision: 'approve' }, 'u-daniel').status, 'approved');
  assert.equal(status(() => app.createCase({ title: 'x' }, 'u-rebecca')), 403, 'executives are read/approve only');
  assert.equal(status(() => app.updateCase('CASE-1002', { ownerId: 'u-leo' }, 'u-aisha')), 403, 'analysts cannot reassign others');
  assert.equal(status(() => app.updateSettings({ detection: { spikeZ: 2 } }, 'u-daniel')), 403);
  assert.equal(status(() => app.user('u-ghost')), 401);
  const esc = app.escalate('CASE-1002', { note: 'Board asking' }, 'u-daniel');
  assert.equal(esc.priority, 'P2');
  assert.equal(esc.escalatedTo, 'u-rebecca');
});

test('ingestion enriches mentions and fires keyword alerts in real time', () => {
  const app = makeApp();
  const { created, newAlerts } = app.ingest({ text: 'Was Halvia hacked? My data got leaked in a breach', source: 'reddit', author: 'u/test', followers: 50 }, 'u-aisha');
  assert.equal(created[0].entity, 'halvia');
  assert.equal(created[0].sentiment.label, 'negative');
  assert.ok(created[0].queries.includes('q-brand'));
  assert.ok(newAlerts.some((a) => a.ruleId === 'rule-security'));
  assert.equal(app.author(created[0].authorId).handle, 'u/test');
  assert.equal(status(() => app.ingest({ text: '' }, 'u-aisha')), 400);
  assert.equal(status(() => app.ingest({ text: 'hi', source: 'myspace' }, 'u-aisha')), 400);
  assert.equal(status(() => app.ingest({ text: 'hi' }, 'u-rebecca')), 403);
  const sim = app.simulate(5, 'u-aisha');
  assert.equal(sim.created.length, 5);
});

test('monitoring queries re-tag history; rules re-run detection', () => {
  const app = makeApp();
  const q = app.upsertQuery({ name: 'Callbacks', terms: ['callback'] }, 'u-aisha');
  assert.ok(q.matches > 0);
  assert.equal(app.listMentions({ query: q.id, limit: 500 }).total, q.matches);
  const r = app.upsertRule({ name: 'Chatbot', terms: ['chatbot'], severity: 'medium' }, 'u-daniel');
  assert.ok(r.newAlerts > 0);
  assert.equal(status(() => app.upsertRule({ name: 'x', terms: ['y'] }, 'u-aisha')), 403);
});

test('analytics: overview, narratives, competitors and influencers', () => {
  const app = makeApp();
  const o = app.overview({ days: 7 });
  assert.equal(o.kpis.total, o.kpis.positive + o.kpis.neutral + o.kpis.negative);
  assert.ok(o.kpis.net < o.kpis.netPrevious, 'week is more negative than the week before');
  assert.equal(o.narratives[0].id, 'n-outage');
  const n = app.narrative('n-privacy', { days: 7 });
  assert.equal(n.momentum, 'rising');
  const c = app.competitors({ days: 3 });
  assert.ok(c.shareOfVoice.find((s) => s.entity === 'telluma').shareChange > 0);
  const inf = app.influencersView({ days: 3, entity: 'halvia', type: 'journalist' });
  assert.ok(inf.length > 0 && inf.every((r) => r.author.type === 'journalist'));
});

test('reports and CSV export', () => {
  const app = makeApp();
  const brief = app.report('brief', { days: 1 }, 'u-rebecca');
  assert.equal(brief.type, 'executive-brief');
  assert.ok(brief.recommendations.length > 0);
  assert.match(app.reportHtml('pr', { days: 7 }, 'u-aisha'), /<title>PR intelligence/);
  assert.match(app.reportHtml('newsletter', {}, 'u-aisha'), /Halvia Signal/);
  const csv = app.exportCsv({ days: 1 }).split('\n');
  assert.match(csv[0], /^id,publishedAt,source/);
  assert.ok(csv.length > 10);
});

test('persistence: state survives a restart; reset regenerates', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mediagpt-')), 'db.json');
  const a = makeApp({ file });
  const c = a.createCase({ narrativeId: 'n-support', title: 'Persist me' }, 'u-sam');
  const b = makeApp({ file });
  assert.equal(b.case(c.id).title, 'Persist me');
  assert.ok(b.db.audit.some((e) => e.action === 'case.created' && e.target === c.id));
  b.reset();
  assert.equal(status(() => b.case(c.id)), 404);
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});
