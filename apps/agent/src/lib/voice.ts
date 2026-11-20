/** Words marked for emphasis (*so*, **so**, _so_, __so__), never a snake_case name, a link or a sum like 2*3*4. */
const withoutEmphasis = (text: string): string =>
  text
    .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, "$1")
    .replace(/(?<![\w*])\*(?=\S)([^*\n]+?)(?<=\S)\*(?![\w*])/g, "$1")
    .replace(/(?<![\w/=.-])__(?=\S)(.+?)(?<=\S)__(?![\w/.])/g, "$1")
    .replace(/(?<![\w/=.-])_(?=\S)([^_\n]+?)(?<=\S)_(?![\w/.])/g, "$1");

/**
 * A dash used as punctuation is the plainest tell of machine-written text, and emphasis the next (the founder,
 * 2026-11-06: "It should never use emphasis and emdashes in the copy"); a prompt alone does not stop a model writing
 * either. What Quest says, and every reply it drafts for a customer to post, goes out with commas instead and with no
 * marks round a word. A range ("3–5") keeps a hyphen. Quotes of other people's words never pass through here.
 */
export function unstyled(raw: string): string {
  const text = withoutEmphasis(raw);
  // This English style rule can break grammar in other scripts (e.g. «Quest — помощник»).
  if (/[\p{Script=Cyrillic}\p{Script=Han}\p{Script=Arabic}\p{Script=Devanagari}]/u.test(text)) return text;
  return text
    .replace(/(\d)\s*[–—]\s*(?=\d)/g, "$1-")
    .replace(/[ \t]*[—–][ \t]*(?=[.,;:!?)]|$)/gm, "")
    .replace(/^([ \t]*)[—–][ \t]*/gm, "$1")
    .replace(/[ \t]*[—–][ \t]*/g, ", ")
    .replace(/,(\s*,)+/g, ",");
}

/** A word that keeps the case it has: a handle, a link, a community, a file, a name like iOS or eBay. */
const keepsCase = (word: string): boolean => /[\p{Lu}\p{N}@#_/]|\.\p{L}|^https?:/u.test(word);
const ABBREVIATION = /(^|\s)(e\.g|i\.e|vs|etc|approx|a\.m|p\.m)\.$|\.\.$/i;

/**
 * Every sentence starts with a capital, and "i" is "I" (the founder, 2026-11-03: "I don't like lowercase, start with a
 * capital always"). For what Quest says and every word the writer writes as them; their own dictated words stay as they
 * wrote them. Handles at the front of a reply ("@maya ha" is "@maya Ha") and an emoji or a quote mark are passed over.
 */
/**
 * A word after a leading handle that makes the handle the one who did it ("@englaris made something"): capitalized, it
 * read as said to them ("@englaris Made something", live, 2026-11-13: an introduction seemed to claim the app as ours).
 */
const SUBJECT_VERB = /^(made|makes|built|builds|build|just|launched|launches|shipped|ships|put|puts|created|creates|wrote|writes|has|had|is|was|does|did|posted|posts|runs|ran|started|starts|released|releases|designed|designs|developed|develops|also|already|recently|literally)\b/u;

export function capitalized(text: string, language?: string): string {
  const sentences = text.replace(
    /(^[\s\p{Extended_Pictographic}️"'“‘(*]*(?:@[\w.]+\s+)*|[.!?]["'”’)]*\s+|\n[\s\p{Extended_Pictographic}️"'“‘(*-]*)(\p{Ll})(?=(\S*))/gu,
    (all: string, before: string, letter: string, rest: string, at: number) =>
      keepsCase(letter + rest) || (before.startsWith(".") && ABBREVIATION.test(text.slice(0, at + 1))) || (before.includes("@") && SUBJECT_VERB.test(letter + rest))
        ? all
        : `${before}${letter.toUpperCase()}`,
  );
  if (language && language !== "en") return sentences;
  return sentences.replace(/(?<![\p{L}\p{N}_@#/.'’-])i(?=['’](m|ll|ve|d)\b|[\s,;:!?)]|$)/gu, "I");
}

/**
 * Phrases that mark a message as written by a bot, not a colleague. The prompt names
 * them too; this is the check that holds when a model slips (live chats, 2026-09-28:
 * "Quick honest update", "Heads up"). Matched as whole words, case aside.
 */
const STOCK_PHRASES = [
  "great question",
  "good question",
  "i'd be happy to",
  "i would be happy to",
  "happy to help",
  "hope this helps",
  "let me know if you have any",
  "let me know if there's anything",
  "feel free to",
  "don't hesitate",
  "do not hesitate",
  "just checking in",
  "just wanted to check",
  "quick update",
  "quick honest update",
  "quick note",
  "heads up",
  "heads-up",
  "i understand your frustration",
  "rest assured",
  "as an ai language model",
  "delve",
  "deep dive",
  "game-changer",
  "game changer",
  "in today's fast",
  "it's worth noting",
  "great news",
  "exciting news",
  "i hope you're well",
  "hope you're doing well",
  // How a chaser reads when a template wrote it.
  "friendly reminder",
  "gentle reminder",
  "circling back",
  "circle back",
  "touching base",
  "just following up",
  "per my last message",
  "as per my last",
  "bumping this",
] as const;

/** A message as words and nothing else: case, curly quotes and punctuation aside. */
const bare = (s: string): string =>
  s.toLowerCase().replace(/[’‘]/g, "'").replace(/[^\p{L}\p{N}' ]+/gu, " ").replace(/\s+/g, " ").trim();

/**
 * The labels that open a message's paragraphs, the way a form or a status update is laid out:
 * "Today's haul:", "The experiment:", "Tomorrow:". A label is up to four words before a colon.
 */
function labels(text: string): { first: boolean; found: string[] } {
  const paragraphs = text.split(/\n\s*\n|\n(?=\S)/).map((p) => p.trim()).filter(Boolean);
  const found: string[] = [];
  let first = false;
  paragraphs.forEach((p, i) => {
    const m = /^([\p{L}'’ ]{2,40}):\s/u.exec(p);
    if (!m || m[1]!.trim().split(/\s+/).length > 4) return;
    found.push(m[1]!.trim());
    if (i === 0) first = true;
  });
  return { first, found };
}

/** Sentences of six words or more that the customer already read, word for word, in one of the earlier messages. */
function repeated(text: string, earlier: readonly string[]): string[] {
  const before = earlier.map(bare);
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => {
      const b = bare(s);
      return b.split(" ").length >= 6 && before.some((e) => e.includes(b));
    });
}

/**
 * How long a message runs: a line, the way a friend texts. The customer's word, 2026-10-01: "people don't speak like
 * that and I don't read so much text"; 2026-10-29: "ultra short responses, slang, reactions".
 */
export const MESSAGE_WORDS = 25;
/** The evening report's length: a few lines, skimmed on a phone. */
export const REPORT_WORDS = 45;

/**
 * How the work was done, which a manager never needs: search words, filters, pages, queues,
 * error codes, experiment numbers. Each from a live message of 2026-10-01.
 */
const MACHINERY: readonly RegExp[] = [
  /\bexperiment #?\d+/i,
  /\bpages? \d+(-\d+)?\b/i,
  /\b(403|404|429)\b/,
  /\blogged[- ]out\b/i,
  /\/new\b/i,
  /\bkeywords?\b/i,
  /\b\d+-page\b/i,
  /\bpaginat/i,
  /\bpage (budget|limit|quota)s?\b/i,
  // Quest's own bookkeeping words (routes.ts), live in a rehearsal of 2026-10-07: "Reddit posts and replies are spent".
  /\broutes?\b/i,
  /\b(is|are) spent\b/i,
];

/** Asking them to go through their cards, or counting what waits there: the cards speak for themselves. */
const CARD_TALK: readonly RegExp[] = [
  /\bkeep (or|\/) skip\b/i,
  /\b(clear|decide|go through|get through) (the|those|these|your) (\w+ )?cards\b/i,
  /\b\d+ (more )?(finds?|cards?) (still )?(wait|are waiting|sit)/i,
  /\bwait(s|ing)? on your cards\b/i,
  /\bqueued? behind (yours?|the)\b/i,
  /\b(\d+|two|three|a few) cards? (are |is )?up\b/i,
  // Live on Telegram, 2026-10-07 and 2026-10-08, closing a shortlist and a day's news: "Cards are up."
  /\b(the )?cards? (are|is) (up|in|ready|out)\b/i,
  /\bon (the|your) cards\b/i,
  /\bthe rest (follow|come|show up) (on their own|by themselves)\b/i,
  // Live on Telegram, 2026-10-21, after an idea's card: "Sent it as a card, so you can tap Write it or wave it off."
  /\b(sent|put) (it|that|this|them) (as|on|in) an? (\w+ )?card\b/i,
  /\btap (write it|not this one|post it|send it|like it|follow)\b/i,
];

/**
 * "Card" is Quest's own word for what waits on them, and means nothing to them. The founder, 2026-11-01: "It is not
 * clear, what does "on card" or cards mean ... use simpler language". A credit card, a gift card and the like are not it.
 */
const CARD_WORD = /\b(?<!(credit|debit|gift|business|sim|bank|loyalty|id|report|playing|trading|sd|graphics|video) )cards?\b/i;

/** Telling them when the report comes: they know. */
const REPORT_TALK = /\b(report (tonight|at \d|goes out|lands)|I'll report\b)/i;

/**
 * Canned reassurance, which a friend helping with the business shows by what they do next rather than
 * says. Soft, and only for Quest's own chat: "no worries if not" is fine in a reply posted as the customer.
 */
const REASSURANCE =
  /\b(no worries|don'?t worry|do not worry|no need to worry|you'?re in good hands|i'?ve got you covered|i got you covered|thanks? (you )?for your patience|appreciate your patience|(sorry|apologies) for (the|any) (inconvenience|confusion))\b/i;

/**
 * Slang that reads as a parody from someone running their business. Texting slang is welcome (the founder, 2026-10-29:
 * "ultra short responses, slang, reactions"): "ngl", "tbh", "lol", "kinda", "lowkey", "btw", "DM" are ordinary.
 */
const FORCED_SLANG = /\b(bestie|slay(ing|ed)?|it'?s giving|bussin|yeet|on fleek|periodt|rizz)\b/i;

/**
 * Emoji, the way a 25-year-old hire texts (the customer's word, 2026-10-01: "It must use emoji as well,
 * but not too much"): one in a message at most, not in every message, and none of the ones that make a
 * message read like a launch post.
 */
const EMOJI = /\p{Extended_Pictographic}/gu;
const BROCHURE_EMOJI = /[🚀✨💡🎯📈📊📌✅👉🔥💯]/u;
const emoji = (text: string): string[] => text.match(EMOJI) ?? [];

export interface VoiceCheck {
  /** English phrase heuristics must not reject a reply in another language. */
  readonly language?: string;
  /** What the customer already heard lately, newest last. */
  readonly earlier?: readonly string[];
  /** The evening report: kept under REPORT_WORDS rather than MESSAGE_WORDS, and opened with the news rather than a label. */
  readonly report?: boolean;
  /** The message names people from a shortlist (best_people): each wants its link. */
  readonly shortlist?: boolean;
  /** They asked how it's going: the answer leads with results, or says plainly there are none. */
  readonly progress?: boolean;
  /** A reply to what they wrote: it starts with the point, not a greeting. */
  readonly reply?: boolean;
}

/** Words that speak of results: people talking, trying, paying, or plainly none. */
const RESULT_WORDS = /\b(results?|nobody|no one|none|not yet|talked|talking|tried|trying|trials?|paid|paying|pays|customers?|users?|signed up|sign-?ups?|conversations?|answered|replied)\b/i;

/** Each language Quest speaks, by name, for notes to the model. */
const LANGUAGE_NAMES: Readonly<Record<string, string>> = {
  en: "English", ru: "Russian", uk: "Ukrainian", pt: "Portuguese", es: "Spanish", fr: "French", de: "German", zh: "Chinese", hi: "Hindi", ar: "Arabic",
};
/** The script each language is written in, and the language a script means when it is not theirs. */
const SCRIPT_OF: Readonly<Record<string, string>> = { en: "Latin", pt: "Latin", es: "Latin", fr: "Latin", de: "Latin", ru: "Cyrillic", uk: "Cyrillic", zh: "Han", hi: "Devanagari", ar: "Arabic" };
const SCRIPT_LANGUAGE: Readonly<Record<string, string>> = { Cyrillic: "ru", Han: "zh", Devanagari: "hi", Arabic: "ar" };
/** Short words common in one Latin-script language and rare in the others: what tells them apart. */
const COMMON_WORDS: Readonly<Record<string, ReadonlySet<string>>> = Object.fromEntries(
  Object.entries({
    en: "the and is are you your i i'm it's to of with what this that for it don't can't be was will have just",
    pt: "não está você para com uma que os do da dos das em no na mas sem eu queres tu seu sua é isso também já ou",
    es: "el los las está usted para con una que del en pero sin yo tú es y muy también ya esto eso",
    fr: "le les est vous pour avec une que des du et pas je tu sur dans ce mais c'est très ou",
    de: "der die das und ist nicht ich du sie mit für auf ein eine zu den dem es aber auch oder",
  }).map(([l, words]) => [l, new Set(words.split(" "))]),
);

/**
 * The language a message to them is plainly written in, when it is not theirs; null when it is theirs, or too
 * short to tell. Quotes, links, handles and community names are left out: those are other people's words.
 * Live, 2026-10-13: after reading their X in Ukrainian, a reply to an English-speaking founder came in Portuguese.
 */
export function otherLanguage(text: string, locale: string): string | null {
  const own = text
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[@#]\w[\w.]*|\b[ur]\/\w+/g, " ")
    .replace(/"[^"\n]*"|“[^”\n]*”|«[^»\n]*»|„[^“”\n]*[“”]/g, " ");
  const counts = Object.fromEntries(["Latin", "Cyrillic", "Han", "Devanagari", "Arabic"].map((s) => [s, (own.match(new RegExp(`\\p{Script=${s}}`, "gu")) ?? []).length]));
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (total < 20) return null;
  const expected = SCRIPT_OF[locale] ?? "Latin";
  const [top, n] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]!;
  const words = own.toLowerCase().replace(/[’‘]/g, "'").split(/[^\p{L}']+/u).filter(Boolean);
  const latin = (): string => {
    const scores = Object.entries(COMMON_WORDS).map(([l, set]) => [l, words.filter((w) => set.has(w)).length] as const);
    return scores.sort((a, b) => b[1] - a[1])[0]![0];
  };
  if (top !== expected && n / total > 0.6) return LANGUAGE_NAMES[top === "Latin" ? latin() : SCRIPT_LANGUAGE[top]!]!;
  if (expected === "Cyrillic") {
    const ru = /[ыэъё]/i.test(own), uk = /[іїєґ]/i.test(own);
    if (locale === "uk" && ru && !uk) return LANGUAGE_NAMES["ru"]!;
    if (locale === "ru" && uk && !ru) return LANGUAGE_NAMES["uk"]!;
  }
  if (expected === "Latin" && COMMON_WORDS[locale]) {
    const mine = words.filter((w) => COMMON_WORDS[locale]!.has(w)).length;
    const best = latin();
    const theirs = words.filter((w) => COMMON_WORDS[best]!.has(w)).length;
    if (best !== locale && theirs >= 4 && theirs >= 2 * Math.max(mine, 1)) return LANGUAGE_NAMES[best]!;
  }
  return null;
}

/**
 * What makes a message read like a template or a log rather than a colleague, each in words a model
 * can act on; empty when it reads fine. Softer than stock phrases: a model is asked once to fix these,
 * then the message goes out. The evening report of 2026-09-30 opened "Today's haul:", ran four
 * labelled paragraphs and 190 words, and said again a sentence sent two minutes before; the morning
 * of 2026-10-01 ran 60-word updates on search words, review-site filters and page numbers.
 */
export function voiceNotes(text: string, check: VoiceCheck = {}): string[] {
  const notes: string[] = [];
  const other = check.language ? otherLanguage(text, check.language) : null;
  if (other) {
    const theirs = LANGUAGE_NAMES[check.language!] ?? check.language!;
    notes.push(`it is written in ${other}, but they read ${theirs}: write it in ${theirs}, whatever language the pages you read were in`);
  }
  // A title before the news: "Evening report, Tally." (2026-09-29).
  const opening = /^[^.!?:\n]*/.exec(text.trim())![0];
  const titled = opening.split(/\s+/).length <= 5 && /\b(report|update|recap|summary|roundup|wrap-?up|haul)\b/i.test(opening);
  if (titled) notes.push(`it opens with a title ("${opening.trim()}"): start with the news in a plain sentence`);
  // One label up front is ordinary chat ("Read your site: …"), except in the report; two make a form anywhere.
  const l = labels(text);
  if ((check.report && l.first && !titled) || l.found.length >= 2) {
    notes.push(
      `it is laid out like a form (${l.found.map((x) => `"${x}:"`).join(", ")}): start with the news in a plain sentence, and write paragraphs without labels`,
    );
  }
  const again = repeated(text, check.earlier ?? []);
  if (again.length) notes.push(`it says again what they already read: "${again[0]}". Leave that out, or point to it in a few words`);
  const machinery = MACHINERY.map((r) => r.exec(text)?.[0]).find(Boolean);
  if (machinery) notes.push(`it says how you did the work ("${machinery}"): say what came of it, and leave out the search words, filters, pages and numbers behind it`);
  const cards = CARD_TALK.map((r) => r.exec(text)?.[0]).find(Boolean);
  if (cards) notes.push(`it talks about their cards ("${cards}"): the cards speak for themselves, so leave them out`);
  else if ((!check.language || check.language === "en") && CARD_WORD.test(text)) {
    notes.push('it says "card", which means nothing to them: say what waits in plain words ("the reply to Dana is waiting for your OK"), or leave it out');
  }
  const report = check.report ? null : REPORT_TALK.exec(text)?.[0];
  if (report) notes.push(`it says when the report comes ("${report}"): they know, so leave it out`);
  const plain = text.replace(/[’‘]/g, "'");
  const soothing = REASSURANCE.exec(plain)?.[0];
  if (soothing) notes.push(`it reassures with a stock line ("${soothing}"): leave it out, what you do next says it`);
  const slang = FORCED_SLANG.exec(plain)?.[0];
  if (slang) notes.push(`"${slang}" reads as forced slang: say it the way you'd text a friend you work with`);
  // The real model, 2026-10-07: "Best bets: u/Little_Guarantee_371 (r/taiwan, …), u/Adept_Key7376 …", and nothing to open.
  if (check.shortlist && /\b[ur]\/\w+/.test(text) && !/https?:\/\//.test(text)) {
    notes.push("it names people without their links: put each one's link by their name, so they can open it");
  }
  // A hello opens a first conversation, or one picked up after a quiet day; mid-conversation, a reply starts with the point.
  const midConversation = check.reply && (check.earlier?.length ?? 0) > 0;
  const greeting = midConversation ? /^(hey|hi|hello|good (morning|afternoon|evening))\b[^.!?\n]{0,20}[.!,]?/i.exec(text.trim())?.[0] : null;
  if (greeting) notes.push(`it opens with "${greeting.trim()}": in a reply, start with the point`);
  // The real model, 2026-10-07, asked "How's it going?": "Two cards are up now… Fresh search is running…".
  if (check.progress && (!check.language || check.language === "en") && !RESULT_WORDS.test(text)) {
    notes.push("they asked how it's going and it says what you did, not what came of it: lead with the results (or plainly that there are none yet) and what didn't work");
  }
  const used = emoji(text);
  const brochure = BROCHURE_EMOJI.exec(text)?.[0];
  if (brochure) notes.push(`it uses ${brochure}, which reads like a launch post: use none, or one a person would text (🙏 👀 🙂 🎉)`);
  else if (used.length > 1) notes.push(`it has ${used.length} emoji (${used.join(" ")}): one at most, or none`);
  else if (used.length && (check.earlier ?? []).slice(-2).filter((e) => emoji(e).length).length === 2) {
    notes.push("it has an emoji, like your last two messages: leave it out of this one");
  }
  const words = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)
    ? [...new Intl.Segmenter(check.language || "zh", { granularity: "word" }).segment(text)].filter((part) => part.isWordLike).length
    : text.split(/\s+/).filter(Boolean).length;
  const limit = check.report ? REPORT_WORDS : MESSAGE_WORDS;
  if (words > limit) {
    notes.push(
      check.report
        ? `it runs ${words} words: keep it under ${REPORT_WORDS}, the few things that matter`
        : `it runs ${words} words: say it in under ${MESSAGE_WORDS}, the way you'd text a busy manager, unless they asked for the detail`,
    );
  }
  return notes;
}

/** The stock phrases in a message, if any. */
export function stockPhrases(text: string): string[] {
  const t = ` ${text.toLowerCase().replace(/[’‘]/g, "'")} `;
  const letter = /[a-z]/;
  return STOCK_PHRASES.filter((p) => {
    for (let at = t.indexOf(p); at >= 0; at = t.indexOf(p, at + 1)) {
      if (!letter.test(t[at - 1]!) && !letter.test(t[at + p.length]!)) return true;
    }
    return false;
  });
}
