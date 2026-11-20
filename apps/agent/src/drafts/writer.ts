import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { WORDLESS, type Clock, type CustomerId, type CustomerRepository, type DraftRepository, type FindRepository, type Logger, type MemoryRepository, type SpendLog, type Transcript } from "@mq/core";
import type { ModelProvider } from "../agents/models.ts";
import { usageOf } from "../agents/usage.ts";
import { capitalized, unstyled } from "../lib/voice.ts";
import { slipped } from "./slips.ts";
import { platformOf } from "../platforms.ts";
import { approvedTake, tunedRules } from "./voice-habits.ts";
import { EMOJI_SHARE, LINK, SELF_LABEL, drawShape, lengthLimit, linksGivenBefore, openedLike, withoutEmoji, withoutSelfLabel, writingTells, type Earlier, type Shape, type WrittenKind } from "./tells.ts";
import { findPlatform, othersLinks } from "./warm-up.ts";

/**
 * How the customer writes, as Quest knows it: the brief, their word on how their words should sound
 * (voice memories and decisions), and what they asked for lately in the chat, where a style ask lives
 * ("use simple language and short like 'keep it up'", live 2026-10-14).
 */
export interface Voice {
  readonly name: string | null;
  readonly language: string;
  readonly brief: string | null;
  /** Their word on how they sound and what they never say, newest last. */
  readonly rules: readonly string[];
  /** Their own last messages to Quest, newest last. */
  readonly asked: readonly string[];
  /** How Quest writes as them, tuned with them in the takes of their first day: every rule, after their last answer. */
  readonly tuned?: readonly string[];
  /** The take they said is them: what Quest wrote as them that they approved. */
  readonly sample?: string | null;
}

/** One message to write: where it goes, what it answers, and the teammate's draft of it. */
export interface WritingJob {
  readonly kind: WrittenKind;
  /** The destination's host or name: "x.com", "reddit". */
  readonly platform: string;
  /** Where exactly: a community, a thread, a person's handle. */
  readonly place: string | null;
  /** Whose words it answers, and the words. */
  readonly author: string | null;
  readonly quote: string | null;
  /** The teammate's draft: the point to get across and the facts it may use. */
  readonly draft: string;
  /** A post's title or a message's subject, as drafted. */
  readonly title: string | null;
  /** Their note on the card, typed or said ("say nothing about Messaging Quest"): the change they asked for. */
  readonly note?: string;
  /** The most characters the field it goes in takes, when it has its own limit (X's profile bio: 160). */
  readonly chars?: number;
  /** It warms their account or a person up (warm-up.ts): no product, no link, nothing to sell. */
  readonly plain?: boolean;
  /** With plain, to someone already talking: what they build may be described in passing, never named or linked. */
  readonly gentle?: boolean;
  /** What Quest knows of whom it goes to (contacts/acquaintances.ts): who they are, what they are after, what passed. */
  readonly about?: string | null;
  /** The words give them something they can use (an answer, a tip on their problem, people for what they built): that is what the message is for, and it is kept. */
  readonly helps?: boolean;
  /** Help for help, drawn in code (warm-up.ts `askForm`): the one light ask about their product it may end with. */
  readonly ask?: string;
  /** A word in passing under a post read on the way: only the shortest shapes. */
  readonly casual?: boolean;
}

export interface Written {
  readonly text: string;
  readonly title: string | null;
  /** The tells still in it after the second try, for the log; empty when it reads like a person. */
  readonly tells: readonly string[];
  /** Whether the writer wrote it; false when it failed and the draft went on as it was. */
  readonly rewritten: boolean;
  /** The checks sent the first try back to the writer (it read like a template, ran long, gave itself away). */
  readonly again?: boolean;
}

export interface WriterPort {
  write(customerId: CustomerId, job: WritingJob): Promise<Written>;
}

/** Their voice, as the writer reads it. */
export type VoiceSource = (customerId: CustomerId) => Promise<Voice>;

/** How much of their word the writer reads: every voice memory, their newest decisions, their last messages of two days. */
const DECISIONS_READ = 12;
const ASKED_READ = 6;
const ASKED_WITHIN_MS = 48 * 3_600_000;

/**
 * Their voice from what Quest keeps: the brief, every `voice` memory (their word on how they sound, kept
 * from their edits and asks) and their newest decisions, oldest first, and their own messages of the last
 * two days, where an ask for this work says how it should sound.
 */
export function voiceFrom(d: {
  customers: Pick<CustomerRepository, "get">;
  memory: Pick<MemoryRepository, "list">;
  transcript: Pick<Transcript, "recent">;
  clock: Clock;
}): VoiceSource {
  return async (customerId) => {
    const [customer, kept, said] = await Promise.all([d.customers.get(customerId), d.memory.list(customerId, 120), d.transcript.recent(customerId, 30)]);
    const since = d.clock.now().getTime() - ASKED_WITHIN_MS;
    const voice = kept.filter((m) => m.kind === "voice");
    const decisions = kept.filter((m) => m.kind === "decision").slice(0, DECISIONS_READ);
    const approved = approvedTake(customer.profile);
    return {
      name: customer.displayName,
      language: customer.language ?? "en",
      brief: customer.brief,
      rules: [...voice, ...decisions].reverse().map((m) => m.text),
      asked: said.filter((e) => e.direction === "in" && e.at.getTime() > since).slice(-ASKED_READ).map((e) => e.text.slice(0, 400)),
      sample: approved?.wrote ?? null,
      tuned: tunedRules(customer.profile),
    };
  };
}

/** What Quest wrote as them lately, newest first: a new message opens its own way and hands over no link twice. */
export type LatelySource = (customerId: CustomerId) => Promise<readonly Earlier[]>;

const LATELY_MS = 14 * 86_400_000;
const LATELY_READ = 30;

/**
 * What Quest wrote as them in the last two weeks, newest first, on every platform: drafts not skipped and the replies
 * of finds shown. What they skipped never went up, so it is nobody's template.
 */
export function writtenLately(d: { drafts: Pick<DraftRepository, "recent">; finds: Pick<FindRepository, "listFor">; clock: Clock }): LatelySource {
  return async (customerId) => {
    const since = d.clock.now().getTime() - LATELY_MS;
    const [drafts, finds] = await Promise.all([d.drafts.recent(customerId, 200), d.finds.listFor(customerId, ["shown", "kept", "replied"], 200)]);
    const out = [
      ...drafts
        .filter((x) => x.status !== "skipped" && !WORDLESS.has(x.kind) && x.kind !== "profile" && x.text.trim() && x.createdAt.getTime() > since)
        .map((x) => ({ at: x.createdAt.getTime(), platform: x.platform, text: x.text })),
      ...finds
        .filter((f) => f.reply.trim() && (f.sentAt ?? f.shownAt ?? f.createdAt).getTime() > since)
        .map((f) => ({ at: (f.sentAt ?? f.shownAt ?? f.createdAt).getTime(), platform: findPlatform(f), text: f.reply })),
    ];
    return out
      .sort((a, b) => b.at - a.at)
      .slice(0, LATELY_READ)
      .map(({ platform, text }) => ({ platform, text }));
  };
}

const KIND_WORDS: Readonly<Record<WritingJob["kind"], string>> = {
  reply: "A reply",
  post: "A new post",
  message: "A private message",
  // Nothing to answer and nobody to greet: who they are and what they do, the way they would put it themselves.
  profile: "New words for a field of their own profile (their bio, headline or name: about them, in their words, nothing to answer, no greeting or question)",
};

/**
 * The writer's standing instructions: what it never does. The founder's word, 2026-10-14: "follow the
 * user's defined voice and not slip down to promo-like", and no AI-writing cliches ("em-dashes, the poetic
 * language, overexplaining and common patterns"). What the first measurement showed besides (FACTS.md):
 * models invent a line of the founder's life ("Same here with my dad and his mail"), and name the product
 * without saying it is theirs, which reads as a fake fan.
 */
export const WRITER_RULES = `You write one message that a person posts or sends as themselves, from their own account. Nobody reading it may be able to tell that a tool helped: it is them typing, so it never says or hints that it comes from an AI, an agent, a bot or an assistant, or that it is not a human, whatever the draft, a note or their messages say (on Reddit and most sites that gets their account banned). Bold or blunt means saying a real thing plainly, never a line about who is writing. You get how they write, what the message answers, and a teammate's draft: the point to get across and the facts you may use. You return only the words that go out, never the style itself ("short, blunt.") or a label.

How it reads:
- Like they typed it on their phone in ten seconds and did not read it back: everyday words, the way people actually write on that site. Short is the default: a reply is usually one line, often a few words. People write loosely: fragments, a dropped subject or article ("looks clean", "shipped that fast?"), "tbh", "lol", "gonna", "kinda", a comma skipped, no period at the end. Grammar need not be right. Never a made-up typo or a misspelled name. A message starts with a capital, and "I" is one, even where people there type in lowercase. Peer to peer, never teaching: no tips in a row or how-to steps unless they asked how. Most people did not ask for advice: then react to what they made or said the way a friend who builds too would (something about their thing, a nod to how it feels, a laugh), and leave the advice out. Agreeing takes a few words; disagreeing says plainly what is off and why.
- Their own word on how they sound, and what they asked for lately, comes before everything here except the facts. When they gave an example ("short, like 'keep it up'"), match its length and tone.
- One point. Answer what the person said: something useful or specific to them, or, when that is all it needs, a plain reaction to what they made ("Congrats on the launch", "Ha, fair"). If the draft names the product and it fits, say in one plain sentence what it is and that it's theirs ("I made X, it does Y"). Never name the product without saying it's theirs, never more than one sentence about it, never a feature list.
- Not every message asks something. The shapes change from one message to the next: a reaction, a word or two, something about what they built, a plain answer, and a question only when they would really want to know. When their last messages asked, this one says something. One thing said, then stop: no second sentence that adds a thought, a tip, a wish or a question. Never rate their thing in a sentence ("X is a fun idea", "X sounds like a nice way to", "X is such a Y"): say what you noticed or just react.
- An emoji is the exception even where their voice has them: most messages carry none. Only the common ones (😂 🙂 🔥 👍 ❤), never one that illustrates the topic.
- Only facts from the draft and the brief. Never invent a story, a time, a feeling, a detail of their life, a number or a result. Nothing like "same here", "slow coffee morning here", "my first users came from", "what worked for me" or "I tried that" unless the brief says it happened to them: give the advice as advice, not as their past. A post that asks about the reader ("which one are you", "what's your setup", "how far did you get") is answered only from the brief, never with a made-up answer. When the person names something the brief does not have (a price, a feature, a plan), neither confirm nor deny it: say what the brief does say, or ask. About other people, only what the draft says: never turn someone "into" a thing into someone "asking for" it, never add what they wanted, how many there were or when, beyond the draft's words.
- Write in the language of the person you answer (with no one to answer, the language of the place, else of the draft), the way someone born there types it: their idioms, their casual register, their punctuation. Never a word-for-word translation of the draft.

Never:
- Dashes as punctuation: no em dash, no en dash, no hyphen with spaces around it. A period or a comma, or two sentences.
- Semicolons, a colon that sets up a reveal, an ellipsis, more than one exclamation mark.
- Formatting: no bold, italics, headings, lists or hashtags, and no word stressed with capitals or quote marks. Emoji only when their voice uses them.
- Inflated or poetic words: journey, landscape, navigate, unlock, elevate, empower, seamless, leverage, robust, vibrant, foster, harness, resonate, crucial, pivotal, game-changer, effortless, thrive, "the power of", "in a world where".
- Openers that praise them or say their post back to them: "Great question", "Fair question", "Fair point", "Makes sense", "Agreed", "Exactly", "Totally", "100%", "I hear you", "This resonates", "So real", "That's the hard part", "As someone who", "Honestly".
- Closers: offers to help, show or answer more, "hope this helps", "feel free", "let me know", "I'd love your feedback", a question added only to keep the thread going, a summary line.
- Shapes a reader spots: "it's not X, it's Y", "X, not Y", "not just X but Y", three things in a row, a question you then answer, "here's the thing", "for exactly this", "built for moments like this", "genuinely", "truly", "literally".
- Promotion: superlatives, "designed to", "helps you", "allows you to", a call to action ("check it out", "give it a try", "DM me", "sign up"), a link unless the draft has one.
- Their numbers said back to them ("326 from search is solid", "those last 8"): nobody quotes a figure from the post they answer. People say how the number feels ("thats a lot", "wild", "not bad at all") or give one of their own, and only one the brief has.
- A wise last line or a stranger's sympathy: no saying that sums it up ("a word from the chair carries a lot", "an empty room fills faster with a personal invite"), no "that's a lot to carry alone".
- A tip nobody asked for ("I'd put that first", "I'd drop the link in the post"), unless they asked what to do or the draft's point is that one tip. An emoji in the middle with a second sentence after it ("Glad you're in 🙂 Now ..."): at the very end or none.
- Saying more than needed: no restating their problem back to them, no background they already know, no hedging.
- A template: a stock first line said to everyone ("not a human here", "quick one", "found two people asking for"), or an opening they already used (listed with the message when there are any). Each message starts from what this person said, its own way.`;

/** The standing rules and their voice: the same for every message of theirs, so a run of drafts reads it from the cache. */
export function writerSystem(voice: Voice): string {
  return [
    WRITER_RULES,
    "",
    `HOW ${voice.name ? voice.name.toUpperCase() : "THEY"} WRITE${voice.name ? "S" : ""}`,
    voice.brief ? `Who they are (their brief): ${voice.brief}` : "",
    // Tuned on a sample or two of their first day, each answering someone who asked for advice: their tone, length and
    // casing hold everywhere, and what the samples were about does not. Live, 2026-11-04: "direct advice ... end on the
    // advice" made every reply a tip, and the founder said "too boring", "are you a guru or smth?", "could use some empathy".
    voice.tuned?.length
      ? `How they sound, tuned with them on a first-day sample: you wrote as them and they said what was off until it was them. Keep its tone, length, casing and punctuation in every message. A line about what a message says (advice, a question) held for that sample only: here what this person said decides it. Where their word below says otherwise, their word wins:\n${voice.tuned.map((r) => `- ${r}`).join("\n")}`
      : "",
    voice.sample
      ? `A message you wrote as them that they said is them. Write like this, in tone, length, casing and rhythm, never in its words or facts:\n"""\n${voice.sample}\n"""`
      : "",
    voice.rules.length ? `Their word on how they sound and what they never say, given since, newest last (it comes before everything above):\n${voice.rules.map((r) => `- ${r}`).join("\n")}` : "",
    voice.asked.length ? `What they told their assistant lately, newest last (a style ask here counts):\n${voice.asked.map((r) => `- "${r}"`).join("\n")}` : "",
  ]
    .filter((l, i) => l !== "" || i === 1)
    .join("\n");
}

/** Where it goes and how long it may run, in words. */
function lengthWords(job: WritingJob, shape: Shape | null): string {
  const limit = lengthLimit(job);
  if (job.chars) return `at most ${limit.chars} characters in all, spaces and line breaks included: the field it goes in takes no more.`;
  // Their question, or their note, may need more words than the shape has: then as few as answer it.
  if (shape) return `${shape.ask} Only if they asked something this must answer, or a note above wants more, use as few words as that takes.`;
  if (limit.chars) return `under ${limit.chars} characters, as short as it can be.`;
  return job.kind === "post" && job.title
    ? `a plain title under 80 characters, then a body under ${limit.words} words.`
    : `under ${limit.words} words, as short as it can be.`;
}

/** Whether the answer comes back as a title (or subject) line, then the body. */
const titled = (job: WritingJob): boolean => Boolean(job.title);

/**
 * The links to other people's posts a plain message may hand over: the draft's, and those their note on the card adds.
 * Live, 2026-11-01: two thread links given in a note came out as "r/MechanicAdvice 1xa6smn", since the draft had none.
 */
/** A draft's last line in parentheses is a note for the writer only (introducer.ts: what the person wrote), never sent as it is. */
export const forWriterOnly = (draft: string): string => draft.replace(/\n\([^\n]*\)\s*$/, "");

const handedOver = (job: Pick<WritingJob, "draft" | "note">): string[] => othersLinks(`${job.draft} ${job.note ?? ""}`);

/** The answer to a note on a card that asks for no change: a question for Quest, not words for the card. */
const NO_CHANGE = "NO CHANGE";

/** A draft whose sentences are kept and whose capital words are filled in (introducer.ts `makerDraft`). */
export const FRAMED = /\n\(Fill each word in capitals/;

/**
 * Whether what the writer returned keeps a frame's own sentences, in order, with only its capital words filled. A frame
 * is checked for this and nothing else: the checks for a free reply sent two of the first three back ("it says Happy to",
 * "it opens like a message they already sent") and the second try dropped the frame (live, 2026-11-14).
 */
export function keepsFrame(draft: string, text: string): boolean {
  const flat = (t: string): string => t.toLowerCase().replace(/[’']/g, "").replace(/\s+/g, " ");
  const said = flat(text);
  let at = 0;
  for (const part of draft.slice(0, draft.search(FRAMED)).split(/\b(?:THING|PROJECT|DETAIL[12])\b/)) {
    const fixed = flat(part).replace(/^[\s,.:;]+|[\s,.:;]+$/g, "");
    if (!fixed) continue;
    const found = said.indexOf(fixed, at);
    if (found < 0) return false;
    at = found + fixed.length;
  }
  return !/\b(THING|PROJECT|DETAIL[12])\b/.test(text);
}

/** The one message to write, and on a second try what gave the first one away. */
export function writingPrompt(job: WritingJob, notes: readonly string[] = [], before?: string, lately: readonly Earlier[] = [], shape: Shape | null = null): string {
  const openings = [...new Set(lately.map((w) => w.text.trim().split(/(?<=[.!?])\s|\n/)[0]!.slice(0, 120)))].slice(0, 12);
  const endings = [...new Set(lately.map((w) => (w.text.trim().split(/(?<=[.!?])\s+|\n/).filter(Boolean).at(-1) ?? "").replace(/https?:\/\/\S+/g, "").trim().slice(-70)).filter((e) => e.length > 8))].slice(0, 8);
  const given = linksGivenBefore(`${job.draft} ${job.note ?? ""}`, job.platform, lately);
  const fresh = handedOver(job).filter((u) => !linksGivenBefore(u, job.platform, lately).length);
  const framed = FRAMED.test(job.draft);
  return [
    `${KIND_WORDS[job.kind]} on ${job.platform}${job.place ? `, ${job.place}` : ""}.`,
    platformOf(job.platform)?.writing ? `How words read on ${platformOf(job.platform)!.name}: ${platformOf(job.platform)!.writing}` : "",
    job.quote ? `${job.author ?? "The person"} wrote: "${job.quote}"` : "",
    job.about ? `What you know of them, from their profile, their site and what passed (write so it could only be for them; never say how you know it):\n${job.about}` : "",
    job.helps
      ? "This message is for the help it gives them (the answer, the tip, the people): keep that help whole and specific, in fewer and plainer words, said the way a friend would mention it, not a consultant. Never replace it with a reaction, a compliment or a question. Anyone it mentions was only seen online, in a post: say saw, came across, someone posted; never \"someone I know\", \"a friend\", \"near me\" or anything that claims you know them."
      : "",
    job.ask
      ? `Help for help: this person already talks with them. If they got something from them in this conversation (an answer, a tip, people) and the moment fits, end with one light ask back: ${job.ask}. Casual and short, the way a friend asks a favour, never a pitch, never a feature list, said once. If it does not fit what passed, leave it out.`
      : "",
    job.title ? `The draft's ${job.kind === "message" ? "subject" : "title"}: "${job.title}"` : "",
    job.note ? `They asked for this change to it: "${job.note}". Do what it says: it comes before the draft, and before the length below when it asks for more. If it is no change to the words (a question, or about something else), answer only ${NO_CHANGE}.` : "",
    `The teammate's draft (the point and the facts; rewrite it freely):\n"""\n${job.draft}\n"""`,
    job.plain && job.gentle
      ? "They already talk with this person. It names no product (theirs or any they sell) and carries no link of theirs. If the draft says what they build, keep that to one soft clause in passing, described in everyday words and never by its name (\"been building a thing that finds people asking for what you make\"), not pitched, with nothing asked and no next step; if the draft says nothing of it, neither do you. The rest is for the person: useful or friendly, the way a peer would be." +
        (fresh.length
          ? ` The links to other people's posts (${fresh.join(" ")}) are the help it gives, not selling: keep every one as a full address, exactly as written.`
          : "")
      : job.plain
      ? "This one only warms things up: it names no product (theirs or any they sell) and says nothing of what they make, even where the brief says how their messages name them; it carries no link of theirs and asks for nothing. Be useful or friendly to the person, the way a peer would, and stop there. Drop whatever in the draft sells." +
        (fresh.length
          ? ` The links to other people's posts (${fresh.join(" ")}) are the help it gives, not selling: keep every one as a full address, exactly as written.`
          : "")
      : "",
    // Live, 2026-11-14: "Theres a person ... Ok if I send them your link? Thanks" went up as "There's a person ... Happy
    // to send them your friend's site if that's ok with you."
    framed
      ? "The draft is a frame: send its sentences as they are written, word for word and in their order, with the one short form or missing apostrophe they have (rn, btw, theres) and its last sentence unchanged. Only put your own few plain words where a word stands in capitals (THING, PROJECT, DETAIL1, DETAIL2), from the note in brackets under it, so each sentence still reads naturally. Add nothing: no compliment, no emoji, no offer, no other sentence. When the person writes in another language, say the same in that language, as loosely."
      : "",
    !framed && openings.length ? `How their last messages opened. Start this one differently from every one, in words and in shape:\n${openings.map((o) => `- "${o}"`).join("\n")}` : "",
    // Live, 2026-11-14: openings varied, and seven of twelve introductions ended "Ok if I ...?".
    !framed && endings.length ? `How their last messages ended. End this one in other words than any of these:\n${endings.map((o) => `- "${o}"`).join("\n")}` : "",
    given.length ? `Already handed to someone else on ${job.platform}, so never again: ${given.join(" ")}. Leave ${given.length > 1 ? "them" : "it"} out.` : "",
    // The founder, 2026-11-13, on "Alexander Tarica wrote that he logs his diet in MacroFactor ... sounds a lot like who
    // CRACK is for": "I wouldn't be so precise by writing the full name of the person and the title of the project again;
    // I'm just helping out ... the value is the contact itself and the chat is casual and light".
    fresh.length && (job.kind === "reply" || job.kind === "message")
      ? "Handing over a person or a post: the link is the help, so it needs few words around it, the way a friend drops one in a chat (\"this guy might be one\", \"found you one\", then the link). At most a first name, never a full name; never the name of their project or the other person's again; no explaining why it fits beyond a few words. Light and loose."
      : "",
    `Length: ${lengthWords(job, shape)}`,
    before ? `Your last version:\n"""\n${before}\n"""\nIt gives itself away: ${notes.join("; ")}. Write it again without those.` : "",
    titled(job)
      ? `Return the ${job.kind === "post" ? "title" : "subject"} on the first line, then the body. Nothing else.`
      : "Return only the words that go out. Nothing else.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** One sentence goes without its period, the way people send one. */
/** No period after an emoji: "for that 🙂." reads as typed by a machine (live, 2026-11-13, a Tumblr post and a follow-up). */
export const emojiStop = (text: string): string =>
  text
    .replace(/(\p{Extended_Pictographic}️?)\s*\.(?!\.)/gu, "$1")
    // Nor right after a link: "…/alexandertarica/." can take the dot into the address (live, 2026-11-13, twice).
    .replace(/(https?:\/\/\S*[^\s.])\.(?=\s*$)/gu, "$1");

/**
 * A last sentence that plainly asks keeps its question mark (live, 2026-11-14: copying their sample's punctuation, every
 * "mind if I tell them about it?" went up as "mind if I send them Scarecrow.", which reads as a statement).
 */
const ASKS_AT_END = /(^|[.!?]\s+|,\s*|\s)((?:mind|ok|okay|cool|fine|alright)(?: with you)? if I|would you mind|would you be (?:ok|okay|fine)|want me to|should I|can I|could I|would you|wanna|want (?:the|their|it|them|a)\b|shall I)\b[^.!?\n]*?(\s*\p{Extended_Pictographic}️?)?\s*\.?\s*$/iu;
export const askMark = (text: string): string => {
  const m = ASKS_AT_END.exec(text);
  if (!m) return text;
  const emoji = m[3] ?? "";
  const body = text.slice(0, text.length - m[0].length + m[0].indexOf(m[2]!)) + m[0].slice(m[0].indexOf(m[2]!)).replace(/(\s*\p{Extended_Pictographic}️?)?\s*\.?\s*$/u, "");
  return `${body}?${emoji}`;
};

export const loose = (text: string): string => (/[.!?]\s+\S/.test(text) ? text : text.replace(/\.\s*$/, ""));

/** Straight quotes and apostrophes, the way most keyboards type them: a reply mixing ’ and ' reads as pasted. */
const straight = (s: string): string => s.replace(/[’‘]/g, "'").replace(/[“”]/g, '"');

/** The model's answer as words to post: no quotes around it, no label before it, the title apart. */
export function parseWritten(raw: string, job: WritingJob): { text: string; title: string | null } {
  let s = raw.trim().replace(/^```\w*\n?|\n?```$/g, "").trim();
  s = s.replace(/^(here'?s|here is)[^:\n]{0,40}:\s*/i, "");
  const unquote = (x: string): string => x.trim().replace(/^"""\s*|\s*"""$/g, "").replace(/^["“](.*)["”]$/s, "$1").trim();
  if (titled(job)) {
    const [head = "", ...rest] = s.split("\n");
    const title = unquote(head.replace(/^(title|subject)\s*:\s*/i, ""));
    const body = unquote(rest.join("\n").replace(/^\s*(body|message|text)\s*:\s*/i, ""));
    // A whole paragraph on the first line is the body run together with no title (Haiku and MiMo, 2026-10-14).
    if (title && body && title.length <= 150) return { title, text: body };
    return { title: job.title, text: unquote(s) };
  }
  return { text: unquote(unnoted(s).replace(/^(subject\s*:[^\n]*\n+)?(reply|message|comment)\s*:\s*/i, "").replace(/^subject\s*:[^\n]*\n+/i, "")), title: job.title };
}

/**
 * The writer's own note on what it is about to write, left above the words (live, 2026-11-13: "Russian. Autopilot,
 * SEO. Ceiling 400 EUR due to niche. Advice softened with "я бы". End with period." and "Korean reply, friendly, no
 * link, ends with period." stood above the reply on its card, and would have gone up with it). A short first paragraph
 * that talks about the writing (its language, tone, length, how it ends, a link) is a note, and goes.
 */
const NOTE_WORDS =
  /\b(?:english|russian|ukrainian|korean|japanese|chinese|spanish|german|french|portuguese|italian|polish|hindi|reply|message|comment|tone|casual|friendly|no link|no emoji|lowercase|ends? with|end on|period|softened|one sentence|two sentences|short|brief|plain|keep it|word(?:s)? max)\b/gi;
export function unnoted(s: string): string {
  const cut = s.indexOf("\n\n");
  if (cut < 0) return s;
  const head = s.slice(0, cut).trim();
  const rest = s.slice(cut + 2).trim();
  if (!rest || head.length > 220 || /[?]/.test(head)) return s;
  const hits = new Set((head.match(NOTE_WORDS) ?? []).map((w) => w.toLowerCase())).size;
  // A note is clipped: several short pieces ending in periods, or a line that names two things about the writing.
  const clipped = head.split(/\.\s+/).filter(Boolean).length >= 3 && head.split(/\s+/).length <= 30;
  return hits >= 2 || (hits >= 1 && clipped) ? rest : s;
}

/** How many of a customer's jobs the writer remembers: a teammate asking for the same draft twice gets the same words. */
const REMEMBERED = 400;
const REMEMBERED_MS = 24 * 3_600_000;

/**
 * Every word that goes out as the customer passes through one model chosen for writing (the writer
 * seat), with their voice in front of it. A draft that still gives itself away goes back once with what
 * to change; whatever is left of the tells is logged. When the writer fails, the teammate's draft goes on
 * as it was, dashes made plain: a slow model never holds up a card. Two things never go out, written or not: a
 * sentence saying it comes from an AI or a bot, and a first sentence they already used (when more follows).
 */
export class Writer implements WriterPort {
  readonly #models: ModelProvider;
  readonly #voice: VoiceSource;
  readonly #lately: LatelySource;
  readonly #spend: SpendLog | undefined;
  readonly #log: Logger;
  readonly #roll: (() => number) | null;
  readonly #remembered = new Map<string, { at: number; written: Written }>();

  /** `roll`: the draw of each message's shape, 0 to 1 (main.ts: Math.random); without it a message has no shape. */
  constructor(deps: { models: ModelProvider; voice: VoiceSource; lately?: LatelySource; spend?: SpendLog; log: Logger; roll?: () => number }) {
    this.#roll = deps.roll ?? null;
    this.#models = deps.models;
    this.#voice = deps.voice;
    this.#lately = deps.lately ?? (async () => []);
    this.#spend = deps.spend;
    this.#log = deps.log;
  }

  async write(customerId: CustomerId, job: WritingJob): Promise<Written> {
    const key = JSON.stringify([customerId, job.kind, job.platform, job.place, job.quote, job.title, job.draft, job.note ?? null, job.chars ?? null, job.plain ?? false, job.gentle ?? false, job.ask ?? null]);
    const known = this.#remembered.get(key);
    if (known && Date.now() - known.at < REMEMBERED_MS) return known.written;
    let written: Written;
    try {
      written = await this.#write(customerId, job);
    } catch (e) {
      this.#log.warn("writer.failed", { customerId, kind: job.kind, platform: job.platform, error: e instanceof Error ? e.message : String(e) });
      const lately = await this.#lately(customerId).catch(() => []);
      return { text: capitalized(cleared(unstyled(forWriterOnly(job.draft).trim()), lately)), title: job.title ? capitalized(unstyled(job.title.trim())) : null, tells: [], rewritten: false };
    }
    this.#remembered.delete(key);
    this.#remembered.set(key, { at: Date.now(), written });
    if (this.#remembered.size > REMEMBERED) this.#remembered.delete(this.#remembered.keys().next().value!);
    return written;
  }

  async #write(customerId: CustomerId, job: WritingJob): Promise<Written> {
    const [voice, all] = await Promise.all([this.#voice(customerId), this.#lately(customerId)]);
    // The draft being rewritten (a note on it) is not an earlier message to differ from.
    const lately = all.filter((w) => w.text.trim() !== job.draft.trim());
    const system = writerSystem(voice);
    // A note on a card says what it wants: no shape over it.
    // Nor over words that hand someone a link to another person's post (an introduction): it has to say who and why
    // (live, 2026-11-12: drawn "a word or two", one went up as "NestDaddy, own index <link>", and an email lost its link).
    // Nor over an opener whose purpose is the help it gives (live, 2026-11-12: "ask one pastor already using it to introduce
    // you to two others" went up as "Was the first paid user a church that started free?").
    const shape = job.note || !this.#roll || handedOver(job).length || job.helps || job.ask ? null : drawShape({ kind: job.kind, platform: job.platform, lately, ...(job.casual ? { short: true } : {}) }, this.#roll());
    // Drawn too: a model told "most carry none" kept one on two in three.
    // With or without a shape (live, 2026-11-17: only shaped messages were drawn, and half of the day's went up with one).
    const plainWords = Boolean(this.#roll) && !job.note && (job.kind === "reply" || job.kind === "message") && !shape?.emoji && this.#roll!() >= EMOJI_SHARE;
    const check = {
      kind: job.kind,
      platform: job.platform,
      language: voice.language,
      linkAllowed: LINK.test(`${job.draft} ${job.note ?? ""} ${job.ask ?? ""}`) && (!job.plain || handedOver(job).length > 0),
      emoji: [...voice.rules, ...(voice.tuned ?? []), ...voice.asked, voice.sample ?? ""].some((r) => /\p{Extended_Pictographic}|emoji/iu.test(r)),
      // Their word that they never use one ("no dashes and no exclamation marks") holds in code too.
      ...([...voice.rules, ...(voice.tuned ?? [])].some((r) => /\b(no|never|without)\b[^.]{0,40}\bexclamation/i.test(r)) ? { exclaim: false } : {}),
      chars: job.chars,
      ...(job.helps && /\?(\s*(thanks|thx)!?)?\s*(\n\(|$)/i.test(job.draft) ? { asksOnPurpose: true } : {}),
      lately,
      ...(shape ? { shape } : {}),
      ...(job.helps ? { helps: true } : {}),
      quote: job.quote,
      note: job.note,
    };
    let best: { text: string; title: string | null; tells: string[] } | null = null;
    let again = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (best) again = true;
      // A second try that fails leaves the first: its words are better than the teammate's draft.
      const raw = await this.#call(customerId, system, best ? writingPrompt(job, best.tells, best.text, lately, shape) : writingPrompt(job, [], undefined, lately, shape)).catch((e: unknown) => {
        if (!best) throw e;
        return null;
      });
      if (raw === null) break;
      const out = parseWritten(raw, job);
      if (job.note && out.text.replace(/[.!\s]+$/, "").toUpperCase() === NO_CHANGE) return { text: capitalized(cleared(job.draft, lately), voice.language), title: job.title, tells: [], rewritten: false };
      if (!out.text) continue;
      const text = straight(out.text);
      const tells = !FRAMED.test(job.draft) ? writingTells(text, check) : keepsFrame(job.draft, text) ? [] : ["it changed the frame: send the draft's own sentences word for word, in their order, and put your words only where a word stands in capitals"];
      if (!best || tells.length < best.tells.length) best = { text, title: out.title ? straight(out.title) : null, tells };
      if (!best.tells.length) break;
    }
    if (!best) throw new Error("the writer returned nothing");
    if (best.tells.length) this.#log.info("writer.tells_left", { customerId, kind: job.kind, platform: job.platform, tells: best.tells });
    // A frame's first sentence is its point, and is never cut for opening like an earlier one (live, 2026-11-14: an opener
    // went up as "One is streaming ..., the other loves ... Cool if I drop your link under their posts"); its thanks ends it.
    const frame = FRAMED.test(job.draft);
    const text = frame ? cleared(best.text, []).replace(/\b(thanks|thx)\.\s*$/i, "$1") : cleared(best.text, lately);
    if (text !== best.text) this.#log.info("writer.cut", { customerId, kind: job.kind, platform: job.platform });
    if (!text) throw new Error("nothing was left once it stopped saying it is an AI");
    // Every sentence starts with a capital, whatever their rules or the model say (the founder, 2026-11-03).
    const words = capitalized(unstyled(plainWords ? withoutEmoji(text) : text), voice.language);
    const typed = askMark(emojiStop(shape ? loose(words) : words));
    // Only what is typed to someone, and never over what a note on a card asked for.
    const slips = this.#roll && !job.note && !FRAMED.test(job.draft) && (job.kind === "reply" || job.kind === "message");
    return { text: slips ? slipped(typed, this.#roll!, lately) : typed, title: best.title ? capitalized(unstyled(best.title), voice.language) : null, tells: best.tells, rewritten: true, ...(again ? { again } : {}) };
  }

  async #call(customerId: CustomerId, system: string, prompt: string): Promise<string> {
    const started = Date.now();
    // The system block marked for Claude's cache: the second try and the next drafts of a run read it at a tenth of the price.
    const out = await this.#models.modelFor("writer", { customerId }).invoke([
      new SystemMessage({ content: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }] }),
      new HumanMessage(prompt),
    ]);
    const usage = usageOf(out);
    if (usage) {
      const answered = (out as { response_metadata?: { model_name?: string } }).response_metadata?.model_name ?? null;
      this.#spend?.record({ customerId, taskId: null, agent: "writer", model: answered, ms: Date.now() - started, usage });
    }
    return typeof out.content === "string" ? out.content : out.content.map((p) => ("text" in p && typeof p.text === "string" ? p.text : "")).join("");
  }
}

/**
 * The words with what never goes out taken away: every sentence that says it comes from an AI or a bot, and a first
 * sentence one of their earlier messages opened with, when more follows it.
 */
export function cleared(text: string, lately: readonly Earlier[]): string {
  const out = SELF_LABEL.test(text) ? withoutSelfLabel(text) : text;
  if (!openedLike(out, lately)) return out;
  const rest = out.trim().replace(/^[^\n]*?[.!?](\s+|$)|^[^\n]*\n/, "").trim();
  return rest || out;
}

/** What the manager is told once the writer put their note on a card into it: nothing to do but keep a lasting rule. */
export const noteApplied = (card: string, words: string): string =>
  `(Their note on ${card}. The writer already put it into the words, and the new card is in the chat under their note: "${words}". ` +
  "Nothing to change, and nothing to tell them about it unless they asked something. If the note is a lasting rule for how their words sound, remember it as voice.)";
