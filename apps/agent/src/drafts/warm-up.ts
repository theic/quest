import type { Clock, CustomerId, CustomerRepository, Draft, DraftRepository, Find, FindRepository, ResultEntry } from "@mq/core";
import { platformOf } from "../platforms.ts";
import { siteHost } from "./tagged-link.ts";

/**
 * The founder's word, 2026-10-19: "Always be aware of the spam filters, no promotion to the very last point; more
 * simple engagements to warm up, do different kinds of interactions, not just replies." Live the days before, every
 * reply on X named messaging.quest and the $10k SAFE, to people who had never heard of the founder.
 *
 * What a platform's filters and its people take as spam is an account that only promotes: new, with links and a
 * product in every reply, to strangers. So on each platform, what goes up from their account warms it first, and
 * the product comes last:
 * - the first WARM_UP things that go up on a platform name no product and carry no link: likes, follows, replies
 *   that help, posts that are theirs and not ads;
 * - after that, at most one in PLAIN_PER_PROMO + 1 of what went up there in the last PROMO_WINDOW_MS does;
 * - and the product, by name or link, goes to a person only when the words it answers ask for it (what they use, a
 *   link, a tool for this; `asksForIt`; the founder, 2026-10-31).
 * A draft written as them (theirs: their own dictated words) is theirs to post. A profile is theirs to fill: its link
 * and its product are what it is for.
 */
export const WARM_UP = 5;
export const PLAIN_PER_PROMO = 4;
export const PROMO_WINDOW_MS = 14 * 86_400_000;
/** How far back what went up counts toward warming a platform. */
const WARM_WINDOW_MS = 60 * 86_400_000;

/** A link in words: an address, or a bare domain like "acme.io/pricing". */
const LINK = /https?:\/\/|\bwww\.|\b[a-z0-9-]{2,}\.(?:com|io|ai|app|co|so|dev|quest|net|org|me|xyz|tech|tools?|site|page|link|ly)\b/i;

/** Words as they are compared: lowercase, letters and digits. */
const flat = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}.]+/gu, " ").trim();

/**
 * The names their product goes by, from their site's address: "messaging.quest" gives "messaging.quest",
 * "messaging quest" and "messagingquest"; "tally.so" gives "tally.so" and "tally". Names under four letters
 * are left out (too many words are three letters).
 */
export function productNames(siteUrl: string | null | undefined): string[] {
  if (!siteUrl) return [];
  let host: string;
  try {
    host = new URL(/^https?:/i.test(siteUrl) ? siteUrl : `https://${siteUrl}`).hostname.toLowerCase().replace(/^(www|app|get|try)\./, "");
  } catch {
    return [];
  }
  const parts = host.split(".");
  const name = parts.length > 2 ? parts.slice(-2, -1)[0]! : parts[0]!;
  const tld = parts.at(-1)!;
  const words = name.split("-");
  const names = new Set([host]);
  // A host that is the name itself across its dot ("messaging.quest"): both words make the name, and the first
  // alone is only a word ("messaging"). Under a short ending (.io, .so, .app) the name before it is the name.
  if (parts.length === 2 && tld.length > 3) names.add(`${words.join(" ")} ${tld}`).add(`${words.join("")}${tld}`);
  else names.add(words.join(" ")).add(words.join(""));
  return [...names].filter((n) => n.replace(/[^a-z0-9]/g, "").length >= 4);
}

/**
 * A link to a post or a person on a site Quest knows (a Reddit thread, an X post): someone else's conversation, which
 * the value-first play hands over (the founder, 2026-11-01: "warm openers with few clients ready with links; no
 * promo"). Their own site, or any other, is still theirs to sell.
 */
const othersPost = (word: string): boolean => {
  const raw = word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}/]+$/gu, "");
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    // A fediverse post or profile is someone's too, on whatever server ("/@name/117605…"): live, 2026-11-12, an
    // introduction that pointed to a post on hachyderm.io went up without its link.
    return platformOf(url.hostname) !== null || /^\/@[^/]+(\/\d+)?\/?$/.test(url.pathname);
  } catch {
    return false;
  }
};

/** The links in words that go to someone's post on a site Quest knows: what a plain reply may still hand over. */
export const othersLinks = (text: string): string[] => text.split(/\s+/).filter((w) => LINK.test(w) && othersPost(w));

/** Whether words name their own product or link to their own site (not anyone else's). */
export function namesTheirs(text: string, siteUrl: string | null): boolean {
  const names = productNames(siteUrl);
  if (!names.length) return false;
  const host = names.find((n) => n.includes("."));
  if (host && text.toLowerCase().includes(host)) return true;
  return promotes(text.split(/\s+/).filter((w) => !LINK.test(w)).join(" "), names);
}

/** Whether words promote their product: they name it, or carry a link that is not to someone's post on a known site. */
export function promotes(text: string, names: readonly string[]): boolean {
  if (text.split(/\s+/).some((w) => LINK.test(w) && !othersPost(w))) return true;
  const words = ` ${flat(text)} `;
  return names.some((n) => words.includes(` ${flat(n)} `) || words.includes(` ${flat(n)}.`) || words.includes(` ${flat(n)},`));
}

/** Someone's name as compared across sites: no @ or u/, lowercase. */
export const personKey = (name: string | null | undefined): string | null => {
  const k = name?.trim().replace(/^@|^u\//i, "").toLowerCase();
  return k ? k : null;
};

/** What went up from their account on a platform, plain or promoting, as the warm-up counts it. */
export interface WentUp {
  readonly at: Date;
  readonly promoted: boolean;
}

/** What went up on a platform (drafts posted there, finds replied there), newest first. */
export function wentUp(platform: string, drafts: readonly Draft[], finds: readonly Find[], names: readonly string[], now: Date): WentUp[] {
  const since = now.getTime() - WARM_WINDOW_MS;
  const out: WentUp[] = [];
  for (const d of drafts) {
    if (d.status !== "posted" || d.platform !== platform || !d.sentAt || d.sentAt.getTime() < since || d.kind === "profile") continue;
    out.push({ at: d.sentAt, promoted: promotes(`${d.title ?? ""} ${d.text}`, names) });
  }
  for (const f of finds) {
    if (f.status !== "replied" || !f.sentAt || f.sentAt.getTime() < since || findPlatform(f) !== platform) continue;
    out.push({ at: f.sentAt, promoted: promotes(f.reply, names) });
  }
  return out.sort((a, b) => b.at.getTime() - a.at.getTime());
}

export const findPlatform = (f: Find): string => {
  try {
    const host = new URL(f.url).hostname.toLowerCase().replace(/^www\./, "");
    return /(^|\.)reddit\.com$/.test(host) ? "reddit" : host;
  } catch {
    return f.source;
  }
};

/** Whether someone already talks with them: an answer, a reply back, on record as a conversation. */
export function talksWith(person: string | null, results: readonly ResultEntry[]): boolean {
  const key = personKey(person);
  return Boolean(key && results.some((r) => r.stage === "conversation" && personKey(r.person) === key));
}

/**
 * Words that ask for the product: what they use, its name, a link, a tool for it. The founder, 2026-10-31: "Only and
 * only provide link or mention the full brand name for the product if specifically asked by the prospect!" Asking whether they built it, or
 * what they are building, asks too (live, 2026-11-13: "How do you find those people, X search or something you built?"
 * was answered "Something I built", with no name, and the conversation ended there).
 */
const ASKS_FOR_IT =
  /\b(?:what(?:'?s| is) (?:it|this|that|the (?:app|tool|name))(?: called)?|what (?:tool|app|service|product|software)s? (?:do|are|did|would|should) (?:you|u)|what (?:do|are|did) (?:you|u) (?:use|using)|which (?:tool|app|service|product|software)|is there (?:a|an|any) (?:tool|app|service|product|software|bot)|any (?:tool|app|service|product|software)s? (?:for|that)|recommend (?:a|an|any) (?:tool|app|service)|(?:send|drop|share|got|have) (?:me )?(?:a |the )?link|link (?:to it|please|pls)|where (?:can|do) i (?:get|find|try|sign up)|how (?:do|can) i (?:get|try|sign up for) (?:it|this|that)|dm me|(?:something|a tool|an app|a bot|a script) (?:you|u)(?:'ve| have)? (?:built|made|wrote|coded)|did (?:you|u) (?:build|make|code) (?:it|this|that|something)|what (?:did|have) (?:you|u) (?:build|built|make|made)|what (?:are|r) (?:you|u) (?:building|working on|making)|can i (?:try|use|see|test) (?:it|this|that)|is (?:it|this|that) (?:public|open|available|live|out)(?: yet)?)\b/i;

/** Whether the words a reply or message answers ask for the product. */
export const asksForIt = (words: string | null | undefined): boolean => Boolean(words && ASKS_FOR_IT.test(words));

/**
 * The permission close: words of the customer's that describe the thing and ask if the person wants the link, and a yes
 * to them. Live, 2026-11-14: over a week 98 people answered, 3 were told anything about the product and no reply carried
 * a link, since a link went only to someone who asked for it in so many words. An offer costs one question, and a yes
 * to it is asking.
 */
const OFFERS_IT = /\b(?:want|send|share|drop|need)\b[^.?!\n]{0,60}\blink\b[^.!\n]{0,30}\?/i;
export const offersIt = (words: string | null | undefined): boolean => Boolean(words && OFFERS_IT.test(words));
const SAYS_YES =
  /^\W*(?:yes|yeah|yea|yep|yup|sure|ok(?:ay)?|please|pls|go ahead|go for it|sounds good|why not|send (?:it|me|the|over)|would love|i'?d love|love to|definitely|absolutely|of course|for sure|do it|👍|🙏)|\b(?:yes please|send it|send the link|drop the link|share the link)\b/i;
export const saysYes = (words: string | null | undefined): boolean => Boolean(words && words.length < 200 && SAYS_YES.test(words.trim()));

/**
 * A question about the thing itself, from someone already in the conversation: they are looking at it, so where to
 * find it is the answer's last line (live, 2026-11-13: "Does it also rank the posts, or just collect them?", their
 * second question, was answered with no name again).
 */
export const asksAboutIt = (words: string | null | undefined): boolean =>
  Boolean(words && /\b(?:does|can|will|could|is|has|how does|what does|how much (?:is|does)) (?:it|this|that|your (?:tool|app|thing|bot|product))\b(?! (?:right|true|so|ok|okay|all)\b)[^?]*\?/i.test(words));

/**
 * Why a draft that promotes can't go up yet, in words for the manager and the writer; null when it may. `person` is
 * who it answers or goes to; `asked` whether the words it answers ask for the product; `upThere` what went up on its
 * platform (wentUp).
 */
export function tooSoon(upThere: readonly WentUp[], person: string | null, asked: boolean, now: Date): string | null {
  if (upThere.length < WARM_UP) {
    return `their account has put up only ${upThere.length} of the first ${WARM_UP} things on this platform, and those warm it up: no product and no link until then. Like, follow, and answer people with something useful, nothing to sell.`;
  }
  const recent = upThere.filter((u) => now.getTime() - u.at.getTime() < PROMO_WINDOW_MS);
  const promoted = recent.filter((u) => u.promoted).length;
  if ((promoted + 1) * (PLAIN_PER_PROMO + 1) > recent.length + 1) {
    return `${promoted} of the last ${recent.length} things that went up here already named the product or carried a link: at most one in ${PLAIN_PER_PROMO + 1}. Put up plain ones first (a like, a follow, a reply that only helps).`;
  }
  if (!asked) {
    return `${person ?? "they"} did not ask for it: the product's name and its link go only to someone who asks for them (what they use, a link, a tool for this). To someone who already talks with them it may be described in passing, with no name and no link. Be useful, or ask them something you are curious about.`;
  }
  return null;
}

const WEEK_MS = 7 * 86_400_000;
const KIND_NAMES: Readonly<Record<Draft["kind"], string>> = { reply: "replies", post: "posts", message: "messages", like: "likes", follow: "follows", profile: "profile changes" };

/**
 * For the manager's board: on each platform where something went up this week, how many of each kind, how many named
 * the product, and how far its warm-up is. A week of replies and nothing else is how a bot looks.
 */
export function mixLines(drafts: readonly Draft[], names: readonly string[], now: Date): string[] {
  const week = drafts.filter((d) => d.status === "posted" && d.sentAt && now.getTime() - d.sentAt.getTime() < WEEK_MS && d.kind !== "profile");
  const platforms = [...new Set(week.map((d) => d.platform))];
  if (!platforms.length) return [];
  return [
    "What went up from their accounts this week (mix the kinds: a like or a follow before a reply, a post of their own now and then; the product comes last):",
    ...platforms.map((p) => {
      const there = week.filter((d) => d.platform === p);
      const kinds = (["reply", "like", "follow", "post", "message"] as const).map((k) => `${there.filter((d) => d.kind === k).length} ${KIND_NAMES[k]}`).join(", ");
      const promoted = there.filter((d) => promotes(`${d.title ?? ""} ${d.text}`, names)).length;
      const up = wentUp(p, drafts, [], names, now).length;
      return `  - ${p === "reddit" ? "Reddit" : p}: ${kinds}; ${promoted} named the product or carried a link.${up < WARM_UP ? ` Warming up: ${up} of ${WARM_UP} plain first.` : ""}`;
    }),
  ];
}

/** Whether the product may come up yet: why not (null when it may), with the names it goes by. */
export interface WarmCheck {
  readonly why: string | null;
  readonly names: readonly string[];
  /**
   * Held back, but to someone who already talks with them on a warm platform: the words may say in passing what they
   * build, with no name and no link (the founder, 2026-11-11: "we should probably don't name it, just describe it
   * gently; a link is ok if the person specifically asks where to find it or the name").
   */
  readonly gentle?: boolean;
  /** They already talk with them: an answer on record as a conversation. */
  readonly talks?: boolean;
  /**
   * Help for help (the founder, 2026-11-13: "we can ask for a feedback for Quest in the warm conversations, if it fits the
   * context of conversation ... landing review, look in my bio, share a link or just the name"): to someone who talks with
   * them, on a warm platform, never asked before, the words may end with one light ask about the product, as drawn here.
   */
  readonly ask?: string;
}

/** The ways the ask back goes, drawn afresh each time: `{site}` is their site's address, `{name}` the product's name. */
export const ASK_FORMS: readonly string[] = [
  "ask, in passing, if they'd take a quick look at {site} and tell you honestly what's off on the page",
  "say what you're building is in your bio and ask if they'd give it a look, no link",
  "drop {site} and ask what they'd change first",
  "name it only, {name}, say it's yours, and ask if it sounds like something they'd use",
  // The permission close, twice as likely as any other: no name and no link until they say yes.
  "say in a line that finding people who ask for what a founder built is what your own thing does every day, that the first run is free, and end by asking if they want the link. No name and no link yet",
  "say you built a thing that does this for a founder daily and the first run costs nothing, then ask: want the link? No name and no link yet",
];

/** The product's name in words ("messaging quest" as "Messaging Quest"), from the names their site gives. */
export const titled = (names: readonly string[]): string => {
  const spaced = names.find((n) => n.includes(" ") && !n.includes(".")) ?? names.find((n) => !n.includes(".")) ?? names[0] ?? "";
  return spaced.replace(/\b\p{L}/gu, (c) => c.toUpperCase());
};

/** One ask back, drawn: `roll` is a number in [0, 1). */
export const askForm = (names: readonly string[], roll: number): string => {
  const site = names.find((n) => n.includes(".")) ?? titled(names);
  return ASK_FORMS[Math.floor(roll * ASK_FORMS.length) % ASK_FORMS.length]!.replace("{site}", site).replace("{name}", titled(names));
};

/**
 * The warm-up as one check, for what Quest drafts and for the scout's finds alike: from their site (what names the
 * product), what went up on the platform, and who talks with them.
 */
export class WarmUp {
  readonly #d: WarmUpDeps;

  constructor(deps: WarmUpDeps) {
    this.#d = deps;
  }

  /** Their site's host, for the links that go up to it (tagged-link.ts). */
  async site(customerId: CustomerId): Promise<string | null> {
    return siteHost((await this.#d.customers.get(customerId)).siteUrl);
  }

  /**
   * `person`: who it answers or goes to; null for a post of their own, which goes to everyone there. `answering`: the
   * words it answers.
   */
  async check(customerId: CustomerId, platform: string, person: string | null, answering: string | null = null): Promise<WarmCheck> {
    const names = productNames((await this.#d.customers.get(customerId)).siteUrl);
    const now = this.#d.clock.now();
    const [drafts, finds] = await Promise.all([this.#d.drafts.recent(customerId, 300), this.#d.finds.listFor(customerId, ["replied"], 300)]);
    const up = wentUp(platform, drafts, finds, names, now);
    const talks = person !== null && talksWith(person, (await this.#d.results?.list(customerId, 300).catch(() => [])) ?? []);
    const key = personKey(person);
    const toThem = drafts.filter((d) => d.status !== "skipped" && (d.kind === "reply" || d.kind === "message") && [d.author, d.target].some((p) => personKey(p) === key));
    // A yes to "want the link?" asks for it.
    const saidYes = key !== null && saysYes(answering) && toThem.some((d) => d.status === "posted" && offersIt(d.text));
    const why = tooSoon(up, person, person === null || asksForIt(answering) || (talks && asksAboutIt(answering)) || saidYes, now);
    const gentle = why !== null && talks && up.length >= WARM_UP;
    // Help for help: once, to someone who talks with them, where the platform would take the product if asked for.
    const askedBefore = toThem.some((d) => promotes(d.text, names) || offersIt(d.text));
    const ask = talks && names.length && !askedBefore && tooSoon(up, person, true, now) === null ? askForm(names, (this.#d.roll ?? Math.random)()) : null;
    return { why, names, ...(gentle ? { gentle } : {}), ...(talks ? { talks } : {}), ...(ask ? { ask } : {}) };
  }
}

export interface WarmUpDeps {
  readonly customers: Pick<CustomerRepository, "get">;
  readonly drafts: Pick<DraftRepository, "recent">;
  readonly finds: Pick<FindRepository, "listFor">;
  /** Who talks with them: to those, the product may be described. */
  readonly results?: { list(customerId: CustomerId, limit: number): Promise<ResultEntry[]> };
  readonly clock: Clock;
  /** Draws the ask back's form; Math.random unless a test gives one. */
  readonly roll?: () => number;
}
