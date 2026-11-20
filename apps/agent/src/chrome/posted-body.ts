import type { BrowserControl, BrowserView } from "@mq/core";
import { xStatus } from "../tasks/answered-since.ts";

/**
 * Text as a page's words show it: one space between words, and no emoji, which sites draw as pictures (X puts
 * "🚀" in an image's alt, outside the page's text). Live, 2026-10-14: a reply ending in 🚀 went up and was held.
 */
export const plain = (s: string): string => s.replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}\u{FE0F}\u{200D}]/gu, "").replace(/\s+/g, " ").trim();
const words = plain;

/** A link as a draft writes it: with or without its scheme, a bare domain, a path. */
const LINK = /(?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/\S*)?/gi;

/** How far apart two runs of a body's words may show: a site's rendering of the link between them. */
const LINK_ROOM = 120;

/**
 * What a like's or a follow's control says on the sites people use: X's "123 Likes. Like", LinkedIn's "React Like"
 * (its new layout: "Reaction button state: no reaction", live, 2026-11-04: a like refused three times as "not a like
 * control"), Reddit's "upvote". X in Ukrainian (live, 2026-10-23: a like refused as "not a like control"): "17 Уподобань.
 * Уподобання", and "Читати @name" to follow, "Читати" alone being also "read" elsewhere. A page in another language
 * is liked by picture, which the visual check verifies. Instagram and Threads in Ukrainian: "Подобається" and "Не
 * подобається", "Стежити" and "Ви стежите" (live, 2026-11-04: every like on Threads ended unconfirmed).
 */
const ACTS: Readonly<Record<"like" | "follow", RegExp>> = {
  like: /(^|[^\p{L}])(like|liked|unlike|heart|upvote|upvoted|favou?rite|favou?rited|love|react|reaction button state|[ув]?подоба\p{L}*)(?![\p{L}])/iu,
  follow: /(^|[^\p{L}])(follow|following|unfollow|followed|connect|subscribe|subscribed|requested|notification setting|стежити|стежите|(?:читати|підписки)(?=\s*(?:@|$)))(?![\p{L}])/iu,
};
/**
 * The same control once done: its words turn ("Liked", "Unlike", "Following"; X in Ukrainian "Уподобали", "Підписки
 * @name"; LinkedIn's state names the reaction, "Reaction button state: like"), or it shows as pressed. A YouTube channel
 * subscribed to shows only its bell, "... your notification setting for ZazaG Dev" (live, 2026-11-05: a follow already on
 * failed as "could not prepare", and its card came back).
 */
const DONE: Readonly<Record<"like" | "follow", RegExp>> = {
  like: /(^|[^\p{L}])(liked|unlike|remove like|undo like|upvoted|unheart|unfavou?rite|favou?rited|reaction button state:\s*(?!no reaction)\p{L}+|[ув]подобали|[ув]подобано|не подобається)(?![\p{L}])/iu,
  follow: /(^|[^\p{L}])(following|unfollow|followed|requested|subscribed|pending|notification setting|не читати|ви стежите|не стежити|підписки(?=\s*(?:@|$)))(?![\p{L}])/iu,
};

/** Whether a control is the page's like (or follow) control. */
export const actsAs = (c: Pick<BrowserControl, "label">, kind: "like" | "follow"): boolean => ACTS[kind].test(c.label);

/** Whether a like (or follow) control shows as done. */
export const doneOn = (c: Pick<BrowserControl, "label" | "pressed">, kind: "like" | "follow"): boolean => actsAs(c, kind) && (DONE[kind].test(c.label) || c.pressed === true);

/** Each like (or follow) control the page shows as done, as it reads: the ones that turned after a tap are new here. */
export const doneControls = (view: Pick<BrowserView, "controls">, kind: "like" | "follow"): Set<string> => {
  // Each one counted: a second that reads the same is new too (live, 2026-11-11: a comment's heart on Instagram turned
  // to "Unlike" beside the post's own "Unlike", and the like was held as never seen).
  const seen = new Map<string, number>();
  return new Set(
    view.controls.filter((c) => doneOn(c, kind)).map((c) => {
      const key = `${c.role}|${c.label}|${c.item ?? ""}`;
      const n = seen.get(key) ?? 0;
      seen.set(key, n + 1);
      return n ? `${key}#${n}` : key;
    }),
  );
};

/**
 * Whether the page shows the draft's own like (or follow) as done already, before anything was pressed: the Like inside
 * the post with its quote, the Follow naming them.
 */
export function alreadyOn(view: Pick<BrowserView, "controls" | "items" | "url"> & { readonly text?: string }, post: { readonly quote?: string | null; readonly target: string; readonly url?: string }, kind: "like" | "follow"): boolean {
  const handle = post.target.trim().replace(/^@/, "").toLowerCase();
  // On the post's own page its Like comes first, and already on it is the outcome, whatever the quote sits in: the model
  // sees it on and will not press it, and a like on the post for one meant for a comment under it costs nothing (live,
  // 2026-11-10 and 11: Instagram likes already in place ended as "could not prepare" and came back on every tap).
  const first = view.controls.find((c) => actsAs(c, "like"));
  if (kind === "like" && ownPage(view, post) && first && doneOn(first, "like")) return true;
  return view.controls.some((c) => {
    if (!doneOn(c, kind)) return false;
    if (kind === "like") return c.item !== undefined && c.item === likeTarget(view, post);
    // A channel's name may have spaces its handle has not ("ZazaG Dev", @ZazaGDev).
    return handle.length > 1 && c.label.toLowerCase().replace(/\s+/g, "").includes(handle);
  });
}

/** An address as one page: its host without www, and its path without a trailing slash. */
const pageOf = (url: string): string | null => {
  if (!URL.canParse(url)) return null;
  const u = new URL(url);
  return `${u.hostname.replace(/^(www|m|mobile)\./, "")}${u.pathname.replace(/\/+$/, "")}`;
};

const ownPage = (view: { readonly url: string }, post: { readonly url?: string }): boolean => Boolean(post.url && pageOf(post.url) && pageOf(post.url) === pageOf(view.url));

/**
 * Which post's Like a like draft means: the post its quote is in, when that post has a Like of its own. On the post's own
 * page, a quote in a reply with none (or not shown) means the post the address names, the first Like there: a like goes
 * on one post by its own address. Live, 2026-11-05: a Threads like quoted heyfabee_'s answer in the thread, the only Like
 * was the post's, already on, and the card came back five times as "could not post".
 */
export function likeTarget(view: Pick<BrowserView, "controls" | "items" | "url"> & { readonly text?: string }, post: { readonly quote?: string | null; readonly url?: string }): number {
  const quoted = quotedItem(view, post.quote);
  const likes = view.controls.filter((c) => c.item !== undefined && actsAs(c, "like"));
  if (quoted >= 0 && likes.some((c) => c.item === quoted)) return quoted;
  const own = post.url ? pageOf(post.url) : null;
  if (own && own === pageOf(view.url) && likes.length) return likes[0]!.item!;
  return quoted;
}

/** Where some run of the quote's words first shows in a text, or -1. */
function quoteAt(text: string, quote: string | null | undefined): number {
  if (!quote) return -1;
  const have = words(text).toLowerCase();
  const want = words(quote).toLowerCase();
  if (!want) return -1;
  if (want.length <= 24) return have.indexOf(want);
  for (let at = 0; at + 24 <= want.length; at += 8) {
    const found = have.indexOf(want.slice(at, at + 24));
    if (found >= 0) return found;
  }
  return -1;
}

/**
 * Whether a post in a page's list (`items`, the start of each) is the one a quote comes from: some run of the quote's
 * words is in it. A feed's Like buttons all say "Like": only the post they sit in tells them apart.
 */
export function itemQuotes(item: string | undefined, quote: string | null | undefined): boolean {
  return Boolean(item) && quoteAt(item!, quote) >= 0;
}

/**
 * Which post in a page's list a quote comes from, or -1. An item is only its start (200 characters), and on LinkedIn its
 * author's name, headline and "Follow" fill most of that (live, 2026-11-05: five likes refused on the right post as
 * "belongs to another post"), so a quote not in any start is found in the page's words: the post it falls under is the
 * last one whose start shows before it.
 */
export function quotedItem(view: Pick<BrowserView, "items"> & { readonly text?: string }, quote: string | null | undefined): number {
  const items = view.items ?? [];
  const direct = items.findIndex((i) => itemQuotes(i, quote));
  if (direct >= 0 || !view.text) return direct;
  const at = quoteAt(view.text, quote);
  if (at < 0) return -1;
  const page = words(view.text).toLowerCase();
  let best = -1;
  let bestAt = -1;
  items.forEach((item, i) => {
    // All of it: one author's posts open with the same name and headline, and differ only in their age and first words.
    const start = words(item).toLowerCase();
    if (start.length < 12) return;
    // The nearest showing of its start before the quote.
    const shows = page.lastIndexOf(start, at);
    if (shows >= 0 && shows > bestAt) {
      best = i;
      bestAt = shows;
    }
  });
  return best;
}

/**
 * Who wrote a post in a page's list, as its start shows it: on X its first @handle ("Serhii L @theIcreator · 2 лист."),
 * elsewhere the name it opens with (Threads' and Instagram's "theicreator 2d"). Null when the start shows none.
 */
export function itemAuthor(item: string, url: string): string | null {
  const tokens = item.trim().split(/\s+/).slice(0, 6);
  let host = "";
  try {
    host = new URL(url).hostname.replace(/^(www|mobile)\./, "");
  } catch {
    return null;
  }
  if (host === "x.com" || host === "twitter.com") return tokens.find((t) => /^@[A-Za-z0-9_]{1,15}$/.test(t))?.slice(1) ?? null;
  const first = tokens[0]?.replace(/^@/, "");
  return first && /^[A-Za-z0-9_.]{2,30}$/.test(first) ? first : null;
}

/**
 * Whether an item after a post can be an answer under it, not something beside the thread. X's post page lists "Relevant
 * people" after the replies, each a card with a name, an @handle and a bio; a reply opens "@handle · 2h", a card never
 * does. Live, 2026-11-04: the customer's own card read as their answer, and their tap on a reply to Himanshu was stopped.
 */
export function answerRow(item: string, url: string): boolean {
  let host = "";
  try {
    host = new URL(url).hostname.replace(/^(www|mobile)\./, "");
  } catch {
    return true;
  }
  return !(host === "x.com" || host === "twitter.com") || /@[A-Za-z0-9_]{1,15}\s+·\s/.test(item.slice(0, 120));
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
/**
 * How old a row says it is, in minutes ("· 9h", "· 12m"; a date, "· Nov 13", counted from the start of that day, the
 * oldest it can be, and never under a day, since X gives a date only past 24 hours: whether a reply of that day came
 * before or after is asked of X's own search when the reply is drafted, `answered-since.ts`), or null when it says nothing. Live, 2026-11-14: three
 * answers on X were a few hours old, the customer's reply they answered said "Nov 13", which read as no age at all, and
 * all three replies were stopped as already given.
 */
export const rowAge = (item: string, now: Date = new Date()): number | null => {
  const head = item.slice(0, 200);
  const m = /·\s*(\d+)\s*(s|m|h|d)\b/.exec(head);
  if (m) return Number(m[1]) * { s: 1 / 60, m: 1, h: 60, d: 1440 }[m[2] as "s" | "m" | "h" | "d"];
  const d = /·\s*(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2})(?:,\s*(\d{4}))?/i.exec(head);
  if (!d) return null;
  const month = MONTHS.indexOf(d[1]!.slice(0, 3).toLowerCase());
  let at = Date.UTC(d[3] ? Number(d[3]) : now.getUTCFullYear(), month, Number(d[2]));
  if (!d[3] && at > now.getTime() + 86_400_000) at = Date.UTC(now.getUTCFullYear() - 1, month, Number(d[2]));
  return Math.max(1440, (now.getTime() - at) / 60_000);
};
/**
 * Their own answer under the post a quote is from, as a page's list shows it (a thread: its post, then the replies under
 * it): the first post after it by their account. Null when none shows.
 */

export function answeredBelow(items: readonly string[] | undefined, quote: string | null | undefined, handle: string | null, url: string): string | null {
  if (!items?.length || !quote || !handle) return null;
  const me = handle.replace(/^@/, "").toLowerCase();
  // The last row that holds the quote: a reply box open on X lists a copy of the post being answered first, before the
  // page's own posts, and everything of theirs in the thread then read as coming after it (live, 2026-11-14: three
  // answers to people waiting on X were stopped so, twice each).
  const at = items.findLastIndex((i) => itemQuotes(i, quote));
  if (at < 0) return null;
  // A post of theirs older than the one answered is what that person answered, not an answer to it (live, 2026-11-13: on
  // the page of someone's answer X listed the customer's own reply from 9 hours before after it, and the reply to the
  // answer was stopped as already given).
  // The post a page is for gives no age in its row (X puts its time under the words): its address says when it went up.
  const own = xStatus(url);
  const quoted = rowAge(items[at]!) ?? (own && itemAuthor(items[at]!, url)?.toLowerCase() === own.handle.toLowerCase() ? Math.max(0, (Date.now() - own.at.getTime()) / 60_000) : null);
  // Two rows that give only a date and the same one say nothing of which came first: not an answer (live, 2026-11-14:
  // their own post of Nov 12 stopped the answer to a question asked under it that day, twice).
  const dated = (i: string): boolean => !/·\s*\d+\s*(s|m|h|d)\b/.test(i.slice(0, 200));
  return items.slice(at + 1).find((i) => answerRow(i, url) && itemAuthor(i, url)?.toLowerCase() === me && !(quoted !== null && ((rowAge(i) ?? -1) > quoted || (rowAge(i) === quoted && dated(i))))) ?? null;
}

/** How far under the words answered an earlier reply of theirs still counts as an answer to them, in characters of the page. */
const UNDER = 2500;
/**
 * Words of theirs that already went up to this person, shown on the page right under the words now being answered: the
 * answer is there already. The page's own order is the check, whoever the site names as the author (live, 2026-11-18:
 * three replies went up under one LinkedIn comment, the third with the first two on screen; LinkedIn's rows open with a
 * display name, so the check by handle never matched there). Not on X, whose pages list older posts after newer ones.
 */
export function saidUnder(text: string, quote: string | null | undefined, before: readonly string[] | undefined, url: string): string | null {
  if (!quote || !before?.length || /^https?:\/\/(www\.|mobile\.)?(x|twitter)\.com\//i.test(url)) return null;
  const page = words(text);
  const q = words(quote).slice(0, 80);
  if (q.length < 12) return null;
  const at = page.lastIndexOf(q);
  if (at < 0) return null;
  const under = page.slice(at + q.length, at + q.length + UNDER);
  return before.find((b) => { const w = words(b).slice(0, 60); return w.length >= 20 && under.includes(w); }) ?? null;
}

/**
 * Whether a page shows this body as posted. Sites show a link their own way (X shortens a long one to
 * "example.com/pa…" behind t.co), so a body with links counts when its words between the links show, in order,
 * close together. Live, 2026-10-14: an exact-only check held a reply on X that had gone up.
 */
export function bodyShown(page: string, body: string): boolean {
  const text = words(page);
  const want = words(body);
  if (!want) return false;
  if (text.includes(want)) return true;
  const runs = want.split(LINK).map(words).filter(Boolean);
  // Too little besides its links to know it by.
  if (runs.join(" ").length < 20) return false;
  let at = text.indexOf(runs[0]!);
  while (at >= 0) {
    let end = at + runs[0]!.length;
    let all = true;
    for (const run of runs.slice(1)) {
      const next = text.indexOf(run, end);
      if (next < 0 || next - end > LINK_ROOM) { all = false; break; }
      end = next + run.length;
    }
    if (all) return true;
    at = text.indexOf(runs[0]!, at + 1);
  }
  return false;
}
