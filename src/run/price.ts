// What tokens cost, so a session whose harness never reported its cost can
// still have one recorded.
//
// A table owned by this program, which goes stale when a model ships after a
// release: a model it does not know prices as null rather than as a guess, and
// the run-log row keeps the tokens beside it so it can be priced again later.
// The three entries are the ones whose prices were checked to the cent against
// costs Claude Code itself reported, on sessions that did finish.

import type { ModelTokens } from "./transcript.ts";

/** Dollars per million tokens. Cache writes are priced from `input`. */
interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
}

/** Keyed by the model id a transcript names, without any `[…]` variant. */
export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25 },
};

/** A five-minute cache write costs 1.25 times input; an hour-long one, twice. */
const CACHE_WRITE_5M = 1.25;
const CACHE_WRITE_1H = 2;

/**
 * The dollars a session's tokens cost, or null when any model that spent
 * something is not in the table.
 *
 * All or nothing, because a partial sum would read as the whole: a row with a
 * cost is summed by whoever reads the log, and a figure missing one model's
 * spend is a figure nobody can tell is short.
 */
export function priceUsage(byModel: Readonly<Record<string, ModelTokens>>): number | null {
  let dollars = 0;
  for (const [model, tokens] of Object.entries(byModel)) {
    const spent = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite5m + tokens.cacheWrite1h;
    if (spent === 0) continue;
    const price = MODEL_PRICES[model];
    if (price === undefined) return null;
    dollars +=
      (tokens.input * price.input +
        tokens.output * price.output +
        tokens.cacheRead * price.cacheRead +
        tokens.cacheWrite5m * price.input * CACHE_WRITE_5M +
        tokens.cacheWrite1h * price.input * CACHE_WRITE_1H) /
      1_000_000;
  }
  return dollars;
}
