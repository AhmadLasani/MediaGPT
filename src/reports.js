// Reporting: executive briefings, PR intelligence, branded newsletters and
// daily digests. Each report is JSON, plus a print-ready HTML rendering
// (browser "Save as PDF").
import { DAY, compact, htmlEscape as h } from './util.js';
import { inWindow, summary, shareOfVoice, narrativeStats, influencers, engagementOf, breakdown, series, net } from './metrics.js';
import { answerLocal } from './copilot.js';

const fmtNet = (n) => `${n > 0 ? '+' : ''}${Math.round(n * 100)}`;
const top = (list, n) => [...list].sort((a, b) => engagementOf(b) - engagementOf(a)).slice(0, n);

export function executiveBrief(ctx, days = 1) {
  const { now, brand } = ctx;
  const from = now - days * DAY;
  const brandList = ctx.mentions.filter((m) => m.entity === brand);
  const cur = inWindow(brandList, from, now);
  const prev = inWindow(brandList, from - days * DAY, from);
  const narratives = narrativeStats(ctx.mentions, ctx.narratives.filter((n) => n.entity === brand), { now, days }).sort((a, b) => b.count - a.count).slice(0, 5);
  const alerts = (ctx.alerts || []).filter((a) => Date.parse(a.detectedAt) >= from - 2 * DAY && ['critical', 'high'].includes(a.severity)).slice(0, 6);
  const rec = answerLocal('What should we do next?', ctx);
  return {
    type: 'executive-brief',
    title: `Executive briefing: ${ctx.entities.find((e) => e.id === brand).name}`,
    period: { from: new Date(from).toISOString(), to: new Date(now).toISOString(), days },
    generatedAt: new Date(now).toISOString(),
    kpis: summary(cur, prev),
    shareOfVoice: shareOfVoice(inWindow(ctx.mentions, from, now), ctx.entities),
    narratives: narratives.map(({ id, name, count, net: n, growth, momentum, summary: s }) => ({ id, name, count, net: n, growth, momentum, summary: s })),
    alerts: alerts.map(({ id, title, detail, severity, status }) => ({ id, title, detail, severity, status })),
    cases: (ctx.cases || []).filter((c) => !['resolved'].includes(c.status)).map(({ id, title, priority, status, ownerId }) => ({ id, title, priority, status, owner: ctx.usersById[ownerId]?.name || ownerId })),
    recommendations: rec.answer.split('\n').slice(1).map((l) => l.replace(/^\d+\.\s*/, '').replace(/\[M-\d+\]/g, '').trim()).filter(Boolean),
    highlights: top(cur, 5).map((m) => ({ id: m.id, source: m.source, author: ctx.authorsById[m.authorId]?.handle, text: m.title || m.text, sentiment: m.sentiment.label, reach: m.reach })),
    series: series(cur, { from, to: now, size: days <= 2 ? 3600e3 * 3 : DAY }).map((b) => ({ t: b.end, total: b.total, negative: b.negative, positive: b.positive })),
  };
}

export function prReport(ctx, days = 7) {
  const { now, brand } = ctx;
  const from = now - days * DAY;
  const news = inWindow(ctx.mentions, from, now).filter((m) => m.source === 'news' || ctx.authorsById[m.authorId]?.type === 'journalist');
  const mine = news.filter((m) => m.entity === brand);
  const outlets = breakdown(mine, (m) => ctx.authorsById[m.authorId]?.outlet || ctx.authorsById[m.authorId]?.name || 'Other');
  const journalists = influencers(mine, ctx.authorsById, 10).filter((r) => r.author.type === 'journalist');
  return {
    type: 'pr-intelligence',
    title: 'PR intelligence: earned media',
    period: { from: new Date(from).toISOString(), to: new Date(now).toISOString(), days },
    generatedAt: new Date(now).toISOString(),
    kpis: { articles: mine.length, reach: mine.reduce((s, m) => s + m.reach, 0), net: net(mine), negative: mine.filter((m) => m.sentiment.label === 'negative').length, positive: mine.filter((m) => m.sentiment.label === 'positive').length },
    mediaShareOfVoice: shareOfVoice(news, ctx.entities),
    outlets,
    journalists: journalists.map((r) => ({ name: r.author.name, outlet: r.author.outlet, articles: r.mentions, stance: r.stance, audience: r.author.followers })),
    articles: top(mine, 10).map((m) => ({ id: m.id, title: m.title || m.text.slice(0, 90), outlet: ctx.authorsById[m.authorId]?.outlet || ctx.authorsById[m.authorId]?.name, publishedAt: m.publishedAt, sentiment: m.sentiment.label, reach: m.reach })),
  };
}

export function newsletter(ctx, days = 7) {
  const { now, brand } = ctx;
  const from = now - days * DAY;
  const cur = inWindow(ctx.mentions, from, now);
  const positives = top(cur.filter((m) => m.entity === brand && m.sentiment.label === 'positive'), 3);
  const narratives = narrativeStats(ctx.mentions, ctx.narratives, { now, days }).filter((n) => n.count > 0).slice(0, 4);
  const competitors = shareOfVoice(cur, ctx.entities).filter((s) => s.kind === 'competitor');
  return {
    type: 'newsletter',
    title: 'Halvia Signal: weekly intelligence',
    period: { from: new Date(from).toISOString(), to: new Date(now).toISOString(), days },
    generatedAt: new Date(now).toISOString(),
    sections: [
      { heading: 'The week in one line', body: `${cur.filter((m) => m.entity === brand).length} conversations about Halvia; top story: ${narratives[0]?.name || 'n/a'}.` },
      { heading: 'What people are talking about', items: narratives.map((n) => `${n.name}: ${n.count} mentions, net sentiment ${fmtNet(n.net)}`) },
      { heading: 'Wins worth sharing', items: positives.map((m) => `"${(m.title || m.text).slice(0, 140)}" (${ctx.authorsById[m.authorId]?.handle})`) },
      { heading: 'Competitor watch', items: competitors.map((c) => `${c.name}: ${c.share}% share of voice, net ${fmtNet(c.net)}`) },
    ],
  };
}

export function digest(ctx) {
  const b = executiveBrief(ctx, 1);
  return {
    type: 'daily-digest',
    subject: `MediaGPT daily digest: ${b.kpis.total} mentions, net sentiment ${fmtNet(b.kpis.net)}, ${b.alerts.length} priority alerts`,
    to: ctx.settings.digest.recipients,
    brief: b,
  };
}

// ---------------- HTML rendering (print to PDF) ----------------

const CSS = `body{font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif;color:#141225;margin:0;background:#f4f3fb}
.page{max-width:860px;margin:24px auto;background:#fff;padding:40px 48px;border-radius:12px;box-shadow:0 2px 10px rgba(0,0,0,.06)}
header{display:flex;justify-content:space-between;align-items:center;border-bottom:3px solid #6d4aff;padding-bottom:14px;margin-bottom:22px}
.logo{font-weight:800;font-size:20px;color:#6d4aff}.logo small{display:block;font-size:11px;color:#6b6889;font-weight:600}
h1{font-size:22px;margin:0 0 4px}h2{font-size:15px;margin:26px 0 10px;color:#3d2bb3;text-transform:uppercase;letter-spacing:.05em}
.muted{color:#6b6889;font-size:12px}.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
.kpi{border:1px solid #e6e3f5;border-radius:10px;padding:12px}.kpi b{display:block;font-size:22px}.kpi span{font-size:11px;color:#6b6889;text-transform:uppercase;font-weight:600}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:7px 8px;border-bottom:1px solid #eee}th{font-size:11px;color:#6b6889;text-transform:uppercase}
.neg{color:#d92d20;font-weight:700}.pos{color:#079455;font-weight:700}.sev{font-size:11px;font-weight:700;padding:2px 8px;border-radius:99px;background:#fee4e2;color:#b42318}
ul{padding-left:18px}li{margin:5px 0}.print{position:fixed;top:14px;right:14px;background:#6d4aff;color:#fff;border:0;padding:9px 14px;border-radius:8px;font-weight:700;cursor:pointer}
@media print{body{background:#fff}.page{box-shadow:none;margin:0;padding:0}.print{display:none}}`;

const cls = (n) => (n < -0.05 ? 'neg' : n > 0.05 ? 'pos' : '');
const shell = (title, period, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${h(title)}</title><style>${CSS}</style></head>
<body><button class="print" onclick="window.print()">Save as PDF</button><div class="page"><header><div class="logo">MediaGPT<small>AI media intelligence copilot</small></div><div class="muted">${h(new Date(period.from).toUTCString().slice(5, 22))} to ${h(new Date(period.to).toUTCString().slice(5, 22))} UTC</div></header>
<h1>${h(title)}</h1><div class="muted">Generated ${h(new Date().toUTCString())}. Confidential: internal use only.</div>${body}</div></body></html>`;

export function renderHtml(report) {
  if (report.type === 'executive-brief') {
    const k = report.kpis;
    return shell(report.title, report.period, `
<h2>Headline numbers</h2><div class="kpis">
<div class="kpi"><span>Mentions</span><b>${k.total}</b>${k.change == null ? '' : `${k.change > 0 ? '+' : ''}${k.change}% vs prior`}</div>
<div class="kpi"><span>Net sentiment</span><b class="${cls(k.net)}">${fmtNet(k.net)}</b>was ${fmtNet(k.netPrevious)}</div>
<div class="kpi"><span>Potential reach</span><b>${compact(k.reach)}</b></div>
<div class="kpi"><span>Negative</span><b class="neg">${k.negative}</b>of ${k.total}</div></div>
<h2>Priority alerts</h2>${report.alerts.length ? `<ul>${report.alerts.map((a) => `<li><span class="sev">${h(a.severity)}</span> <b>${h(a.title)}</b>: ${h(a.detail)}</li>`).join('')}</ul>` : '<p class="muted">No priority alerts in this period.</p>'}
<h2>Top narratives</h2><table><tr><th>Narrative</th><th>Mentions</th><th>Net</th><th>Momentum</th></tr>${report.narratives.map((n) => `<tr><td><b>${h(n.name)}</b><div class="muted">${h(n.summary || '')}</div></td><td>${n.count}</td><td class="${cls(n.net)}">${fmtNet(n.net)}</td><td>${h(n.momentum)}</td></tr>`).join('')}</table>
<h2>Share of voice</h2><table><tr><th>Brand</th><th>Share</th><th>Mentions</th><th>Net</th></tr>${report.shareOfVoice.map((s) => `<tr><td>${h(s.name)}</td><td>${s.share}%</td><td>${s.count}</td><td class="${cls(s.net)}">${fmtNet(s.net)}</td></tr>`).join('')}</table>
<h2>Recommended actions</h2><ol>${report.recommendations.map((r) => `<li>${h(r.replace(/\*\*/g, ''))}</li>`).join('')}</ol>
<h2>Response workflow</h2>${report.cases.length ? `<table><tr><th>Case</th><th>Priority</th><th>Status</th><th>Owner</th></tr>${report.cases.map((c) => `<tr><td>${h(c.id)}: ${h(c.title)}</td><td>${h(c.priority)}</td><td>${h(c.status.replace('_', ' '))}</td><td>${h(c.owner)}</td></tr>`).join('')}</table>` : '<p class="muted">No open cases.</p>'}
<h2>Most-engaged mentions</h2><ul>${report.highlights.map((m) => `<li>${h(m.author)} (${h(m.source)}, <span class="${m.sentiment === 'negative' ? 'neg' : m.sentiment === 'positive' ? 'pos' : ''}">${h(m.sentiment)}</span>): ${h(m.text)}</li>`).join('')}</ul>`);
  }
  if (report.type === 'pr-intelligence') {
    const k = report.kpis;
    return shell(report.title, report.period, `
<h2>Earned media</h2><div class="kpis"><div class="kpi"><span>Articles</span><b>${k.articles}</b></div><div class="kpi"><span>Audience</span><b>${compact(k.reach)}</b></div><div class="kpi"><span>Net tone</span><b class="${cls(k.net)}">${fmtNet(k.net)}</b></div><div class="kpi"><span>Negative</span><b class="neg">${k.negative}</b></div></div>
<h2>Media share of voice</h2><table><tr><th>Brand</th><th>Articles</th><th>Share</th><th>Net tone</th></tr>${report.mediaShareOfVoice.map((s) => `<tr><td>${h(s.name)}</td><td>${s.count}</td><td>${s.share}%</td><td class="${cls(s.net)}">${fmtNet(s.net)}</td></tr>`).join('')}</table>
<h2>Journalists</h2><table><tr><th>Journalist</th><th>Outlet</th><th>Articles</th><th>Stance</th></tr>${report.journalists.map((j) => `<tr><td>${h(j.name)}</td><td>${h(j.outlet)}</td><td>${j.articles}</td><td>${h(j.stance)}</td></tr>`).join('')}</table>
<h2>Top articles</h2><table><tr><th>Headline</th><th>Outlet</th><th>Tone</th></tr>${report.articles.map((a) => `<tr><td>${h(a.title)}</td><td>${h(a.outlet)}</td><td class="${a.sentiment === 'negative' ? 'neg' : a.sentiment === 'positive' ? 'pos' : ''}">${h(a.sentiment)}</td></tr>`).join('')}</table>`);
  }
  if (report.type === 'newsletter') {
    return shell(report.title, report.period, report.sections.map((s) => `<h2>${h(s.heading)}</h2>${s.body ? `<p>${h(s.body)}</p>` : ''}${s.items ? `<ul>${s.items.map((i) => `<li>${h(i)}</li>`).join('')}</ul>` : ''}`).join(''));
  }
  return shell('Report', report.period || { from: Date.now(), to: Date.now() }, `<pre>${h(JSON.stringify(report, null, 2))}</pre>`);
}
