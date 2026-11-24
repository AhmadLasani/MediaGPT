// Demo dataset: a fictional telecom brand ("Halvia Mobile") and three fictional
// competitors, with a 30-day storyline. All names, handles and outlets are
// invented. Timestamps are relative to "now" so the story is always current.
import { rng, pick, between, HOUR, DAY, MIN, iso } from './util.js';

export const BRAND = 'halvia';

export const ENTITIES = [
  { id: 'halvia', name: 'Halvia Mobile', kind: 'brand', color: '#6d4aff', aliases: ['halvia', 'halvia mobile', '@halviamobile', '#halvia', '#halvia5g', '#halviadown', '@halviacares'] },
  { id: 'telluma', name: 'Telluma', kind: 'competitor', color: '#f59e0b', aliases: ['telluma', '@telluma', '#tellumaswitch', '#telluma'] },
  { id: 'corvane', name: 'Corvane Wireless', kind: 'competitor', color: '#10b981', aliases: ['corvane', 'corvane wireless', '@corvane', '#corvane'] },
  { id: 'brisa', name: 'Brisa Connect', kind: 'competitor', color: '#0ea5e9', aliases: ['brisa connect', '@brisaconnect', '#brisaconnect', 'brisa'] },
];

export const SOURCES = {
  x: { name: 'X / Twitter', icon: '𝕏' },
  reddit: { name: 'Reddit', icon: '👽' },
  news: { name: 'News', icon: '📰' },
  youtube: { name: 'YouTube', icon: '▶️' },
  instagram: { name: 'Instagram', icon: '📷' },
  tiktok: { name: 'TikTok', icon: '🎵' },
  facebook: { name: 'Facebook', icon: '👥' },
  forum: { name: 'Forums', icon: '💬' },
  blog: { name: 'Blogs', icon: '✍️' },
  podcast: { name: 'Podcasts', icon: '🎙️' },
};

const SOCIAL = ['x', 'x', 'x', 'reddit', 'reddit', 'instagram', 'tiktok', 'facebook', 'forum', 'youtube'];
const CITIES = ['Denver, CO', 'Colorado Springs, CO', 'Phoenix, AZ', 'Dallas, TX', 'Austin, TX', 'Seattle, WA', 'Chicago, IL', 'Atlanta, GA', 'Boston, MA', 'Miami, FL', 'Portland, OR', 'Minneapolis, MN'];
const OUTAGE_CITIES = ['Denver, CO', 'Denver, CO', 'Colorado Springs, CO', 'Boulder, CO', 'Phoenix, AZ', 'Salt Lake City, UT'];

// d = rolling days ago (0 = the last 24 hours). Each curve returns the expected mentions per day.
const bump = (d, center, width, height) => height * Math.exp(-((d - center) ** 2) / (2 * width * width));

export const NARRATIVES = [
  {
    id: 'n-outage', entity: 'halvia', name: 'Network outage in the Mountain region', polarity: 'negative', team: 'Network Ops',
    summary: 'Customers in Colorado, Arizona and Utah report no signal and dropped calls after a core network failure.',
    signals: ['outage', 'no signal', 'sos only', 'network down', 'dropped calls', 'no service', '#halviadown', 'blackout', 'still down', 'service restored', 'restored'],
    curve: (d) => (d === 2 ? 58 : d === 1 ? 74 : d === 0 ? 34 : d < 6 ? 0.3 : 0),
    hourWindow: (d) => (d === 2 ? [0, 11] : null), // the outage began ~60h ago
    playbook: {
      facts: ['Service was fully restored at 06:40 MT after a fiber cut affected a core router in Denver.', 'Affected customers receive an automatic one-day bill credit; no action is needed.', 'Live updates are posted at halvia.example/status.'],
      stance: 'Apologise without hedging, confirm restoration and the credit, point to the status page.',
    },
    templates: [
      'No signal for {hours} hours now. {brand} what is going on?? SOS only in {city} 😡',
      '{brand} network down again. Missed a work call and a doctor callback. Absolutely unacceptable.',
      'Is {brand} down for anyone else in {city}? Dropped calls all morning #halviadown',
      'Day two of the {brand} outage. No service, no updates, no apology. Worst experience ever.',
      'My whole family is on {brand} and we have had no signal since yesterday. Seriously thinking about cancelling. #halviadown',
      '{brand} outage means I can not even call 911 properly. This is dangerous, not just annoying 🤬',
      'Lawyers on my local forum are already talking class action over the {brand} outage. Can not say I blame them.',
      'Service restored for me in {city} 🙏 still, {hours} hours of no signal from {brand} deserves more than a tweet.',
      'Signal is back. Thanks to the {brand} field crews working overnight, but the communication was terrible.',
      '{brand} still down in {city}. Their status page says restored, my phone says SOS only.',
    ],
    news: [
      ['{brand} outage leaves thousands without service across the Mountain West', 'A core network failure left customers of {brand} without calls or data for up to {hours} hours. Customers reported no signal and dropped calls in Denver and Phoenix.'],
      ['{brand} restores service after day-long blackout, promises bill credit', '{brand} said service was restored after a fiber cut. Critics say the outage exposed weak redundancy and poor customer communication.'],
      ['Regulators ask questions after {brand} network down for {hours} hours', 'State officials requested a report from {brand} after the outage disrupted emergency calls in parts of Colorado.'],
    ],
  },
  {
    id: 'n-price', entity: 'halvia', name: 'Plan price increase backlash', polarity: 'negative', team: 'Communications',
    summary: 'A $5/month increase on legacy unlimited plans triggered complaints about broken price-lock promises.',
    signals: ['price increase', 'price hike', 'raising prices', 'price lock', 'more per month', 'legacy plan', 'overpriced', 'bill went up', '$5 more'],
    curve: (d) => (d > 13 ? 0.4 : 1.2 + bump(d, 11, 1.6, 15)),
    playbook: {
      facts: ['The $5 change applies to legacy Unlimited plans only, starting next billing cycle.', 'Customers on Price Lock plans are not affected.', 'Customers can move to Unlimited Flex at no extra cost via the app.'],
      stance: 'Acknowledge the frustration, explain who is and is not affected, offer the no-cost plan switch.',
    },
    templates: [
      '{brand} raising prices on legacy plans by $5 more per month. So much for the price lock promise.',
      'Got the email. {brand} price hike on my unlimited plan. Overpriced already, now this. 👎',
      'My bill went up and {brand} calls it a "plan update". Misleading. Looking at {comp}.',
      'The {brand} price increase is greedy, plain and simple. Record profits and they still hike.',
      'To be fair the {brand} price increase only hits the old legacy plan, Unlimited Flex is still the same price.',
      'Called {brand} about the price hike and they moved me to a cheaper plan. Support was actually helpful.',
    ],
    news: [
      ['{brand} to raise legacy plan prices by $5 a month', '{brand} confirmed a price increase on legacy unlimited plans, prompting complaints that the company broke its price lock promise.'],
      ['Why your {brand} bill went up this month', 'Consumer advocates call the {brand} price hike confusing; the company says Price Lock customers are not affected.'],
    ],
  },
  {
    id: 'n-5g', entity: 'halvia', name: '5G Ultra launch and speeds', polarity: 'positive', team: 'Marketing',
    summary: 'The 5G Ultra launch earned strong speed-test reviews and creator coverage.',
    signals: ['5g ultra', '#halvia5g', 'speed test', 'speeds', 'gbps', 'mmwave', 'launch'],
    curve: (d) => 1.5 + bump(d, 19, 2.2, 16),
    playbook: { facts: ['5G Ultra is live in 42 cities, with 30 more by spring.', 'Existing Unlimited customers get 5G Ultra at no extra cost.'], stance: 'Thank, amplify, invite them to share their speed tests.' },
    templates: [
      'Speed test on {brand} 5G Ultra in {city}: 1.4 Gbps down 🔥 genuinely impressive. #halvia5g',
      '{brand} 5G Ultra launch is the real deal. Fastest mobile speeds I have ever seen.',
      'Tested {brand} 5G Ultra vs {comp} downtown. {brand} wins, and it was not close. #halvia5g',
      'Not going to lie the {brand} 5G Ultra speeds are amazing, battery drain is real though.',
      'Love the new {brand} 5G Ultra. Streaming in 4K on the train with zero buffering 😍',
      '{brand} 5G Ultra coverage in {city} is still patchy, speeds are great when you find it.',
    ],
    news: [
      ['{brand} launches 5G Ultra in 42 cities', 'The {brand} 5G Ultra launch promises multi-gigabit speeds; early speed test results were impressive.'],
      ['Review: {brand} 5G Ultra is the fastest network we have tested', 'In our speed test across six cities, {brand} 5G Ultra posted the best median download speeds.'],
    ],
  },
  {
    id: 'n-support', entity: 'halvia', name: 'Customer support wait times', polarity: 'negative', team: 'Customer Experience',
    summary: 'Long hold times and chatbot loops, which grew sharply during the outage.',
    signals: ['on hold', 'hold time', 'customer service', 'support', 'chatbot', 'wait time', 'agent', 'callback', '@halviacares'],
    curve: (d) => (d <= 2 ? 13 : 3.2),
    playbook: { facts: ['Callback wait times are back under 10 minutes.', 'Customers can skip the queue via in-app chat with a live agent.'], stance: 'Apologise, offer a direct route (DM or callback), take it offline.' },
    templates: [
      'On hold with {brand} customer service for {mins} minutes. This is ridiculous.',
      '{brand} support chatbot keeps looping me back to the start. Just give me a human agent 😩',
      '@HalviaCares promised a callback two days ago. Still waiting. Frustrated.',
      'Honestly the {brand} support agent I got today was friendly and fixed my issue quickly. Credit where it is due.',
      'Wait time for {brand} customer service is {mins} minutes. During an outage. Brilliant planning 🙄',
    ],
    news: [['{brand} customers face long hold times as support lines are swamped', 'Customers told reporters they waited over an hour for {brand} customer service.']],
  },
  {
    id: 'n-privacy', entity: 'halvia', name: 'Location data sharing concerns', polarity: 'negative', team: 'Legal',
    summary: 'An emerging narrative after a researcher flagged a privacy-policy clause on sharing location data with ad partners.',
    signals: ['location data', 'privacy', 'privacy policy', 'data sharing', 'ad partners', 'opt out', 'tracking', 'sold my data'],
    curve: (d) => (d > 5 ? 0.15 : d === 5 ? 1 : d === 4 ? 2 : d === 3 ? 4 : d === 2 ? 7 : d === 1 ? 12 : 13),
    playbook: { facts: ['Halvia does not sell customer location data.', 'Aggregated, de-identified insights are shared only with opt-in consent.', 'Customers can review and change settings under Privacy Center in the app.'], stance: 'Be precise and factual, avoid defensiveness, link to the Privacy Center.' },
    templates: [
      'Just read the new {brand} privacy policy. They share location data with ad partners?? Creepy. How do I opt out',
      'PSA: {brand} customers, go to settings and opt out of location data sharing. Took me 4 screens to find it.',
      'Researchers say the {brand} privacy policy allows data sharing with ad partners. Concerning if true.',
      'Did {brand} just quietly change the privacy policy to allow tracking? Worried about this.',
      'Not great: {brand} location data clause looks invasive. Want a clear answer from the company.',
    ],
    news: [['Privacy researchers question {brand} location data sharing clause', 'A clause in the {brand} privacy policy appears to allow sharing location data with ad partners, researchers said; the company has not yet commented.']],
  },
  {
    id: 'n-green', entity: 'halvia', name: 'Device recycling program', polarity: 'positive', team: 'Marketing',
    summary: 'The Green Halvia trade-in and recycling program draws steady positive mentions.',
    signals: ['recycling', 'recycle', 'trade-in', 'trade in', 'sustainable', 'green halvia', 'e-waste'],
    curve: (d) => 1.6 + bump(d, 8, 1.2, 5),
    playbook: { facts: ['Green Halvia has recycled 1.2M devices since launch.', 'Every trade-in plants a tree with our reforestation partner.'], stance: 'Thank and amplify.' },
    templates: [
      'Dropped my old phone at the {brand} store for the recycling program. Easy and they gave me trade-in credit. Love it 👏',
      'Nice to see {brand} taking e-waste seriously. The Green Halvia recycling initiative is solid.',
      '{brand} trade-in plus recycling for my old devices. Sustainable and I saved money. Win.',
    ],
    news: [['{brand} says recycling program passed 1.2 million devices', 'The Green Halvia program lets customers recycle or trade in old devices at any store.']],
  },
  {
    id: 'n-coverage', entity: 'halvia', name: 'Everyday coverage and reliability', polarity: 'mixed', team: 'Network Ops',
    summary: 'Ongoing mentions of everyday coverage quality, mostly favourable outside the outage.',
    signals: ['coverage', 'reliable', 'signal', 'bars', 'rural', 'reception'],
    curve: (d) => (d <= 2 ? 1.5 : 4.5),
    playbook: { facts: ['Halvia covers 99% of the US population with LTE.'], stance: 'Thank, or offer a coverage check for complaints.' },
    templates: [
      '{brand} coverage on my road trip through {city} was solid, full bars nearly everywhere.',
      'Switched to {brand} last year and the reception at my place is way better than {comp}. Reliable.',
      '{brand} signal in my basement office is weak. Otherwise coverage is fine.',
      'Rural coverage from {brand} still has gaps, but it is better than it was.',
    ],
    news: [],
  },
  {
    id: 'n-halvia-other', entity: 'halvia', name: null, polarity: 'neutral', team: null, signals: [],
    curve: () => 3.5,
    templates: [
      'Anyone know if {brand} has a store open late in {city}?',
      'Thinking about getting the new phone through {brand}. Any thoughts?',
      'Watching the game at a bar sponsored by {brand}. Neat halftime ad.',
      '{brand} app update today, the new layout looks clean.',
      'Ported my number to {brand}, took about 20 minutes.',
    ],
    news: [],
  },
  // ---------------- competitors ----------------
  {
    id: 'n-telluma-switch', entity: 'telluma', name: 'Telluma "Switch & Save" offer', polarity: 'positive', team: null,
    summary: 'Telluma is targeting Halvia customers with an aggressive switching offer during the outage.',
    signals: ['switch & save', 'switch and save', '#tellumaswitch', 'switching', 'switched', 'pay off your phone', 'switch'],
    curve: (d) => (d === 1 ? 24 : d === 0 ? 19 : d === 2 ? 9 : 1),
    templates: [
      'Just switched to {comp_t} with the Switch & Save deal after the Halvia outage. They paid off my phone 👍 #tellumaswitch',
      '{comp_t} is running a switch and save offer aimed straight at Halvia customers. Smart timing, a bit savage 💀',
      '{comp_t} switching was painless, saved $20 a month. #tellumaswitch',
      'Thinking of switching to {comp_t}. Anyone tried their switch & save offer?',
    ],
    news: [['{comp_t} courts Halvia customers with Switch & Save offer', '{comp_t} launched a switch and save promotion that pays off devices for customers switching from rival carriers.']],
  },
  {
    id: 'n-telluma-app', entity: 'telluma', name: 'Telluma app redesign', polarity: 'mixed', team: null, signals: ['app', 'redesign', 'update', 'login'],
    curve: () => 3,
    templates: ['The new {comp_t} app redesign is clean but the login keeps failing.', '{comp_t} app update is great, finally can see my data usage properly.', '{comp_t} app redesign broke autopay for me. Annoying.'],
    news: [],
  },
  {
    id: 'n-corvane-rural', entity: 'corvane', name: 'Corvane rural coverage expansion', polarity: 'positive', team: null, signals: ['rural', 'expansion', 'coverage', 'towers', 'small towns'],
    curve: (d) => 2.5 + bump(d, 8, 2, 6),
    templates: ['{comp_c} rural coverage expansion finally reached my town. Great signal now 🙌', '{comp_c} is building new towers in small towns, good for rural folks.', 'Impressed by the {comp_c} expansion, coverage on the ranch is reliable now.'],
    news: [['{comp_c} adds 900 rural towers in coverage expansion', '{comp_c} said the expansion brings reliable coverage to small towns across the Midwest.']],
  },
  {
    id: 'n-corvane-other', entity: 'corvane', name: null, polarity: 'neutral', team: null, signals: [], curve: () => 3,
    templates: ['Any {comp_c} customers here? How is the international roaming?', '{comp_c} store downtown is moving next month.', 'Got my bill from {comp_c}, same as last month.'],
    news: [],
  },
  {
    id: 'n-brisa-billing', entity: 'brisa', name: 'Brisa Connect billing errors', polarity: 'negative', team: null, signals: ['billing', 'overcharged', 'bill', 'charged twice', 'refund'],
    curve: () => 3,
    templates: ['{comp_b} charged twice this month. Billing is a mess, waiting on a refund.', 'Overcharged again by {comp_b}. Third time this year 😤', '{comp_b} billing error fixed after one call, fair play.'],
    news: [['{comp_b} customers report billing errors', 'Several {comp_b} customers say they were overcharged; the company promised refunds.']],
  },
  {
    id: 'n-brisa-other', entity: 'brisa', name: null, polarity: 'neutral', team: null, signals: [], curve: () => 3,
    templates: ['Is {comp_b} good in Seattle? Thinking of a family plan.', '{comp_b} added a new prepaid option.', 'Using {comp_b} for my tablet, works fine.'],
    news: [],
  },
];

export const USERS = [
  { id: 'u-aisha', name: 'Aisha Khan', role: 'analyst', team: 'Communications', title: 'Intelligence Analyst' },
  { id: 'u-daniel', name: 'Daniel Ortiz', role: 'manager', team: 'Communications', title: 'Head of Communications' },
  { id: 'u-rebecca', name: 'Rebecca Lin', role: 'executive', team: 'Leadership', title: 'VP Corporate Affairs' },
  { id: 'u-sam', name: 'Sam Patel', role: 'analyst', team: 'Customer Experience', title: 'CX Lead' },
  { id: 'u-leo', name: 'Leo Fischer', role: 'analyst', team: 'Marketing', title: 'Campaign Manager' },
  { id: 'u-nora', name: 'Nora Haddad', role: 'manager', team: 'Legal', title: 'Privacy Counsel' },
  { id: 'u-admin', name: 'Platform Admin', role: 'admin', team: 'IT', title: 'Workspace Administrator' },
];

export const TEAMS = ['Communications', 'Customer Experience', 'Marketing', 'Legal', 'Network Ops', 'Leadership'];

export const DEFAULT_QUERIES = [
  { id: 'q-brand', name: 'Halvia brand', kind: 'brand', terms: ['halvia', 'halvia mobile', '@halviamobile', '@halviacares', '#halvia'], exclude: [], active: true },
  { id: 'q-competitors', name: 'Competitors', kind: 'competitor', terms: ['telluma', 'corvane', 'brisa connect'], exclude: [], active: true },
  { id: 'q-5g', name: '5G Ultra campaign', kind: 'campaign', terms: ['5g ultra', '#halvia5g'], exclude: [], active: true },
  { id: 'q-network', name: 'Network issues', kind: 'issue', terms: ['outage', 'no signal', 'network down', 'dropped calls', '#halviadown'], exclude: [], active: true },
  { id: 'q-privacy', name: 'Privacy and data', kind: 'issue', terms: ['privacy', 'location data', 'data sharing', 'tracking'], exclude: [], active: true },
];

export const DEFAULT_ALERT_RULES = [
  { id: 'rule-legal', name: 'Legal and regulatory risk', terms: ['class action', 'lawsuit', 'sue', 'regulators', 'boycott'], severity: 'critical', entity: 'halvia', active: true },
  { id: 'rule-security', name: 'Security and data incident', terms: ['breach', 'hacked', 'leaked', 'sold my data'], severity: 'high', entity: 'halvia', active: true },
  { id: 'rule-safety', name: 'Public safety', terms: ['911', 'emergency calls'], severity: 'critical', entity: 'halvia', active: true },
];

export const DEFAULT_SETTINGS = {
  workspace: 'Halvia Mobile: Corporate Affairs',
  brand: BRAND,
  detection: { spikeZ: 3, sentimentDrop: 0.2, emergingRatio: 2, emergingMin: 8, influencerFollowers: 100000, sovShiftPts: 6 },
  approvals: {
    P1: [{ step: 'Communications approval', role: 'manager' }, { step: 'Executive sign-off', role: 'executive' }],
    P2: [{ step: 'Communications approval', role: 'manager' }],
    P3: [{ step: 'Team lead approval', role: 'manager' }],
    P4: [],
  },
  slaHours: { P1: 2, P2: 8, P3: 24, P4: 72 },
  digest: { enabled: true, time: '07:30', recipients: ['comms-leadership@halvia.example'] },
};

// ---------------- authors ----------------
const FIRST = ['jordan', 'casey', 'riley', 'alex', 'morgan', 'taylor', 'jamie', 'devon', 'quinn', 'avery', 'rowan', 'sky', 'harper', 'reese', 'emery', 'kai', 'sage', 'drew', 'blair', 'lane'];
const LAST = ['m', 'tx', '_co', '84', 'k', 'writes', 'reviews', '_den', 'p', 'v', '22', 'lee', 'ray', '_az', 'n', 'zz', '_atl', '07', 'b', 'q'];

const NAMED_AUTHORS = [
  { id: 'a-grace', handle: '@gadgetgrace', name: 'Grace Okafor', type: 'creator', source: 'youtube', followers: 812000, verified: true, bio: 'Tech reviews and mobile deep dives' },
  { id: 'a-techtrio', handle: '@techtrio', name: 'TechTrio', type: 'creator', source: 'tiktok', followers: 1450000, verified: true, bio: 'Three friends, one phone a day' },
  { id: 'a-dealdan', handle: '@dealhunterdan', name: 'Dan Whitlock', type: 'creator', source: 'x', followers: 286000, verified: true, bio: 'Deals, switching offers, money saving' },
  { id: 'a-eli', handle: '@privacyfirst_eli', name: 'Eli Brandt', type: 'analyst', source: 'x', followers: 64000, verified: true, bio: 'Privacy researcher. Reads the policies so you do not have to.' },
  { id: 'a-mila', handle: '@milamoves', name: 'Mila Torres', type: 'creator', source: 'instagram', followers: 433000, verified: true, bio: 'Travel and digital nomad life' },
  { id: 'a-netwatch', handle: '@netwatch_ops', name: 'NetWatch', type: 'analyst', source: 'x', followers: 158000, verified: true, bio: 'Real-time outage tracking' },
  { id: 'a-marcus', handle: 'Marcus Bell', name: 'Marcus Bell', type: 'journalist', source: 'news', outlet: 'Signal & Wire', followers: 2100000, verified: true },
  { id: 'a-priya', handle: 'Priya Raman', name: 'Priya Raman', type: 'journalist', source: 'news', outlet: 'The Metro Ledger', followers: 3400000, verified: true },
  { id: 'a-tom', handle: 'Tom Achebe', name: 'Tom Achebe', type: 'journalist', source: 'news', outlet: 'Bytewise News', followers: 960000, verified: true },
  { id: 'a-lena', handle: 'Lena Fischer', name: 'Lena Fischer', type: 'journalist', source: 'news', outlet: 'Consumer Watch Today', followers: 1250000, verified: true },
  { id: 'a-ken', handle: 'Ken Mori', name: 'Ken Mori', type: 'journalist', source: 'news', outlet: 'Northbridge Herald', followers: 780000, verified: true },
  { id: 'a-sofia', handle: 'Sofia Grant', name: 'Sofia Grant', type: 'journalist', source: 'news', outlet: 'Daily Circuit', followers: 540000, verified: true },
  { id: 'a-telpod', handle: 'The Spectrum Show', name: 'The Spectrum Show', type: 'creator', source: 'podcast', followers: 120000, verified: false },
  { id: 'a-blog', handle: 'carrierchronicle.example', name: 'Carrier Chronicle', type: 'outlet', source: 'blog', followers: 85000, verified: false },
];

function buildAuthors(r) {
  const authors = [...NAMED_AUTHORS];
  for (let i = 0; i < 260; i++) {
    const source = pick(r, SOCIAL);
    const big = r() < 0.06;
    authors.push({
      id: `a-${i}`,
      handle: source === 'reddit' ? `u/${pick(r, FIRST)}${pick(r, LAST)}${i}` : `@${pick(r, FIRST)}${pick(r, LAST)}${i}`,
      name: null,
      type: big ? 'creator' : 'consumer',
      source,
      followers: big ? between(r, 15000, 90000) : Math.floor(30 + r() ** 3 * 6000),
      verified: big && r() < 0.5,
    });
  }
  return authors;
}

// ---------------- mention generation ----------------
const DISPLAY = { halvia: ['Halvia', '@HalviaMobile', 'Halvia', 'Halvia Mobile'] };

export function fill(r, text, extra = {}) {
  return text
    .replace(/\{brand\}/g, () => pick(r, DISPLAY.halvia))
    .replace(/\{comp\}/g, () => pick(r, ['Telluma', 'Corvane', 'Brisa Connect']))
    .replace(/\{comp_t\}/g, () => pick(r, ['Telluma', '@Telluma']))
    .replace(/\{comp_c\}/g, () => pick(r, ['Corvane', 'Corvane Wireless']))
    .replace(/\{comp_b\}/g, () => pick(r, ['Brisa Connect', '@BrisaConnect']))
    .replace(/\{city\}/g, () => extra.city || pick(r, CITIES).split(',')[0])
    .replace(/\{hours\}/g, () => String(between(r, 9, 31)))
    .replace(/\{mins\}/g, () => String(between(r, 45, 140)));
}

function engagementFor(r, followers, intensity) {
  const base = Math.max(1, followers * (0.004 + r() * 0.02) * (1 + intensity));
  return { likes: Math.round(base), shares: Math.round(base * (0.08 + r() * 0.25)), comments: Math.round(base * (0.04 + r() * 0.12)) };
}

/** Build one raw mention (before NLP enrichment). */
export function makeRawMention(r, { narrative, ts, author, forceNews = false }) {
  const isOutage = narrative.id === 'n-outage';
  const location = isOutage ? pick(r, OUTAGE_CITIES) : pick(r, CITIES);
  const city = location.split(',')[0];
  let source = author.source;
  let title = null;
  let text;
  if ((forceNews || source === 'news') && narrative.news?.length) {
    const [t, body] = pick(r, narrative.news);
    title = fill(r, t, { city });
    text = fill(r, body, { city });
    source = 'news';
  } else {
    if (source === 'news') source = 'x';
    text = fill(r, pick(r, narrative.templates), { city });
  }
  const mediaType = source === 'youtube' || source === 'tiktok' ? 'video' : source === 'instagram' ? 'image' : source === 'podcast' ? 'audio' : 'text';
  return {
    source,
    authorId: author.id,
    title,
    text,
    publishedAt: iso(ts),
    location,
    mediaType,
    lang: 'en',
    reach: author.followers,
    engagement: engagementFor(r, author.followers, isOutage ? 1.5 : 0),
    seedNarrative: narrative.id,
  };
}

// Specific, hand-placed mentions that anchor the demo story (influencers, journalists).
function anchorMentions(now) {
  const at = (h) => now - h * HOUR;
  return [
    { authorId: 'a-netwatch', source: 'x', h: 59, text: 'Seeing a large spike of Halvia outage reports across Denver, Boulder and Colorado Springs. Calls and data affected. No signal for many users. #halviadown' },
    { authorId: 'a-grace', source: 'youtube', h: 41, title: 'Halvia outage: what went wrong and should you switch?', text: 'Halvia network down for over 24 hours in my area. No signal, no updates, and the support chatbot is useless. Honestly the worst outage I have covered. #halviadown' },
    { authorId: 'a-marcus', source: 'news', h: 38, title: 'Halvia outage leaves thousands without service across the Mountain West', text: 'A core network failure left Halvia customers without calls or data for up to 30 hours. Emergency calls were disrupted, and regulators are asking questions.' },
    { authorId: 'a-techtrio', source: 'tiktok', h: 30, text: 'POV: you are on Halvia and it is day two of the outage 💀 no signal, SOS only, still down. Switching is looking real good #halviadown' },
    { authorId: 'a-dealdan', source: 'x', h: 26, text: 'Telluma Switch & Save will pay off your phone if you are leaving Halvia after the outage. Honestly a great deal 👍 #tellumaswitch' },
    { authorId: 'a-priya', source: 'news', h: 20, title: 'Halvia restores service after day-long blackout, promises bill credit', text: 'Halvia said service was restored after a fiber cut. Critics say the outage exposed weak redundancy and poor communication, and customers are frustrated by long hold times.' },
    { authorId: 'a-eli', source: 'x', h: 70, text: 'Thread: the new Halvia privacy policy lets them share location data with ad partners unless you opt out. This is concerning and buried in section 7. 🧵' },
    { authorId: 'a-tom', source: 'news', h: 14, title: 'Privacy researchers question Halvia location data sharing clause', text: 'A clause in the Halvia privacy policy appears to allow sharing location data with ad partners. Halvia has not yet commented on the privacy concerns.' },
    { authorId: 'a-lena', source: 'news', h: 9, title: 'Thinking of leaving Halvia? What the Switch & Save offers really cost', text: 'After the Halvia outage, Telluma and others are courting customers with switching offers. We compare the fine print.' },
    { authorId: 'a-mila', source: 'instagram', h: 260, text: 'Halvia 5G Ultra speed test from a rooftop in Austin: 1.6 Gbps 🔥 Absolutely love it for uploading content on the go. #halvia5g' },
    { authorId: 'a-ken', source: 'news', h: 450, title: 'Review: Halvia 5G Ultra is the fastest network we have tested', text: 'In our speed test across six cities, Halvia 5G Ultra posted impressive speeds and excellent reliability.' },
    { authorId: 'a-sofia', source: 'news', h: 270, title: 'Halvia to raise legacy plan prices by $5 a month', text: 'Halvia confirmed a price increase on legacy unlimited plans, and customers say the price hike breaks the price lock promise.' },
  ].map((a) => ({ ...a, ts: at(a.h) }));
}

/**
 * Generate the full demo database. Deterministic for a given `seed`, with
 * timestamps relative to `now`.
 */
export function generate({ now = Date.now(), seed = 7 } = {}) {
  const r = rng(seed);
  const authors = buildAuthors(r);
  const byId = Object.fromEntries(authors.map((a) => [a.id, a]));
  const pools = {
    social: authors.filter((a) => a.source !== 'news' && a.type !== 'journalist'),
    journalists: authors.filter((a) => a.type === 'journalist'),
  };
  const raws = [];
  for (let d = 29; d >= 0; d--) {
    const windowStart = now - (d + 1) * DAY;
    for (const n of NARRATIVES) {
      const lambda = n.curve(d);
      const count = Math.max(0, Math.round(lambda * (0.8 + r() * 0.4) + (r() < lambda % 1 ? 1 : 0) - 0.3));
      const hw = n.hourWindow?.(d);
      for (let i = 0; i < count; i++) {
        const span = hw ? (hw[1] - hw[0]) * HOUR : DAY;
        const ts = Math.min(now - 2 * MIN, windowStart + (hw ? (24 - hw[1]) * HOUR : 0) + Math.floor(r() * span));
        const asNews = n.news?.length && r() < 0.09;
        const author = asNews ? pick(r, pools.journalists) : pick(r, pools.social);
        raws.push(makeRawMention(r, { narrative: n, ts, author, forceNews: asNews }));
      }
    }
  }
  for (const a of anchorMentions(now)) {
    const author = byId[a.authorId];
    raws.push({
      source: a.source, authorId: a.authorId, title: a.title || null, text: a.text, publishedAt: iso(a.ts),
      location: a.text.includes('Austin') ? 'Austin, TX' : 'Denver, CO',
      mediaType: a.source === 'youtube' || a.source === 'tiktok' ? 'video' : a.source === 'instagram' ? 'image' : 'text',
      lang: 'en', reach: author.followers, engagement: engagementFor(r, author.followers, 3), anchor: true,
    });
  }
  raws.sort((a, b) => Date.parse(a.publishedAt) - Date.parse(b.publishedAt));
  return { authors, raws };
}

/** Seed cases that show the response workflow mid-flight. */
export function seedCases(now) {
  return [
    {
      id: 'CASE-1001', title: 'Price increase: publish FAQ and social replies', narrativeId: 'n-price', priority: 'P2', status: 'resolved',
      ownerId: 'u-aisha', team: 'Communications', createdAt: iso(now - 11 * DAY), resolvedAt: iso(now - 8 * DAY),
      draft: { text: 'We hear you. The $5 change applies only to legacy Unlimited plans, and Price Lock plans are not affected. You can move to Unlimited Flex at no extra cost in the app.', channel: 'x', generatedBy: 'mediagpt-ai', editedBy: 'u-aisha', version: 2 },
      approvals: [{ step: 'Communications approval', role: 'manager', decision: 'approved', by: 'u-daniel', at: iso(now - 10 * DAY), note: 'Good, ship it.' }],
      mentionIds: [], escalated: false,
    },
    {
      id: 'CASE-1002', title: 'Support backlog: callback commitments for outage-affected customers', narrativeId: 'n-support', priority: 'P3', status: 'in_progress',
      ownerId: 'u-sam', team: 'Customer Experience', createdAt: iso(now - 20 * HOUR), mentionIds: [], escalated: false, approvals: [], draft: null,
    },
    {
      id: 'CASE-1003', title: 'Bytewise News inquiry: location data clause', narrativeId: 'n-privacy', priority: 'P2', status: 'awaiting_approval',
      ownerId: 'u-nora', team: 'Legal', createdAt: iso(now - 5 * HOUR), mentionIds: [], escalated: false,
      draft: { text: 'Halvia does not sell customer location data. Aggregated, de-identified insights are shared only with opt-in consent, and customers can review their choices at any time in the Privacy Center.', channel: 'media-statement', generatedBy: 'mediagpt-ai', editedBy: 'u-nora', version: 1 },
      approvals: [],
    },
  ];
}
