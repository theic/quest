/** About one reply or message in eight has a slip: a model asked for typos makes ones a reader spots. */
export const SLIP_SHARE = 0.12;

/**
 * What a thumb really does to everyday words (the founder, 2026-11-06: "small typos here and there bring more humanity
 * into the messages; but they must not feel intentional"). A list, so a name, a handle or a link is never touched.
 */
const SLIPS: Readonly<Record<string, string>> = {
  actually: "acutally",
  because: "becuase",
  definitely: "definately",
  different: "diferent",
  people: "poeple",
  probably: "probaly",
  really: "realy",
  something: "somehting",
  "can't": "cant",
  "didn't": "didnt",
  "doesn't": "doesnt",
  "don't": "dont",
  "isn't": "isnt",
  "that's": "thats",
  "won't": "wont",
  "you're": "youre",
};

/** A whole word, not part of a link, a handle or an address. */
const WORD = /(?<![\w@#/.:'-])[A-Za-z]+(?:'[a-z]+)?(?![\w/@'-]|\.\w)/g;

/**
 * Now and then one slip in a message, never a second, and never one its recent messages already have: `pick` is the
 * draw, 0 to 1 (main.ts: Math.random). Words outside the list stay, so text in other languages goes out as written.
 */
export function slipped(text: string, pick: () => number, lately: readonly { readonly text: string }[]): string {
  if (pick() >= SLIP_SHARE) return text;
  const spots = [...text.matchAll(WORD)].filter((m) => {
    const slip = SLIPS[m[0].toLowerCase()];
    return slip && !lately.some((w) => w.text.toLowerCase().includes(slip));
  });
  const spot = spots[Math.floor(pick() * spots.length)];
  if (!spot) return text;
  const slip = SLIPS[spot[0].toLowerCase()]!;
  const typed = spot[0][0] === spot[0][0]!.toUpperCase() ? slip[0]!.toUpperCase() + slip.slice(1) : slip;
  return text.slice(0, spot.index) + typed + text.slice(spot.index + spot[0].length);
}
