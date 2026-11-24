// Context-aware response suggestions. Drafts are built from the narrative's
// approved playbook (facts + stance), the audience type and the channel, so
// they never introduce claims that legal/comms have not approved.
import { complete, llmConfigured, MODEL } from './llm.js';

const CHANNEL_LIMIT = { x: 280, instagram: 600, tiktok: 300, facebook: 600, reddit: 1200, youtube: 600, forum: 1200, 'media-statement': 1500, email: 2000, 'internal-brief': 2000 };

export function channelFor(mention, author) {
  if (!mention) return 'media-statement';
  if (author?.type === 'journalist' || mention.source === 'news') return 'media-statement';
  if (['x', 'instagram', 'tiktok', 'facebook', 'reddit', 'youtube', 'forum'].includes(mention.source)) return mention.source;
  return 'email';
}

function firstName(author) {
  if (!author) return null;
  if (author.name && author.type !== 'outlet') return author.name.split(' ')[0];
  return author.handle?.startsWith('@') ? author.handle : null;
}

const lcFirst = (s) => (s ? s[0].toLowerCase() + s.slice(1) : s);
const trimTo = (s, n) => (s.length <= n ? s : `${s.slice(0, n - 1).replace(/\s+\S*$/, '')}…`);

/** Deterministic, playbook-grounded draft. */
export function suggestLocal({ narrative, mention, author, channel, brandName = 'Halvia Mobile' }) {
  channel = channel || channelFor(mention, author);
  const pb = narrative?.playbook || { facts: [], stance: 'Acknowledge, thank them for raising it, and offer a direct line to the team.' };
  const tone = mention?.sentiment?.label || (narrative?.polarity === 'positive' ? 'positive' : 'negative');
  const name = firstName(author);
  const rationale = [];
  let text;

  if (channel === 'media-statement') {
    const opener = tone === 'positive'
      ? `${brandName} welcomes the coverage of the ${lcFirst(narrative?.name) || 'work our teams do'}.`
      : `${brandName} understands the concern about the ${lcFirst(narrative?.name) || 'issue raised'}, and we owe our customers a clear answer.`;
    text = [`Statement from ${brandName}:`, '', opener, ...pb.facts, '', 'We will continue to share updates as they become available. Media contact: press@halvia.example.'].join('\n');
    rationale.push('Journalist or news audience, so this is a formal statement using approved facts only.');
  } else if (tone === 'positive') {
    text = `${name ? `Thanks ${name}! ` : 'Thank you! '}We're so glad to hear it. ${pb.facts[0] || ''}`.trim();
    rationale.push('Positive mention: thank and amplify, no ask.');
  } else {
    const sorry = narrative?.polarity === 'negative' ? "We're really sorry about this." : 'Thanks for flagging this.';
    const fact = pb.facts[0] ? ` ${pb.facts[0]}` : '';
    const cta = ' Please DM @HalviaCares and our team will make it right.';
    text = `${name ? `Hi ${name}, ` : 'Hi, '}${sorry}${fact}${cta}`;
    if (text.length > (CHANNEL_LIMIT[channel] || 600) && pb.facts[0]) text = `${name ? `Hi ${name}, ` : 'Hi, '}${sorry}${cta}`;
    rationale.push('Negative social mention: apologise, give one approved fact, move to a private channel.');
  }
  text = trimTo(text, CHANNEL_LIMIT[channel] || 1000);
  if (pb.stance) rationale.push(`Playbook stance: ${pb.stance}`);
  if (author?.followers >= 100000) rationale.push(`High-reach account (${author.followers.toLocaleString()} followers): route through approval before posting.`);
  return { text, channel, tone, rationale, factsUsed: pb.facts, generatedBy: 'mediagpt-ai', characterLimit: CHANNEL_LIMIT[channel] || null };
}

const SYSTEM = `You draft responses for a corporate communications team. Use ONLY the approved facts provided; never add new claims, numbers, promises or legal admissions.
Match the channel: social replies are short, warm and human (respect the character limit); media statements are formal and factual.
Return only the draft text, with no preamble and no quotation marks.`;

export async function suggest(input) {
  const local = suggestLocal(input);
  if (!llmConfigured() || input.useLlm === false) return local;
  const { narrative, mention, author } = input;
  const prompt = [
    `Channel: ${local.channel} (limit ${local.characterLimit || 'none'} characters)`,
    `Narrative: ${narrative?.name || 'n/a'}: ${narrative?.summary || ''}`,
    `Stance: ${narrative?.playbook?.stance || 'acknowledge and help'}`,
    `Approved facts:\n${(local.factsUsed || []).map((f) => `- ${f}`).join('\n') || '- (none, so do not state facts)'}`,
    mention ? `Responding to ${author?.type || 'user'} ${author?.handle || ''} (${author?.followers || 0} followers):\n"${mention.title ? `${mention.title}. ` : ''}${mention.text}"` : 'Write a general holding statement.',
  ].join('\n\n');
  const text = await complete({ system: SYSTEM, prompt, maxTokens: 1200 });
  if (!text || (local.characterLimit && text.length > local.characterLimit)) return local;
  return { ...local, text, generatedBy: 'claude', model: MODEL };
}
