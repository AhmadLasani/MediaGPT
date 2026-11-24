import test from 'node:test';
import assert from 'node:assert/strict';
import { sentiment, detectEntities, classifyNarrative, matchQueries, hashtags, keywords } from '../src/nlp.js';
import { ENTITIES, NARRATIVES } from '../src/seed.js';

test('sentiment: basic polarity with explanations', () => {
  const pos = sentiment('I love the new 5G speeds, amazing!');
  assert.equal(pos.label, 'positive');
  assert.ok(pos.terms.some((t) => t.term === 'love'));
  const neg = sentiment('Worst network ever. Totally useless.');
  assert.equal(neg.label, 'negative');
  assert.equal(sentiment('The store opens at nine.').label, 'neutral');
});

test('sentiment: negation flips within a clause but not across sentences', () => {
  assert.equal(sentiment('The service is not good').label, 'negative');
  const s = sentiment('Day two of the outage. No service, no updates, no apology. Worst experience ever.');
  assert.equal(s.label, 'negative');
  assert.ok(!s.terms.some((t) => t.term === 'not worst'), 'negation must not leak across the sentence boundary');
});

test('sentiment: domain phrases and contrast', () => {
  const s = sentiment('Their status page says restored, my phone says SOS only.');
  assert.equal(s.label, 'negative');
  assert.ok(s.terms.some((t) => t.term === 'sos only'));
  // "still" shifts weight to the clause that follows it
  assert.equal(sentiment('Service restored for me 🙏 still, 20 hours of no signal deserves more than a tweet.').label, 'negative');
});

test('sentiment: questions are damped toward neutral', () => {
  assert.equal(sentiment('Is Brisa Connect good in Seattle?').label, 'neutral');
});

test('entities: alias matching respects word boundaries', () => {
  assert.deepEqual(detectEntities('Switched from Halvia to @Telluma today', ENTITIES).sort(), ['halvia', 'telluma']);
  assert.deepEqual(detectEntities('#halvia5g is fast', ENTITIES), ['halvia']);
  assert.deepEqual(detectEntities('A brisance test', ENTITIES), []);
});

test('narratives: classification explains the signals it matched', () => {
  const c = classifyNarrative('No signal and dropped calls all day #halviadown', 'halvia', NARRATIVES);
  assert.equal(c.id, 'n-outage');
  assert.ok(c.matched.includes('no signal'));
  assert.equal(classifyNarrative('lovely weather', 'halvia', NARRATIVES).id, null);
  // Narratives are scoped to their entity
  assert.notEqual(classifyNarrative('billing error, overcharged', 'halvia', NARRATIVES).id, 'n-brisa-billing');
});

test('queries, hashtags and keywords', () => {
  const qs = [{ id: 'q1', terms: ['outage'], exclude: ['test'] }, { id: 'q2', terms: ['privacy'], active: false }];
  assert.deepEqual(matchQueries('Big outage today', qs), ['q1']);
  assert.deepEqual(matchQueries('outage test drill', qs), []);
  assert.deepEqual(matchQueries('privacy please', qs), []);
  assert.deepEqual(hashtags('Wow #Halvia5G and #halvia5g #down'), ['#halvia5g', '#down']);
  assert.equal(keywords(['outage in denver', 'denver outage again'], { n: 1 })[0].term, 'outage');
});
