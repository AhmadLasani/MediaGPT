import { MediaGPT } from '../src/service.js';

export const NOW = Date.parse('2026-11-12T15:00:00Z');

// Building the demo workspace takes ~60ms; share one pristine copy per file
// and hand each test a fresh instance when it mutates state.
export function makeApp(opts = {}) {
  let now = opts.now ?? NOW;
  const app = new MediaGPT({ file: opts.file ?? null, clock: () => now, seed: opts.seed ?? 7 });
  app.setNow = (t) => { now = t; };
  return app;
}
