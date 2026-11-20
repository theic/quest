/**
 * What gives away words a model wrote, in a reply, post or message that goes out as the customer.
 * The founder's word, 2026-10-14: "the writer must never use AI-writing cliches that are easily
 * spotable: em-dashes, the poetic language, overexplaining and common patterns". The writer's prompt
 * names all of these; this is the check that holds when a model slips anyway, and its notes go back to
 * the writer once. Each note says what to change, in words a model can act on.
 */

/** What the writer writes: every kind with words (a like or a follow has none). */
export type WrittenKind = "reply" | "post" | "message" | "profile";

/** Where a message goes, for how long it may run. */
export interface TellsCheck {
  readonly kind: WrittenKind;
  /** The destination's host or name: "x.com", "reddit", "linkedin.com". */
  readonly platform: string;
  /** The customer's language: the word lists are English, and stay quiet on any other. */
  readonly language?: string;
  /** Whether the draft it was written from had a link: only then may it keep one. */
  readonly linkAllowed?: boolean;
  /** Whether their own voice uses emoji. */
  readonly emoji?: boolean;
  /** Its question is its purpose (may I introduce you, may I send it): never told to ask nothing this time. */
  readonly asksOnPurpose?: boolean;
  /** Whether they use exclamation marks: false when they said never. */
  readonly exclaim?: boolean;
  /** The most characters the field it goes in takes, when it has its own limit (X's profile bio: 160). */
  readonly chars?: number;
  /** What Quest wrote as them lately, newest first, on every platform: a message that opens like one of these is a template. */
  readonly lately?: readonly Earlier[];
  /** The shape drawn for this message (`drawShape`): how long it may run. */
  readonly shape?: Shape;
  /** Their words that it answers, and the customer's own note on it, when there are any. */
  readonly quote?: string | null;
  readonly note?: string | null;
  /** Its purpose is the help it gives (an opener's one tip): a tip there is no tell. */
  readonly helps?: boolean;
}

/**
 * One way a reply can go, drawn for each message by code. Asked to vary, a model settles on one shape all the same (live,
 * 2026-11-05, 40 replies: "X is a Y" and an emoji, then a second sentence; the founder: "I see the 2-sentence approach with
 * an ending advise or a question too often, also people mostly speak in shorter forms and bad grammar").
 */
export interface Shape {
  readonly name: string;
  /** How often it comes up, against the others. */
  readonly weight: number;
  /** What it asks of the writer. */
  readonly ask: string;
  readonly words: number;
  /** It carries a question; none may when their last messages asked. */
  readonly question?: boolean;
  /** Only an emoji: the emoji limit does not take it away. */
  readonly emoji?: boolean;
}

export const SHAPES: readonly Shape[] = [
  // The shortest answer there is (the founder, 2026-11-18: "use extra short reactions when appropriate, even an emoji counts").
  { name: "an emoji", weight: 2, words: 1, emoji: true, ask: "Only one everyday emoji that fits what they said, the kind anyone taps under a post, and nothing else. No words." },
  { name: "a word or two", weight: 4, words: 4, ask: "A word or two, up to four. Not a sentence: what someone taps out in a second. An emoji alone beside it is fine." },
  { name: "a reaction", weight: 4, words: 8, ask: "One short reaction, under nine words. A fragment, no subject needed." },
  { name: "one detail", weight: 3, words: 14, ask: "One line on the one thing in it that caught your eye, under fifteen words. Say the thing, don't rate it." },
  { name: "a question", weight: 2, words: 10, question: true, ask: "Only a short plain question about their thing, under eleven words. Nothing before it, nothing after it." },
];

/** Where the drawing does not apply: an answer on Reddit has to carry its point, a post or a profile is not a reaction. */
const REACTS = (kind: WrittenKind, platform: string): boolean => (kind === "reply" || kind === "message") && !/reddit/i.test(platform);

/**
 * The shape this message takes, or null where it has none. Never a question after one, and never what the last message
 * was: `roll` is 0 to 1, in tests a fixed number.
 */
export function drawShape(c: Pick<TellsCheck, "kind" | "platform" | "lately"> & { readonly short?: boolean }, roll: number): Shape | null {
  if (!REACTS(c.kind, c.platform)) return null;
  const last = c.lately?.[0]?.text ?? "";
  // A casual word in passing is never a line about their thing or a question: only the three shortest.
  const open = SHAPES.filter((s) => !c.short || s.words <= 8).filter((s) => !(s.question && asks(last)) && !(wordsIn(last) <= s.words && wordsIn(last) > 0 && s.words <= 4));
  const all = open.reduce((n, s) => n + s.weight, 0);
  let at = roll * all;
  for (const s of open) {
    at -= s.weight;
    if (at < 0) return s;
  }
  return open.at(-1) ?? null;
}

/** How many messages of a shape may carry an emoji: told "most carry none", a model still put one on two in three. */
export const EMOJI_SHARE = 0.3;

/** The words without their emoji, unless that leaves nothing. An emoji that ended a sentence leaves a period in its place. */
export function withoutEmoji(text: string): string {
  const emoji = "[\\p{Extended_Pictographic}\\p{Emoji_Modifier}\\u{FE0F}\\u{200D}]+";
  const out = text
    .replace(new RegExp(`([\\p{L}\\p{N}])\\s*${emoji}\\s+(?=\\p{Lu})`, "gu"), "$1. ")
    .replace(new RegExp(`\\s*${emoji}`, "gu"), "")
    .trim();
  return out || text;
}

const wordsIn = (s: string): number => s.trim().split(/\s+/).filter(Boolean).length;

/** One message Quest wrote as them, where it went. */
export interface Earlier {
  readonly platform: string;
  readonly text: string;
}

/**
 * Words that say the message comes from an AI, a bot or anything but them. Live, 2026-11-01: seven Reddit replies
 * from the founder's account opened "not a human here, i'm the ai agent a founder runs", five of them alike, and
 * moderators took five down within 35 minutes. The founder: "that is awful and exactly what gets the account banned
 * on reddit; by being blunt, I meant to be more authentic". Whatever a note or a draft says, it never goes out.
 */
export const SELF_LABEL =
  /\b(not (even )?an? (real |actual )?(human|person)|no(t)? human here|i'?m (an?|the|just an?|only an?) (\w+ )?(ai|bot|agent|assistant|llm)\b|i am (an?|the) (\w+ )?(ai|bot|agent|assistant)\b|as an? (ai|bot|language model)\b|(this is|it'?s) (an?|the) (ai|bot)\b|(an?|the|my) ai agent\b|take this as a bot|a bot asking|written by (an? )?ai\b)/i;

/** The first sentence's words, lowercase, for comparing how two messages open. */
function openingWords(text: string): string[] {
  const first = text.trim().split(/(?<=[.!?])\s|\n/)[0] ?? "";
  return (first.toLowerCase().replace(/[’‘]/g, "'").match(/[\p{L}\p{N}']+/gu) ?? []).slice(0, 16);
}

/**
 * The earlier message this one opens like, if any: the same first four words, or a first sentence that shares most
 * of its words with one's. Five replies opened "not a human here, i'm the ai agent a founder runs. found two people
 * asking for …" (2026-11-01): a reader who opens the account sees a template.
 */
export function openedLike(text: string, lately: readonly Earlier[]): string | null {
  const mine = openingWords(text);
  if (mine.length < 3) return null;
  const content = (ws: readonly string[]): Set<string> => new Set(ws.filter((w) => w.length >= 4));
  const myContent = content(mine);
  for (const w of lately) {
    const theirs = openingWords(w.text);
    if (theirs.length >= 4 && mine.length >= 4 && mine.slice(0, 4).join(" ") === theirs.slice(0, 4).join(" ")) return w.text;
    const theirContent = content(theirs);
    const smaller = Math.min(myContent.size, theirContent.size);
    if (smaller < 3) continue;
    let shared = 0;
    for (const x of myContent) if (theirContent.has(x)) shared++;
    if (shared / smaller >= 0.6) return w.text;
  }
  return null;
}

/** A web address as compared: no scheme, no www, no query or trailing slash, lowercase. */
const address = (u: string): string =>
  u.toLowerCase().replace(/[).,;:!?'"]+$/, "").replace(/^https?:\/\/(www\.)?/, "").replace(/[?#].*$/, "").replace(/\/+$/, "");

/**
 * The addresses in it that already went out on this platform in another message: one account handing the same thread
 * to person after person is what spam filters look for (2026-11-01: the same two Reddit threads went to eight people).
 */
export function linksGivenBefore(text: string, platform: string, lately: readonly Earlier[]): string[] {
  const before = new Set(lately.filter((w) => w.platform === platform).flatMap((w) => (w.text.match(/https?:\/\/\S+/g) ?? []).map(address)));
  return (text.match(/https?:\/\/\S+/g) ?? []).filter((u) => before.has(address(u)));
}

/** The text without its sentences that say it comes from an AI or a bot: what goes out when a model will not drop them. */
export function withoutSelfLabel(text: string): string {
  return text
    .split("\n")
    .map((line) =>
      line
        .split(/(?<=[.!?])\s+/)
        .filter((s) => !SELF_LABEL.test(s))
        .join(" ")
        .trim(),
    )
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Sites where a reply is a line or two, and X cuts a free account's post at 280 characters. */
const SHORT_FORM = /(^|\.)(x\.com|twitter\.com|threads\.(net|com)|bsky\.app|mastodon\.\w+|warpcast\.com)$|^(x|twitter|threads|bluesky|mastodon)$/i;

/** How long each kind may run: characters on the short-form sites, words elsewhere. */
/** Whether the words are English: the word lists below mean nothing in another language, whatever the customer speaks. */
export function looksEnglish(text: string): boolean {
  const words = text.toLowerCase().match(/\p{L}+/gu) ?? [];
  const common = words.filter((w) => ENGLISH_WORDS.has(w)).length;
  return words.length > 0 && common / words.length >= 0.12;
}
const ENGLISH_WORDS = new Set(["the", "a", "an", "and", "or", "but", "is", "are", "was", "it", "its", "to", "of", "in", "on", "for", "with", "you", "your", "i", "my", "me", "we", "this", "that", "what", "not", "just", "so", "if", "they", "them", "do", "have", "keep", "up", "at", "from", "be", "can"]);

export function lengthLimit(c: Pick<TellsCheck, "kind" | "platform" | "chars">): { readonly chars?: number; readonly words?: number } {
  // A profile's words are a line about them: X's bio takes 160 characters, and elsewhere a bio is a sentence or two.
  const site: { readonly chars?: number; readonly words?: number } =
    c.kind === "profile" ? (SHORT_FORM.test(c.platform) ? { chars: 160 } : { words: 40 }) : SHORT_FORM.test(c.platform) ? { chars: c.kind === "post" ? 280 : 220 } : { words: c.kind === "post" ? 170 : c.kind === "message" ? 80 : 70 };
  // A field's own limit holds over the site's: X takes 280 characters in a post and 160 in a bio.
  return c.chars ? { ...site, chars: Math.min(c.chars, site.chars ?? c.chars) } : site;
}

/** Words that read as a brochure or a poem, never as a person typing a reply. Whole words, case aside. */
const INFLATED = [
  "delve", "delves", "delving", "tapestry", "testament", "landscape", "realm", "journey", "navigate", "navigating",
  "unlock", "unlocks", "unlocking", "elevate", "elevates", "empower", "empowers", "empowering", "seamless", "seamlessly",
  "leverage", "leveraging", "robust", "vibrant", "embark", "foster", "fostering", "harness", "harnessing", "resonate",
  "resonates", "intricate", "pivotal", "crucial", "paramount", "beacon", "symphony", "ever-evolving", "game-changer",
  "game changer", "supercharge", "streamline", "streamlines", "revolutionize", "revolutionizes", "cutting-edge",
  "next-level", "effortless", "effortlessly", "hassle-free", "unleash", "thrive", "thriving", "bustling", "nestled",
  "meticulous", "comprehensive", "invaluable", "moreover", "furthermore", "additionally", "ultimately", "transformative",
  "groundbreaking", "unparalleled", "elevated", "holistic", "synergy", "in today's", "dive in", "deep dive",
  "a world where", "in a world", "the power of", "at its core", "rest assured", "worth noting",
] as const;

/**
 * Openings that praise them or say their post back to them before saying anything. "Agreed" and its kind too (the
 * founder, 2026-11-04, on "Agreed, an exception lane makes sense ...": "It's like you always agreeing").
 */
const ECHO_OPENERS =
  /^(great|good|fair|love|loved|such a|what a|so) (question|point|post|this|take|share)\b|^(i hear you|i feel you|i totally get|totally get|i get it|makes (total )?sense|this resonates|so real|so true|this is so|oof|ugh|that's (the|a) (hard|tough|real|worst) (part|one)|as someone who|absolutely|honestly|ah,? the|agreed|exactly|totally|100%)(?=\W|$)/i;

/** A question in it, and an either/or one ("pricing first, or users?"). */
const asks = (s: string): boolean => /\?/.test(s);
const eitherOr = (s: string): boolean => /,? or [^?.!]{1,60}\?/i.test(s);

/**
 * A question after two messages that asked one, or an either/or after one: the shape that made the founder's hand-run
 * replies read as a template (2026-11-02: "each reply is the same-template question and feels really robotic"). A
 * reaction, a word or something about what they made is a reply too; a question only when they'd really want to know.
 */
function questionAgain(text: string, c: TellsCheck): string | null {
  if (c.kind !== "reply" && c.kind !== "message") return null;
  // Live, 2026-11-14: told to ask nothing, "mind if I introduce you?" came back as "okay if I mention X under their post."
  if (!asks(text) || c.asksOnPurpose) return null;
  const [last, before] = c.lately ?? [];
  if (eitherOr(text) && last && eitherOr(last.text)) return "it ends on an either/or question, and so did their last message: say something instead, and ask nothing this time";
  if (last && before && asks(last.text) && asks(before.text)) return "it asks a question, and so did their last two messages: this time say something (a reaction, what you'd add) and ask nothing";
  return null;
}

/**
 * A first sentence that rates what they made: "A pigeon club is a fun name", "Two plans is a much easier story", "X sounds
 * like a nice way to start the day". Twenty-odd of the last forty replies opened so (live, 2026-11-05).
 */
const RATES = /^[^.!?]{0,90}\b(is|are|sounds?|looks?|feels?)( like)? (a|an|such a|so|the|peak|my kind of)\b/i;
const rates = (s: string): boolean => RATES.test(s.trim());

/** It rates their thing after one of the last three did. */
function ratesAgain(text: string, c: TellsCheck): boolean {
  return REACTS(c.kind, c.platform) && rates(text) && (c.lately ?? []).slice(0, 3).some((w) => rates(w.text));
}

/**
 * Their own number said back to them. The founder, 2026-11-15, on "326 from search is solid, curious where those last 8
 * even came from" under a post with both numbers: "people don't respond by quoting the exact number, mostly they simply
 * express their emotion over the number or give their own example. Patterns like this will get us banned."
 */
const numbers = (s: string): string[] => s.match(/\d+(?:[.,]\d+)*/g) ?? [];
function numberBack(text: string, c: TellsCheck): string | null {
  if ((c.kind !== "reply" && c.kind !== "message") || !c.quote) return null;
  const [theirs, asked] = [new Set(numbers(c.quote)), new Set(numbers(c.note ?? ""))];
  return numbers(text).find((n) => theirs.has(n) && !asked.has(n)) ?? null;
}

/** It carries an emoji after both their last two did: one on every message is a signature. */
function emojiAgain(text: string, c: TellsCheck): boolean {
  const has = (s: string): boolean => /\p{Extended_Pictographic}/u.test(s);
  const [last, before] = c.lately ?? [];
  return REACTS(c.kind, c.platform) && has(text) && Boolean(last && before && has(last.text) && has(before.text));
}

/**
 * What made a day's replies read as one hand (the founder, 2026-11-17: "measure the cringe levels"; of five days' 566
 * replies and messages 190 had an emoji, 124 of them the same smile, 62 went "clause, emoji, then a second sentence", and
 * on the last day 5 of 16 opened Glad, Curious or Thanks and 4 closed on a saying).
 */
const STOCK_START = /^(glad|curious|thanks|thank you|nice|love|hope|saw|came across|sounds)\b/i;
function startsAgain(text: string, c: TellsCheck): string | null {
  const mine = STOCK_START.exec(text.trim())?.[0].toLowerCase();
  if (!mine || !REACTS(c.kind, c.platform)) return null;
  return (c.lately ?? []).slice(0, 6).some((w) => w.text.trim().toLowerCase().startsWith(mine)) ? mine : null;
}
/** An emoji with words after it: the "Glad you're in 🙂 Now the tip" seam. */
const EMOJI_MID = /\p{Extended_Pictographic}️?\s+[\p{L}\p{N}]/u;
/** A tip nobody asked for ("I'd put that first"), after one of their last three gave one. */
const TIP = /\bI'?d (put|drop|write|shift|talk|start|try|lead|add|move|make|keep|go|test|post|pick|cut|ask|look|search|focus|swap|change|show)\b/i;
function tipAgain(text: string, c: TellsCheck): boolean {
  if (!REACTS(c.kind, c.platform) || c.helps || c.note || /\?/.test(c.quote ?? "")) return false;
  return TIP.test(text) && (c.lately ?? []).slice(0, 3).some((w) => TIP.test(w.text));
}
/** A saying that sums it up, or a stranger's sympathy. */
const SAYINGS = /\b(carries a lot|goes a long way|a lot to carry|a good place to be|(better|faster|more|harder) than any\b|tells? you (way )?more)\b/i;

/** Endings that offer more help, invite a reply for its own sake, or sum up. */
const CLOSERS =
  /\b(happy to \w+|glad to (help|share|answer)|feel free|hope (this|that|it) helps|let me know( if)?|any questions|reach out|dm me|drop me a|check it out|give it a (try|go|shot)|worth a (try|look|shot)|try it (out|free)|sign up|link in (my )?bio|(i'?d|would) love (your|to hear|some|any) (feedback|thoughts)|in short|bottom line|tl;?dr|good luck( with it)?!)\b/i;

/** A link, or a bare web address ("vocavela.live"). */
export const LINK = /https?:\/\/|www\.|\b[\w-]+\.(com|io|app|live|ai|co|so|dev|net|org)\b/i;

/** Sentence shapes a reader spots as a model's: the contrast pivot, the reveal, the bolted-on question. */
const PATTERNS: readonly [RegExp, string][] = [
  [/\b(it|this|that)('s| is| was) not (just |only |about )?[^.;!?]{1,40}[,;.]\s*(it|this|that)('s| is| was)\b/i, "the \"it's not X, it's Y\" turn"],
  [/\b(isn'?t|is not|wasn'?t|aren'?t) (just |only |about )?[^.;!?]{1,40}[,;.]\s*(it|this|that|they)('s| is|'re| are)\b/i, "the \"X isn't Y, it's Z\" turn"],
  [/\bnot (just|only) [^.,;!?]{1,40},? but\b/i, "\"not just X but Y\""],
  // MiMo's own drafts, 2026-10-13: "Speaking practice is the core of it, not tapping through lessons." "It's for real conversations here, not lessons."
  [/\w, not (just |only )?[^.,;!?]{2,40}[.!]/i, "the \"X, not Y\" contrast"],
  [/\bhere'?s (the thing|why|what|how)\b/i, "\"here's the thing\""],
  [/\bthe (real|best|hard|secret|key) (part|thing|trick|question|win)\b[^.?!]{0,30}\?/i, "a question it then answers"],
  [/\b(for exactly this|exactly for this|that'?s exactly (why|what)|built (it )?for (exactly )?(this|that|moments like)|moments like (this|that|these))\b/i, "\"built for exactly this\""],
  [/\b(designed to|built to help|helps you|allows you to|enables you to|lets you easily)\b/i, "brochure verbs (\"helps you\", \"designed to\")"],
  [/\b(genuinely|truly|literally|incredibly|super easy|really powerful|the best way)\b/i, "an intensifier (\"genuinely\", \"truly\", \"literally\")"],
];

const bare = (s: string): string => ` ${s.toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, " ")} `;

/** The words the text uses from a list, as whole words. */
function used(text: string, list: readonly string[]): string[] {
  const t = bare(text);
  return list.filter((w) => new RegExp(`[^a-z'-]${w.replace(/[-']/g, "[-' ]?")}[^a-z'-]`).test(t));
}

/**
 * Three short things in a row, "a, b, and c" or "a, b and c": the rhythm a reader hears as a model's. Each item a
 * word or two, so a sentence going on after a comma ("I made X, it finds them and writes") is not one.
 */
const TRIPLET = /\b[\w'-]+(?: [\w'-]+)?, [\w'-]+(?: [\w'-]+)?,? and [\w'-]+\b/i;

/** What gives the text away as written by a model, each with what to do instead; empty when it reads like a person. */
export function writingTells(text: string, c: TellsCheck): string[] {
  const notes: string[] = [];
  const t = text.trim();
  const label = SELF_LABEL.exec(t)?.[0];
  if (label) notes.push(`it says it comes from an AI or a bot ("${label}"): it is them typing, from their own account, so leave that out entirely, whatever the draft or the note says`);
  const like = openedLike(t, c.lately ?? []);
  if (like) notes.push(`it opens like a message they already sent ("${like.slice(0, 80)}"): start from what this person said, in a first sentence of its own`);
  const asked = questionAgain(t, c);
  if (asked) notes.push(asked);
  if (c.shape && wordsIn(t) > c.shape.words) notes.push(`it runs ${wordsIn(t)} words: ${c.shape.ask}`);
  if (ratesAgain(t, c)) notes.push("it opens by rating their thing (\"X is a Y\", \"X sounds like a Y\"), and so did a message just before: say the thing itself, or just react");
  const number = numberBack(t, c);
  if (number) notes.push(`it says their own number back to them ("${number}"): no number of theirs in it. React to it the way people do ("thats a lot", "wild", "not bad at all"), or say something else`);
  const start = startsAgain(t, c);
  if (start) notes.push(`it opens with "${start}", and so did a message just before: start from the thing they said, in other words`);
  if (REACTS(c.kind, c.platform) && EMOJI_MID.test(t)) notes.push("it has an emoji in the middle, with a second sentence after it: the emoji at the very end, or none, and say one thing");
  if (tipAgain(t, c)) notes.push("it gives a tip nobody asked for (\"I'd ...\"), and so did a message just before: react to what they said, no advice this time");
  const saying = REACTS(c.kind, c.platform) ? SAYINGS.exec(t)?.[0] : null;
  if (saying) notes.push(`it closes on a saying or sympathy ("${saying}"): leave that sentence out`);
  if (emojiAgain(t, c)) notes.push("it has an emoji, and so did their last two messages: none this time");
  const again = linksGivenBefore(t, c.platform, c.lately ?? []);
  if (again.length) notes.push(`it hands over ${again.join(" ")}, which already went to someone else on this site: leave ${again.length > 1 ? "those links" : "that link"} out`);
  if (/[—–]/.test(t)) notes.push("it has a dash (— or –): use a period or a comma, or say it in two sentences");
  else if (/\S \- \S/.test(t)) notes.push("it uses a hyphen as a dash (\" - \"): use a period or a comma");
  if (/;/.test(t)) notes.push("it has a semicolon: two short sentences instead");
  if (/(\*\*|__|^#{1,3} |^\s*[-*•] |^\s*\d+\. )/m.test(t)) notes.push("it has formatting (bold, a heading or a list): plain sentences, the way people type a reply");
  if (/(^|\s)#\w/.test(t)) notes.push("it has a hashtag: none");
  if (c.exclaim === false && /!/.test(t)) notes.push("it has an exclamation mark, and they never use them: none");
  else if ((t.match(/!/g) ?? []).length > 1) notes.push("it has more than one exclamation mark: one at most, or none");
  if (/\.\.\.|…/.test(t)) notes.push("it trails off with an ellipsis: end the sentence");
  if (!c.linkAllowed && LINK.test(t)) notes.push("it has a link or a web address: leave it out, the name is enough");
  const emoji = t.match(/\p{Extended_Pictographic}/gu) ?? [];
  if (emoji.length && !c.emoji) notes.push("it has emoji, and their voice doesn't use them: none");
  else if (emoji.length > 1) notes.push("it has more than one emoji: one at most");
  const english = looksEnglish(t);
  if (english) {
    const inflated = used(t, INFLATED);
    if (inflated.length) notes.push(`it uses ${inflated.map((w) => `"${w}"`).join(", ")}, which reads as a brochure: say it in plain words`);
    const opener = ECHO_OPENERS.exec(t)?.[0];
    if (opener) notes.push(`it opens with "${opener}": start with the point`);
    const closer = CLOSERS.exec(t)?.[0];
    if (closer) notes.push(`it says "${closer}": leave out offers, calls to action and summaries`);
    for (const [re, what] of PATTERNS) {
      const m = re.exec(t)?.[0];
      if (m) notes.push(`it uses ${what} ("${m.trim()}"): say it straight`);
    }
    const triplet = TRIPLET.exec(t)?.[0];
    if (triplet) notes.push(`it lists three things in a row ("${triplet}"): name the one that matters to them`);
    const questions = t.split(/(?<=[.!?])\s+/).filter((s) => s.trim().endsWith("?"));
    if (questions.length > 1) notes.push("it asks more than one question: one at most");
  }
  const limit = lengthLimit(c);
  const words = t.split(/\s+/).filter(Boolean).length;
  if (limit.chars && t.length > limit.chars) notes.push(`it runs ${t.length} characters: keep it under ${limit.chars}, one or two short sentences`);
  if (limit.words && words > limit.words) notes.push(`it runs ${words} words: keep it under ${limit.words}, and cut what they already know`);
  return notes;
}
