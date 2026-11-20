/** Content words two texts share, over the shorter one's: how far one says what the other does. */
export function overlap(a: string, b: string): number {
  const words = (s: string): Set<string> => new Set(s.toLowerCase().match(/\p{L}{4,}/gu) ?? []);
  const x = words(a);
  const y = words(b);
  if (!x.size || !y.size) return 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return shared / Math.min(x.size, y.size);
}

/**
 * Memories this close say much the same thing, and the older one should go or be merged. Measured on the
 * 21 live memories of 2026-10-07: the twelve "this wording is exhausted, next try that" lessons about one
 * route overlap each other at a median of 0.41 (36 of their 66 pairs at 0.4 or more); every other pair of
 * the same kind at a median of 0.05, and only one at 0.4 or more: two "Reddit took down a reply" lessons
 * that are duplicates too.
 */
export const SAME_MEMORY = 0.4;

/**
 * The least a memory must share with the one replacing it: below this, a "replaces" id is taken for a
 * mistake. On the same live memories, 4 of the 66 pairs of the one route's lessons fall below it; the
 * replacement the real model got wrong ("No Reddit today" retiring "Saved Messages test is done; never
 * send those notes again") shares 0.
 */
export const REPLACES_OVERLAP = 0.2;
