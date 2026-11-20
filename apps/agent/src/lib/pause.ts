/**
 * Pauses a person would take, never the same twice (the founder, 2026-11-04: "let it do the browsing organically with
 * random pauses between actions, no specific cap per day"). A pause that a loop checks again and again (the outbox every
 * 15 s, the rotation every 2 minutes) is drawn from what it follows, so every check sees the same one: drawn afresh each
 * time, the shortest would win at once.
 */

/** Between `min` and `max` ms, the same for the same `seed`: the moment a send went up, the run a rest follows. */
export function pauseFor(seed: string | number, min: number, max: number): number {
  if (max <= min) return min;
  // FNV-1a over the seed's text: spread enough that two sends a second apart get unrelated pauses.
  let h = 0x811c9dc5;
  for (const ch of String(seed)) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return min + (h % (max - min + 1));
}

/** Between `min` and `max` ms, drawn afresh: a pause nothing looks at again (before a click). */
export const anyPause = (min: number, max: number, random: () => number = Math.random): number => min + Math.floor(random() * (max - min + 1));
