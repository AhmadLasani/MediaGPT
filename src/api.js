// Versioned REST API (/api/v1): role-based access via the X-MediaGPT-User
// header, optional API key for writes, per-client rate limiting.
import { HttpError } from './util.js';
import { llmStatus } from './llm.js';

const route = (method, pattern, handler) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/\./g, '\\.').replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+?)')) + '/?$');
  return { method, re, keys, handler };
};

export function buildRoutes(app) {
  const who = ({ req, query }) => req.headers['x-mediagpt-user'] || query.as || 'u-aisha';
  const read = (ctx) => app.require(app.user(who(ctx)), 'read');
  const r = (method, pattern, handler, { open = false } = {}) =>
    route(method, pattern, (ctx) => { if (method === 'GET' && !open) read(ctx); return handler({ ...ctx, actor: who(ctx) }); });

  return [
    r('GET', '/api/v1/health', async () => ({ status: 'ok', product: 'MediaGPT', version: '0.1.0', time: new Date().toISOString(), mentions: app.db.mentions.length, ai: await llmStatus() }), { open: true }),
    r('GET', '/api/v1/meta', async () => ({ ...app.meta(), ai: await llmStatus() })),

    // Listening & analytics
    r('GET', '/api/v1/overview', ({ query }) => app.overview(query)),
    r('GET', '/api/v1/mentions', ({ query }) => app.listMentions(query)),
    r('POST', '/api/v1/mentions', ({ body, actor }) => [201, app.ingest(body, actor)]),
    r('POST', '/api/v1/mentions/simulate', ({ body, actor }) => [201, app.simulate(body?.count, actor)]),
    r('GET', '/api/v1/mentions/:id', ({ params }) => app.mention(params.id)),
    r('GET', '/api/v1/export/mentions.csv', ({ query }) => ({ __raw: app.exportCsv(query), type: 'text/csv' })),
    r('GET', '/api/v1/narratives', ({ query }) => app.narrativesView(query)),
    r('GET', '/api/v1/narratives/:id', ({ params, query }) => app.narrative(params.id, query)),
    r('GET', '/api/v1/competitors', ({ query }) => app.competitors(query)),
    r('GET', '/api/v1/influencers', ({ query }) => app.influencersView(query)),
    r('GET', '/api/v1/authors/:id', ({ params }) => app.author(params.id)),

    // Detection
    r('GET', '/api/v1/alerts', ({ query }) => app.listAlerts(query)),
    r('GET', '/api/v1/alerts/:id', ({ params }) => app.viewAlert(app.alert(params.id), true)),
    r('POST', '/api/v1/alerts/:id/triage', ({ params, body, actor }) => app.triageAlert(params.id, body, actor)),
    r('POST', '/api/v1/alerts/:id/case', ({ params, body, actor }) => [201, app.createCase({ ...body, alertId: params.id }, actor)]),

    // Copilot
    r('POST', '/api/v1/copilot', ({ body, actor }) => app.ask(body?.question, actor)),

    // Response management
    r('GET', '/api/v1/cases', ({ query }) => app.listCases(query)),
    r('POST', '/api/v1/cases', ({ body, actor }) => [201, app.createCase(body, actor)]),
    r('GET', '/api/v1/cases/:id', ({ params }) => app.viewCase(app.case(params.id), true)),
    r('PATCH', '/api/v1/cases/:id', ({ params, body, actor }) => app.updateCase(params.id, body, actor)),
    r('POST', '/api/v1/cases/:id/draft/suggest', ({ params, body, actor }) => app.suggestDraft(params.id, body, actor)),
    r('PUT', '/api/v1/cases/:id/draft', ({ params, body, actor }) => app.saveDraft(params.id, body, actor)),
    r('POST', '/api/v1/cases/:id/submit', ({ params, actor }) => app.submit(params.id, actor)),
    r('POST', '/api/v1/cases/:id/decision', ({ params, body, actor }) => app.decide(params.id, body, actor)),
    r('POST', '/api/v1/cases/:id/publish', ({ params, actor }) => app.publish(params.id, actor)),
    r('POST', '/api/v1/cases/:id/escalate', ({ params, body, actor }) => app.escalate(params.id, body, actor)),
    r('POST', '/api/v1/cases/:id/resolve', ({ params, body, actor }) => app.resolve(params.id, body, actor)),

    // Reporting
    r('GET', '/api/v1/reports/:type.html', ({ params, query, actor }) => ({ __raw: app.reportHtml(params.type, query, actor), type: 'text/html' })),
    r('GET', '/api/v1/reports/:type', ({ params, query, actor }) => app.report(params.type, query, actor)),

    // Configuration & governance
    r('GET', '/api/v1/queries', () => app.db.queries),
    r('POST', '/api/v1/queries', ({ body, actor }) => [201, app.upsertQuery(body, actor)]),
    r('DELETE', '/api/v1/queries/:id', ({ params, actor }) => app.deleteQuery(params.id, actor)),
    r('GET', '/api/v1/rules', () => app.db.rules),
    r('POST', '/api/v1/rules', ({ body, actor }) => [201, app.upsertRule(body, actor)]),
    r('PATCH', '/api/v1/settings', ({ body, actor }) => app.updateSettings(body, actor)),
    r('GET', '/api/v1/audit', ({ query }) => app.auditLog(query)),
    r('POST', '/api/v1/admin/reset', ({ actor }) => { app.require(app.user(actor), 'settings.edit'); return app.reset(); }),
  ];
}

/** Token bucket per client: `limit` requests per minute. */
export function rateLimiter(limit = 600) {
  const buckets = new Map();
  return (key) => {
    const now = Date.now();
    const b = buckets.get(key) || { tokens: limit, at: now };
    b.tokens = Math.min(limit, b.tokens + ((now - b.at) / 60000) * limit);
    b.at = now;
    buckets.set(key, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  };
}

export function createApiHandler(app, { apiKey = process.env.MEDIAGPT_API_KEY, rateLimit = 600 } = {}) {
  const routes = buildRoutes(app);
  const allow = rateLimiter(rateLimit);

  return async function handle(req, res, url) {
    const send = (status, data, type = 'application/json') => {
      res.writeHead(status, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(type === 'application/json' ? JSON.stringify(data) : data);
    };
    if (!allow(req.socket.remoteAddress || 'local')) return send(429, { error: 'Rate limit exceeded' });
    if (apiKey && req.method !== 'GET' && req.headers['x-api-key'] !== apiKey) return send(401, { error: 'Missing or invalid X-API-Key' });

    let match = null;
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = url.pathname.match(r.re);
      if (m) { match = { r, m }; break; }
    }
    if (!match) return send(404, { error: `No route for ${req.method} ${url.pathname}` });

    try {
      let body = {};
      if (['POST', 'PATCH', 'PUT'].includes(req.method)) {
        const chunks = [];
        let size = 0;
        for await (const c of req) {
          size += c.length;
          if (size > 2e6) throw new HttpError(413, 'Payload too large');
          chunks.push(c);
        }
        const raw = Buffer.concat(chunks).toString('utf8');
        body = raw ? JSON.parse(raw) : {};
      }
      const params = Object.fromEntries(match.r.keys.map((k, i) => [k, decodeURIComponent(match.m[i + 1])]));
      const result = await match.r.handler({ req, params, query: Object.fromEntries(url.searchParams), body });
      if (result?.__raw !== undefined) return send(200, result.__raw, result.type);
      if (Array.isArray(result) && typeof result[0] === 'number' && result.length === 2) return send(result[0], result[1]);
      return send(200, result);
    } catch (e) {
      if (e instanceof SyntaxError) return send(400, { error: 'Invalid JSON body' });
      if (!e.status) console.error(e);
      return send(e.status || 500, { error: e.status ? e.message : 'Internal server error' });
    }
  };
}
