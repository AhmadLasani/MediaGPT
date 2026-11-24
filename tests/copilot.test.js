import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp } from './helpers.js';
import { classify, answerLocal, answer } from '../src/copilot.js';
import { suggestLocal } from '../src/respond.js';

const app = makeApp();
const ctx = app.ctx();
const ids = new Set(app.db.mentions.map((m) => m.id));
const citesAreReal = (r) => r.citations.length > 0 && r.citations.every((c) => ids.has(c.id)) && [...r.answer.matchAll(/\[(M-\d+)\]/g)].every((m) => ids.has(m[1]));

test('intent classification', () => {
  assert.equal(classify('Why did negative sentiment rise?'), 'why');
  assert.equal(classify('Which narratives are gaining momentum?'), 'emerging');
  assert.equal(classify('How does our visibility compare with competitors?'), 'compare');
  assert.equal(classify('Who is driving the outage conversation?'), 'influencers');
  assert.equal(classify('What should we do next?'), 'recommend');
  assert.equal(classify('Executive summary please'), 'summary');
  assert.equal(classify('banana'), 'search');
});

test('"why" explains the sentiment drop with evidence', () => {
  const r = answerLocal('Why did negative sentiment rise in the last 72 hours?', ctx);
  assert.equal(r.intent, 'why');
  assert.equal(r.window.days, 3);
  assert.equal(r.evidence.drivers[0].narrativeId, 'n-outage');
  assert.match(r.answer, /Network outage/);
  assert.ok(r.evidence.sentiment.current > r.evidence.sentiment.baseline);
  assert.ok(citesAreReal(r), 'every citation points at a real mention');
});

test('emerging narratives surface the privacy issue', () => {
  const r = answerLocal('Which narratives are gaining momentum this week?', ctx);
  assert.ok(r.evidence.rising.some((n) => n.id === 'n-privacy'));
  assert.ok(citesAreReal(r));
});

test('competitive comparison covers all brands', () => {
  const r = answerLocal('How does our share of voice compare with competitors?', ctx);
  for (const name of ['Halvia Mobile', 'Telluma', 'Corvane Wireless', 'Brisa Connect']) assert.match(r.answer, new RegExp(name));
  const total = r.evidence.sov.reduce((s, x) => s + x.share, 0);
  assert.ok(Math.abs(total - 100) < 0.5);
});

test('influencers, recommendations, summary and narrative deep dive', () => {
  const who = answerLocal('Who is driving the outage conversation?', ctx);
  assert.equal(who.evidence.narrativeId, 'n-outage');
  assert.ok(who.evidence.accounts.length > 0);
  const rec = answerLocal('What should we do next?', ctx);
  assert.match(rec.answer, /case/i);
  const sum = answerLocal('Give me an executive summary of the last 24 hours', ctx);
  assert.equal(sum.window.days, 1);
  const deep = answerLocal('location data', ctx);
  assert.equal(deep.intent, 'narrative');
  assert.ok(citesAreReal(deep));
});

test('search fallback and graceful no-result answers', () => {
  const r = answerLocal('anything about callback?', ctx);
  assert.ok(r.citations.length > 0);
  const none = answerLocal('zebra quantum marmalade', ctx);
  assert.equal(none.citations.length, 0);
  assert.match(none.answer, /could not find/);
});

test('answer() uses the local engine when no API key is configured', async () => {
  const prev = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  const r = await answer('Why did negative sentiment rise?', ctx);
  assert.equal(r.engine, 'local');
  if (prev) process.env.ANTHROPIC_API_KEY = prev;
});

test('response drafts are grounded in the playbook and respect channel limits', () => {
  const n = app.narrativeById['n-outage'];
  const m = app.db.mentions.find((x) => x.narrativeId === 'n-outage' && x.source === 'x' && x.sentiment.label === 'negative');
  const d = suggestLocal({ narrative: n, mention: m, author: app.authorsById[m.authorId] });
  assert.equal(d.channel, 'x');
  assert.ok(d.text.length <= 280);
  assert.ok(n.playbook.facts.some((f) => d.text.includes(f)) || /DM @HalviaCares/.test(d.text));
  const statement = suggestLocal({ narrative: n, mention: null, channel: 'media-statement' });
  for (const f of n.playbook.facts) assert.ok(statement.text.includes(f));
});

test('Claude mode: grounded prose is used only when every citation is a real source', async () => {
  const { setCompletionOverride } = await import('../src/llm.js');
  const q = 'Why did negative sentiment rise in the last 72 hours?';
  let seenPrompt = '';
  try {
    const local = answerLocal(q, ctx);
    const real = local.citations[0].id;
    setCompletionOverride(async ({ prompt }) => { seenPrompt = prompt; return `The outage drove it [${real}].`; });
    const ok = await answer(q, ctx);
    assert.equal(ok.engine, 'claude');
    assert.deepEqual(ok.citations.map((c) => c.id), [real]);
    assert.ok(seenPrompt.includes(`[${real}]`), 'the prompt carries the evidence mentions');

    setCompletionOverride(async () => 'Made-up claim [M-99999].');
    assert.equal((await answer(q, ctx)).engine, 'local', 'hallucinated citations fall back to local');

    setCompletionOverride(async () => null);
    assert.equal((await answer(q, ctx)).engine, 'local', 'API failures fall back to local');
  } finally {
    setCompletionOverride(null);
  }
});
