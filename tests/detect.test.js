import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, NOW } from './helpers.js';
import { HOUR } from '../src/util.js';

const app = makeApp();

test('seed: deterministic and complete', () => {
  const again = makeApp();
  assert.equal(app.db.mentions.length, again.db.mentions.length);
  assert.equal(app.db.mentions[100].text, again.db.mentions[100].text);
  assert.ok(app.db.mentions.length > 1000);
  assert.ok(app.db.mentions.every((m) => m.entity), 'every seeded mention is attributed to an entity');
  assert.ok(app.db.mentions.every((m) => Date.parse(m.publishedAt) <= NOW), 'nothing is in the future');
});

test('NLP pipeline recovers the storyline narratives with >95% accuracy', () => {
  const seeded = app.db.mentions.filter((m) => m.seedNarrative);
  const correct = seeded.filter((m) => {
    const n = app.narrativeById[m.seedNarrative];
    return (m.narrativeId || null) === (n.name ? n.id : null);
  });
  assert.ok(correct.length / seeded.length > 0.95, `accuracy ${correct.length / seeded.length}`);
});

test('detection: finds the outage spike, sentiment drop and keyword risks', () => {
  const find = (type, pred = () => true) => app.db.alerts.find((a) => a.type === type && pred(a));
  const spike = find('spike', (a) => a.entity === 'halvia');
  assert.ok(spike, 'brand spike detected');
  assert.equal(spike.severity, 'critical');
  assert.equal(spike.narrativeId, 'n-outage');
  assert.ok(spike.mentionIds.length > 0);
  const shift = find('sentiment_shift');
  assert.ok(shift && shift.metrics.current < shift.metrics.baseline, 'sentiment drop detected');
  assert.ok(find('keyword', (a) => a.ruleId === 'rule-legal'), 'legal risk keyword detected');
  assert.ok(find('keyword', (a) => a.ruleId === 'rule-safety'), 'public safety keyword detected');
});

test('detection: emerging narrative, influencer activity and competitive movement', () => {
  assert.ok(app.db.alerts.some((a) => a.type === 'emerging_narrative' && a.narrativeId === 'n-privacy'), 'privacy narrative flagged as emerging');
  assert.ok(app.db.alerts.some((a) => a.type === 'competitive' && a.entity === 'telluma'), 'Telluma share-of-voice jump flagged');
  const infl = app.db.alerts.filter((a) => a.type === 'influencer');
  assert.ok(infl.some((a) => a.authorId === 'a-grace'));
  assert.equal(new Set(infl.map((a) => a.authorId)).size, infl.length, 'one influencer alert per account');
});

test('detection is idempotent and stable across a time rebase', () => {
  const fresh = makeApp();
  const before = fresh.db.alerts.length;
  assert.equal(fresh.refreshAlerts().length, 0, 're-running detection creates no duplicates');
  const spike = fresh.db.alerts.find((a) => a.type === 'spike' && a.entity === 'halvia');
  const [id, at] = [spike.id, Date.parse(spike.detectedAt)];
  fresh.setNow(NOW + 31 * HOUR);
  const delta = fresh.rebase();
  assert.equal(delta, 30 * HOUR, 'rebase shifts by whole 6h detection steps');
  assert.equal(fresh.db.alerts.length, before, 'rebase keeps the same alerts');
  const moved = fresh.db.alerts.find((a) => a.id === id);
  assert.equal(Date.parse(moved.detectedAt), at + delta, 'alert timestamps move with the data');
});
