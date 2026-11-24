// Optional Claude integration. MediaGPT works fully offline with its local,
// explainable engine; when ANTHROPIC_API_KEY is set and the optional
// @anthropic-ai/sdk package is installed, Claude writes the prose for
// Copilot answers and response drafts, grounded in local evidence only.
export const MODEL = process.env.MEDIAGPT_MODEL || 'claude-opus-5-5';

let clientPromise = null;
let testOverride = null;

/** Test hook: route completions to a stub instead of the API (pass null to clear). */
export function setCompletionOverride(fn) { testOverride = fn; }

export function llmConfigured() {
  if (testOverride) return true;
  return Boolean(process.env.ANTHROPIC_API_KEY) && process.env.MEDIAGPT_LLM !== 'off';
}

async function getClient() {
  if (!llmConfigured()) return null;
  if (!clientPromise) {
    clientPromise = import('@anthropic-ai/sdk')
      .then((m) => new m.default({ timeout: 45_000, maxRetries: 1 }))
      .catch(() => {
        console.warn('  ANTHROPIC_API_KEY is set but @anthropic-ai/sdk is not installed. Run `npm install` to enable Claude.');
        return null;
      });
  }
  return clientPromise;
}

export async function llmStatus() {
  const c = await getClient();
  return { enabled: Boolean(c), model: c ? MODEL : null };
}

/** Returns the model's text, or null on any failure (callers fall back to the local engine). */
export async function complete({ system, prompt, maxTokens = 4000 }) {
  if (testOverride) return testOverride({ system, prompt, maxTokens });
  const client = await getClient();
  if (!client) return null;
  try {
    const res = await client.beta.messages.create({
      model: MODEL,
      max_tokens: maxTokens,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low' },
      system,
      messages: [{ role: 'user', content: prompt }],
    });
    if (res.stop_reason === 'refusal' || res.stop_reason === 'max_tokens') return null;
    const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    return text || null;
  } catch (e) {
    console.warn(`  Claude request failed (${e.status || ''} ${e.message}); using the local engine.`);
    return null;
  }
}
