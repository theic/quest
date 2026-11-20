import { bareHandle, type CustomerId, type Logger, type PostSearch } from "@mq/core";
import { contactSite, handleOf } from "../contacts/handles.ts";
import type { KeptPair, KnownPeople, SidedPost } from "../infra/pg-known.ts";
import type { Loop } from "../lifecycle/idle-sleeper.ts";
import { answeredThere, hobby, needsCustomers, sells, type PairFinder } from "./pair-finder.ts";

/**
 * Introductions by code (the founder, 2026-11-12: "it must connect at least 100 people per day", and "both much more
 * targeted and selective and at the same time process much more people"). A run of the outreach teammate brought one or
 * two pairs together in ten minutes of model steps, and the rest of what the matcher found was lost. Here the matcher
 * runs on a clock, every pair is kept (mq.pairs), and each person who can be answered where they posted gets the
 * introduction as a reply written by the writer, with no run: the two posts are already read, and the reply is one line
 * that points to the other. Whoever is on a site that is read only is left to a run, which finds where else they are.
 * Every draft goes through DraftService.offer, so one reply per post, the day limits, trust and the outbox's pace hold.
 */

/** How often the matcher looks again for each customer. */
export const MATCH_EVERY_MS = 12 * 60_000;
/** How many makers are written to at a look, each with the people found for them. */
const MAKERS_A_LOOK = 3;
/** With this many introductions waiting to go up, no more are written: the outbox's pace is the limit. */
const WAITING_MAX = 20;
/**
 * Everyday words of the Latin-script languages Quest speaks (en, pt, es, fr, de): a Latin post with fewer than two of one
 * is in a language nobody reads here (live, 2026-11-13: a reply went out in Italian). The founder, 2026-11-14: "Use other
 * languages more, from the 10 we do support", so Russian, Ukrainian, Chinese, Hindi and Arabic go by their script.
 */
const LATIN_WORDS: readonly RegExp[] = [
  /\b(the|and|is|are|you|my|for|with|this|that|it|on|of|to|just|out|now|we|our|your|have|from|i|a|an|in|at|be|do|so|if|me|im|i'm|it's|can|any|anyone|got|get|want|need|love|what|how|who|using|built|made|looking|new|free|like|has|was|will|about|into|through|lmk|see|which|all|one|more|by|or|not|here|there)\b/g,
  /\b(que|não|uma|para|com|você|isso|meu|minha|está|são|também|mais|muito|fiz|lancei)\b/g,
  /\b(que|una|para|con|está|esto|mi|los|las|pero|también|muy|hice|lancé|busco)\b/g,
  /\b(le|les|des|une|est|pour|avec|je|vous|mon|ma|mais|très|pas|sur|j'ai)\b/g,
  /\b(und|ist|ich|nicht|das|ein|eine|mit|für|auf|mein|aber|sehr|habe|wir)\b/g,
];
/** Scripts of the other five: Cyrillic (ru, uk), Han (zh), Devanagari (hi), Arabic (ar). */
const OTHER_SCRIPTS = /[\p{Script=Cyrillic}\p{Script=Han}\p{Script=Devanagari}\p{Script=Arabic}]/gu;

/** Whether a post is in one of the ten languages Quest speaks. */
export function spoken(text: string): boolean {
  const l = text.replace(/[^\p{L}]/gu, "");
  if (!l.length) return true;
  const other = (l.match(OTHER_SCRIPTS) ?? []).length;
  const latin = (l.match(/\p{Script=Latin}/gu) ?? []).length;
  if (other / l.length > 0.5) return true;
  if (latin / l.length < 0.7) return false;
  const low = text.toLowerCase();
  // A short post or a launch's title has few everyday words (live, 2026-11-15: 69 of 117 pairs in a day were dropped as
  // another language, nearly all English: "Omg I love rhythm games", "Show HN: Minute – An Offline Meeting Notetaker").
  const need = low.split(/\s+/).filter(Boolean).length < 12 ? 1 : 2;
  return LATIN_WORDS.some((re) => (low.match(re) ?? []).length >= need);
}
/** With this many waiting on Bluesky, makers there wait and the look writes to makers elsewhere. */
const BLUESKY_WAITING = 2;
/** With this many waiting on any one site, makers there wait for a later look. */
const SITE_WAITING = 3;
/** How many more may wait for makers on other sites than Bluesky. */
const WAITING_ELSEWHERE = 12;

/** Whether code can answer someone under their post: a site with replies, and a post with an address of its own. */
const byCode = (p: SidedPost): boolean =>
  answeredThere(p) && !p.source.startsWith("web") && !/(^|\/\/)(t\.me|web\.telegram\.org)\//.test(p.url) && !/recent-activity/.test(p.url) && Boolean(p.author);

const words = (p: SidedPost, max: number): string => [p.title, p.text].filter(Boolean).join(". ").replace(/\s+/g, " ").trim().slice(0, max);
/** Fewer than eight words of their own once links and handles are left out. */
const saysLittle = (p: SidedPost): boolean => words(p, 600).split(/\s+/).filter((w) => w && !/^(https?:\/\/|www\.|@)|\.\w{2,}\//.test(w) && /\p{L}/u.test(w)).length < 8;

/** A few of their own words to answer under. */
const quoteOf = (p: SidedPost): string => words(p, 160);

const nameOf = (p: SidedPost): string => (p.author ? (p.author.includes("@") || p.author.includes(" ") ? p.author : `@${p.author}`) : "someone");

/** One of several, drawn: a model handed the same draft every time settles on one reply (the founder, 2026-11-13: "don't use a single message template for each person"). */
const pick = <T>(list: readonly T[], roll: () => number): T => list[Math.min(list.length - 1, Math.floor(roll() * list.length))]!;

/**
 * Words first, the link once they answer (the founder, 2026-11-13: "introduce in words first, link after they answer ...
 * Be genuine, like: I think I've seen a post or two from someone looking for this, do you need?"). Over a day, 111
 * introductions with a stranger's link brought about 5 answers, a plain word 3 of 40. The link goes in the plan
 * (`Links:`), and the reply watch's next step hands it over (`linkStep`).
 */
export const WORDS_FIRST = true;

/** What the writer starts from, to someone who asked: that someone made such a thing, and an offer to send it. */
export function askerDraft(pair: KeptPair, roll: () => number = Math.random): string {
  if (WORDS_FIRST)
    return pick(
      [
        "I think I saw someone launch pretty much this a few days ago, want me to send it?",
        "pretty sure I came across a post this week from someone who built a thing for exactly this. want the link?",
        "not sure if you found one yet, but someone I saw recently made something like that. should I dig it up?",
        "funny, I think someone shipped something close to this the other day. want me to send it over?",
        "might be late on this, but I'm fairly sure I saw a maker post about building just this. want it?",
      ],
      roll,
    );
  const who = nameOf(pair.launch);
  const said = words(pair.launch, 140);
  const url = pair.launch.url;
  return pick(
    [
      `${who} made just this, posted it this week: "${said}" ${url}`,
      `saw this today and thought of your post, by ${who}: "${said}" ${url}`,
      `not sure if you found one yet, ${who} just put this out: "${said}" ${url}`,
      `${url} this is ${who}'s, a few days old, sounds like what you described: "${said}"`,
      `might be late on this but ${who} built something for it: "${said}" ${url}`,
    ],
    roll,
  );
}

/** The links a plan keeps to hand over once they answer, or none. */
export const linksOf = (plan: string | null | undefined): string[] => (/Links:\s*([^\n]+)/.exec(plan ?? "")?.[1] ?? "").split(/\s+/).filter((u) => /^https?:\/\//.test(u));

/** Someone a maker said yes to being introduced to: their post, who wrote it, a few of their words. */
export interface Introduce {
  readonly url: string;
  readonly author: string;
  readonly quote: string;
  /** The maker's launch, and their handle where both are on one site. */
  readonly launch: string;
  readonly maker: string | null;
  /** What the launch says, for a word on what theirs is. */
  readonly made?: string;
  /**
   * Whether they asked for such a thing. Only then does the maker's link go under their post; someone who only showed
   * the need is on the maker's page as "might fit" and is never written to (the founder, 2026-11-18: "Yes, only those").
   * A plan from before keeps none: mq.pairs says, and nobody it does not know is written to.
   */
  readonly asked?: boolean;
}

/** The plan line for one introduction to make once the maker says yes. */
export const introduceLine = (i: Introduce): string => `Introduce: ${JSON.stringify(i)}`;

/** The introductions a maker's plan keeps, or none. */
export const introsOf = (plan: string | null | undefined): Introduce[] =>
  [...(plan ?? "").matchAll(/^Introduce: (\{.*\})$/gm)].flatMap((m) => {
    try {
      const i = JSON.parse(m[1]!) as Introduce;
      return typeof i.url === "string" && typeof i.author === "string" && typeof i.quote === "string" && typeof i.launch === "string" ? [i] : [];
    } catch {
      return [];
    }
  });

/** Under the person's post, once the maker said yes: who made what they were after. */
export function introductionDraft(i: Introduce, roll: () => number = Math.random): string {
  const who = i.maker ? `@${i.maker.replace(/^@/, "")}` : "someone";
  const note = i.made ? `\n(what theirs is, to say in a few words where it fits what this person wants: "${i.made}")` : "";
  return (
    pick(
      [
        `${who} just launched one, might be what you need ${i.launch}`,
        `Not sure if you found one yet, ${who} built this ${i.launch}`,
        `This might be it, ${who} made it ${i.launch}`,
        `${who} made one for exactly this btw ${i.launch}`,
        `Saw this today, ${who} just put it out, sounds like what you were after ${i.launch}`,
      ],
      roll,
    ) + note
  );
}

/** Back to the maker: it's done, with where. */
export function doneDraft(urls: readonly string[], name: string | null = null, roll: () => number = Math.random): string {
  const all = urls.join(" ");
  const done = urls.length > 1 ? pick([`Done, both here: ${all}`, `Sent, here ${all}`, `Did it, under their posts ${all}`], roll) : pick([`Done, here: ${all}`, `Sent it, here ${all}`, `Did it ${all}`], roll);
  // Who is writing, once they said yes (the founder, 2026-11-14: "I'm Serhii, btw. I use my automation to find users on socials").
  const me = name
    ? pick([`I'm ${name} btw. I use my automation to find users on socials`, `Im ${name} btw, I find users on socials with my own automation`, `${name} here btw. I use an automation of mine to find users on socials`], roll)
    : pick(["I use my automation to find users on socials btw", "Btw I find users on socials with my own automation"], roll);
  return `${done}\n${me}`;
}

/** How many people a maker's link goes to on one yes: the ones they were told of, and more found for them then. */
export const MATCH_MAX = 6;

/**
 * Everyone a maker's link goes to once they said yes (the founder, 2026-11-17: "I want it to provide more then one lead
 * - if person agrees, let Quest do match with multiple people at once"): the people their opener named, whoever else was
 * paired with the launch since, and one more search for it. Only people who can be answered where they posted, in a
 * language Quest speaks, who said enough, each once, and nobody already written to.
 */
export async function everyoneFor(
  intros: readonly Introduce[],
  deps: { readonly kept: (launchUrl: string) => Promise<readonly KeptPair[]>; readonly more: (launch: SidedPost) => Promise<readonly { readonly ask: SidedPost }[]>; readonly written: (author: string) => boolean },
): Promise<Introduce[]> {
  const first = intros[0];
  if (!first) return [];
  const kept = await deps.kept(first.launch).catch(() => []);
  const launch = kept[0]?.launch;
  const more = launch ? await deps.more(launch).catch(() => []) : [];
  const site = contactSite(first.launch);
  const maker = handleOf(first.launch);
  const name = (s: string | null | undefined): string => (s ?? "").trim().replace(/^@/, "").toLowerCase();
  const seen = new Set(intros.flatMap((i) => [i.url, name(i.author)]));
  const extra: Introduce[] = [];
  // Whether each asked, as the judge said when the pair was made.
  const askedAt = new Map(kept.map((k) => [k.ask.url, k.ask.tell !== false]));
  for (const p of [...kept.map((k) => k.ask), ...more.map((m) => m.ask)]) {
    if (!p.author || seen.has(p.url) || seen.has(name(p.author)) || name(p.author) === name(launch?.author)) continue;
    if (!byCode(p) || !spoken(words(p, 200)) || saysLittle(p) || needsCustomers(p) || deps.written(p.author)) continue;
    seen.add(p.url).add(name(p.author));
    extra.push({ url: p.url, author: p.author, quote: quoteOf(p), launch: first.launch, maker: site && maker && contactSite(p.url) === site ? maker : null, ...(first.made ? { made: first.made } : {}), asked: p.tell !== false });
  }
  // Whoever asked first: they are the ones the link goes to.
  const all = [...intros.map((i) => ({ ...i, asked: i.asked ?? askedAt.get(i.url) ?? false })), ...extra];
  return [...all.filter((i) => i.asked), ...all.filter((i) => !i.asked)].slice(0, MATCH_MAX);
}

/**
 * The people a page lists for someone who was not introduced to anybody (they left a link under a thread, or asked for
 * a page): whoever asked first, each once, in a language Quest speaks, with enough of their own words.
 */
export function pagePeople(found: readonly { readonly ask: SidedPost }[], maker: string): { author: string; quote: string; url: string }[] {
  const name = (s: string | null | undefined): string => (s ?? "").trim().replace(/^@/, "").toLowerCase();
  const seen = new Set<string>([name(maker)]);
  const kept = found.map((f) => f.ask).filter((p) => p.author && !seen.has(name(p.author)) && seen.add(name(p.author)) && spoken(words(p, 200)) && !saysLittle(p) && !needsCustomers(p));
  return [...kept.filter((p) => p.tell !== false), ...kept.filter((p) => p.tell === false)].slice(0, MATCH_MAX).map((p) => ({ author: p.author!, quote: quoteOf(p), url: p.url }));
}

/**
 * Back to the maker with their page: everyone their link went to, on one address of Quest's own, so nothing about the
 * product is said (the founder, 2026-11-17: "we don't have to mention messaging quest, because there will be a branded
 * link on the page"). Goes as written.
 */
export function pageDraft(link: string, people: number, name: string | null = null, roll: () => number = Math.random, fits = 0): string {
  const n = people === 1 ? "1 person" : `${people} people`;
  const signed = (said: string): string => (name ? `${said}\n${pick([`I'm ${name} btw`, `${name} here btw`], roll)}` : said);
  // Nobody asked for such a thing, so nobody was written to: the page is the people and their posts, theirs to say hi to.
  if (!people) return signed(pick([`Put them on a page for you, with their posts: ${link}`, `Here they are with their posts ${link}`, `Made you a page with who they are and what they posted ${link}`], roll));
  if (fits) return signed(pick([`Done, sent your link to ${n} who asked. They're on this page with ${fits} more who might fit: ${link}`, `Sent it to ${n} who asked for it, and put them on a page with ${fits} more who might fit ${link}`], roll));
  const done = pick(
    [
      `Done, sent your link to ${n}. All of them with their posts are here: ${link}`,
      `Sent it to ${n}, put them on a page for you ${link}`,
      `Did it, ${n} got your link. Made you a page with who they are and what they posted ${link}`,
      `Done. ${n === "1 person" ? "The person" : `All ${people}`} and their posts are on this page ${link}`,
    ],
    roll,
  );
  return name ? `${done}\n${pick([`I'm ${name} btw`, `${name} here btw`], roll)}` : done;
}

/** The last step, on their next answer whatever it says: the name, and the one ask back (the founder: "It is called Messaging Quest. Id really appreciate your feedback thanks!"). */
export function nameDraft(product: string, roll: () => number = Math.random): { readonly text: string; readonly ask: string } {
  return {
    // Where it lives is said with the name: only someone with Telegram can use it (the founder, 2026-11-14).
    text: pick([`It's called ${product}, it lives in Telegram.`, `Its called ${product} btw, a bot in Telegram.`, `The automation is ${product}, you talk to it in Telegram.`], roll),
    ask: pick(["say you'd really appreciate their feedback on it, and thanks", "ask if they'd give it a look and say what's off", "say you'd love their honest take on it, thanks"], roll),
  };
}

/** Step two of a words-first introduction: the link they said yes to. */
export function linkStep(links: readonly string[], roll: () => number = Math.random): string {
  const all = links.join(" ");
  return links.length > 1
    ? pick([`here you go ${all}`, `sure, these two ${all}`, `${all} both from this week`, `here they are ${all}, hope one of them works out`], roll)
    : pick([`here you go ${all}`, `sure, this one ${all}`, `${all} this is it, posted a few days ago`, `found it ${all}`], roll);
}

/** To the one who made it: the people found for them, in one reply (Bluesky's 300 characters hold two links). */
export function makerDraft(pairs: readonly KeptPair[], roll: () => number = Math.random): string {
  if (WORDS_FIRST) {
    // Who is on the other side is said at once (the founder, 2026-11-14: "Quest must already know who is on the other
    // side ... share some information from the posts it found in the opener and ask if the founder would like to connect
    // with those, like Boardy": "Hey, there is two people looking for budgeting app right now, one from the US. Is it ok
    // if I send your link over? Thanks"). The frame is drawn here, with one everyday shortener in its first sentence; the
    // writer fills the capital words from the posts.
    const told = pairs.slice(0, /bsky.app/.test(pairs[0]!.launch.url) ? 2 : 3);
    const many = told.length > 1;
    // Only what they said: people who asked for such a thing are "looking for" it; people who only show they like the kind
    // would "be into" it (live, 2026-11-13: two nonogram players were told to a maker as "asking for a nonogram").
    const asked = told.some((p) => p.ask.tell === true);
    const w = told.length === 2 ? "two" : "three";
    const other = told.length === 2 ? "the other" : "another";
    // One thought, said by someone glad to connect people (the founder, 2026-11-14, on "Letterboxd for gigs, nice. Two
    // people posting concert history memes rn, ...": "The first two sentences feel like glued together. Hey I can help
    // her do an introduction to two people I just found browsing, I just naturally happy to help"). Whom was found and
    // what each said run on in one sentence; the offer is the second. About one in three starts from their project.
    const project = roll() < 0.35;
    const each = many ? `one DETAIL1 and ${other} DETAIL2` : "they DETAIL1";
    const lead = project
      ? pick(
          many
            ? asked
              ? [`Hey, saw PROJECT and it made me think of ${w} people I just came across, ${each}.`, `Hey, PROJECT is just what ${w} people I ran into today are after, ${each}.`]
              : [`Hey, saw PROJECT and it made me think of ${w} people I just came across, ${each}.`, `Hey, PROJECT is something ${w} people I ran into today would love, ${each}.`]
            : asked
              ? [`Hey, saw PROJECT and it made me think of someone I just came across, ${each}.`, `Hey, PROJECT is just what someone I ran into today is after, ${each}.`]
              : [`Hey, saw PROJECT and it made me think of someone I just came across, ${each}.`, `Hey, PROJECT is something a person I ran into today would love, ${each}.`],
          roll,
        )
      : pick(
          many
            ? asked
              ? [
                  `Hey, just ran into ${w} people looking for THING, ${each}.`,
                  `Hey, was browsing and found ${w} people asking for THING rn, ${each}.`,
                  `Hey, I think I can introduce you to ${w} people I just found looking for THING, ${each}.`,
                  `Hey, ${w} people I came across today are after THING, ${each}.`,
                ]
              : [
                  `Hey, just ran into ${w} people who'd love THING, ${each}.`,
                  `Hey, was browsing and found ${w} people who'd be into THING, ${each}.`,
                  `Hey, I think I can introduce you to ${w} people I just found who'd be into THING, ${each}.`,
                ]
            : asked
              ? ["Hey, just ran into someone looking for THING, they DETAIL1.", "Hey, was browsing and found someone asking for THING rn, they DETAIL1.", "Hey, I think I can introduce you to someone I just found looking for THING, they DETAIL1."]
              : ["Hey, just ran into someone who'd love THING, they DETAIL1.", "Hey, was browsing and found someone who'd be into THING, they DETAIL1.", "Hey, I think I can introduce you to someone I just found who'd be into THING, they DETAIL1."],
          roll,
        );
    // Two in three go without the "Hey," (the founder, 2026-11-15: "our strategy starts to feel like a template again").
    const opening = roll() < 0.66 ? lead.replace(/^Hey, ([a-z])/i, (_, c: string) => c.toUpperCase()) : lead;
    const posts = many ? "posts" : "post";
    // Someone who only showed the need is never written to, so the offer is their posts, not the maker's link under them.
    const close = !asked
      ? pick(["Want me to send you their posts?", `Happy to pass their ${posts} along, want ${many ? "them" : "it"}?`, "Can put them on a page for you if you want?"], roll)
      : pick(
      [
        "Happy to connect you, ok if I send them your link?",
        "Would love to introduce you, can I send them your link? Thanks",
        "Glad to point them your way, is it ok if I send your link over?",
        "Want me to send them your link?",
        `I'd love to connect you, mind if I drop your link under their ${posts}?`,
      ],
      roll,
    );
    const said = told.slice(0, 2).map((p, i) => `DETAIL${i + 1}, from the ${i ? "second" : "first"} person's post: "${words(p.ask, 140)}"`);
    const fill = [
      project ? `PROJECT: their thing by what it does, one specific point from their launch, four to seven words: "${words(pairs[0]!.launch, 160)}"` : `THING: what they made, as two to four plain words with "a" or "an", from their launch: "${words(pairs[0]!.launch, 160)}"`,
      ...said,
    ].join("; ");
    return `${opening} ${close}\n(Fill each word in capitals in your own few plain words and keep the frame around them, its short forms too: ${fill}. A detail is what that person wants or is stuck on, worded to read on after "one" or "they" ("wants ...", "is stuck on ...", "just asked for ..."), and where they are only if their post says it; never quoted whole, never who they are.)`;
  }
  const people = pairs.slice(0, /bsky.app/.test(pairs[0]!.launch.url) ? 2 : 3);
  const first = people[0]!.ask;
  const links = people.map((p) => p.ask.url).join(" ");
  // That more will come is said to one maker in three, each time in other words.
  const closing = roll() < 0.34 ? pick([" (I keep running into people who want things like this, will send them your way)", " (will pass along more when I see them)", " (if more turn up I'll drop them here)"], roll) : "";
  const body =
    people.length === 1
      ? pick(
          [
            `this person would be into what you made, they said: "${words(first, 120)}" ${first.url}`,
            `"${words(first, 110)}" ${first.url} someone said this the other day, thought of it reading your post`,
            `${first.url} this one is looking for pretty much what you built: "${words(first, 100)}"`,
            `nice detail in what you made: "${words(pairs[0]!.launch, 70)}". someone who wants it: "${words(first, 90)}" ${first.url}`,
          ],
          roll,
        )
      : pick(
          [
            `found a few people who would be into what you made: ${links} the first one said: "${words(first, 100)}"`,
            `"${words(first, 90)}" that is the first of these, both sound like who you made this for: ${links}`,
            `${links} people I saw this week talking about exactly this`,
            `nice detail in what you made: "${words(pairs[0]!.launch, 70)}". these would want it ${links}`,
          ],
          roll,
        );
  return body + closing;
}

/**
 * Step two of a maker's plan, when they answer the people sent to them: what the customer does, in passing, with no name
 * and no link, and an offer of more. Written by code (live, 2026-11-13: of ten who answered overnight the manager
 * replied to one, with a joke, and told the customer of the rest). The writer rewrites it in their voice.
 */
export function stepTwoDraft(roll: () => number = Math.random): string {
  return pick(
    [
      // Three in five end on the permission close (live, 2026-11-15: about 120 answered in a week and 5 heard of the
      // product, since every form here offered more people and none offered the thing itself).
      // Since 2026-11-18 two of them offer a page instead: people for what they built, on an address of their own, whose
      // button is the way on. A page is easier to say yes to than a link to a product (10 of 149 who answered heard any offer).
      "glad it landed. finding people who want what someone built is most of what I do these days. I can put a few more of them on a page for you, want one?",
      "anytime. I keep an eye out for people asking for stuff like yours, kind of my thing lately. can drop more here when I see them",
      "good to hear. this is basically what I work on, a thing that matches makers with the people already asking for what they made. want a page of them for yours?",
      "nice. I spend my days digging up people who want what founders made, so there's more where that came from if you want them",
      "cool, hope they turn into users. I'm building something that does this digging for founders daily, so I see a lot of these. it's free to try, want the link?",
    ],
    roll,
  );
}

export interface IntroducerDeps {
  readonly online: () => readonly CustomerId[];
  /** On, let in, not resting, the models not resting: whether anything may be written for them now. */
  readonly allowed: (customerId: CustomerId) => Promise<boolean>;
  readonly pairs: Pick<PairFinder, "find">;
  readonly posts: (customerId: CustomerId) => PostSearch;
  readonly known: Pick<KnownPeople, "openPairs" | "takePair" | "askerTold">;
  readonly drafts: { offer(customerId: CustomerId, request: { platform: "browser"; kind: "reply"; url: string; target: string; text: string; quote: string; author: string | null; helps?: boolean; cold?: boolean }): Promise<string | { draft: { id: string }; alone: boolean }> };
  /** The customer's record of people: a maker who was sent people is kept as helped, with the steps that follow. */
  readonly people?: { keep(customerId: CustomerId, check: { site: string; handle: string; name: string | null; profileUrl: string; siteUrl: string | null; about: string; needs: string | null; canGive: string | null; gave: string | null; note: string | null }): Promise<unknown> };
  /** What names the customer in a handle or an address (their name, their site's), squashed: their own posts are nobody to introduce. */
  readonly theirs?: (customerId: CustomerId) => Promise<readonly string[]>;
  /** How many of their sends wait to go up. */
  readonly waiting: (customerId: CustomerId) => Promise<number>;
  /** How many more first words a site takes today (drafts: coldRoom); a maker on a site with none is left for a later look. */
  readonly room?: (customerId: CustomerId, url: string) => Promise<number>;
  /** How many of theirs wait to go up on one site. */
  readonly waitingOn?: (customerId: CustomerId, site: string) => Promise<number>;
  readonly now: () => Date;
  readonly log: Logger;
}

export class Introducer implements Loop {
  readonly #d: IntroducerDeps;
  readonly #matched = new Map<CustomerId, number>();
  #looks = 0;
  #timer: ReturnType<typeof setInterval> | null = null;
  #running: Promise<void> | null = null;

  constructor(deps: IntroducerDeps) {
    this.#d = deps;
  }

  get busy(): boolean {
    return this.#running !== null;
  }

  start(): void {
    this.#timer ??= setInterval(() => void this.tick(), 60_000);
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    await this.#running;
  }

  tick(): Promise<void> {
    this.#running ??= this.#look().finally(() => (this.#running = null));
    return this.#running;
  }

  async #look(): Promise<void> {
    for (const id of this.#d.online()) {
      await this.#one(id).catch((e: unknown) => this.#d.log.warn("intro.failed", { customerId: id, error: e instanceof Error ? e.message.slice(0, 200) : String(e) }));
    }
  }

  async #one(customerId: CustomerId): Promise<void> {
    const d = this.#d;
    if (!(await d.allowed(customerId))) return;
    const now = d.now().getTime();
    if (now - (this.#matched.get(customerId) ?? 0) >= MATCH_EVERY_MS) {
      this.#matched.set(customerId, now);
      await d.pairs.find({ customerId, posts: d.posts(customerId) });
    }
    // With the line full, makers on other sites than Bluesky are still written to: its line is the long one (most people found are there), and each site keeps its own pace.
    const waiting = await d.waiting(customerId);
    if (waiting >= WAITING_MAX + WAITING_ELSEWHERE) return;
    // Bluesky's own line is short (the founder, 2026-11-14: "Spread somewhat evenly across all platforms, I see a lot of
    // blue sky in the queue"): most makers found are there, so past a few waiting the look writes to makers elsewhere.
    const elsewhere = waiting >= WAITING_MAX || ((await d.waitingOn?.(customerId, "bsky.app").catch(() => 0)) ?? 0) >= BLUESKY_WAITING || this.#looks++ % 2 === 1;
    // The pairs by who made the thing: its maker hears of everyone found for them in one reply.
    const byMaker = new Map<string, KeptPair[]>();
    const names = ((await d.theirs?.(customerId).catch(() => [])) ?? []).filter((n) => n.length >= 5);
    const squash = (p: SidedPost): string => `${p.author ?? ""} ${p.url}`.toLowerCase().replace(/[^a-z0-9]/g, "");
    const own = (p: SidedPost): boolean => names.some((n) => squash(p).includes(n));
    // A language Quest does not speak: the writer answers in their language, and nobody could read it.
    const foreign = (p: SidedPost): boolean => !spoken(words(p, 200));
    // An account that reposts a feed is nobody to introduce (live, 2026-11-13: a Hacker News repost bot on Bluesky was written to as a launch's maker).
    const feed = (p: SidedPost): boolean => /newsyc|hacker[\s_-]?news|hn[\s_-]?(new|front|daily|bot)|(^|[^a-z])(bot|rss|digest|feed)([^a-z]|$)/i.test(`${p.author ?? ""} ${p.url}`);
    // With Bluesky's line full, the look asks for makers elsewhere: the first 30 open pairs were all Bluesky makers (live,
    // 2026-11-13: 124 of 147), so the 22 on Mastodon, LinkedIn and X waited behind them and nothing was written for an hour.
    for (const p of await d.known.openPairs(30, elsewhere ? "bsky.app" : undefined)) {
      if (feed(p.ask) || feed(p.launch)) {
        await d.known.takePair(p.id, customerId, "not written: an account that reposts a feed");
        continue;
      }
      if (own(p.ask) || own(p.launch) || foreign(p.ask) || foreign(p.launch)) {
        await d.known.takePair(p.id, customerId, own(p.ask) || own(p.launch) ? "not written: the customer's own post" : "not written: another language");
        continue;
      }
      // A post that says next to nothing in its own words is nobody to name as wanting a thing (live, 2026-11-13: a bare
      // link to a virtual arcade was paired with an arcade shooter, and its maker heard someone was "asking for" one).
      if (saysLittle(p.ask)) {
        await d.known.takePair(p.id, customerId, "not written: their post says too little in their own words");
        continue;
      }
      // A founder who says they need customers is the customer's own to help: a run checks them and finds them people.
      if (needsCustomers(p.ask)) {
        await d.known.takePair(p.id, customerId, "maker: not told; asker: needs customers, left for a run");
        continue;
      }
      // A maker with nobody to sell to is nobody to win (the founder, 2026-11-18: "Focus on ICP"; over a week the Bluesky
      // makers written to were mostly hobby game devs).
      if (hobby(p.launch)) {
        await d.known.takePair(p.id, customerId, "not written: a hobby project, nobody to sell to");
        continue;
      }
      byMaker.set(p.launch.url, [...(byMaker.get(p.launch.url) ?? []), p]);
    }
    // Only a maker someone asked for is written to (over a week 279 of 1,772 pairs were ones where the person asked, the
    // only ones a link may go to): a group where everyone only showed the need waits for someone who asks.
    for (const [launch, group] of byMaker) if (!group.some((p) => p.ask.tell === true)) byMaker.delete(launch);
    // A look writes to makers on different sites, so no site's line fills while the others stand empty.
    const host = (g: readonly KeptPair[]): string => contactSite(g[0]!.launch.url) ?? "";
    // No opener by code on Bluesky or Mastodon (live, 2026-11-15: at 130 and 40 unasked replies a day mastodon.social
    // suspended their account for spam and a Bluesky maker answered "What is your end game, bot?", while thirty makers who
    // had said yes heard nothing more). There, only the yeses already given are kept; openers go where people answered.
    // Since 2026-11-18 a few a day go there again (the founder: "all platforms, just in reasonable amounts"): the day's
    // room is asked of the drafts, so a maker on a site that is full waits instead of being spent on a refusal.
    const rooms = new Map<string, number>();
    const roomFor = async (u: string): Promise<number> => {
      const key = u.includes("bsky.app") ? "bsky" : /^https?:\/\/[^/]+\/@[^/]+\/\d{6,}/.test(u) ? "fedi" : (contactSite(u) ?? u);
      if (!rooms.has(key)) rooms.set(key, (await d.room?.(customerId, u).catch(() => 1)) ?? 1);
      return rooms.get(key)!;
    };
    const withRoom: KeptPair[][] = [];
    for (const g of byMaker.values()) if ((await roomFor(g[0]!.launch.url)) > 0) withRoom.push(g);
    // Sellers first: a price, a waitlist, customers in their own words.
    withRoom.sort((a, b) => Number(sells(b[0]!.launch)) - Number(sells(a[0]!.launch)));
    const open = withRoom.filter((g) => !elsewhere || !g[0]!.launch.url.includes("bsky.app"));
    const firsts = open.filter((g, i) => open.findIndex((o) => host(o) === host(g)) === i);
    // Bluesky answered least (live, three days to 2026-11-14: 9% of 200 people, mostly players; LinkedIn 40%, Threads 31%,
    // X 20%, mostly founders) and took half of all words: every other look passes it over, and a look writes to one maker there.
    let sky = 0;
    const turn = [...firsts, ...open.filter((g) => !firsts.includes(g))].sort((a, b) => Number(host(a) === "bsky.app") - Number(host(b) === "bsky.app")).filter((g) => host(g) !== "bsky.app" || sky++ < 1);
    // No site's line grows past a few (live, 2026-11-14: with Bluesky held to two, eleven openers for Mastodon makers
    // stood in line, over an hour of sends at its pace): a maker on a site with SITE_WAITING waiting is left for a later look.
    const lines = new Map<string, number>();
    for (const h of new Set(turn.map(host))) lines.set(h, (await d.waitingOn?.(customerId, h).catch(() => 0)) ?? 0);
    const roomy = turn.filter((g) => {
      const n = lines.get(host(g)) ?? 0;
      if (n >= SITE_WAITING) return false;
      lines.set(host(g), n + 1);
      return true;
    });
    for (const group of roomy.slice(0, MAKERS_A_LOOK)) {
      const maker = group[0]!.launch;
      const say = async (p: SidedPost, text: string): Promise<string> => {
        const out = await d.drafts.offer(customerId, { platform: "browser", kind: "reply", url: p.url, target: p.author!, text, quote: quoteOf(p), author: p.author, helps: true, cold: true });
        return typeof out === "string" ? `not drafted (${out.slice(0, 120)})` : `draft ${out.draft.id}${out.alone ? " going up" : " on a card"}`;
      };
      const toMaker = byCode(maker) ? await say(maker, makerDraft(group)) : `left for a run (${maker.source})`;
      // The maker is remembered with what was given and the next two steps, so their answer is met with a plan.
      const site = contactSite(maker.url);
      const handle = handleOf(maker.url) ?? bareHandle(maker.author ?? "");
      if (toMaker.startsWith("draft") && site && handle) {
        await d.people?.keep(customerId, {
          site, handle, name: null, profileUrl: maker.url, siteUrl: null,
          about: `Made and just launched: ${words(maker, 300)}`,
          needs: "first users for what they launched",
          canGive: "people who want what they built, found by matching posts",
          gave: WORDS_FIRST ? `told them people want what they built, asked if I may introduce them` : `${group.length} ${group.length === 1 ? "person" : "people"} who want what they built: ${group.map((p) => p.ask.url).join(" ")}`,
          note: WORDS_FIRST
            ? `Plan: 1. told them who is looking for what they built, asked if I may send those people their link. 2. when they say yes: their link under each one's post, then tell them it's done with the posts, and who I am.\n${group
                .slice(0, /bsky.app/.test(maker.url) ? 2 : 3)
                .filter((p) => byCode(p.ask))
                .map((p) => introduceLine({ url: p.ask.url, author: p.ask.author!, quote: quoteOf(p.ask), launch: maker.url, maker: contactSite(p.ask.url) === site ? handle : null, made: words(maker, 80), asked: p.ask.tell !== false }))
                .join("\n")}\n3. when they answer again: the name of what I use, and that I'd appreciate their feedback.`
            : "Plan: 1. sent them people who want it, asking nothing. 2. when they answer: that finding such people for founders is what the customer does all day, with a thing they are building (described, no name, no link), and offer a few more. 3. when they ask how: the name and the link, and an invitation to run it on their own product.",
        }).catch(() => undefined);
      }
      // A launch's link goes to one person: the writer never hands the same link to a second, and the words lose their point.
      let told = await d.known.askerTold(maker.url).catch(() => false);
      for (const pair of group) {
        // Someone who only showed the need is not written to: their maker has their post.
        const toAsker = pair.ask.tell === false ? "not told, only the maker" : told ? "not told: someone already got this launch" : /recent-activity/.test(maker.url) ? "not told: the launch has no address of its own" : !byCode(pair.ask) ? `left for a run (${pair.ask.source})` : WORDS_FIRST ? "not told yet: the maker is asked first" : await say(pair.ask, askerDraft(pair));
        if (toAsker.startsWith("draft")) told = true;
        // Whoever asked is kept with the link they were offered, for when they say yes.
        const askSite = contactSite(pair.ask.url);
        const askHandle = handleOf(pair.ask.url) ?? bareHandle(pair.ask.author ?? "");
        if (WORDS_FIRST && toAsker.startsWith("draft") && askSite && askHandle)
          await d.people?.keep(customerId, {
            site: askSite, handle: askHandle, name: null, profileUrl: pair.ask.url, siteUrl: null,
            about: `Asked for: ${words(pair.ask, 300)}`,
            needs: "a tool for what they asked about",
            canGive: "someone who just made it",
            gave: "told them someone made what they asked for, offered the link",
            note: `Plan: 1. said someone made what they asked for, offered the link. 2. when they answer: the link. Links: ${maker.url}\n3. when they answer again: a word, and what the customer does if it fits (described, no name, no link).`,
          }).catch(() => undefined);
        await d.known.takePair(pair.id, customerId, `maker: ${toMaker}; asker: ${toAsker}`);
      }
      d.log.info("intro.maker", { customerId, maker: maker.url, people: group.length, toMaker });
    }
  }
}
