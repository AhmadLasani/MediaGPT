// Intelligence Copilot: answers natural-language questions about the
// monitoring data. Every answer links to the evidence behind it: source
// mentions, amplifying accounts, the time window and the metrics used.
import { DAY, HOUR, round, pct, compact, topN, countBy, tokenize } from './util.js';
import { inWindow, net, summary, shareOfVoice, narrativeStats, influencers, engagementOf, hourly, breakdown, topKeywords } from './metrics.js';
import { relevance } from './nlp.js';
import { complete, llmConfigured, MODEL } from './llm.js';

const ts = (m) => m._ts ?? (m._ts = Date.parse(m.publishedAt));
const fmtNet = (n) => `${n > 0 ? '+' : ''}${Math.round(n * 100)}`;
const when = (t, now) => {
  const h = Math.round((now - t) / HOUR);
  return h < 1 ? 'within the last hour' : h < 48 ? `about ${h}h ago` : `${Math.round(h / 24)} days ago`;
};
const who = (a) => (a ? `${a.name && a.type === 'journalist' ? `${a.name} (${a.outlet})` : a.handle} · ${compact(a.followers)}` : 'unknown');
const cite = (m) => `[${m.id}]`;
const byEngagement = (list) => [...list].sort((a, b) => engagementOf(b) - engagementOf(a));

export const SUGGESTED_QUESTIONS = [
  'Why did negative sentiment rise in the last 72 hours?',
  'Which narratives are gaining momentum this week?',
  'How does our share of voice compare with competitors?',
  'Who is driving the outage conversation?',
  'What should we do next?',
  'Give me an executive summary of the last 24 hours',
];

function parseWindow(q, fallbackDays) {
  if (/today|24 ?h|last day|past day|yesterday/.test(q)) return 1;
  if (/48 ?h|two days|2 days/.test(q)) return 2;
  if (/72 ?h|three days|3 days/.test(q)) return 3;
  if (/week|7 days|seven days/.test(q)) return 7;
  if (/two weeks|14 days|fortnight/.test(q)) return 14;
  if (/month|30 days/.test(q)) return 30;
  return fallbackDays;
}

export function classify(question) {
  const q = question.toLowerCase();
  if (/compar|competit|share of voice|\bsov\b|\bvs\.?\b|versus|benchmark|against (telluma|corvane|brisa)/.test(q)) return 'compare';
  if (/\bwho\b|influenc|journalist|amplif|creators|accounts|voices|reporters/.test(q)) return 'influencers';
  if (/recommend|should we|next step|what (do|can) we do|action plan|how should we respond/.test(q)) return 'recommend';
  if (/\bwhy\b|cause|reason|driv|behind|what happened|explain/.test(q)) return 'why';
  if (/narrative|theme|emerging|momentum|gaining|trending|storyline|topics/.test(q)) return 'emerging';
  if (/summar|brief|overview|status|update|how are we doing|executive|headline/.test(q)) return 'summary';
  return 'search';
}

function focusEntity(q, ctx) {
  const lower = q.toLowerCase();
  const comp = ctx.entities.find((e) => e.kind === 'competitor' && e.aliases.some((a) => lower.includes(a.replace(/^[@#]/, ''))));
  return comp ? comp.id : ctx.brand;
}

function focusNarrative(q, ctx, entity) {
  const toks = new Set(tokenize(q));
  let best = null;
  for (const n of ctx.narratives) {
    if (!n.name || (entity && n.entity !== entity)) continue;
    const nameHits = tokenize(n.name).filter((t) => toks.has(t) && t.length > 3).length;
    const sigHits = n.signals.filter((s) => q.toLowerCase().includes(s.replace(/^#/, ''))).length;
    const score = nameHits * 2 + sigHits;
    if (score && (!best || score > best.score)) best = { n, score };
  }
  return best?.n || null;
}

function citation(m, ctx) {
  const a = ctx.authorsById[m.authorId];
  return { id: m.id, source: m.source, author: a?.handle || m.authorId, authorName: a?.name || null, followers: a?.followers || 0, publishedAt: m.publishedAt, sentiment: m.sentiment.label, title: m.title, snippet: (m.title ? `${m.title}: ` : '') + m.text.slice(0, 220) };
}

// ---------------- intents ----------------

function whyAnswer(q, ctx, days) {
  const { now } = ctx;
  const entity = focusEntity(q, ctx);
  const ename = ctx.entities.find((e) => e.id === entity).name;
  const lookingUp = /positive|improv|better|up\b/.test(q.toLowerCase()) && !/negative/.test(q.toLowerCase());
  const label = lookingUp ? 'positive' : 'negative';
  const from = now - days * DAY;
  const list = ctx.mentions.filter((m) => m.entity === entity);
  const cur = inWindow(list, from, now);
  const base = inWindow(list, from - 14 * DAY, from);
  const curShare = pct(cur.filter((m) => m.sentiment.label === label).length, cur.length);
  const baseShare = pct(base.filter((m) => m.sentiment.label === label).length, base.length);

  // Which narratives contribute the excess negative (or positive) mentions?
  const drivers = new Map();
  for (const m of cur.filter((x) => x.sentiment.label === label)) {
    const k = m.narrativeId || 'none';
    drivers.set(k, (drivers.get(k) || 0) + 1);
  }
  const baseRate = new Map();
  for (const m of base.filter((x) => x.sentiment.label === label)) {
    const k = m.narrativeId || 'none';
    baseRate.set(k, (baseRate.get(k) || 0) + 1);
  }
  const ranked = [...drivers.entries()]
    .map(([k, c]) => ({ id: k, count: c, excess: c - ((baseRate.get(k) || 0) / 14) * days }))
    .sort((a, b) => b.excess - a.excess);
  const totalLabel = cur.filter((m) => m.sentiment.label === label).length;
  if (!totalLabel) return { answer: `There were no ${label} mentions of ${ename} in the last ${days} day(s), so there is nothing to explain.`, citations: [], evidence: {} };

  const top = ranked[0];
  const topNar = ctx.narratives.find((n) => n.id === top.id);
  const topList = cur.filter((m) => m.sentiment.label === label && (m.narrativeId || 'none') === top.id);
  const first = topList.reduce((a, m) => (ts(m) < ts(a) ? m : a), topList[0]);
  const hours = hourly(topList, now, days * 24);
  const peak = hours.reduce((a, b) => (b.total > a.total ? b : a), hours[0]);
  const locs = breakdown(topList, (m) => m.location).slice(0, 3).map((x) => x.key);
  const amps = influencers(topList, ctx.authorsById, 3);
  const second = ranked.slice(1, 3).filter((d) => d.excess > 1);
  const ampMentions = amps.map((a) => byEngagement(topList.filter((m) => m.authorId === a.author.id))[0]).filter(Boolean);
  const examples = byEngagement(topList).filter((m) => !ampMentions.includes(m)).slice(0, 3);
  const cites = [first, ...ampMentions, ...examples].filter((m, i, arr) => m && arr.indexOf(m) === i).slice(0, 7);

  const lines = [];
  lines.push(`**${label === 'negative' ? 'Negative' : 'Positive'} sentiment toward ${ename} ${curShare > baseShare ? 'rose' : 'did not rise'}** from ${baseShare}% of mentions (14-day baseline) to **${curShare}%** in the last ${days * 24}h. Net sentiment moved from ${fmtNet(net(base))} to ${fmtNet(net(cur))}.`);
  lines.push('');
  lines.push(`**Main driver: ${topNar ? topNar.name : 'general, unclassified chatter'}.** It accounts for ${top.count} of ${totalLabel} ${label} mentions (${pct(top.count, totalLabel, 0)}%).`);
  if (first) lines.push(`- Started ${when(ts(first), now)}${locs.length ? `, concentrated in ${locs.join(', ')}` : ''} ${cite(first)}.`);
  if (peak?.total) lines.push(`- Peaked at ${peak.total} mentions/hour around ${new Date(peak.end).toUTCString().slice(5, 22)} UTC.`);
  if (amps.length) lines.push(`- Amplified by ${amps.map((a, i) => `${who(a.author)}${ampMentions[i] ? ` ${cite(ampMentions[i])}` : ''}`).join('; ')}.`);
  if (examples.length) lines.push(`- Typical posts: ${examples.map((m) => `"${m.text.slice(0, 80)}${m.text.length > 80 ? '…' : ''}" ${cite(m)}`).join(' ')}`);
  if (second.length) {
    lines.push('');
    lines.push(`**Secondary drivers:** ${second.map((d) => { const n = ctx.narratives.find((x) => x.id === d.id); return `${n?.name || 'unclassified chatter'} (${d.count} mentions, +${Math.round(d.excess)} vs normal)`; }).join('; ')}.`);
  }
  const compAlert = (ctx.alerts || []).find((a) => a.type === 'competitive' && a.status !== 'dismissed' && Date.parse(a.detectedAt) >= from);
  if (compAlert && entity === ctx.brand) lines.push(`\n**Watch:** ${compAlert.title}. ${compAlert.detail}`);
  return {
    answer: lines.join('\n'),
    citations: cites.map((m) => citation(m, ctx)),
    evidence: { entity, window: { days }, sentiment: { current: curShare, baseline: baseShare, netNow: net(cur), netBefore: net(base) }, drivers: ranked.slice(0, 4).map((d) => ({ narrativeId: d.id === 'none' ? null : d.id, name: ctx.narratives.find((n) => n.id === d.id)?.name || 'Unclassified', count: d.count, excess: round(d.excess, 1) })), amplifiers: amps.map((a) => ({ authorId: a.author.id, handle: a.author.handle, followers: a.author.followers, mentions: a.mentions })) },
    focus: { narrativeId: topNar?.id || null },
  };
}

function emergingAnswer(q, ctx, days) {
  const entity = focusEntity(q, ctx);
  const stats = narrativeStats(ctx.mentions, ctx.narratives.filter((n) => n.entity === entity), { now: ctx.now, days });
  const rising = stats.filter((s) => s.last3d >= 5 && (s.growth == null || s.growth >= 40)).sort((a, b) => (b.growth ?? 999) - (a.growth ?? 999));
  const fading = stats.filter((s) => s.prev3d >= 5 && s.last3d < s.prev3d * 0.6);
  const cites = [];
  const lines = [`**Narratives gaining momentum for ${ctx.entities.find((e) => e.id === entity).name}** (last 72h vs the 72h before):`];
  if (!rising.length) lines.push('- No narrative is accelerating right now; conversation is stable.');
  for (const s of rising.slice(0, 4)) {
    const top = byEngagement(inWindow(ctx.mentions.filter((m) => m.narrativeId === s.id), ctx.now - 3 * DAY, ctx.now))[0];
    if (top) cites.push(top);
    lines.push(`- **${s.name}**: ${s.last3d} mentions (${s.growth == null ? 'new' : `+${s.growth}%`}), net sentiment ${fmtNet(s.net)}${s.firstSeen && ctx.now - s.firstSeen < 7 * DAY ? ', first seen this week' : ''}. ${s.summary || ''} ${top ? cite(top) : ''}`);
  }
  if (fading.length) lines.push(`\n**Fading:** ${fading.map((s) => `${s.name} (${s.prev3d} → ${s.last3d})`).join('; ')}.`);
  const emergingNeg = rising.find((s) => s.polarity === 'negative' && s.prev3d < 10);
  if (emergingNeg) lines.push(`\n**Early warning:** "${emergingNeg.name}" is small but accelerating, and is the narrative most likely to become the next issue if left unanswered.`);
  return { answer: lines.join('\n'), citations: cites.map((m) => citation(m, ctx)), evidence: { rising: rising.map(({ id, name, last3d, prev3d, growth, net: n }) => ({ id, name, last3d, prev3d, growth, net: n })), fading: fading.map((s) => s.id) } };
}

function compareAnswer(q, ctx, days) {
  const from = ctx.now - days * DAY;
  const cur = inWindow(ctx.mentions, from, ctx.now);
  const prev = inWindow(ctx.mentions, from - days * DAY, from);
  const sov = shareOfVoice(cur, ctx.entities);
  const sovPrev = Object.fromEntries(shareOfVoice(prev, ctx.entities).map((s) => [s.entity, s]));
  const lines = [`**Share of voice, last ${days} day(s)** (${cur.length} mentions across ${ctx.entities.length} brands):`, ''];
  lines.push('| Brand | Share of voice | Change | Net sentiment | News articles |');
  lines.push('|---|---|---|---|---|');
  const cites = [];
  for (const s of [...sov].sort((a, b) => b.share - a.share)) {
    const d = round(s.share - (sovPrev[s.entity]?.share || 0), 1);
    lines.push(`| ${s.name}${s.entity === ctx.brand ? ' (you)' : ''} | ${s.share}% | ${d > 0 ? '+' : ''}${d} pts | ${fmtNet(s.net)} | ${s.news} |`);
    const top = byEngagement(cur.filter((m) => m.entity === s.entity))[0];
    if (top) cites.push(top);
  }
  const movers = sov.map((s) => ({ ...s, delta: s.share - (sovPrev[s.entity]?.share || 0) })).sort((a, b) => b.delta - a.delta);
  const mine = sov.find((s) => s.entity === ctx.brand);
  const bestNet = [...sov].sort((a, b) => b.net - a.net)[0];
  lines.push('');
  lines.push(`- **Biggest gainer:** ${movers[0].name} (+${round(movers[0].delta, 1)} pts).${movers[0].entity !== ctx.brand ? ` Its top post: ${cites.find((m) => m.entity === movers[0].entity) ? cite(cites.find((m) => m.entity === movers[0].entity)) : ''}` : ''}`);
  lines.push(`- **${mine.name}** leads on volume at ${mine.share}%, but much of that is ${mine.net < 0 ? 'negative' : 'positive'} (net ${fmtNet(mine.net)}). ${bestNet.entity !== ctx.brand ? `${bestNet.name} has the healthiest sentiment (net ${fmtNet(bestNet.net)}).` : ''}`);
  return { answer: lines.join('\n'), citations: cites.map((m) => citation(m, ctx)), evidence: { sov, previous: Object.values(sovPrev) } };
}

function influencerAnswer(q, ctx, days) {
  const entity = focusEntity(q, ctx);
  const nar = focusNarrative(q, ctx, entity);
  let list = inWindow(ctx.mentions.filter((m) => m.entity === entity), ctx.now - days * DAY, ctx.now);
  if (nar) list = list.filter((m) => m.narrativeId === nar.id);
  const lower = q.toLowerCase();
  if (/negative|critic|attack/.test(lower)) list = list.filter((m) => m.sentiment.label === 'negative');
  if (/positive|advocat|fans|support us/.test(lower)) list = list.filter((m) => m.sentiment.label === 'positive');
  const rows = influencers(list, ctx.authorsById, 6);
  const cites = [];
  const scope = nar ? `the "${nar.name}" conversation` : `${ctx.entities.find((e) => e.id === entity).name} mentions`;
  const lines = [`**Who is driving ${scope}** (last ${days * 24}h, ranked by impact = reach × engagement × volume):`];
  if (!rows.length) lines.push('- No accounts found for this scope.');
  for (const r of rows) {
    const m = ctx.mentions.find((x) => x.id === r.mentionIds[r.mentionIds.length - 1]);
    if (m) cites.push(m);
    lines.push(`- **${r.author.name && r.author.type === 'journalist' ? `${r.author.name}, ${r.author.outlet}` : r.author.handle}** (${r.author.type}, ${compact(r.author.followers)} audience): ${r.mentions} mention${r.mentions > 1 ? 's' : ''}, ${compact(r.engagement)} engagements, stance ${r.stance} ${m ? cite(m) : ''}`);
  }
  const journalists = rows.filter((r) => r.author.type === 'journalist');
  if (journalists.length) lines.push(`\n${journalists.length} journalist${journalists.length > 1 ? 's are' : ' is'} covering this. Consider proactive outreach with a statement.`);
  return { answer: lines.join('\n'), citations: cites.map((m) => citation(m, ctx)), evidence: { narrativeId: nar?.id || null, accounts: rows.map((r) => ({ authorId: r.author.id, handle: r.author.handle, followers: r.author.followers, mentions: r.mentions, impact: r.impact, stance: r.stance })) } };
}

function summaryAnswer(q, ctx, days) {
  const { now, brand } = ctx;
  const list = ctx.mentions.filter((m) => m.entity === brand);
  const cur = inWindow(list, now - days * DAY, now);
  const prev = inWindow(list, now - 2 * days * DAY, now - days * DAY);
  const s = summary(cur, prev);
  const stats = narrativeStats(ctx.mentions, ctx.narratives.filter((n) => n.entity === brand), { now, days: Math.max(days, 1) }).sort((a, b) => b.count - a.count).slice(0, 3);
  const open = (ctx.alerts || []).filter((a) => a.status === 'new' && ['critical', 'high'].includes(a.severity));
  const openCases = (ctx.cases || []).filter((c) => !['resolved', 'closed'].includes(c.status));
  const cites = stats.map((n) => byEngagement(cur.filter((m) => m.narrativeId === n.id))[0]).filter(Boolean);
  const lines = [
    `**Executive summary: ${ctx.entities.find((e) => e.id === brand).name}, last ${days * 24}h**`,
    `- **${s.total} mentions** (${s.change == null ? 'n/a' : `${s.change > 0 ? '+' : ''}${s.change}%`} vs prior period), potential reach ${compact(s.reach)}.`,
    `- **Net sentiment ${fmtNet(s.net)}** (was ${fmtNet(s.netPrevious)}): ${s.positive} positive, ${s.neutral} neutral, ${s.negative} negative.`,
    `- **Top narratives:** ${stats.map((n, i) => `${n.name} (${n.count}, net ${fmtNet(n.net)})${cites[i] ? ` ${cite(cites[i])}` : ''}`).join('; ')}.`,
    `- **${open.length} high-priority alert${open.length === 1 ? '' : 's'}** awaiting triage; **${openCases.length} open case${openCases.length === 1 ? '' : 's'}** in the response workflow.`,
  ];
  if (open[0]) lines.push(`- **Most urgent:** ${open[0].title}. ${open[0].detail}`);
  return { answer: lines.join('\n'), citations: cites.map((m) => citation(m, ctx)), evidence: { summary: s, narratives: stats.map((n) => ({ id: n.id, name: n.name, count: n.count, net: n.net })), alerts: open.length, openCases: openCases.length } };
}

function recommendAnswer(q, ctx) {
  const { now } = ctx;
  const stats = narrativeStats(ctx.mentions, ctx.narratives.filter((n) => n.entity === ctx.brand), { now, days: 7 });
  const caseFor = (id) => (ctx.cases || []).find((c) => c.narrativeId === id && !['resolved', 'closed'].includes(c.status));
  const actions = [];
  const cites = [];
  for (const s of stats.filter((x) => x.last3d >= 5).sort((a, b) => b.last3d * (1 - b.net) - a.last3d * (1 - a.net))) {
    const n = ctx.narratives.find((x) => x.id === s.id);
    const top = byEngagement(inWindow(ctx.mentions.filter((m) => m.narrativeId === s.id), now - 3 * DAY, now))[0];
    const existing = caseFor(s.id);
    if (s.net < -0.2) {
      const prio = s.last3d >= 60 ? 'P1' : s.last3d >= 20 ? 'P2' : 'P3';
      actions.push(`**${s.name}** (${s.last3d} mentions in 72h, net ${fmtNet(s.net)}): ${existing ? `case ${existing.id} is ${existing.status.replace('_', ' ')}; push it through approval.` : `open a ${prio} case for ${n.team}.`} Stance: ${n.playbook?.stance || 'acknowledge and take it offline.'} ${top ? cite(top) : ''}`);
      if (top) cites.push(top);
    } else if (s.net > 0.3 && s.last3d >= 5) {
      actions.push(`**${s.name}** is positive (net ${fmtNet(s.net)}). Amplify it with owned channels and thank top advocates. ${top ? cite(top) : ''}`);
      if (top) cites.push(top);
    }
  }
  const comp = (ctx.alerts || []).find((a) => a.type === 'competitive' && a.status !== 'dismissed');
  if (comp) {
    const m = ctx.mentions.find((x) => x.id === comp.mentionIds[0]);
    actions.push(`**Competitive:** ${comp.title}. Brief retention/CX teams on save offers for affected customers. ${m ? cite(m) : ''}`);
    if (m) cites.push(m);
  }
  const lines = ['**Recommended next actions** (ranked by volume × negativity):', ...actions.slice(0, 5).map((a, i) => `${i + 1}. ${a}`)];
  return { answer: lines.join('\n'), citations: cites.map((m) => citation(m, ctx)), evidence: { narratives: stats.map(({ id, name, last3d, net: n }) => ({ id, name, last3d, net: n })) } };
}

function narrativeAnswer(nar, ctx, days) {
  const list = inWindow(ctx.mentions.filter((m) => m.narrativeId === nar.id), ctx.now - days * DAY, ctx.now);
  const s = summary(list);
  const locs = breakdown(list, (m) => m.location).slice(0, 3);
  const srcs = breakdown(list, (m) => m.source).slice(0, 3);
  const amps = influencers(list, ctx.authorsById, 3);
  const kw = topKeywords(list, ctx.entities, 6).map((k) => k.term);
  const top = byEngagement(list).slice(0, 4);
  const lines = [
    `**${nar.name}**: ${list.length} mentions in the last ${days} day(s), net sentiment ${fmtNet(s.net)}.`,
    nar.summary ? `${nar.summary}` : '',
    `- **Where:** ${locs.map((l) => `${l.key} (${l.count})`).join(', ') || 'n/a'}. **Channels:** ${srcs.map((x) => `${x.key} ${x.share}%`).join(', ')}.`,
    `- **Key terms:** ${kw.join(', ')}.`,
    amps.length ? `- **Top voices:** ${amps.map((a) => who(a.author)).join('; ')}.` : '',
    `- **Representative posts:** ${top.map(cite).join(' ')}`,
    nar.playbook ? `- **Approved talking points:** ${nar.playbook.facts.join(' ')}` : '',
  ].filter(Boolean);
  return { answer: lines.join('\n'), citations: top.map((m) => citation(m, ctx)), evidence: { narrativeId: nar.id, summary: s } };
}

function searchAnswer(q, ctx, days) {
  const from = ctx.now - days * DAY;
  const scored = inWindow(ctx.mentions, from, ctx.now)
    .map((m) => ({ m, r: relevance(q, `${m.title || ''} ${m.text}`) }))
    .filter((x) => x.r >= 0.34)
    .sort((a, b) => b.r - a.r || engagementOf(b.m) - engagementOf(a.m));
  if (!scored.length) {
    return { answer: `I could not find mentions matching "${q}" in the last ${days} day(s). Try one of the suggested questions, or ask about a narrative such as the outage, pricing or privacy.`, citations: [], evidence: {} };
  }
  const list = scored.map((x) => x.m);
  const s = summary(list);
  const ents = topN(countBy(list, (m) => m.entity), 3).map(([e, c]) => `${ctx.entities.find((x) => x.id === e)?.name} (${c})`);
  const top = list.slice(0, 5);
  return {
    answer: [`Found **${list.length} matching mentions** in the last ${days} day(s), mostly about ${ents.join(', ')}. Sentiment: ${s.positive} positive, ${s.neutral} neutral, ${s.negative} negative (net ${fmtNet(s.net)}).`, `Most relevant: ${top.map(cite).join(' ')}`].join('\n'),
    citations: top.map((m) => citation(m, ctx)),
    evidence: { matches: list.length, summary: s },
  };
}

/** Local, deterministic answer. */
export function answerLocal(question, ctx) {
  const q = String(question || '').trim();
  const intent = classify(q);
  const lower = q.toLowerCase();
  const defaults = { why: 3, emerging: 7, compare: 7, influencers: 3, summary: 1, recommend: 3, search: 30, narrative: 7 };
  let result;
  let finalIntent = intent;
  const nar = focusNarrative(q, ctx, null);
  let days;
  if (intent === 'search' && nar) {
    finalIntent = 'narrative';
    days = parseWindow(lower, defaults.narrative);
    result = narrativeAnswer(nar, ctx, days);
  } else {
    days = parseWindow(lower, defaults[intent]);
    result = { why: whyAnswer, emerging: emergingAnswer, compare: compareAnswer, influencers: influencerAnswer, summary: summaryAnswer, recommend: recommendAnswer, search: searchAnswer }[intent](q, ctx, days);
  }
  return {
    question: q,
    intent: finalIntent,
    engine: 'local',
    window: { from: new Date(ctx.now - days * DAY).toISOString(), to: new Date(ctx.now).toISOString(), days },
    ...result,
    suggestions: followUps(finalIntent),
  };
}

function followUps(intent) {
  const map = {
    why: ['Who is driving the outage conversation?', 'What should we do next?', 'How does our share of voice compare with competitors?'],
    emerging: ['Tell me about the location data narrative', 'Who is driving the privacy conversation?', 'What should we do next?'],
    compare: ['Why is Telluma gaining share of voice?', 'Which narratives are gaining momentum this week?'],
    influencers: ['What should we do next?', 'Why did negative sentiment rise in the last 72 hours?'],
    summary: ['Why did negative sentiment rise in the last 72 hours?', 'What should we do next?'],
    recommend: ['Give me an executive summary of the last 24 hours', 'Which narratives are gaining momentum this week?'],
    narrative: ['Who is driving this conversation?', 'What should we do next?'],
    search: SUGGESTED_QUESTIONS.slice(0, 3),
  };
  return map[intent] || [];
}

const SYSTEM = `You are the MediaGPT Intelligence Copilot, a media-intelligence analyst for a corporate communications team.
Answer the user's question using ONLY the evidence provided (metrics and source mentions). Never invent numbers, accounts or events.
Cite source mentions inline by their id in square brackets, e.g. [M-00042]; cite only ids that appear in the evidence.
Write for a busy communications lead: lead with the direct answer, then 3-6 short bullets with specifics (numbers, time, places, accounts).
Use simple Markdown (bold, bullets, a table only if comparing brands). Keep it under 220 words. If the evidence does not answer the question, say so plainly.`;

/** Answer with Claude when configured, grounded on the local evidence; otherwise local. */
export async function answer(question, ctx) {
  const local = answerLocal(question, ctx);
  if (!llmConfigured() || ctx.useLlm === false) return local;
  const pool = new Map(local.citations.map((c) => [c.id, c]));
  // Add a few extra relevant mentions so the model has more grounding.
  for (const m of inWindow(ctx.mentions, Date.parse(local.window.from), ctx.now)
    .map((m) => ({ m, r: relevance(question, `${m.title || ''} ${m.text}`) }))
    .filter((x) => x.r >= 0.5).sort((a, b) => b.r - a.r).slice(0, 8).map((x) => x.m)) {
    if (!pool.has(m.id)) pool.set(m.id, citation(m, ctx));
  }
  const prompt = [
    `Question: ${question}`,
    `Time window: ${local.window.from} to ${local.window.to}. Current time: ${new Date(ctx.now).toISOString()}.`,
    `Analytic findings from the local engine (trustworthy, computed from the data):\n${local.answer}`,
    `Structured evidence:\n${JSON.stringify(local.evidence).slice(0, 6000)}`,
    `Source mentions:\n${[...pool.values()].map((c) => `[${c.id}] ${c.source} · ${c.author}${c.followers ? ` (${c.followers} followers)` : ''} · ${c.publishedAt} · ${c.sentiment}: ${c.snippet}`).join('\n')}`,
  ].join('\n\n');
  const text = await complete({ system: SYSTEM, prompt, maxTokens: 2000 });
  if (!text) return local;
  const cited = [...text.matchAll(/\[(M-\d+)\]/g)].map((x) => x[1]);
  if (cited.some((id) => !pool.has(id))) return local; // reject answers that cite unknown sources
  const order = [...new Set(cited)];
  return { ...local, engine: 'claude', model: MODEL, answer: text, citations: order.length ? order.map((id) => pool.get(id)) : local.citations };
}
