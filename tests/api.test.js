import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { makeApp } from './helpers.js';
import { createApiHandler } from '../src/api.js';

async function withServer(opts, fn) {
  const app = makeApp();
  const handler = createApiHandler(app, opts);
  const server = http.createServer((req, res) => handler(req, res, new URL(req.url, 'http://x')));
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  try { await fn(base, app); } finally { server.close(); }
}

const json = (body, user = 'u-aisha') => ({ method: 'POST', headers: { 'content-type': 'application/json', 'x-mediagpt-user': user }, body: JSON.stringify(body) });

test('REST API: read endpoints', () =>
  withServer({ apiKey: '' }, async (base) => {
    const h = await (await fetch(`${base}/health`)).json();
    assert.equal(h.status, 'ok');
    assert.equal(h.ai.enabled, false);
    const meta = await (await fetch(`${base}/meta`)).json();
    assert.equal(meta.entities.length, 4);
    const ov = await (await fetch(`${base}/overview?days=7`)).json();
    assert.ok(ov.series.length > 0);
    const list = await (await fetch(`${base}/mentions?sentiment=negative&limit=5`)).json();
    assert.equal(list.items.length, 5);
    assert.ok(list.items.every((m) => m.sentiment.label === 'negative'));
    const m = await (await fetch(`${base}/mentions/${list.items[0].id}`)).json();
    assert.ok(m.explanation.sentiment);
    const csv = await fetch(`${base}/export/mentions.csv?days=1`);
    assert.match(csv.headers.get('content-type'), /text\/csv/);
    const html = await fetch(`${base}/reports/brief.html?days=1`);
    assert.match(html.headers.get('content-type'), /text\/html/);
    assert.match(await html.text(), /Executive briefing/);
  }));

test('REST API: copilot and case workflow', () =>
  withServer({ apiKey: '' }, async (base) => {
    const a = await (await fetch(`${base}/copilot`, json({ question: 'Which narratives are gaining momentum?' }))).json();
    assert.equal(a.intent, 'emerging');
    assert.ok(a.citations.length > 0);
    const res = await fetch(`${base}/cases`, json({ narrativeId: 'n-privacy', priority: 'P2' }));
    assert.equal(res.status, 201);
    const c = await res.json();
    const d = await (await fetch(`${base}/cases/${c.id}/draft/suggest`, json({ channel: 'x' }))).json();
    assert.ok(d.draft.text.length <= 280);
    const s = await (await fetch(`${base}/cases/${c.id}/submit`, json({}))).json();
    assert.equal(s.status, 'awaiting_approval');
    const ok = await (await fetch(`${base}/cases/${c.id}/decision`, json({ decision: 'approve' }, 'u-daniel'))).json();
    assert.equal(ok.status, 'approved');
  }));

test('REST API: errors are JSON with proper status codes', () =>
  withServer({ apiKey: '' }, async (base) => {
    assert.equal((await fetch(`${base}/cases/NOPE`)).status, 404);
    assert.equal((await fetch(`${base}/nope`)).status, 404);
    assert.equal((await fetch(`${base}/mentions`, { method: 'POST', body: '{bad' })).status, 400);
    assert.equal((await fetch(`${base}/copilot`, json({ question: '' }))).status, 400);
    assert.equal((await fetch(`${base}/overview`, { headers: { 'x-mediagpt-user': 'u-ghost' } })).status, 401);
    const forbidden = await fetch(`${base}/cases`, json({ title: 'x' }, 'u-rebecca'));
    assert.equal(forbidden.status, 403);
    assert.match((await forbidden.json()).error, /permission/);
  }));

test('REST API: API key required for writes when configured', () =>
  withServer({ apiKey: 'secret' }, async (base) => {
    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.equal((await fetch(`${base}/mentions`, json({ text: 'Halvia rocks' }))).status, 401);
    const ok = await fetch(`${base}/mentions`, { ...json({ text: 'Halvia rocks' }), headers: { 'content-type': 'application/json', 'x-api-key': 'secret' } });
    assert.equal(ok.status, 201);
  }));
