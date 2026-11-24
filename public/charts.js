// Tiny dependency-free SVG charts.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const COLORS = { positive: '#12b76a', neutral: '#b3b0c9', negative: '#e0352b' };

// Round axis maximum so that 4 gridline steps land on "nice" numbers.
function niceMax(v) {
  const raw = Math.max(v, 4) / 4;
  const p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((x) => x >= raw);
  return Math.max(4, Math.ceil(step) * 4);
}

function tickLabel(t, bucket) {
  const d = new Date(t);
  if (bucket === 'hour' || bucket === '6h') return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${d.getHours().toString().padStart(2, '0')}:00`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Stacked columns: series = [{t, ...keys}] */
export function stackedBars(series, { keys = ['negative', 'neutral', 'positive'], colors = COLORS, height = 190, bucket = 'day' } = {}) {
  const W = 760, H = height, padL = 34, padB = 22, padT = 8;
  const max = niceMax(Math.max(1, ...series.map((b) => keys.reduce((s, k) => s + (b[k] || 0), 0))));
  const n = series.length;
  const bw = (W - padL) / n;
  const y = (v) => padT + (H - padT - padB) * (1 - v / max);
  let out = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Mention volume by sentiment">`;
  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i;
    out += `<line class="grid-line" x1="${padL}" x2="${W}" y1="${y(v)}" y2="${y(v)}"/><text x="${padL - 6}" y="${y(v) + 3}" text-anchor="end">${Math.round(v)}</text>`;
  }
  const every = Math.ceil(n / 8);
  series.forEach((b, i) => {
    let acc = 0;
    const x = padL + i * bw + bw * 0.12;
    const w = Math.max(1, bw * 0.76);
    const total = keys.reduce((s, k) => s + (b[k] || 0), 0);
    out += `<g><title>${esc(tickLabel(b.end || b.t, bucket))}: ${total} mentions (${keys.map((k) => `${b[k] || 0} ${k}`).join(', ')})</title>`;
    for (const k of keys) {
      const v = b[k] || 0;
      if (!v) continue;
      out += `<rect x="${x}" y="${y(acc + v)}" width="${w}" height="${y(acc) - y(acc + v)}" fill="${colors[k]}" rx="1.5"/>`;
      acc += v;
    }
    out += '</g>';
    if (i % every === 0) out += `<text x="${x + w / 2}" y="${H - 6}" text-anchor="middle">${esc(tickLabel(b.end || b.t, bucket))}</text>`;
  });
  return out + '</svg>' + `<div class="legend">${keys.map((k) => `<span><i style="background:${colors[k]}"></i>${k}</span>`).join('')}</div>`;
}

/** Multi-line chart: lines = [{name, color, points:[{t, value}]}] */
export function lines(list, { height = 200, bucket = 'day', format = (v) => Math.round(v), min = null } = {}) {
  const W = 760, H = height, padL = 34, padB = 22, padT = 8;
  const all = list.flatMap((l) => l.points.map((p) => p.value));
  const lo = min ?? Math.min(0, ...all);
  const hi = Math.max(lo + 1, ...all);
  const top = lo < 0 ? hi : niceMax(hi);
  const n = Math.max(...list.map((l) => l.points.length));
  const x = (i) => padL + ((W - padL - 6) * i) / Math.max(1, n - 1);
  const y = (v) => padT + (H - padT - padB) * (1 - (v - lo) / (top - lo || 1));
  let out = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img">`;
  for (let i = 0; i <= 4; i++) {
    const v = lo + ((top - lo) / 4) * i;
    out += `<line class="grid-line" x1="${padL}" x2="${W}" y1="${y(v)}" y2="${y(v)}"/><text x="${padL - 6}" y="${y(v) + 3}" text-anchor="end">${format(v)}</text>`;
  }
  const every = Math.ceil(n / 8);
  (list[0]?.points || []).forEach((p, i) => { if (i % every === 0) out += `<text x="${x(i)}" y="${H - 6}" text-anchor="middle">${esc(tickLabel(p.t, bucket))}</text>`; });
  for (const l of list) {
    const d = l.points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join('');
    out += `<path d="${d}" fill="none" stroke="${l.color}" stroke-width="2.2" stroke-linejoin="round"><title>${esc(l.name)}</title></path>`;
  }
  return out + '</svg>' + `<div class="legend">${list.map((l) => `<span><i style="background:${l.color}"></i>${esc(l.name)}</span>`).join('')}</div>`;
}

export function sparkline(values, { color = '#6d4aff', width = 120, height = 30 } = {}) {
  if (!values.length) return '';
  const max = Math.max(1, ...values);
  const pts = values.map((v, i) => `${((width * i) / Math.max(1, values.length - 1)).toFixed(1)},${(height - 2 - ((height - 4) * v) / max).toFixed(1)}`);
  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" aria-hidden="true"><polyline points="${pts.join(' ')}" fill="none" stroke="${color}" stroke-width="1.8" stroke-linejoin="round"/></svg>`;
}

export function donut(segments, { size = 150, label = '' } = {}) {
  const total = segments.reduce((s, x) => s + x.value, 0) || 1;
  const r = size / 2 - 12, c = size / 2, circ = 2 * Math.PI * r;
  let off = 0;
  let out = `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="${esc(label)}">`;
  for (const s of segments) {
    const len = (s.value / total) * circ;
    out += `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${s.color}" stroke-width="18" stroke-dasharray="${len} ${circ - len}" stroke-dashoffset="${-off}" transform="rotate(-90 ${c} ${c})"><title>${esc(s.label)}: ${s.value}</title></circle>`;
    off += len;
  }
  return out + `<text x="${c}" y="${c + 5}" text-anchor="middle" style="font-size:15px;font-weight:800;fill:currentColor">${esc(label)}</text></svg>`;
}

export function hbars(rows, { max = null } = {}) {
  const m = max ?? Math.max(1, ...rows.map((r) => r.value));
  return `<div class="bars">${rows.map((r) => `<div class="bar"><span class="wrap-anywhere" title="${esc(r.label)}">${r.labelHtml || esc(r.label)}</span><div class="track"><div class="fill" style="width:${(r.value / m) * 100}%;background:${r.color || 'var(--accent)'}"></div></div><span class="muted" style="text-align:right">${esc(r.display ?? r.value)}</span></div>`).join('')}</div>`;
}

export function sentBar(c) {
  const t = (c.positive || 0) + (c.neutral || 0) + (c.negative || 0) || 1;
  return `<div class="sentbar" title="${c.positive} positive · ${c.neutral} neutral · ${c.negative} negative"><span style="width:${(c.positive / t) * 100}%;background:${COLORS.positive}"></span><span style="width:${(c.neutral / t) * 100}%;background:${COLORS.neutral}"></span><span style="width:${(c.negative / t) * 100}%;background:${COLORS.negative}"></span></div>`;
}
