// MediaGPT web console: vanilla JS single-page app over the /api/v1 REST API.
import { stackedBars, lines, sparkline, donut, hbars, sentBar, COLORS } from './charts.js';

const $view = document.getElementById('view');
const $drawer = document.getElementById('drawer');
const $drawerBody = document.getElementById('drawerBody');
let META = null;
let ME = localStorage.getItem('mediagpt.user') || 'u-aisha';
const chatLog = []; // Copilot conversation for this session

// ---------------- helpers ----------------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, opts = {}) {
  const res = await fetch(`/api/v1${path}`, {
    method: opts.method || 'GET',
    headers: { 'content-type': 'application/json', 'x-mediagpt-user': ME },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function toast(msg, err = false) {
  const el = document.createElement('div');
  el.className = `toast${err ? ' err' : ''}`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), err ? 4200 : 2600);
}

async function act(fn, ok) {
  try { const r = await fn(); if (ok) toast(ok); return r; } catch (e) { toast(e.message, true); return null; }
}

const me = () => META.users.find((u) => u.id === ME);
const can = (perm) => { const p = META.permissions[me().role] || []; return p.includes('*') || p.includes(perm); };
const compact = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(Math.round(n)));
const fmtNet = (n) => `${n > 0 ? '+' : ''}${Math.round(n * 100)}`;
const netCls = (n) => (n > 0.05 ? 'good' : n < -0.05 ? 'bad' : 'muted');
const ago = (iso) => {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};
const dt = (iso) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const sentBadge = (l) => `<span class="badge s-${l}">${l}</span>`;
const sevBadge = (s) => `<span class="badge sev-${s}">${s}</span>`;
const prio = (p) => `<span class="badge ${p}">${p}</span>`;
const statusBadge = (s) => `<span class="badge st">${esc(s.replace('_', ' '))}</span>`;
const src = (k) => META.sources[k] || { name: k, icon: '•' };
const ent = (id) => META.entities.find((e) => e.id === id) || { name: id || 'n/a', color: '#999' };
const user = (id) => META.users.find((u) => u.id === id);
const initials = (a) => (a?.name || a?.handle || '?').replace(/^[@u/]+/, '').slice(0, 2).toUpperCase();
const ALERT_TYPES = { spike: 'Conversation spike', sentiment_shift: 'Sentiment shift', emerging_narrative: 'Emerging narrative', influencer: 'Influencer activity', competitive: 'Competitive movement', keyword: 'Priority keyword' };
const SEV_COLOR = { critical: 'var(--crit)', high: 'var(--high)', medium: 'var(--med)', low: 'var(--low)' };

function hashQuery() {
  const i = location.hash.indexOf('?');
  return Object.fromEntries(new URLSearchParams(i >= 0 ? location.hash.slice(i + 1) : ''));
}
const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== '' && v != null)).toString();

/** Minimal Markdown → HTML (bold, lists, tables, paragraphs) with citation chips. */
function md(text) {
  const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\[(M-\d+)\]/g, '<button class="cite" data-mid="$1" title="Open source mention">$1</button>');
  const lines_ = String(text).split('\n');
  let html = '';
  let i = 0;
  while (i < lines_.length) {
    const l = lines_[i];
    if (/^\s*\|/.test(l)) {
      const rows = [];
      while (i < lines_.length && /^\s*\|/.test(lines_[i])) { rows.push(lines_[i]); i++; }
      const cells = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const body = rows.filter((r) => !/^\s*\|[\s|:-]+\|\s*$/.test(r));
      html += `<table><thead><tr>${cells(body[0]).map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${body.slice(1).map((r) => `<tr>${cells(r).map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
      continue;
    }
    if (/^\s*[-*] /.test(l)) {
      html += '<ul>';
      while (i < lines_.length && /^\s*[-*] /.test(lines_[i])) { html += `<li>${inline(lines_[i].replace(/^\s*[-*] /, ''))}</li>`; i++; }
      html += '</ul>';
      continue;
    }
    if (/^\s*\d+\. /.test(l)) {
      html += '<ol>';
      while (i < lines_.length && /^\s*\d+\. /.test(lines_[i])) { html += `<li>${inline(lines_[i].replace(/^\s*\d+\. /, ''))}</li>`; i++; }
      html += '</ol>';
      continue;
    }
    if (/^#{1,4} /.test(l)) { html += `<h3>${inline(l.replace(/^#+ /, ''))}</h3>`; i++; continue; }
    if (l.trim()) html += `<p>${inline(l)}</p>`;
    i++;
  }
  return html;
}

function mentionRow(m) {
  const a = m.author || {};
  return `<div class="mention" data-mid="${m.id}">
    <div class="avatar" style="background:${ent(m.entity).color}22;color:${ent(m.entity).color}">${esc(initials(a))}</div>
    <div style="min-width:0">
      <div class="meta"><span class="who">${esc(a.type === 'journalist' ? `${a.name} · ${a.outlet}` : a.handle)}</span>${a.verified ? '<span title="Verified">✔</span>' : ''}<span>${compact(a.followers || 0)} followers</span><span>${src(m.source).icon} ${esc(src(m.source).name)}</span><span>${ago(m.publishedAt)}</span></div>
      <div class="text">${m.title ? `<span class="title">${esc(m.title)}</span><br>` : ''}${esc(m.text)}</div>
      <div class="meta">${sentBadge(m.sentiment.label)}<span class="badge" style="background:${ent(m.entity).color}22;color:${ent(m.entity).color}">${esc(ent(m.entity).name)}</span>${m.narrativeName ? `<span class="chip">${esc(m.narrativeName)}</span>` : ''}${m.location ? `<span>📍 ${esc(m.location)}</span>` : ''}<span>♥ ${compact(m.engagement.likes)} · ↻ ${compact(m.engagement.shares)} · 💬 ${compact(m.engagement.comments)}</span></div>
    </div></div>`;
}

const seg = (name, value, opts) => `<div class="seg" data-seg="${name}">${opts.map(([v, l]) => `<button data-v="${v}" class="${String(v) === String(value) ? 'on' : ''}">${l}</button>`).join('')}</div>`;
function onSeg(name, fn) {
  $view.querySelector(`[data-seg="${name}"]`)?.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) fn(b.dataset.v); });
}

// ---------------- drawer ----------------
function openDrawer(html) {
  $drawerBody.innerHTML = html;
  $drawer.hidden = false;
  $drawer.querySelector('.drawer-panel').scrollTop = 0;
}
function closeDrawer() { $drawer.hidden = true; }
$drawer.addEventListener('click', (e) => { if (e.target === $drawer || e.target.closest('.drawer-close')) closeDrawer(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });

async function openMention(id) {
  const m = await act(() => api(`/mentions/${id}`));
  if (!m) return;
  const a = m.author || {};
  openDrawer(`
    <div class="row"><div class="avatar">${esc(initials(a))}</div><div><b>${esc(a.name || a.handle)}</b>${a.verified ? ' ✔' : ''}<div class="muted small">${esc(a.handle)} · ${esc(a.type)}${a.outlet ? ` · ${esc(a.outlet)}` : ''} · ${compact(a.followers || 0)} followers</div></div></div>
    <p class="muted small" style="margin-top:12px">${src(m.source).icon} ${esc(src(m.source).name)} · ${dt(m.publishedAt)} · ${esc(m.id)}${m.location ? ` · 📍 ${esc(m.location)}` : ''}</p>
    ${m.title ? `<h2>${esc(m.title)}</h2>` : ''}<p style="font-size:15px">${esc(m.text)}</p>
    <div class="row">${sentBadge(m.sentiment.label)}<span class="badge">${esc(ent(m.entity).name)}</span>${m.narrativeName ? `<a class="chip" href="#/narrative/${m.narrativeId}">${esc(m.narrativeName)}</a>` : ''}${m.hashtags.map((h) => `<span class="chip">${esc(h)}</span>`).join('')}</div>
    <div class="grid three" style="margin:14px 0"><div class="card kpi"><div class="label">Reach</div><div class="value" style="font-size:20px">${compact(m.reach)}</div></div><div class="card kpi"><div class="label">Engagement</div><div class="value" style="font-size:20px">${compact(m.engagement.likes + m.engagement.shares + m.engagement.comments)}</div></div><div class="card kpi"><div class="label">Score</div><div class="value ${netCls(m.sentiment.score)}" style="font-size:20px">${m.sentiment.score}</div></div></div>
    <h3>Why the AI classified it this way</h3>
    <div class="explain"><p><b>Sentiment:</b> ${esc(m.explanation.sentiment)}</p><p><b>Narrative:</b> ${esc(m.explanation.narrative)}</p><p><b>Entities:</b> ${esc(m.explanation.entities)}</p><p style="margin-bottom:0"><b>Matched queries:</b> ${esc(m.explanation.queries.join(', ') || 'none')}</p></div>
    ${m.cases.length ? `<h3 style="margin-top:14px">Linked cases</h3>${m.cases.map((c) => `<a class="chip" href="#/case/${c.id}">${c.id}: ${esc(c.title)} (${esc(c.status)})</a>`).join(' ')}` : ''}
    <div class="row" style="margin-top:16px">
      ${can('case.create') ? `<button class="primary" id="mCase">Open a case from this mention</button>` : ''}
      ${m.narrativeId ? `<a class="btn" href="#/copilot?q=${encodeURIComponent(`Tell me about ${m.narrativeName}`)}">Ask Copilot</a>` : ''}
      ${a.id ? `<button id="mAuthor">Author profile</button>` : ''}
    </div>`);
  $drawerBody.querySelector('#mCase')?.addEventListener('click', async () => {
    const c = await act(() => api('/cases', { method: 'POST', body: { mentionIds: [m.id], narrativeId: m.narrativeId, title: m.narrativeName ? `Respond: ${m.narrativeName}` : `Respond to ${a.handle}`, priority: a.followers >= 100000 ? 'P2' : 'P3' } }), 'Case created');
    if (c) { closeDrawer(); location.hash = `#/case/${c.id}`; }
  });
  $drawerBody.querySelector('#mAuthor')?.addEventListener('click', () => openAuthor(a.id));
}

async function openAuthor(id) {
  const a = await act(() => api(`/authors/${id}`));
  if (!a) return;
  openDrawer(`<div class="row"><div class="avatar">${esc(initials(a))}</div><div><h2 style="margin:0">${esc(a.name || a.handle)}${a.verified ? ' ✔' : ''}</h2><div class="muted small">${esc(a.handle)} · ${esc(a.type)}${a.outlet ? ` · ${esc(a.outlet)}` : ''} · ${src(a.source).name}</div></div></div>
    ${a.bio ? `<p>${esc(a.bio)}</p>` : ''}
    <div class="grid three" style="margin:14px 0"><div class="card kpi"><div class="label">Audience</div><div class="value" style="font-size:20px">${compact(a.followers)}</div></div><div class="card kpi"><div class="label">Mentions</div><div class="value" style="font-size:20px">${a.stats.total}</div></div><div class="card kpi"><div class="label">Net sentiment</div><div class="value ${netCls(a.stats.net)}" style="font-size:20px">${fmtNet(a.stats.net)}</div></div></div>
    <h3>Recent mentions</h3><div class="card flush">${a.mentions.map(mentionRow).join('') || '<div class="empty">No mentions</div>'}</div>`);
}

async function openAlert(id) {
  const a = await act(() => api(`/alerts/${id}`));
  if (!a) return;
  openDrawer(`<div class="row">${sevBadge(a.severity)}<span class="badge">${ALERT_TYPES[a.type]}</span>${statusBadge(a.status)}</div>
    <h2 style="margin-top:10px">${esc(a.title)}</h2><p>${esc(a.detail)}</p>
    <div class="explain"><b>Detected</b> ${dt(a.detectedAt)} (${ago(a.detectedAt)})${a.narrativeName ? ` · <b>Narrative</b> <a href="#/narrative/${a.narrativeId}">${esc(a.narrativeName)}</a>` : ''}<br><b>Signal metrics:</b> ${Object.entries(a.metrics).map(([k, v]) => `${esc(k)} = ${esc(v)}`).join(', ')}</div>
    ${alertActions(a)}
    <h3 style="margin-top:16px">Evidence: ${a.mentions.length} mention${a.mentions.length === 1 ? '' : 's'}</h3><div class="card flush">${a.mentions.map(mentionRow).join('')}</div>`);
  bindAlertActions($drawerBody, () => openAlert(id));
}

function alertActions(a) {
  const btns = [];
  if (a.caseId) btns.push(`<a class="btn small" href="#/case/${a.caseId}">View ${a.caseId}</a>`);
  else if (can('case.create') && !['dismissed', 'resolved'].includes(a.status)) btns.push(`<button class="small primary" data-alert-case="${a.id}">Open case</button>`);
  if (can('alert.triage') && a.status === 'new') btns.push(`<button class="small" data-alert-triage="${a.id}" data-status="acknowledged">Acknowledge</button>`, `<button class="small danger" data-alert-triage="${a.id}" data-status="dismissed">Dismiss</button>`);
  if (a.narrativeName) btns.push(`<a class="btn small" href="#/copilot?q=${encodeURIComponent(`Why is "${a.narrativeName}" happening and who is driving it?`)}">Investigate with Copilot</a>`);
  return `<div class="row" style="margin-top:10px">${btns.join('')}</div>`;
}

function bindAlertActions(root, after) {
  root.querySelectorAll('[data-alert-case]').forEach((b) => b.addEventListener('click', async (e) => {
    e.stopPropagation();
    const c = await act(() => api(`/alerts/${b.dataset.alertCase}/case`, { method: 'POST', body: {} }), 'Case opened from alert');
    if (c) { closeDrawer(); location.hash = `#/case/${c.id}`; }
  }));
  root.querySelectorAll('[data-alert-triage]').forEach((b) => b.addEventListener('click', async (e) => {
    e.stopPropagation();
    const r = await act(() => api(`/alerts/${b.dataset.alertTriage}/triage`, { method: 'POST', body: { status: b.dataset.status } }), `Alert ${b.dataset.status}`);
    if (r) { refreshCounts(); after(); }
  }));
}

// Global delegation: mention rows and citation chips open the mention drawer.
document.addEventListener('click', (e) => {
  const cite = e.target.closest('[data-mid]');
  if (cite && !e.target.closest('a,button:not(.cite)')) { e.preventDefault(); openMention(cite.dataset.mid); return; }
  const author = e.target.closest('[data-author]');
  if (author) { e.preventDefault(); openAuthor(author.dataset.author); }
});

// ---------------- router ----------------
const routes = [
  [/^#\/overview/, overview],
  [/^#\/mentions/, mentions],
  [/^#\/narratives/, narratives],
  [/^#\/narrative\/([^?]+)/, narrativeView],
  [/^#\/competitors/, competitors],
  [/^#\/influencers/, influencersView],
  [/^#\/alerts/, alertsView],
  [/^#\/copilot/, copilot],
  [/^#\/cases/, casesView],
  [/^#\/case\/([^?]+)/, caseView],
  [/^#\/reports/, reports],
  [/^#\/settings/, settings],
];

async function render() {
  const hash = location.hash || '#/overview';
  const nav = hash.slice(2).split(/[/?]/)[0];
  const map = { narrative: 'narratives', case: 'cases' };
  for (const a of document.querySelectorAll('[data-nav]')) a.classList.toggle('active', a.dataset.nav === (map[nav] || nav));
  const r = routes.find(([re]) => re.test(hash)) || routes[0];
  try {
    await r[1](...(hash.match(r[0]) || []).slice(1).map(decodeURIComponent));
  } catch (e) {
    $view.innerHTML = `<div class="card">⚠️ ${esc(e.message)}</div>`;
  }
}
window.addEventListener('hashchange', () => { closeDrawer(); render(); });

async function refreshCounts() {
  const m = await api('/meta').catch(() => null);
  if (!m) return;
  META = m;
  document.getElementById('alertCount').textContent = m.counts.alerts || '';
  document.getElementById('caseCount').textContent = m.counts.cases || '';
}

// ---------------- views ----------------
let OV_DAYS = 7;
async function overview() {
  const o = await api(`/overview?days=${OV_DAYS}`);
  const k = o.kpis;
  const chg = k.change == null ? '' : `<span class="${k.change > 0 ? 'up' : 'down'}">${k.change > 0 ? '▲' : '▼'} ${Math.abs(k.change)}%</span> vs previous ${OV_DAYS === 1 ? '24h' : `${OV_DAYS} days`}`;
  const sovSegs = o.shareOfVoice.map((s) => ({ label: s.name, value: s.count, color: s.color }));
  $view.innerHTML = `
  <header class="top"><div><h1>${esc(ent(o.entity).name)}: overview</h1><div class="sub">${esc(META.workspace)} · ${k.total} mentions in the last ${OV_DAYS === 1 ? '24 hours' : `${OV_DAYS} days`}</div></div>
    <div class="row">${seg('days', OV_DAYS, [[1, '24h'], [7, '7 days'], [30, '30 days']])}${can('mention.ingest') ? '<button id="simulate" title="Simulate new mentions arriving from connected sources">⟳ Pull live mentions</button>' : ''}</div></header>
  <div class="grid kpis">
    <div class="card kpi"><div class="label">Mentions</div><div class="value">${k.total.toLocaleString()}</div><div class="hint">${chg}</div></div>
    <div class="card kpi"><div class="label">Net sentiment</div><div class="value ${netCls(k.net)}">${fmtNet(k.net)}</div><div class="hint">was ${fmtNet(k.netPrevious)}</div><div style="margin-top:6px">${sentBar(k)}</div></div>
    <div class="card kpi"><div class="label">Negative mentions</div><div class="value bad">${k.negative}</div><div class="hint">${k.total ? Math.round((k.negative / k.total) * 100) : 0}% of conversation</div></div>
    <div class="card kpi"><div class="label">Potential reach</div><div class="value">${compact(k.reach)}</div><div class="hint">${compact(k.engagement)} engagements</div></div>
    <div class="card kpi"><div class="label">Open alerts</div><div class="value ${o.alerts.length ? 'bad' : ''}">${META.counts.alerts}</div><div class="hint">${o.openCases} open cases</div></div>
  </div>
  <div class="grid two" style="margin-top:14px">
    <div class="stack">
      <div class="card"><div class="card-h"><h2>Conversation volume and sentiment</h2><span class="muted small">per ${o.bucket}</span></div>${stackedBars(o.series, { bucket: o.bucket })}</div>
      <div class="card"><div class="card-h"><h2>Top narratives</h2><a href="#/narratives" class="small">All narratives →</a></div>
        <table><thead><tr><th>Narrative</th><th>Mentions</th><th class="hide-sm">Trend</th><th>Net</th><th>72h change</th></tr></thead><tbody>
        ${o.narratives.map((n) => `<tr class="click" data-href="#/narrative/${n.id}"><td><b>${esc(n.name)}</b> <span class="badge mom-${n.momentum}">${n.momentum}</span></td><td>${n.count}</td><td class="hide-sm">${sparkline(n.spark, { color: n.net < -0.1 ? COLORS.negative : n.net > 0.1 ? COLORS.positive : '#6d4aff' })}</td><td class="${netCls(n.net)}">${fmtNet(n.net)}</td><td>${n.growth == null ? '<span class="badge mom-rising">new</span>' : `${n.growth > 0 ? '+' : ''}${n.growth}%`}</td></tr>`).join('')}
        </tbody></table></div>
      <div class="card flush"><div class="card-h" style="padding:14px 16px 0"><h2>Latest mentions</h2><a href="#/mentions?entity=${o.entity}" class="small">Mention stream →</a></div>${o.latest.map(mentionRow).join('')}</div>
    </div>
    <div class="stack">
      <div class="card"><div class="card-h"><h2>Needs attention</h2><a href="#/alerts" class="small">All alerts →</a></div>
        ${o.alerts.length ? o.alerts.map((a) => `<div class="row spread" style="padding:8px 0;border-bottom:1px solid var(--line);cursor:pointer" data-alert="${a.id}"><div style="min-width:0;flex:1">${sevBadge(a.severity)} <b>${esc(a.title)}</b><div class="muted small">${esc(ALERT_TYPES[a.type])} · ${ago(a.detectedAt)}</div></div></div>`).join('') : '<div class="empty">All clear. No new alerts.</div>'}</div>
      <div class="card"><h2>Share of voice</h2><div class="row" style="align-items:center;flex-wrap:nowrap">${donut(sovSegs, { size: 140, label: `${o.shareOfVoice.find((s) => s.entity === o.entity)?.share || 0}%` })}<div class="stack" style="gap:6px;min-width:0">${o.shareOfVoice.map((s) => `<div class="small"><i style="display:inline-block;width:10px;height:10px;border-radius:3px;background:${s.color}"></i> ${esc(s.name)} <b>${s.share}%</b> <span class="${netCls(s.net)}">${fmtNet(s.net)}</span></div>`).join('')}</div></div></div>
      <div class="card"><div class="card-h"><h2>Who is driving it</h2><a href="#/influencers" class="small">All →</a></div>${o.influencers.map((r) => `<div class="row spread" style="padding:6px 0;cursor:pointer" data-author="${r.author.id}"><div class="row" style="flex-wrap:nowrap;min-width:0"><div class="avatar">${esc(initials(r.author))}</div><div style="min-width:0"><b class="wrap-anywhere">${esc(r.author.type === 'journalist' ? r.author.name : r.author.handle)}</b><div class="muted small">${esc(r.author.outlet || r.author.type)} · ${compact(r.author.followers)}</div></div></div>${sentBadge(r.stance)}</div>`).join('')}</div>
      <div class="card"><h2>Channels</h2>${hbars(o.sources.map((s) => ({ label: `${src(s.key).icon} ${s.name}`, value: s.count, display: `${s.share}%` })))}</div>
      <div class="card"><h2>Locations</h2>${hbars(o.locations.map((s) => ({ label: s.key, value: s.count, color: s.net < -0.2 ? COLORS.negative : undefined })))}</div>
      <div class="card"><h2>Trending terms</h2><div class="cloud">${o.keywords.map((kw, i) => `<a href="#/mentions?q=${encodeURIComponent(kw.term)}" style="font-size:${12 + Math.max(0, 8 - i / 2)}px">${esc(kw.term)}</a>`).join('')}${o.hashtags.map((h) => `<a class="chip" href="#/mentions?q=${encodeURIComponent(h.tag)}">${esc(h.tag)} ${h.count}</a>`).join('')}</div></div>
    </div>
  </div>`;
  onSeg('days', (v) => { OV_DAYS = Number(v); overview(); });
  $view.querySelectorAll('[data-href]').forEach((r) => r.addEventListener('click', () => { location.hash = r.dataset.href; }));
  $view.querySelectorAll('[data-alert]').forEach((r) => r.addEventListener('click', () => openAlert(r.dataset.alert)));
  $view.querySelector('#simulate')?.addEventListener('click', simulate);
}

async function simulate() {
  const r = await act(() => api('/mentions/simulate', { method: 'POST', body: { count: 10 } }));
  if (!r) return;
  toast(`${r.created.length} new mentions ingested${r.newAlerts.length ? `, ${r.newAlerts.length} new alert(s)` : ''}`);
  await refreshCounts();
  render();
}

let MENTION_LIMIT = 40;
async function mentions() {
  const q = { days: 30, ...hashQuery() };
  const res = await api(`/mentions?${qs({ ...q, limit: MENTION_LIMIT })}`);
  const sel = (name, opts, label) => `<select data-f="${name}" aria-label="${label}"><option value="">${label}</option>${opts.map(([v, l]) => `<option value="${esc(v)}" ${String(q[name] || '') === String(v) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  $view.innerHTML = `
  <header class="top"><div><h1>Mentions</h1><div class="sub">${res.total.toLocaleString()} mentions match · social, news, video, forums and blogs</div></div>
    <div class="row"><a class="btn" href="/api/v1/export/mentions.csv?${qs({ ...q, as: ME })}">⤓ Export CSV</a>${can('mention.ingest') ? '<button id="simulate">⟳ Pull live mentions</button>' : ''}</div></header>
  <div class="filters">
    <input data-f="q" placeholder="Keyword or #hashtag" value="${esc(q.q || '')}" />
    ${sel('entity', META.entities.map((e) => [e.id, e.name]), 'All brands')}
    ${sel('source', Object.entries(META.sources).map(([k, v]) => [k, v.name]), 'All channels')}
    ${sel('sentiment', [['positive', 'Positive'], ['neutral', 'Neutral'], ['negative', 'Negative']], 'Any sentiment')}
    ${sel('narrative', [...META.narratives.map((n) => [n.id, n.name]), ['none', 'Unclassified']], 'All narratives')}
    ${sel('query', META.queries.map((x) => [x.id, x.name]), 'All queries')}
    ${sel('days', [[1, 'Last 24h'], [3, 'Last 72h'], [7, 'Last 7 days'], [30, 'Last 30 days']], 'Period')}
    ${sel('sort', [['recent', 'Most recent'], ['engagement', 'Most engagement'], ['reach', 'Largest reach']], 'Sort')}
    ${Object.keys(hashQuery()).length ? '<a href="#/mentions" class="small">Clear filters</a>' : ''}
  </div>
  <div class="card flush">${res.items.map(mentionRow).join('') || '<div class="empty">No mentions match these filters.</div>'}</div>
  ${res.total > res.items.length ? `<div class="row" style="justify-content:center;margin-top:12px"><button id="more">Load more (${res.total - res.items.length} remaining)</button></div>` : ''}`;
  const apply = () => {
    const f = {};
    $view.querySelectorAll('[data-f]').forEach((el) => { if (el.value) f[el.dataset.f] = el.value; });
    if (f.days === '30') delete f.days;
    MENTION_LIMIT = 40;
    location.hash = `#/mentions${Object.keys(f).length ? `?${qs(f)}` : ''}`;
  };
  $view.querySelectorAll('select[data-f]').forEach((el) => el.addEventListener('change', apply));
  $view.querySelector('input[data-f="q"]').addEventListener('keydown', (e) => { if (e.key === 'Enter') apply(); });
  $view.querySelector('#more')?.addEventListener('click', () => { MENTION_LIMIT += 60; mentions(); });
  $view.querySelector('#simulate')?.addEventListener('click', simulate);
}

let NAR_ENTITY = null;
async function narratives() {
  NAR_ENTITY = NAR_ENTITY || META.brand;
  const list = await api(`/narratives?days=30&entity=${NAR_ENTITY}`);
  $view.innerHTML = `
  <header class="top"><div><h1>Narrative intelligence</h1><div class="sub">Themes and storylines detected in the conversation, ranked by 72-hour activity</div></div>
    ${seg('ent', NAR_ENTITY, META.entities.map((e) => [e.id, e.name]))}</header>
  <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(320px,1fr))">
  ${list.map((n) => `<div class="card ncard" data-href="#/narrative/${n.id}">
    <div class="row spread"><span class="badge mom-${n.momentum}">${n.momentum === 'rising' ? '▲ ' : n.momentum === 'fading' ? '▼ ' : ''}${n.momentum}</span>${n.openCase ? `<span class="badge st">${n.openCase}</span>` : ''}</div>
    <h2 style="margin:0">${esc(n.name)}</h2>
    <div class="muted small">${esc(n.summary || '')}</div>
    ${sparkline(n.spark, { width: 280, height: 40, color: n.net < -0.1 ? COLORS.negative : n.net > 0.1 ? COLORS.positive : '#6d4aff' })}
    <div class="row spread small"><span><b>${n.count}</b> mentions (30d)</span><span><b>${n.last3d}</b> in 72h ${n.growth == null ? '<span class="badge mom-rising">new</span>' : `<span class="${n.growth > 0 ? 'up' : 'muted'}">${n.growth > 0 ? '+' : ''}${n.growth}%</span>`}</span><span class="${netCls(n.net)}">net ${fmtNet(n.net)}</span></div>
    ${sentBar(n.sentiment)}
    <div class="muted small">Top voices: ${n.topAuthors.map(esc).join(', ') || 'n/a'}${n.team ? ` · Owner team: ${esc(n.team)}` : ''}</div>
  </div>`).join('') || '<div class="empty">No narratives for this brand.</div>'}
  </div>`;
  onSeg('ent', (v) => { NAR_ENTITY = v; narratives(); });
  $view.querySelectorAll('[data-href]').forEach((r) => r.addEventListener('click', () => { location.hash = r.dataset.href; }));
}

async function narrativeView(id) {
  const n = await api(`/narratives/${id}?days=14`);
  $view.innerHTML = `
  <header class="top"><div><a href="#/narratives" class="small">← Narratives</a><h1>${esc(n.name)}</h1><div class="sub">${esc(n.entityName)} · ${esc(n.summary || '')}</div></div>
    <div class="row">${can('case.create') && n.entity === META.brand ? `<button class="primary" id="openCase">${n.cases.some((c) => c.status !== 'resolved') ? 'Open another case' : 'Open response case'}</button>` : ''}<a class="btn" href="#/copilot?q=${encodeURIComponent(`Who is driving the ${n.name} conversation?`)}">Ask Copilot</a><a class="btn" href="#/mentions?narrative=${n.id}">All mentions</a></div></header>
  <div class="grid kpis">
    <div class="card kpi"><div class="label">Mentions (14d)</div><div class="value">${n.count}</div><div class="hint">${n.last24h} in the last 24h</div></div>
    <div class="card kpi"><div class="label">72h momentum</div><div class="value">${n.growth == null ? 'New' : `${n.growth > 0 ? '+' : ''}${n.growth}%`}</div><div class="hint">${n.prev3d} → ${n.last3d} mentions</div></div>
    <div class="card kpi"><div class="label">Net sentiment</div><div class="value ${netCls(n.net)}">${fmtNet(n.net)}</div><div class="hint">${sentBar(n.sentiment)}</div></div>
    <div class="card kpi"><div class="label">Potential reach</div><div class="value">${compact(n.reach)}</div><div class="hint">first seen ${n.firstSeen ? ago(new Date(n.firstSeen).toISOString()) : 'n/a'}</div></div>
  </div>
  <div class="grid two" style="margin-top:14px">
    <div class="stack">
      <div class="card"><h2>Timeline</h2>${stackedBars(n.series, { bucket: n.series.length > 30 ? '6h' : 'day' })}</div>
      <div class="card flush"><div class="card-h" style="padding:14px 16px 0"><h2>Most-engaged posts</h2></div>${n.mentions.map(mentionRow).join('')}</div>
    </div>
    <div class="stack">
      ${n.playbook ? `<div class="card ai"><h2>Approved response playbook</h2><ul>${n.playbook.facts.map((f) => `<li>${esc(f)}</li>`).join('')}</ul><div class="explain"><b>Stance:</b> ${esc(n.playbook.stance)}</div></div>` : ''}
      ${n.alerts.length ? `<div class="card"><h2>Alerts</h2>${n.alerts.map((a) => `<div style="padding:6px 0;cursor:pointer" data-alert="${a.id}">${sevBadge(a.severity)} ${esc(a.title)} <span class="muted small">${ago(a.detectedAt)}</span></div>`).join('')}</div>` : ''}
      ${n.cases.length ? `<div class="card"><h2>Cases</h2>${n.cases.map((c) => `<div style="padding:4px 0"><a href="#/case/${c.id}">${c.id}</a> ${prio(c.priority)} ${statusBadge(c.status)}<div class="small">${esc(c.title)}</div></div>`).join('')}</div>` : ''}
      <div class="card"><h2>Who is driving it</h2>${n.influencers.map((r) => `<div class="row spread" style="padding:5px 0;cursor:pointer" data-author="${r.author.id}"><span class="wrap-anywhere"><b>${esc(r.author.type === 'journalist' ? `${r.author.name} (${r.author.outlet})` : r.author.handle)}</b> <span class="muted small">${compact(r.author.followers)}</span></span>${sentBadge(r.stance)}</div>`).join('') || '<div class="muted">n/a</div>'}</div>
      <div class="card"><h2>Where</h2>${hbars(n.locations.map((l) => ({ label: l.key, value: l.count })))}</div>
      <div class="card"><h2>Channels</h2>${hbars(n.sources.map((s) => ({ label: `${src(s.key).icon} ${src(s.key).name}`, value: s.count, display: `${s.share}%` })))}</div>
      <div class="card"><h2>Signal terms</h2><div class="cloud">${n.keywords.map((k) => `<span>${esc(k.term)} <small class="muted">${k.count}</small></span>`).join('')}</div><div class="muted small" style="margin-top:8px">Classifier signals: ${n.signals.map(esc).join(', ')}</div></div>
    </div>
  </div>`;
  $view.querySelector('#openCase')?.addEventListener('click', async () => {
    const pr = n.last3d >= 60 ? 'P1' : n.last3d >= 20 ? 'P2' : 'P3';
    const c = await act(() => api('/cases', { method: 'POST', body: { narrativeId: n.id, priority: pr, mentionIds: n.mentions.slice(0, 5).map((m) => m.id) } }), 'Case created');
    if (c) location.hash = `#/case/${c.id}`;
  });
  $view.querySelectorAll('[data-alert]').forEach((r) => r.addEventListener('click', () => openAlert(r.dataset.alert)));
}

let COMP_DAYS = 7;
async function competitors() {
  const c = await api(`/competitors?days=${COMP_DAYS}`);
  const nets = c.series.map((s) => ({ name: s.name, color: s.color, points: s.points.map((p) => ({ t: p.t, value: p.total })) }));
  $view.innerHTML = `
  <header class="top"><div><h1>Competitive intelligence</h1><div class="sub">Share of voice, sentiment, media visibility and conversation trends across ${c.shareOfVoice.length} brands</div></div>${seg('days', COMP_DAYS, [[3, '72h'], [7, '7 days'], [30, '30 days']])}</header>
  ${c.alerts.filter((a) => a.status === 'new').map((a) => `<div class="card" style="border-left:4px solid var(--warn);margin-bottom:12px;cursor:pointer" data-alert="${a.id}">${sevBadge(a.severity)} <b>${esc(a.title)}</b> <span class="muted">${esc(a.detail)}</span></div>`).join('')}
  <div class="grid two">
    <div class="card"><h2>Conversation volume by brand</h2>${lines(nets, { bucket: COMP_DAYS <= 7 ? '6h' : 'day' })}</div>
    <div class="card"><h2>Share of voice</h2>${hbars(c.shareOfVoice.map((s) => ({ label: s.name, value: s.share, display: `${s.share}%`, color: s.color })), { max: 100 })}</div>
  </div>
  <div class="card" style="margin-top:14px"><h2>Benchmark</h2><div style="overflow-x:auto"><table><thead><tr><th>Brand</th><th>Mentions</th><th>Share of voice</th><th>Change</th><th>Net sentiment</th><th>Δ sentiment</th><th>News coverage</th><th>Potential reach</th><th>Top narrative</th></tr></thead><tbody>
  ${c.shareOfVoice.map((s) => { const top = c.narratives.find((x) => x.entity === s.entity)?.top[0]; return `<tr><td><i style="display:inline-block;width:10px;height:10px;border-radius:3px;background:${s.color}"></i> <b>${esc(s.name)}</b>${s.entity === META.brand ? ' <span class="badge st">you</span>' : ''}</td><td>${s.count}</td><td>${s.share}%</td><td class="${s.shareChange > 0 ? 'up' : s.shareChange < 0 ? 'down' : ''}">${s.shareChange > 0 ? '+' : ''}${s.shareChange} pts</td><td class="${netCls(s.net)}">${fmtNet(s.net)}</td><td class="${netCls(s.netChange)}">${s.netChange > 0 ? '+' : ''}${Math.round(s.netChange * 100)}</td><td>${s.news}</td><td>${compact(s.reach)}</td><td>${top ? `<a href="#/narrative/${top.id}">${esc(top.name)}</a>` : '<span class="muted">n/a</span>'}</td></tr>`; }).join('')}
  </tbody></table></div></div>
  <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(260px,1fr));margin-top:14px">
  ${c.narratives.map((x) => `<div class="card"><h3 style="color:${ent(x.entity).color}">${esc(ent(x.entity).name)}</h3>${x.top.map((t) => `<div style="padding:5px 0;border-bottom:1px solid var(--line)"><a href="#/narrative/${t.id}">${esc(t.name)}</a><div class="small muted">${t.count} mentions · net <span class="${netCls(t.net)}">${fmtNet(t.net)}</span>${t.growth ? ` · ${t.growth > 0 ? '+' : ''}${t.growth}% (72h)` : ''}</div></div>`).join('') || '<div class="muted small">No named narratives</div>'}
  <div class="small muted" style="margin-top:8px">Channels: ${(c.sources.find((s) => s.entity === x.entity)?.sources || []).map((s) => `${src(s.key).name} ${s.share}%`).join(', ')}</div></div>`).join('')}
  </div>`;
  onSeg('days', (v) => { COMP_DAYS = Number(v); competitors(); });
  $view.querySelectorAll('[data-alert]').forEach((r) => r.addEventListener('click', () => openAlert(r.dataset.alert)));
}

async function influencersView() {
  const q = { days: 7, entity: META.brand, ...hashQuery() };
  const rows = await api(`/influencers?${qs({ ...q, limit: 40 })}`);
  const sel = (name, opts, label) => `<select data-f="${name}"><option value="">${label}</option>${opts.map(([v, l]) => `<option value="${v}" ${String(q[name] || '') === String(v) ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
  $view.innerHTML = `
  <header class="top"><div><h1>Influencer intelligence</h1><div class="sub">Influential accounts, journalists, creators and sources, ranked by impact (reach × engagement × volume)</div></div></header>
  <div class="filters">${sel('entity', META.entities.map((e) => [e.id, e.name]), 'All brands')}${sel('sentiment', [['negative', 'Critics'], ['positive', 'Advocates'], ['neutral', 'Neutral']], 'Any stance')}${sel('type', [['journalist', 'Journalists'], ['creator', 'Creators'], ['analyst', 'Analysts'], ['consumer', 'Consumers']], 'All types')}${sel('narrative', META.narratives.map((n) => [n.id, n.name]), 'All narratives')}${sel('days', [[1, '24h'], [3, '72h'], [7, '7 days'], [30, '30 days']], 'Period')}</div>
  <div class="card flush" style="overflow-x:auto"><table><thead><tr><th>Account</th><th>Type</th><th>Audience</th><th>Mentions</th><th>Engagement</th><th>Stance</th><th>Impact</th><th class="hide-sm">Last seen</th></tr></thead><tbody>
  ${rows.map((r) => `<tr class="click" data-author="${r.author.id}"><td><div class="row" style="flex-wrap:nowrap"><div class="avatar">${esc(initials(r.author))}</div><div><b>${esc(r.author.name || r.author.handle)}</b>${r.author.verified ? ' ✔' : ''}<div class="muted small">${esc(r.author.outlet || r.author.handle)}</div></div></div></td><td>${esc(r.author.type)}</td><td>${compact(r.author.followers)}</td><td>${r.mentions}</td><td>${compact(r.engagement)}</td><td>${sentBadge(r.stance)} ${sentBar(r)}</td><td><b>${r.impact}</b></td><td class="hide-sm muted">${ago(r.latest)}</td></tr>`).join('') || '<tr><td colspan="8" class="empty">No accounts for these filters.</td></tr>'}
  </tbody></table></div>`;
  $view.querySelectorAll('select[data-f]').forEach((el) => el.addEventListener('change', () => {
    const f = {};
    $view.querySelectorAll('[data-f]').forEach((x) => { if (x.value) f[x.dataset.f] = x.value; });
    location.hash = `#/influencers?${qs({ entity: '', ...f })}`;
  }));
}

async function alertsView() {
  const q = { status: 'open', ...hashQuery() };
  const list = await api(`/alerts?${qs(q)}`);
  const tabs = [['open', 'Open'], ['case_opened', 'In a case'], ['dismissed', 'Dismissed'], ['', 'All']];
  $view.innerHTML = `
  <header class="top"><div><h1>Alerts</h1><div class="sub">Spikes, sentiment shifts, emerging narratives, influencer activity, competitive movement and priority keywords. Detection re-runs on every ingest.</div></div>
  <div class="row">${seg('status', q.status, tabs)}<select id="typeF"><option value="">All types</option>${Object.entries(ALERT_TYPES).map(([k, v]) => `<option value="${k}" ${q.type === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div></header>
  <div class="card flush">${list.map((a) => `<div class="alert ${['dismissed', 'resolved'].includes(a.status) ? 'dim' : ''}"><div class="stripe" style="background:${SEV_COLOR[a.severity]}"></div>
    <div style="min-width:0;cursor:pointer" data-alert="${a.id}"><div class="row">${sevBadge(a.severity)}<span class="badge">${ALERT_TYPES[a.type]}</span>${a.entityName ? `<span class="muted small">${esc(a.entityName)}</span>` : ''}<span class="muted small">${a.id} · ${dt(a.detectedAt)} (${ago(a.detectedAt)})</span>${a.status !== 'new' ? statusBadge(a.status) : ''}</div>
    <div style="font-weight:700;margin-top:4px">${esc(a.title)}</div><div class="muted">${esc(a.detail)}</div></div>
    <div>${alertActions(a)}</div></div>`).join('') || '<div class="empty">No alerts in this view.</div>'}</div>`;
  onSeg('status', (v) => { location.hash = `#/alerts?${qs({ ...q, status: v })}`; });
  $view.querySelector('#typeF').addEventListener('change', (e) => { location.hash = `#/alerts?${qs({ ...q, type: e.target.value })}`; });
  $view.querySelectorAll('[data-alert]').forEach((r) => r.addEventListener('click', () => openAlert(r.dataset.alert)));
  bindAlertActions($view, alertsView);
}

// ---------------- copilot ----------------
async function copilot() {
  const q = hashQuery().q;
  $view.innerHTML = `
  <header class="top"><div><h1>Intelligence Copilot</h1><div class="sub">Ask questions in plain language. Every answer links to the sources, accounts, time window and records behind it.</div></div><span class="ai-badge">${META.ai?.enabled ? `Claude · ${esc(META.ai.model)} + local evidence` : 'Local evidence engine'}</span></header>
  <div class="grid two"><div class="stack"><div class="chat" id="chat"></div>
    <form class="composer" id="composer"><input id="question" placeholder="e.g. Why did negative sentiment rise in the last 72 hours?" autocomplete="off" ${can('copilot') ? '' : 'disabled'} /><button class="primary" ${can('copilot') ? '' : 'disabled'}>Ask</button></form></div>
    <div class="stack"><div class="card"><h2>Try asking</h2><div class="suggest">${META.suggestedQuestions.map((s) => `<button data-q="${esc(s)}">${esc(s)}</button>`).join('')}</div></div>
    <div class="card"><h2>How answers are grounded</h2><div class="small muted"><p>The Copilot first computes the answer from your monitoring data: sentiment baselines, narrative drivers, influence rankings and share of voice. It then cites the specific mentions it used.</p><p>${META.ai?.enabled ? 'Claude writes the final prose from that evidence only. Answers that cite unknown sources are rejected and the local answer is shown instead.' : 'Set <code>ANTHROPIC_API_KEY</code> on the server to have Claude write the prose. Evidence and citations stay the same.'}</p><p>Click any <span class="cite">M-00000</span> chip to open the source record.</p></div></div></div></div>`;
  const $chat = $view.querySelector('#chat');
  const draw = () => {
    $chat.innerHTML = chatLog.length ? chatLog.map((t) => `<div class="q-bubble">${esc(t.q)}</div>${t.pending ? '<div class="a-bubble thinking">Analysing mentions, baselines and narratives…</div>' : t.error ? `<div class="a-bubble bad">${esc(t.error)}</div>` : answerHtml(t.a)}`).join('') : '<div class="card empty">Ask a question to start. Answers include source citations you can open.</div>';
    $chat.querySelectorAll('[data-q]').forEach((b) => b.addEventListener('click', () => ask(b.dataset.q)));
  };
  const ask = async (question) => {
    if (!question?.trim()) return;
    const turn = { q: question.trim(), pending: true };
    chatLog.push(turn);
    draw();
    try { turn.a = await api('/copilot', { method: 'POST', body: { question: turn.q } }); } catch (e) { turn.error = e.message; }
    turn.pending = false;
    draw();
    $chat.lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  $view.querySelector('#composer').addEventListener('submit', (e) => { e.preventDefault(); const i = $view.querySelector('#question'); ask(i.value); i.value = ''; });
  $view.querySelectorAll('.suggest [data-q]').forEach((b) => b.addEventListener('click', () => ask(b.dataset.q)));
  draw();
  if (q) { history.replaceState(null, '', '#/copilot'); ask(q); }
}

function answerHtml(a) {
  return `<div class="a-bubble">${md(a.answer)}
    <div class="evidence"><div class="row small muted"><span>🕒 ${dt(a.window.from)} to ${dt(a.window.to)}</span><span>· intent: ${esc(a.intent)}</span><span>· engine: ${esc(a.engine === 'claude' ? `Claude (${a.model})` : 'local')}</span><span>· ${a.citations.length} source${a.citations.length === 1 ? '' : 's'}</span></div>
    ${a.citations.length ? `<details style="margin-top:6px"><summary class="small" style="cursor:pointer">Supporting sources</summary>${a.citations.map((c) => `<div class="src" data-mid="${c.id}"><span class="cite">${c.id}</span><span><b>${esc(c.authorName || c.author)}</b> <span class="muted">· ${esc(src(c.source).name)} · ${compact(c.followers)} · ${ago(c.publishedAt)}</span> ${sentBadge(c.sentiment)}<br>${esc(c.snippet)}</span></div>`).join('')}</details>` : ''}
    ${a.suggestions?.length ? `<div class="suggest" style="margin-top:10px">${a.suggestions.map((s) => `<button class="small" data-q="${esc(s)}">${esc(s)}</button>`).join('')}</div>` : ''}</div></div>`;
}

// ---------------- cases ----------------
const COLS = [['open', 'Open'], ['in_progress', 'In progress'], ['awaiting_approval', 'Awaiting approval'], ['approved', 'Approved'], ['responded', 'Responded'], ['resolved', 'Resolved']];
async function casesView() {
  const list = await api('/cases');
  $view.innerHTML = `
  <header class="top"><div><h1>Response management</h1><div class="sub">Turn conversations into cases, assign owners, draft responses with AI, route through approval chains and track every action.</div></div>${can('case.create') ? '<button class="primary" id="newCase">+ New case</button>' : ''}</header>
  <div class="board">${COLS.map(([s, label]) => { const cs = list.filter((c) => c.status === s); return `<div class="col"><h3><span>${label}</span><span>${cs.length}</span></h3>${cs.map((c) => `<div class="ccard" data-href="#/case/${c.id}"><div class="row spread"><span class="muted small">${c.id}</span>${prio(c.priority)}</div><div class="t">${esc(c.title)}</div><div class="small muted">${esc(c.ownerName || 'Unassigned')} · ${esc(c.team)}</div>${c.escalated ? '<span class="badge sev-high">escalated</span> ' : ''}${c.overdue ? '<span class="badge sev-critical">SLA overdue</span>' : c.dueAt && !['resolved', 'responded'].includes(c.status) ? `<span class="small muted">due ${dt(c.dueAt)}</span>` : ''}${c.pendingStep ? `<div class="small" style="margin-top:4px">⏳ ${esc(c.pendingStep.step)}</div>` : ''}</div>`).join('') || '<div class="muted small" style="padding:8px">Nothing here</div>'}</div>`; }).join('')}</div>`;
  $view.querySelectorAll('[data-href]').forEach((r) => r.addEventListener('click', () => { location.hash = r.dataset.href; }));
  $view.querySelector('#newCase')?.addEventListener('click', () => {
    openDrawer(`<h2>New case</h2><form id="caseForm"><label>Title</label><input name="title" required style="width:100%" placeholder="e.g. Respond to outage coverage" />
      <label>Narrative</label><select name="narrativeId" style="width:100%"><option value="">None</option>${META.narratives.filter((n) => n.entity === META.brand).map((n) => `<option value="${n.id}">${esc(n.name)}</option>`).join('')}</select>
      <label>Priority</label><select name="priority"><option>P1</option><option>P2</option><option selected>P3</option><option>P4</option></select>
      <label>Owner</label><select name="ownerId">${META.users.map((u) => `<option value="${u.id}" ${u.id === ME ? 'selected' : ''}>${esc(u.name)} (${u.team})</option>`).join('')}</select>
      <label>Note</label><textarea name="note" style="min-height:70px"></textarea><div class="row" style="margin-top:12px"><button class="primary">Create case</button></div></form>`);
    $drawerBody.querySelector('#caseForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(e.target));
      if (!body.narrativeId) delete body.narrativeId;
      const c = await act(() => api('/cases', { method: 'POST', body }), 'Case created');
      if (c) { closeDrawer(); location.hash = `#/case/${c.id}`; }
    });
  });
}

async function caseView(id) {
  const c = await api(`/cases/${id}`);
  const locked = ['awaiting_approval', 'approved', 'responded', 'resolved'].includes(c.status);
  const step = c.pendingStep;
  const canDecide = step && can('case.approve') && (me().role === 'admin' || me().role === step.role);
  const limit = { x: 280, tiktok: 300, instagram: 600, facebook: 600, youtube: 600 }[c.draft?.channel] || null;
  $view.innerHTML = `
  <header class="top"><div><a href="#/cases" class="small">← Cases</a><h1>${esc(c.title)}</h1>
    <div class="row sub">${c.id} ${prio(c.priority)} ${statusBadge(c.status)}${c.escalated ? `<span class="badge sev-high">escalated to ${esc(user(c.escalatedTo)?.name || '')}</span>` : ''}${c.overdue ? '<span class="badge sev-critical">SLA overdue</span>' : ''}<span>Owner: <b>${esc(c.ownerName)}</b> · ${esc(c.team)}</span><span>Due ${dt(c.dueAt)}</span>${c.narrativeName ? `<a href="#/narrative/${c.narrativeId}" class="chip">${esc(c.narrativeName)}</a>` : ''}</div></div>
    <div class="row">
      ${can('case.escalate') && !['resolved', 'responded'].includes(c.status) ? '<button id="escalate">⇪ Escalate</button>' : ''}
      ${can('case.resolve') && c.status !== 'resolved' && c.status !== 'awaiting_approval' ? '<button id="resolve">✓ Resolve</button>' : ''}
    </div></header>
  <div class="grid two">
    <div class="stack">
      <div class="card">
        <div class="card-h"><h2>Response draft</h2>${c.draft ? `<span class="muted small">v${c.draft.version} · ${c.draft.generatedBy === 'claude' ? 'drafted by Claude' : c.draft.generatedBy === 'mediagpt-ai' ? 'drafted by MediaGPT AI' : 'written by hand'}${c.draft.editedBy ? `, edited by ${esc(user(c.draft.editedBy)?.name)}` : ''}</span>` : ''}</div>
        <div class="row" style="margin-bottom:8px"><label style="margin:0">Channel</label><select id="channel" ${locked ? 'disabled' : ''}>${['x', 'instagram', 'tiktok', 'facebook', 'reddit', 'youtube', 'forum', 'media-statement', 'email', 'internal-brief'].map((ch) => `<option ${c.draft?.channel === ch ? 'selected' : ''}>${ch}</option>`).join('')}</select>
          ${!locked && can('case.edit') ? `<select id="replyTo" title="Mention to respond to"><option value="">Reply to: highest reach</option>${c.mentions.map((m) => `<option value="${m.id}" ${c.draft?.replyTo === m.id ? 'selected' : ''}>${m.id} · ${esc(m.author?.handle)}</option>`).join('')}</select><button id="suggest">✧ Suggest response</button>` : ''}</div>
        <textarea id="draft" ${locked || !can('case.edit') ? 'readonly' : ''} placeholder="Generate a suggested response or write your own.">${esc(c.draft?.text || '')}</textarea>
        <div class="row spread small"><span class="muted" id="charCount"></span>${c.draft?.rationale ? `<span class="muted">${esc(c.draft.rationale[0])}</span>` : ''}</div>
        <div class="row" style="margin-top:10px">
          ${!locked && can('case.edit') ? '<button id="saveDraft">Save draft</button>' : ''}
          ${['open', 'in_progress'].includes(c.status) && can('case.submit') ? `<button class="primary" id="submit" ${c.draft ? '' : 'disabled title="Add a draft first"'}>Submit for approval →</button>` : ''}
          ${c.status === 'approved' && can('case.publish') ? '<button class="primary" id="publish">Publish response</button>' : ''}
        </div>
        ${c.draft?.rationale?.length ? `<details style="margin-top:10px"><summary class="small muted" style="cursor:pointer">Why this draft</summary><ul class="small">${c.draft.rationale.map((r) => `<li>${esc(r)}</li>`).join('')}</ul></details>` : ''}
      </div>
      <div class="card"><h2>Approval chain</h2>
        ${c.approvals.length ? `<div class="chain">${c.approvals.map((a, i) => `${i ? '<span class="muted">→</span>' : ''}<div class="step ${a.decision} ${a === c.approvals.find((x) => x.decision === 'pending') ? 'current' : ''}"><b>${esc(a.step)}</b><div class="muted">${esc(a.role)}</div><div>${a.decision === 'pending' ? '⏳ pending' : `${a.decision === 'approved' ? '✅' : '❌'} ${esc(a.byName || '')}`}</div>${a.note ? `<div class="muted">"${esc(a.note)}"</div>` : ''}</div>`).join('')}</div>` : `<div class="muted small">${c.status === 'open' || c.status === 'in_progress' ? `When submitted, ${c.priority} drafts go through: ${(META.settings.approvals[c.priority] || []).map((s) => s.step).join(' → ') || 'no approval (auto-approved)'}.` : 'No approvals required.'}</div>`}
        ${canDecide ? `<div class="row" style="margin-top:12px"><input id="decisionNote" placeholder="Note (optional)" style="flex:1" /><button class="primary" id="approve">Approve</button><button class="danger" id="reject">Request changes</button></div>` : step ? `<div class="muted small" style="margin-top:8px">Waiting for a ${esc(step.role)} to review. Switch user (top right) to act as an approver.</div>` : ''}
      </div>
      <div class="card flush"><div class="card-h" style="padding:14px 16px 0"><h2>Linked conversations (${c.mentions.length})</h2></div>${c.mentions.map(mentionRow).join('') || '<div class="empty">No linked mentions</div>'}</div>
    </div>
    <div class="stack">
      <div class="card"><h2>Ownership</h2>
        ${can('case.assign') && c.status !== 'resolved' ? `<label>Owner</label><select id="owner" style="width:100%">${META.users.map((u) => `<option value="${u.id}" ${u.id === c.ownerId ? 'selected' : ''}>${esc(u.name)} · ${esc(u.title)}</option>`).join('')}</select>
        <label>Team</label><select id="team" style="width:100%">${META.teams.map((t) => `<option ${t === c.team ? 'selected' : ''}>${t}</option>`).join('')}</select>
        <label>Priority</label><select id="priority">${['P1', 'P2', 'P3', 'P4'].map((p) => `<option ${p === c.priority ? 'selected' : ''}>${p}</option>`).join('')}</select>
        <div style="margin-top:10px"><button id="saveOwner">Save</button></div>` : `<p>${esc(c.ownerName)} · ${esc(c.team)}</p><p class="muted small">${can('case.assign') ? '' : 'Only managers can reassign cases.'}</p>`}
      </div>
      ${c.playbook ? `<div class="card"><h2>Playbook</h2><ul class="small">${c.playbook.facts.map((f) => `<li>${esc(f)}</li>`).join('')}</ul><div class="explain"><b>Stance:</b> ${esc(c.playbook.stance)}</div></div>` : ''}
      <div class="card"><h2>Activity</h2>
        ${can('case.edit') ? '<div class="row" style="margin-bottom:8px"><input id="comment" placeholder="Add a comment" style="flex:1" /><button id="addComment">Post</button></div>' : ''}
        <ul class="timeline">${[...c.timeline].reverse().map((t) => `<li><b>${esc(t.byName)}</b> <span class="muted">${esc(t.action.replace('_', ' '))} · ${dt(t.at)}</span>${t.note ? `<div>${esc(t.note)}</div>` : ''}</li>`).join('')}</ul></div>
    </div>
  </div>`;
  const $d = $view.querySelector('#draft');
  const count = () => { const n = $d.value.length; const lim = { x: 280, tiktok: 300, instagram: 600, facebook: 600, youtube: 600 }[$view.querySelector('#channel').value] || limit; $view.querySelector('#charCount').innerHTML = `${n} characters${lim ? ` / ${lim}` : ''}${lim && n > lim ? ' <span class="bad">over limit</span>' : ''}`; };
  $d.addEventListener('input', count);
  $view.querySelector('#channel').addEventListener('change', count);
  count();
  const reload = () => caseView(id);
  const on = (sel, fn) => $view.querySelector(sel)?.addEventListener('click', fn);
  on('#suggest', async (e) => {
    e.target.disabled = true; e.target.textContent = 'Drafting…';
    const r = await act(() => api(`/cases/${id}/draft/suggest`, { method: 'POST', body: { channel: $view.querySelector('#channel').value, mentionId: $view.querySelector('#replyTo').value || undefined } }), 'Suggested response ready');
    if (r) reload(); else { e.target.disabled = false; e.target.textContent = '✧ Suggest response'; }
  });
  on('#saveDraft', async () => { if (await act(() => api(`/cases/${id}/draft`, { method: 'PUT', body: { text: $d.value, channel: $view.querySelector('#channel').value } }), 'Draft saved')) reload(); });
  on('#submit', async () => {
    if ($d.value.trim() && $d.value !== (c.draft?.text || '')) await act(() => api(`/cases/${id}/draft`, { method: 'PUT', body: { text: $d.value, channel: $view.querySelector('#channel').value } }));
    if (await act(() => api(`/cases/${id}/submit`, { method: 'POST' }), 'Submitted for approval')) { refreshCounts(); reload(); }
  });
  on('#approve', async () => { if (await act(() => api(`/cases/${id}/decision`, { method: 'POST', body: { decision: 'approve', note: $view.querySelector('#decisionNote').value } }), 'Approved')) reload(); });
  on('#reject', async () => { if (await act(() => api(`/cases/${id}/decision`, { method: 'POST', body: { decision: 'reject', note: $view.querySelector('#decisionNote').value || 'Changes requested' } }), 'Sent back for changes')) reload(); });
  on('#publish', async () => { if (await act(() => api(`/cases/${id}/publish`, { method: 'POST' }), 'Response published')) reload(); });
  on('#escalate', async () => { const note = prompt('Escalation note for leadership (optional):') ?? null; if (note === null) return; if (await act(() => api(`/cases/${id}/escalate`, { method: 'POST', body: { note } }), 'Escalated')) reload(); });
  on('#resolve', async () => { const note = prompt('Resolution note:', 'Response delivered; conversation has stabilised.'); if (note === null) return; if (await act(() => api(`/cases/${id}/resolve`, { method: 'POST', body: { note } }), 'Case resolved')) { refreshCounts(); reload(); } });
  on('#saveOwner', async () => { if (await act(() => api(`/cases/${id}`, { method: 'PATCH', body: { ownerId: $view.querySelector('#owner').value, team: $view.querySelector('#team').value, priority: $view.querySelector('#priority').value } }), 'Case updated')) reload(); });
  on('#addComment', async () => { const v = $view.querySelector('#comment').value.trim(); if (v && (await act(() => api(`/cases/${id}`, { method: 'PATCH', body: { comment: v } })))) reload(); });
}

// ---------------- reports ----------------
let REPORT = { type: 'brief', days: 1 };
async function reports() {
  const types = [
    ['brief', 'Executive briefing', 'Concise summary for leadership: KPIs, priority alerts, top narratives, share of voice, recommended actions and case status.', [[1, '24h'], [7, '7 days']]],
    ['pr', 'PR intelligence', 'Earned media exposure: articles, audience, journalists, outlets and media share of voice vs competitors.', [[7, '7 days'], [30, '30 days']]],
    ['newsletter', 'Branded newsletter', 'Curated weekly intelligence for internal or external audiences.', [[7, '7 days']]],
  ];
  const digest = await api('/reports/digest').catch(() => null);
  $view.innerHTML = `
  <header class="top"><div><h1>Reports</h1><div class="sub">Live dashboards, automated reports, executive briefings and PR intelligence. Open any report and use "Save as PDF".</div></div></header>
  <div class="grid three">${types.map(([t, title, desc, ds]) => `<div class="card ${REPORT.type === t ? 'ai' : ''}" style="${REPORT.type === t ? 'border-color:var(--accent)' : ''}"><h2>${title}</h2><p class="muted small">${desc}</p><div class="row">${ds.map(([d, l]) => `<button class="small ${REPORT.type === t && REPORT.days === d ? 'primary' : ''}" data-rt="${t}" data-rd="${d}">${l}</button>`).join('')}</div></div>`).join('')}</div>
  <div class="grid two" style="margin-top:14px">
    <div class="card"><div class="card-h"><h2>Preview</h2><a class="btn small primary" target="_blank" rel="noopener" href="/api/v1/reports/${REPORT.type}.html?days=${REPORT.days}&as=${ME}">Open printable report / Save as PDF ↗</a></div>
      <iframe class="report-preview" title="Report preview" src="/api/v1/reports/${REPORT.type}.html?days=${REPORT.days}&as=${ME}"></iframe></div>
    <div class="stack">
      <div class="card"><h2>Scheduled delivery</h2>${digest ? `<p class="small"><b>Daily email digest</b> at ${esc(META.settings.digest.time)} to ${META.settings.digest.recipients.map(esc).join(', ')}</p><div class="explain"><b>Subject:</b> ${esc(digest.subject)}</div>` : '<p class="muted small">You do not have access to scheduled reports.</p>'}
        <p class="small muted" style="margin-top:10px">Also scheduled: weekly executive briefing (Mon 08:00), weekly PR intelligence (Fri 16:00), monthly branded newsletter.</p></div>
      <div class="card"><h2>Data export</h2><p class="small muted">Download raw, enriched mention records (sentiment, narrative, entity, reach, engagement) for BI tools.</p><a class="btn" href="/api/v1/export/mentions.csv?days=30&as=${ME}">⤓ Mentions CSV (30 days)</a></div>
      <div class="card"><h2>API access</h2><p class="small muted">All data is available over the REST API, e.g. <code>GET /api/v1/overview?days=7</code>, <code>POST /api/v1/mentions</code> for ingestion and <code>POST /api/v1/copilot</code>.</p></div>
    </div>
  </div>`;
  $view.querySelectorAll('[data-rt]').forEach((b) => b.addEventListener('click', () => { REPORT = { type: b.dataset.rt, days: Number(b.dataset.rd) }; reports(); }));
}

// ---------------- settings ----------------
let SET_TAB = 'monitoring';
async function settings() {
  await refreshCounts();
  const tabs = [['monitoring', 'Monitoring queries'], ['rules', 'Alert rules'], ['workflow', 'Workflow & detection'], ['access', 'Users & access'], ['audit', 'Audit trail']];
  let body = '';
  if (SET_TAB === 'monitoring') {
    body = `<div class="card flush"><table><thead><tr><th>Query</th><th>Type</th><th>Terms</th><th>Exclude</th><th></th></tr></thead><tbody>${META.queries.map((q) => `<tr><td><b>${esc(q.name)}</b></td><td>${esc(q.kind)}</td><td>${q.terms.map((t) => `<span class="chip">${esc(t)}</span>`).join('')}</td><td>${(q.exclude || []).map(esc).join(', ') || '<span class="muted">n/a</span>'}</td><td>${can('query.edit') ? `<button class="small danger" data-delq="${q.id}">Delete</button>` : ''} <a class="small" href="#/mentions?query=${q.id}">View</a></td></tr>`).join('')}</tbody></table></div>
    ${can('query.edit') ? `<div class="card" style="margin-top:14px"><h2>Add monitoring query</h2><form id="qForm" class="row" style="align-items:flex-end"><div><label>Name</label><input name="name" required placeholder="e.g. Store experience" /></div><div><label>Type</label><select name="kind"><option>topic</option><option>campaign</option><option>issue</option><option>brand</option><option>competitor</option></select></div><div style="flex:1;min-width:220px"><label>Terms (comma separated)</label><input name="terms" required style="width:100%" placeholder="store, retail, shop staff" /></div><div><label>Exclude</label><input name="exclude" placeholder="optional" /></div><button class="primary">Add query</button></form><p class="muted small">New queries are applied to all historical mentions immediately and to every new mention on ingest.</p></div>` : ''}`;
  } else if (SET_TAB === 'rules') {
    body = `<div class="card flush"><table><thead><tr><th>Rule</th><th>Severity</th><th>Terms</th><th>Scope</th></tr></thead><tbody>${META.rules.map((r) => `<tr><td><b>${esc(r.name)}</b></td><td>${sevBadge(r.severity)}</td><td>${r.terms.map((t) => `<span class="chip">${esc(t)}</span>`).join('')}</td><td>${esc(ent(r.entity).name)}</td></tr>`).join('')}</tbody></table></div>
    ${can('rule.edit') ? `<div class="card" style="margin-top:14px"><h2>Add priority alert rule</h2><form id="rForm" class="row" style="align-items:flex-end"><div><label>Name</label><input name="name" required placeholder="e.g. Executive mentions" /></div><div style="flex:1;min-width:220px"><label>Terms (comma separated)</label><input name="terms" required style="width:100%" placeholder="ceo, chief executive" /></div><div><label>Severity</label><select name="severity"><option>critical</option><option selected>high</option><option>medium</option><option>low</option></select></div><button class="primary">Add rule</button></form></div>` : '<p class="muted small" style="margin-top:10px">Managers and admins can add alert rules.</p>'}`;
  } else if (SET_TAB === 'workflow') {
    const s = META.settings;
    const isAdmin = can('settings.edit');
    body = `<div class="grid half"><div class="card"><h2>Approval chains by priority</h2><table><thead><tr><th>Priority</th><th>Steps</th><th>SLA</th></tr></thead><tbody>${['P1', 'P2', 'P3', 'P4'].map((p) => `<tr><td>${prio(p)}</td><td>${s.approvals[p].map((x) => `${esc(x.step)} <span class="muted small">(${x.role})</span>`).join(' → ') || '<span class="muted">Auto-approved</span>'}</td><td>${isAdmin ? `<input type="number" min="1" data-sla="${p}" value="${s.slaHours[p]}" style="width:70px" /> h` : `${s.slaHours[p]}h`}</td></tr>`).join('')}</tbody></table>
      <p class="muted small">Segregation of duties: the person who submits a draft cannot approve it.</p></div>
      <div class="card"><h2>Detection thresholds</h2>${[['spikeZ', 'Spike sensitivity (z-score)'], ['sentimentDrop', 'Sentiment shift (net change)'], ['emergingRatio', 'Emerging narrative growth (x)'], ['emergingMin', 'Emerging narrative minimum (72h)'], ['influencerFollowers', 'Influencer audience threshold'], ['sovShiftPts', 'Competitor share-of-voice shift (pts)']].map(([k, l]) => `<div class="row spread" style="padding:4px 0"><span>${l}</span>${isAdmin ? `<input type="number" step="any" data-det="${k}" value="${s.detection[k]}" style="width:110px" />` : `<b>${s.detection[k]}</b>`}</div>`).join('')}
      ${isAdmin ? '<button class="primary" id="saveDet" style="margin-top:10px">Save and re-run detection</button>' : '<p class="muted small">Only admins can change detection settings.</p>'}</div></div>`;
  } else if (SET_TAB === 'access') {
    const perms = ['read', 'copilot', 'alert.triage', 'case.create', 'case.edit', 'case.submit', 'case.assign', 'case.approve', 'case.escalate', 'case.publish', 'mention.ingest', 'query.edit', 'rule.edit', 'report.generate', 'settings.edit'];
    const has = (role, p) => META.permissions[role].includes('*') || META.permissions[role].includes(p);
    body = `<div class="grid half"><div class="card flush"><table><thead><tr><th>User</th><th>Role</th><th>Team</th></tr></thead><tbody>${META.users.map((u) => `<tr><td><b>${esc(u.name)}</b><div class="muted small">${esc(u.title)}</div></td><td><span class="badge st">${u.role}</span></td><td>${esc(u.team)}</td></tr>`).join('')}</tbody></table></div>
    <div class="card" style="overflow-x:auto"><h2>Role-based access control</h2><table class="matrix"><thead><tr><th>Permission</th>${Object.keys(META.permissions).map((r) => `<th>${r}</th>`).join('')}</tr></thead><tbody>${perms.map((p) => `<tr><td>${p}</td>${Object.keys(META.permissions).map((r) => `<td>${has(r, p) ? '<span class="pill-ok">●</span>' : '<span class="pill-no">○</span>'}</td>`).join('')}</tr>`).join('')}</tbody></table><p class="muted small">Enterprise SSO (SAML/OIDC) maps identity-provider groups to these roles in the full platform. In this MVP, switch users at the top right.</p></div></div>`;
  } else if (SET_TAB === 'audit') {
    const log = await api('/audit?limit=150');
    body = `<div class="card flush"><table><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Target</th><th>Detail</th></tr></thead><tbody>${log.map((e) => `<tr><td class="muted small">${dt(e.at)}</td><td>${esc(e.actorName)}</td><td><code>${esc(e.action)}</code></td><td>${e.target ? esc(e.target) : ''}</td><td class="small">${esc(e.detail)}</td></tr>`).join('')}</tbody></table></div>`;
  }
  $view.innerHTML = `<header class="top"><div><h1>Settings & governance</h1><div class="sub">Monitoring configuration, alert rules, approval workflows, access control and audit trail</div></div>${can('settings.edit') ? '<button class="danger" id="reset">Reset demo data</button>' : ''}</header>
    <div style="margin-bottom:14px">${seg('tab', SET_TAB, tabs)}</div>${body}`;
  onSeg('tab', (v) => { SET_TAB = v; settings(); });
  const split = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
  $view.querySelector('#qForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    const r = await act(() => api('/queries', { method: 'POST', body: { ...f, terms: split(f.terms), exclude: split(f.exclude) } }));
    if (r) { toast(`Query saved: ${r.matches} matching mentions`); settings(); }
  });
  $view.querySelectorAll('[data-delq]').forEach((b) => b.addEventListener('click', async () => { if (confirm('Delete this query?') && (await act(() => api(`/queries/${b.dataset.delq}`, { method: 'DELETE' }), 'Query deleted'))) settings(); }));
  $view.querySelector('#rForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    const r = await act(() => api('/rules', { method: 'POST', body: { ...f, terms: split(f.terms) } }));
    if (r) { toast(`Rule saved${r.newAlerts ? `; ${r.newAlerts} new alert(s)` : ''}`); settings(); }
  });
  $view.querySelector('#saveDet')?.addEventListener('click', async () => {
    const detection = {}; const slaHours = {};
    $view.querySelectorAll('[data-det]').forEach((i) => { detection[i.dataset.det] = Number(i.value); });
    $view.querySelectorAll('[data-sla]').forEach((i) => { slaHours[i.dataset.sla] = Number(i.value); });
    const r = await act(() => api('/settings', { method: 'PATCH', body: { detection, slaHours } }));
    if (r) { toast(`Saved. Detection re-run: ${r.newAlerts} new alert(s)`); settings(); }
  });
  $view.querySelector('#reset')?.addEventListener('click', async () => {
    if (!confirm('Regenerate the demo workspace? All cases, alerts and changes will be lost.')) return;
    if (await act(() => api('/admin/reset', { method: 'POST' }), 'Demo data regenerated')) { chatLog.length = 0; await refreshCounts(); location.hash = '#/overview'; render(); }
  });
}

// ---------------- boot ----------------
async function boot() {
  META = await api('/meta');
  if (!META.users.some((u) => u.id === ME)) ME = 'u-aisha';
  const sel = document.getElementById('userSelect');
  sel.innerHTML = META.users.map((u) => `<option value="${u.id}" ${u.id === ME ? 'selected' : ''}>${esc(u.name)} · ${u.role}</option>`).join('');
  sel.addEventListener('change', async () => { ME = sel.value; localStorage.setItem('mediagpt.user', ME); toast(`Now acting as ${me().name} (${me().role})`); await refreshCounts(); render(); });
  document.getElementById('aiBadge').textContent = META.ai?.enabled ? `✧ Claude copilot` : '✧ Local AI engine';
  document.getElementById('searchForm').addEventListener('submit', (e) => { e.preventDefault(); const v = document.getElementById('searchInput').value.trim(); location.hash = `#/mentions${v ? `?q=${encodeURIComponent(v)}` : ''}`; });
  await refreshCounts();
  if (!location.hash) location.hash = '#/overview';
  render();
  setInterval(refreshCounts, 60000);
}
boot().catch((e) => { $view.innerHTML = `<div class="card">⚠️ Could not reach the MediaGPT API: ${esc(e.message)}</div>`; });
