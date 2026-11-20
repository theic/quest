import {
  isAddress,
  AlreadyAnswered,
  SiteLimit,
  askKeys,
  BROWSER_ONLY,
  ChromeError,
  TooLong,
  WORDLESS,
  draftLabel,
  placeKeys,
  REDDIT,
  platformFor,
  trustKey,
  type ChromePost,
  type ChromePosted,
  type Clock,
  type CustomerId,
  type Draft,
  type DraftAction,
  type DraftKind,
  type DraftId,
  type DraftRepository,
  type TaskId,
  type FindRepository,
  type Logger,
  type NewDraft,
  type PlaceRepository,
  type ReplyPoster,
  type AssetFile,
  type Ask,

  type BrowserView,
  type EventSink,
  type OutboxItem,
} from "@mq/core";
import { draftLine, type AskDeck } from "../asks/deck.ts";
import { alreadyOn, bodyShown, doneOn } from "../chrome/posted-body.ts";
import { commentRef, communityName, isReddit, personUrl, postRef, redditUser } from "../chrome/reddit.ts";
import type { Messenger } from "../conversation/messenger.ts";
import { notDone, notPosted } from "../finds/find-service.ts";
import { nextLook } from "../finds/reply-watch.ts";
import type { Errands } from "../lifecycle/errands.ts";
import { unstyled } from "../lib/voice.ts";
import { platformOf } from "../platforms.ts";
import { saysUnder18, UNDER_18_REFUSAL } from "./adults.ts";
import { noRefusal, type Refusal, type SaidNo } from "../contacts/said-no.ts";
import { dayLimit, limitFreesAt } from "./day-limits.ts";
import { tagLinks } from "./tagged-link.ts";
import { platformName, type Autopilot } from "./autopilot.ts";
import { earlierReplies, listPage, NOT_A_POST, replySpot, secondReply, whoKey } from "./one-reply.ts";
import { LIMIT_WAIT_MS, QUEUED, type Outbox, type OutboxSender, type SendOutcome } from "./outbox.ts";

/** How long a site whose sign-in wall stopped a send gets no new draft: only they can sign in. */
const SIGNED_OUT_MS = 12 * 3_600_000;
import { blueskyAccount, messagesClosed } from "../chrome/bluesky-gate.ts";
import { namesTheirs, othersLinks, promotes, type WarmCheck, type WarmUp } from "./warm-up.ts";
import { forWriterOnly, noteApplied, type WriterPort, type WritingJob } from "./writer.ts";

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
/** Reddit's own limits: a post title, a message subject. */
const TITLE_MAX = 300;
const SUBJECT_MAX = 100;

/** What a draft's card button says, and the verb for it in a sentence. */
export const doneWords = (kind: Draft["kind"], platform?: string | null): { readonly button: string; readonly done: string } =>
  kind === "follow" && platform && platformOf(platform)?.key === "linkedin" ? { button: "Ask to connect", done: "Connection request sent" } : kind === "like" ? { button: "Like it", done: "Liked" } : kind === "follow" ? { button: "Follow", done: "Followed" } : kind === "profile" ? { button: "Update it", done: "Updated" } : kind === "message" ? { button: "Send it", done: "Sent" } : { button: "Post it", done: "Posted" };

/**
 * What Quest asks to draft: a reply under a post or comment, a new post in a community, a private message, a like
 * on a post, a follow of a person, or new words for a field of their own profile.
 */
export type DraftRequest =
  | {
      readonly platform: "browser";
      readonly kind: DraftKind;
      readonly url: string;
      readonly target: string;
      readonly text: string;
      readonly title?: string | null;
      readonly author?: string | null;
      readonly quote?: string | null;
      readonly rulesRead?: boolean;
      readonly limit?: number | null;
      /** The words give the person something they can use: the writer keeps it instead of cutting it to a reaction. */
      readonly helps?: boolean;
      /** One ask back that names their product on purpose (the last step of an introduction): it goes alone, like help for help. */
      readonly ask?: string;
      /** A word in passing under a post read on the way (a reaction, a word or two): the writer keeps it that short. */
      readonly casual?: boolean;
      /** A first word to someone who never heard from them, written by code: held to COLD_REPLIES_A_DAY on a site. */
      readonly cold?: boolean;
      /** The run opened the post just now and nothing of theirs answers it there: a mark that they answered by hand, left by a send stopped before, is then stale. */
      readonly unanswered?: boolean;
      /** The customer's own words from their message: they go on as written, never through the writer. */
      readonly theirs?: boolean;
      /** Their pictures (or videos) it goes up with, by asset id. */
      readonly assets?: readonly string[];
    }
  | { readonly kind: "reply"; readonly url: string; readonly quote: string; readonly author: string | null; readonly text: string }
  | {
      readonly kind: "post";
      readonly community: string;
      readonly title: string;
      readonly text: string;
      /** The manager read the community's rules, as filed, and they allow this post. */
      readonly rulesRead?: boolean;
      readonly assets?: readonly string[];
    }
  | {
      readonly kind: "message";
      readonly to: string;
      readonly subject: string;
      readonly text: string;
      /** The post of theirs it is about, with their words from it, when there is one. */
      readonly url: string | null;
      readonly quote: string | null;
    };

const parse = (raw: string): URL | null => {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
};

/** Someone's name as their site writes it: u/name is Reddit's; on X it is @name (live, 2026-10-14: "u/makerfour" on an X card). */
const handleOn = (platform: string, author: string | null | undefined): string | null => {
  const name = author?.trim().replace(/^u\//i, "");
  if (!name) return null;
  return platform === "x.com" && /^[A-Za-z0-9_]{1,15}$/.test(name) ? `@${name}` : name;
};

/** The draft to save, or why it can't be one, in words the manager can act on. */
export function draftFor(customerId: CustomerId, req: DraftRequest): NewDraft | string {
  const text = unstyled(req.text.trim());
  const wordless = "platform" in req && WORDLESS.has(req.kind);
  if (!text && !wordless) return "The draft is empty.";
  if ("platform" in req) {
    const url = parse(req.url);
    if (!url || !/^https?:$/.test(url.protocol) || url.username || url.password) return "Give the exact web address of the destination workspace or thread.";
    const platform = platformFor(url.href);
    // Reddit's own forms take replies, posts and messages; a like, a follow or a profile edit there goes through the page.
    if (platform === "reddit" && !BROWSER_ONLY.has(req.kind)) return "Use the Reddit draft fields for Reddit; other workspaces use the browser destination.";
    if (!req.target.trim()) return "A browser draft needs the exact community, thread or recipient.";
    // A message goes to a person, never to a post's address: the poster opens the post and the words go up as a comment
    // (live, 2026-11-17: a "message" to Dana Reed at a LinkedIn post's address became a second reply under his comment).
    if (req.kind === "message" && /^https:\/\/(www\.)?linkedin\.com\/(feed|posts)\//i.test(req.url)) return "A private message goes to their profile's address (linkedin.com/in/…), not a post's: there the words would go up as a comment. Use their profile, or draft a reply.";
    // And a reply goes under a post, never to a profile (live, 2026-11-18: a reply to a comment was addressed to the
    // post author's profile, and the poster looked for the comment there for five minutes).
    if (req.kind === "reply" && /^https:\/\/(www\.)?linkedin\.com\/in\/[^/]+\/?$/i.test(req.url)) return "A reply goes to the post's own address (linkedin.com/posts/… or /feed/update/…), not to a profile. Open the post, take its address, and draft again.";
    if (req.kind === "message" && req.target.trim().toLowerCase() === platform) return "Use the person's or chat's exact name (or email address) as target, not the workspace's host. Read and verify the recipient in the workspace first.";
    if (req.kind === "reply" && !req.quote?.trim()) return "A reply needs a short quote of the words it answers.";
    // A like goes on one post: the words of the post it likes, as read, tell it apart from the replies under it.
    if (req.kind === "like" && !req.quote?.trim()) return "A like needs a short quote of the post it likes, exactly as you read it.";
    return { customerId, kind: req.kind, platform, url: url.href, target: req.target.trim(), title: wordless ? null : req.title?.trim() || null, author: handleOn(platform, req.author), quote: req.quote?.trim() || null, text: wordless ? "" : text, ...(req.assets?.length && !wordless ? { assets: req.assets } : {}) };
  }
  switch (req.kind) {
    case "reply": {
      const u = parse(req.url);
      if (!u || !isReddit(u)) return "I can post replies only on Reddit so far. Give the address of the Reddit post or comment it answers.";
      const target = commentRef(u.href) ?? postRef(u.href);
      if (!target) return "That address is not a Reddit post or comment. Give the one the reply goes under.";
      const quote = req.quote.trim();
      if (!quote) return "A reply needs a short quote of the words it answers.";
      const author = redditUser(req.author ?? undefined);
      return { customerId, kind: "reply", platform: "reddit", url: personUrl(u.href), target, title: null, author, quote, text };
    }
    case "post": {
      const community = communityName(req.community);
      if (!community) return `"${req.community}" is not a community name: give it as r/name.`;
      const title = unstyled(req.title.trim());
      if (!title || title.length > TITLE_MAX) return `A post needs a title of up to ${TITLE_MAX} characters.`;
      return { customerId, kind: "post", platform: "reddit", url: `https://www.reddit.com/r/${community}/`, target: community, title, author: null, quote: null, text, ...(req.assets?.length ? { assets: req.assets } : {}) };
    }
    case "message": {
      const to = redditUser(req.to);
      if (!to) return `"${req.to}" is not a Reddit username: give it as u/name.`;
      const subject = unstyled(req.subject.trim());
      if (!subject || subject.length > SUBJECT_MAX) return `A message needs a subject of up to ${SUBJECT_MAX} characters.`;
      const about = req.url ? parse(req.url) : null;
      if (req.url && (!about || !isReddit(about))) return "The post a message is about has to be on Reddit.";
      const url = about ? personUrl(about.href) : `https://www.reddit.com/user/${to}/`;
      const quote = req.quote?.trim() || null;
      return { customerId, kind: "message", platform: "reddit", url, target: to, title: subject, author: to, quote, text };
    }
  }
}

/** What the extension posts for a draft; with its pictures, it goes through the page on Reddit too (Reddit's forms take words only). */
export function chromePost(d: Draft, files: readonly AssetFile[] = [], before: readonly string[] = []): ChromePost {
  if (d.platform !== "reddit" || d.kind === "like" || d.kind === "follow" || d.kind === "profile" || files.length)
    return { platform: "browser", kind: d.kind, url: d.url, target: d.target, title: d.title, text: d.text, quote: d.quote, author: d.author, ...(files.length ? { files } : {}), ...(before.length ? { before } : {}) };
  switch (d.kind) {
    case "reply":
      return { platform: "reddit", url: d.url, parent: d.target, text: d.text };
    case "post":
      return { platform: "reddit", kind: "post", url: d.url, community: d.target, title: d.title ?? "", text: d.text };
    case "message":
      return { platform: "reddit", kind: "message", url: d.url, to: d.target, subject: d.title ?? "", text: d.text };
  }
}

export interface DraftServiceDeps {
  /** Your move (asks/deck.ts): a draft goes there, not on a card of its own. Without it, each draft is its own card. */
  readonly deck?: AskDeck;
  readonly events?: EventSink;
  readonly drafts: DraftRepository;
  /** Finds posted count against the same daily limit, and a find's reply is a reply there as much as a draft's. */
  readonly finds: Pick<FindRepository, "sentSince" | "listFor">;
  /** A post never goes to a community filed as avoid. */
  readonly places: Pick<PlaceRepository, "listFor">;
  readonly messenger: Messenger;
  readonly poster: ReplyPoster;
  readonly errands: Errands;
  /** Where everything that goes out waits its turn, and their Chrome (outbox.ts). */
  readonly outbox: Outbox;
  /** Whether Quest posts on a platform by itself yet. Without it, everything waits for a tap. */
  readonly autopilot?: Autopilot;
  /** Puts every draft in their voice before its card shows. Without it, the words go on as the manager or a teammate wrote them. */
  readonly writer?: WriterPort;
  /** What Quest knows of whom a draft goes to, for the writer (contacts/acquaintances.ts). */
  readonly people?: { about(customerId: CustomerId, url: string, who: string | null): Promise<string | null> };
  /** Whether someone answered them since a time, as the record has it (mq.results). Without it, nobody did. */
  readonly answeredSince?: (customerId: CustomerId, person: string, since: Date) => Promise<boolean>;
  /** Whether the product may come up yet: it comes last (warm-up.ts). Without it, nothing is held back. */
  readonly warmUp?: WarmUp;
  /** Their assets' files, read again from the chat for a post that goes up with them (ideas/idea-service.ts). */
  readonly files?: { files(customerId: CustomerId, ids: readonly string[]): Promise<AssetFile[]> };
  /**
   * Quest's own account (the customer whose product is Quest): a link to messaging.quest in a reply or a message gets a
   * code of its own that carries the conversation, so whoever comes by it starts where they were (hand-off below).
   */
  /** Whoever asked to be left alone: nothing is drafted or sent to them again (contacts/said-no.ts). */
  readonly saidNo?: Pick<SaidNo, "who" | "tagged" | "note">;
  /** What a draft keeps for trust and the day's sample: they changed its words, or the checks sent it back (infra/pg-draft-marks.ts). */
  readonly marks?: { edited(id: DraftId): Promise<void>; sentBack(id: DraftId): Promise<void> };
  readonly handOff?: { mint(note: string): Promise<string | null>; seller(customerId: CustomerId): Promise<boolean> };
  readonly clock: Clock;
  readonly log: Logger;
}

/** A link to messaging.quest that carries no code of its own yet (a maker's page, /m/, is not one: it goes as it is). */
const QUEST_LINK = /\b(?:https?:\/\/)?(?:www\.)?messaging\.quest(?!\/m\/)\/?(?![\w/?#=&.-]*[?&]i=)(?:[\w/#-]|\.(?=\w))*/i;

/** What the writer needs to know about a draft: where it goes, what it answers, and the words as drafted. Never a like or a follow, which have no words. */
export const writingJob = (d: Pick<NewDraft, "kind" | "platform" | "target" | "author" | "quote" | "text" | "title">): WritingJob => ({
  kind: d.kind as WritingJob["kind"],
  platform: d.platform,
  place: d.platform === "reddit" ? (d.kind === "message" ? `u/${d.target}` : d.kind === "post" ? `r/${d.target}` : null) : d.target,
  author: d.author,
  quote: d.quote,
  draft: d.text,
  title: d.title,
});

/** What became of a draft the manager wrote. */
/** Replies a site takes in a day before code writes no more first words to strangers there. */
export const COLD_REPLIES_A_DAY = 12;
/**
 * Where unasked replies got an account in trouble, a few a day and no more (the founder, 2026-11-18: "Let Quest do it
 * on all platforms, just in reasonable amounts; even the platforms that perform poorly"): Bluesky, where a maker asked
 * "What is your end game, bot?" at 130 a day, and any Mastodon server, where 33 a day got the account suspended.
 */
export const COLD_ON_BLUESKY = 6;
export const COLD_ON_MASTODON = 3;
const fediPost = (url: string): boolean => /^https?:\/\/[^/]+\/@[^/]+\/\d{6,}/.test(url);
/** How many replies a site may have taken in a day before no more first words go there by code. */
export const coldCap = (url: string): number => (fediPost(url) ? COLD_ON_MASTODON : /^https?:\/\/bsky\.app\//i.test(url) ? COLD_ON_BLUESKY : COLD_REPLIES_A_DAY);

export interface Offered {
  readonly draft: Draft;
  /** Going up by itself: the customer trusts Quest on that platform. */
  readonly alone: boolean;
}

/**
 * Drafts the manager writes for the customer to post as themselves. Each goes to them as a card at
 * once. Post it puts it up from their own account in their Chrome, Edit has them reply with their
 * changes, Skip closes it. Once they approved a few on a platform, a reply or a post there goes up
 * by itself (autopilot.ts); a private message always waits for the tap. All share the daily limit
 * with the finds.
 */
export class DraftService implements OutboxSender {
  readonly #d: DraftServiceDeps;
  readonly #offering = new Map<CustomerId, Promise<unknown>>();
  /** Until when a site takes no more of a kind from a customer, as it said (`SiteLimit`). In memory: a restart asks the site once more. */
  readonly #limited = new Map<string, number>();
  /** Until when a site is taken as signed out for a customer: the poster met its sign-in wall. In memory, like the limits. */
  readonly #signedOut = new Map<string, number>();
  /** Whose draft in the making went back to the writer once: marked on the draft when it is saved (offers go one at a time). */
  readonly #backed = new Set<CustomerId>();

  constructor(deps: DraftServiceDeps) {
    this.#d = deps;
  }

  /**
   * Saves the draft and shows its card, posting it by itself where it may; or why it was not made.
   * One at a time per customer: two drafts from one model step must not both pass the checks.
   */
  offer(customerId: CustomerId, req: DraftRequest, taskId?: TaskId): Promise<Offered | string> {
    const next = (this.#offering.get(customerId) ?? Promise.resolve()).catch(() => undefined).then(() => this.#offer(customerId, req, taskId));
    this.#offering.set(customerId, next);
    return next;
  }

  async #offer(customerId: CustomerId, req: DraftRequest, taskId?: TaskId): Promise<Offered | string> {
    const found = draftFor(customerId, req);
    if (typeof found === "string") return found;
    const asked = taskId ? { ...found, taskId } : found;
    // Live, 2026-11-03: a website draft for Instagram went round the poster twice, and the page said "Editing your links
    // is only available on mobile".
    if (asked.kind === "profile" && platformOf(asked.platform)?.key === "instagram" && /web|site|link|url/i.test(asked.target))
      return "Instagram's website and links change only in its app (its web page says \"Editing your links is only available on mobile\"): draft only the name or the bio there, and tell them to set the link in the app.";
    if (asked.quote && saysUnder18(asked.quote)) return UNDER_18_REFUSAL;
    // Whoever asked to be left alone gets nothing more, and is named under nobody's post; the customer's own words are theirs.
    if (!("platform" in req && req.theirs)) {
      const no = (await this.#toSomeoneWhoSaidNo(asked)) ?? (await this.#d.saidNo?.tagged(customerId, asked.text).catch(() => null)) ?? null;
      if (no) return noRefusal(no);
    }
    // Live, 2026-11-03: a like card on Threads pointed at a profile, so the poster could only guess which post it was for.
    if (asked.kind === "like" && profileAddress(asked.url)) return "A like goes on one post: open the post and give its own address, not the person's profile.";
    if ((asked.kind === "reply" || asked.kind === "like") && listPage(asked.url)) return NOT_A_POST;
    if ((this.#signedOut.get(`${asked.customerId} ${asked.platform}`) ?? 0) > this.#d.clock.now().getTime()) return `Their Chrome is not signed in to ${platformName(asked.platform)}, so nothing can go up there: the last try met its sign-in page. Leave this site, and say so in your report.`;
    // Unasked replies to strangers are what a site reads as spam (live, 2026-11-15: mastodon.social suspended their account
    // for spam after 33 and 39 such replies a day, and on Bluesky, at 130 a day, one answered "What is your end game, bot?").
    // Once a site took this many replies in a day, no more first words go there by code; answers to people talking go on.
    if ("cold" in req && req.cold && asked.kind === "reply" && (await this.coldRoom(customerId, asked.url)) <= 0)
      return `That's a day's replies on ${platformName(asked.platform)}: no more first words to strangers there today, only answers to people already talking.`;
    // A Bluesky message to someone who takes none from them is not put on a card (live, 2026-11-18: 23 waited on Your move
    // in a day, most to people who take messages only from accounts they follow): the words go as a reply instead.
    if (asked.kind === "message" && asked.url.toLowerCase().startsWith("https://bsky.app/")) {
      const closed = await messagesClosed(asked.url, asked.target, blueskyAccount(customerId)).catch(() => null);
      if (closed) return `${closed} Say it as a reply under their last post or their answer instead.`;
    }
    if (this.#atLimit(asked)) return `${platformName(asked.platform)} takes no more of these today, as it said itself. Leave it, and do something else there.`;
    // In their voice before anything is compared: the same draft offered again is written the same way (the writer
    // remembers), so the checks below find it.
    const limit = "platform" in req && req.limit ? req.limit : undefined;
    const theirs = "platform" in req && Boolean(req.theirs);
    // The product comes last: until the platform is warm and the person talks with them, the words stay plain.
    const warm = theirs ? null : await this.#warmUp(asked);
    // Words sent for the help they give may say in passing what the customer builds, with no name and no link: step two
    // of a plan is exactly that, and the writer dropped it whole (live, 2026-11-13: "finding people who want what someone
    // built is what I do most days" went out as a tip about Bluesky, since the answer was on record under another name).
    const helps = "platform" in req && req.helps === true;
    // A brake holds this kind here (someone asked if they are a bot, a reply taken down, answers dropping): no first word
    // to a stranger is drafted until it passes; an answer to someone talking with them is, and waits for their tap.
    const braked = theirs || WORDLESS.has(asked.kind) ? null : (this.#d.autopilot?.braked(customerId, asked.platform, asked.kind) ?? null);
    if (braked && !warm?.talks) return `${platformName(asked.platform)} is paused for this until ${braked.until.toISOString().slice(0, 16).replace("T", " ")} UTC: ${braked.reason}. Nothing new is drafted there meanwhile; go on with the rest.`;
    // Help for help: a reply or message to someone who talks with them may end with one light ask about the product.
    const ask = ("platform" in req && req.ask) || (warm?.ask && (asked.kind === "reply" || asked.kind === "message") ? warm.ask : undefined);
    const casual = "platform" in req && req.casual === true && asked.kind === "reply";
    const voiced = theirs ? asked : await this.#inTheirVoice(asked, limit, Boolean(warm?.why) && !ask, Boolean(warm?.gentle) || helps, helps, ask, casual);
    // A link to their own site says which platform it went up on, where it still fits the field; their dictated words go as written.
    const tagged = theirs || WORDLESS.has(voiced.kind) ? voiced.text : tagLinks(voiced.text, (await this.#d.warmUp?.site(customerId).catch(() => null)) ?? null, voiced.platform);
    const draft = tagged !== voiced.text && !(limit && tagged.length > limit) ? { ...voiced, text: tagged } : voiced;
    // A field with its own limit takes no more (live, 2026-10-15: a 174-character bio for X's 160 never went in).
    if (limit && draft.text.length > limit) return `The field takes at most ${limit} characters, and this has ${draft.text.length}. Write it shorter.`;
    // A frame whose blanks the writer left (it failed, or ran long) is nothing to send.
    if (/\b(THING|PROJECT|DETAIL[12])\b/.test(draft.text)) return "The draft's blanks were not filled in.";
    // The writer talking about the job instead of to the person (live, 2026-11-14: "I'd hold this one. Autovella posted an
    // invoice follow-up schedule, but the other post is a German complaint..." was queued as a reply to a maker).
    if (!theirs && !WORDLESS.has(draft.kind) && /^\W*(i'?d (hold|skip|pass|drop|not send)|(i'?m )?(not sending|holding (off|this)|skipping this|passing on this)|the match (doesn'?t|does not|isn'?t)|i (can'?t|cannot|won'?t|wouldn'?t) (write|send|draft|do)|(this|these) (one|pair|match|two)\b.{0,40}\b(doesn'?t|don'?t|isn'?t|aren'?t|not)\b|not a (good |real )?(match|fit)|no (real )?match\b|the (other|second|first) post (is|isn'?t))/i.test(draft.text.trim()))
      return "The writer held this one: the words were about the match, not for the person. Nothing was drafted; leave this pair.";
    // The writer's own working left in the words (live, 2026-11-15: a reply to @AmeliaonAI read "...🙂\n\nHmm, period after
    // emoji odd. Final:\n\nAppreciate it Amelia..." on its card).
    if (!theirs && /(^|\n)\s*(hmm|ok(ay)?|wait|actually|let me|revised|final( version)?|better)\b[^\n]{0,60}(:\s*$|\bfinal:)/im.test(draft.text))
      return "The words still hold the writer's working notes. Write it again as only the message.";
    if (warm?.why && !ask && promotes(`${draft.title ?? ""} ${draft.text}`, warm.names)) return `${warm.why} Write it again with no product name and no link.`;
    // Words first, the link once they answer (the founder, 2026-11-13; live the same evening, an Introductions run handed a
    // maker a stranger's post in its first word): someone not yet talking with them gets no other person's post or profile.
    if (warm && !warm.talks && !helps && (draft.kind === "reply" || draft.kind === "message") && othersLinks(draft.text).length)
      return "Words first: they have not talked with you yet, so no link to anyone's post or profile. Say you saw people looking for this (or someone who made it) and ask if they want them; keep the link in note_person's plan as \"Links: <url>\", and it goes once they answer.";
    // Words that name the product or link to it always wait for their tap, trusted or not (the founder, 2026-11-13: come back
    // to me only for more input, an ambiguity, or a risky step "like share a link to the product"); the rest goes alone.
    // Only their own product: an introduction's link to another maker's site goes alone.
    // The ask back is theirs already (the founder, 2026-11-13): it goes alone like any other reply.
    const sells = !theirs && !ask && !WORDLESS.has(draft.kind) && namesTheirs(`${draft.title ?? ""} ${draft.text}`, (await this.#d.warmUp?.site(customerId).catch(() => null)) ?? null);
    const recentDrafts = await this.#d.drafts.recent(customerId, 100);
    const same = recentDrafts.find((d) => sameDestination(d, draft) && d.text === draft.text && d.title === draft.title && d.status !== "skipped" && this.#d.clock.now().getTime() - d.createdAt.getTime() < DAY_MS);
    if (same) {
      if (same.status === "posted" && WORDLESS.has(same.kind)) return `Already done: ${draftLabel(same)} (${same.sentUrl}). Do not do it again.`;
      if (same.status === "posted") return `Those exact words already went to that destination: ${same.sentUrl}. Do not send them again.`;
      if (same.status !== "open") return `Draft ${same.id} is ${same.status}. Inspect its outcome; never create another copy.`;
      const alone = Boolean(await this.#d.autopilot?.alone(customerId, trustKey(same.platform, same.kind))) && (await this.#start(same, true)) === null;
      return { draft: same, alone };
    }
    // One reply under a post or comment, whatever its words: a second one reads as spam even when the first is hidden.
    if (draft.kind === "reply" && !("platform" in req && req.theirs)) {
      const refused = await this.#secondReply(draft, recentDrafts, false, "platform" in req && req.unanswered === true);
      if (refused) return refused;
    }
    // A message answers their words, never the customer's own: what Quest sent them is on record.
    if (draft.kind === "message" && draft.quote) {
      const start = wordsOf(draft.quote).slice(0, 60);
      const sent = start.length >= 12 && recentDrafts.find((d) => d.kind === "message" && d.status === "posted" && wordsOf(d.text).includes(start));
      if (sent) return `that quote is from the customer's own message (${draftLabel(sent)}, sent ${sent.sentAt?.toISOString().slice(0, 10) ?? "earlier"}), not an answer to it. Answer only words the other person wrote.`;
    }
    // A Reddit community's own verdict is weighed below, for posts; a hold on all of Reddit holds every draft there.
    const avoided = (await this.#d.places.listFor(customerId)).find((p) => placeKeys(draft.url).includes(p.key) && p.verdict === "avoid");
    if (avoided && (draft.platform !== "reddit" || avoided.key === REDDIT)) return `${avoided.name} is on their avoid list: ${avoided.rules ?? avoided.why}.`;
    if (draft.kind === "post" && req.kind === "post") {
      const keys = placeKeys(draft.url);
      const listed = await this.#d.places.listFor(customerId);
      const place = listed.find((p) => p.verdict === "avoid" && keys.includes(p.key)) ?? listed.find((p) => p.key === keys[0]);
      if (place?.verdict === "avoid") return `${draft.platform === "reddit" ? "r/" : ""}${draft.target} is on their avoid list${place.rules ? ` (${place.rules})` : ""}: no post goes there.`;
      // Live, 2026-10-04: the same founder's announcement for r/expats, r/Bangkok (rules: no advertising)
      // and r/Thailand (never explored), in one step. A post goes where the rules were read, written for it.
      if (!place && draft.platform === "reddit") return `r/${draft.target} is not on their list: the explorer reads a community's rules before anything is posted there.`;
      // A site Quest knows has its rules here: a manager turn starts fresh, and the page that brought them may have
      // been an earlier turn's (live, 2026-10-22: three refusals in a row for a video post on X). Said as a check, not a
      // verdict: given the bare rules, the manager told the founder "X refused the post twice".
      if (draft.platform !== "reddit" && !req.rulesRead) {
        const known = platformOf(draft.url);
        return known?.rules
          ? `rules_read is not set. ${known.name}'s rules as Quest knows them (a check for you, not a refusal of this post):\n${known.rules}\n` +
              "If this post keeps to them, call draft again with the same words and rules_read true."
          : "Read the destination's posting rules first, then draft with rules_read true when this post is allowed.";
      }
      if (place?.rules && !req.rulesRead) {
        return (
          `r/${draft.target}'s rules, as filed: "${place.rules}". Draft it again with rules_read only if they let a member post this, ` +
          "their own product included; if not, answer people there with replies instead."
        );
      }
      const weekAgo = this.#d.clock.now().getTime() - WEEK_MS;
      const recent = (await this.#d.drafts.recent(customerId, 50)).filter((d) => d.kind === "post" && d.status !== "skipped" && d.createdAt.getTime() > weekAgo);
      // One post a week in a community (live, 2026-10-04: two posts for r/SideProject in one step, one titled "Show HN").
      // Both are Reddit's: a post on their own feed elsewhere is held by the platform's day limit, and the same news on X and
      // on Bluesky is not spam (live, 2026-11-13: their changelog went up on X and every other site was told "r/x.com").
      const twin = draft.platform === "reddit" && recent.find((d) => d.platform === draft.platform && d.target.toLowerCase() === draft.target.toLowerCase());
      if (twin) {
        return `r/${draft.target} already has a post of theirs this week (${twin.status === "open" ? `on its card, draft ${twin.id}: change it with edit_card` : "already up"}). One a week in a community.`;
      }
      const copy = draft.platform === "reddit" && recent.find((d) => d.platform === "reddit" && alike(d.text, draft.text));
      if (copy) return `those are nearly the words of their post in r/${copy.target}: the same post in two communities reads as spam. Write one for r/${draft.target}, or none.`;
    }
    // A like or a follow past the platform's day limit is not drafted at all: left open it became an ask on Your move
    // (live, 2026-11-12: Bluesky's 50 a day were used up by 04:31, and the next 12 likes and follows waited on a tap).
    if (WORDLESS.has(draft.kind)) {
      const over = await this.#overDay(customerId, draft, null);
      if (over) return `Not drafted: ${over.replace(/. Tap again tomorrow$/, "")}. No more likes or follows there today; go on with the rest.`;
    }
    const saved = await this.#d.drafts.add(await this.#handOff(draft));
    if (this.#backed.delete(customerId)) void this.#d.marks?.sentBack(saved.id);
    const ref = this.#d.deck ? null : await this.#d.messenger.showDraft(customerId, saved);
    await this.#d.drafts.markShown(saved.id, ref);
    const shown = { ...saved, cardRef: ref };
    this.#d.log.info("drafts.offered", { customerId, draftId: saved.id, kind: saved.kind });
    // Someone who talks with them and asks them something is waiting for them, not for Quest: it waits for their tap
    // (the founder, 2026-11-18: "Keep real cards for ... people who are waiting for you specifically"). What code answers
    // by a plan (a yes, a link they asked for) is not that.
    const personal = !theirs && !helps && !ask && shown.kind === "reply" && Boolean(warm?.talks) && /\?/.test(shown.quote ?? "");
    // A second word to someone who has not answered the first is theirs to decide (live, 2026-11-18 and 19: three replies
    // under one LinkedIn comment, two unasked replies to one maker on Threads five hours apart). Words under their own
    // post and what code sends by a plan are not that.
    const again = !theirs && !helps && !ask && shown.kind === "reply" ? await this.#unanswered(shown) : null;
    if (again) this.#d.log.info("drafts.second_word", { customerId, draftId: shown.id, earlier: again.id });
    const alone = !sells && !personal && !again && Boolean(await this.#d.autopilot?.alone(customerId, trustKey(shown.platform, shown.kind))) && (await this.#start(shown, true)) === null;
    // Going up by itself, it is nothing of theirs to do; on the deck otherwise.
    if (!alone) await this.#d.deck?.changed(customerId);
    return { draft: shown, alone };
  }

  /**
   * The onboarding starts in the thread (the founder, 2026-11-15: "The onboarding starts even before you get the link or
   * installed the extension: in a public thread or DM"): on Quest's own account, the link to messaging.quest in a reply
   * or a message becomes one with a code of its own (?i=), which keeps who they are, what they wrote and what Quest
   * said. They come in by it, and their first turn picks up from that conversation (conversation/way-in.ts).
   */
  async #handOff<T extends Pick<NewDraft, "customerId" | "kind" | "platform" | "url" | "target" | "author" | "quote" | "text">>(draft: T): Promise<T> {
    const h = this.#d.handOff;
    if (!h || (draft.kind !== "reply" && draft.kind !== "message") || !QUEST_LINK.test(draft.text)) return draft;
    if (!(await h.seller(draft.customerId).catch(() => false))) return draft;
    const who = draft.author ?? draft.target;
    const known = await this.#d.people?.about(draft.customerId, draft.url, draft.author).catch(() => null);
    const note = [
      `Met on ${draft.platform} (${draft.url}): ${who}.`,
      draft.quote ? `They wrote: "${draft.quote}".` : null,
      `Quest wrote back: "${draft.text}".`,
      known ? `What Quest knew of them: ${known}` : null,
    ].filter(Boolean).join(" ");
    const code = await h.mint(note).catch(() => null);
    if (!code) return draft;
    // A link already tagged keeps its tag as a second field (live, 2026-11-17: "/?i=E1AEE5C5?utm_source=bluesky" went up).
    this.#d.log.info("drafts.handed_off", { customerId: draft.customerId, platform: draft.platform });
    return { ...draft, text: draft.text.replace(QUEST_LINK, `messaging.quest/?i=${code}`).replace(`?i=${code}?`, `?i=${code}&`) };
  }

  /**
   * Whether the product may come up in this draft yet (warm-up.ts): why not, with the names it goes by; null for what
   * never sells (a like, a follow, their profile) or without the customer's record.
   */
  async #warmUp(d: NewDraft): Promise<WarmCheck | null> {
    if (!this.#d.warmUp || (d.kind !== "reply" && d.kind !== "post" && d.kind !== "message")) return null;
    // A post of their own goes to everyone there, not to a person: only the platform's warmth counts.
    const person = d.kind === "post" ? null : d.platform === "reddit" && d.kind === "message" ? d.target : d.author ?? (d.kind === "message" ? d.target : null) ?? "the person";
    return this.#d.warmUp.check(d.customerId, d.platform, person, d.quote);
  }

  /** The draft's words as the writer put them, within the field's limit when it has one, the title too where it fits the platform's limit. */
  async #inTheirVoice<T extends Pick<NewDraft, "customerId" | "kind" | "platform" | "target" | "author" | "quote" | "text" | "title" | "url">>(draft: T, chars?: number, plain = false, gentle = false, helps = false, ask?: string, casual = false): Promise<T> {
    if (!this.#d.writer || WORDLESS.has(draft.kind)) return WORDLESS.has(draft.kind) ? draft : { ...draft, text: forWriterOnly(draft.text) };
    // Whom it goes to, as Quest knows them: words that could only be for them.
    const who = draft.kind === "message" ? draft.target : draft.author;
    const about = draft.kind === "reply" || draft.kind === "message" ? await this.#d.people?.about(draft.customerId, draft.url, who).catch(() => null) : null;
    const job = { ...writingJob(draft), ...(chars ? { chars } : {}), ...(plain ? { plain } : {}), ...(plain && gentle ? { gentle } : {}), ...(about ? { about } : {}), ...(helps ? { helps } : {}), ...(ask ? { ask } : {}), ...(casual ? { casual } : {}) };
    const w = await this.#d.writer.write(draft.customerId, job);
    if (w.again) this.#backed.add(draft.customerId);
    else this.#backed.delete(draft.customerId);
    const max = draft.platform !== "reddit" ? TITLE_MAX : draft.kind === "message" ? SUBJECT_MAX : TITLE_MAX;
    // A post's tags are kept by code (live, 2026-11-19: the writer's rules drop hashtags, and four of a night's five
    // posts went up with none): the line of tags the draft ended with goes back under the words when it was dropped.
    const tags = draft.kind === "post" ? /\n\s*((?:#[\p{L}\p{N}_]+\s*){1,4})$/u.exec(draft.text.trimEnd())?.[1]?.trim() : undefined;
    const said = tags && w.text && !/#[\p{L}\p{N}_]+\s*$/u.test(w.text.trimEnd()) && (!chars || w.text.length + tags.length + 2 <= chars) ? `${w.text.trimEnd()}\n\n${tags}` : w.text;
    return { ...draft, text: said && (!chars || said.length <= chars) ? said : forWriterOnly(draft.text), title: draft.title && w.title && w.title.length <= max ? w.title : draft.title };
  }

  /** How many more first words by code a site takes today: its cap less the replies that went there in a day (Mastodon's servers count as one). */
  async coldRoom(customerId: CustomerId, url: string): Promise<number> {
    const since = this.#d.clock.now().getTime() - 86_400_000;
    const host = (u: string): string => u.replace(/^https?:\/\/(www\.)?/, "").split("/")[0]!.toLowerCase();
    const fedi = fediPost(url);
    const up = (await this.#d.drafts.recent(customerId, 400)).filter((d) => d.kind === "reply" && d.status !== "skipped" && d.createdAt.getTime() >= since && (fedi ? fediPost(d.url) : host(d.url) === host(url))).length;
    return coldCap(url) - up;
  }

  async recent(customerId: CustomerId, limit: number): Promise<Draft[]> {
    return this.#d.drafts.recent(customerId, limit);
  }

  /**
   * Why a reply can't go where this one would: one of theirs went up there, may have, or is going up (a draft's or a
   * find's), or, when offered, another card for a reply there is still open. Null when it can.
   */
  async #secondReply(draft: Pick<Draft, "customerId" | "platform" | "url" | "target"> & { readonly quote?: string | null }, drafts: readonly Draft[], posting = false, unanswered = false): Promise<string | null> {
    const spot = replyAt(draft);
    if (!spot) return null;
    const finds = await this.#d.finds.listFor(draft.customerId, ["shown", "kept", "replied"], 300);
    // A send stopped because the page seemed to show their own answer leaves a mark, and the mark was for good: a wrong
    // stop (live, 2026-11-14: their own post above a question read as their answer to it) then kept that person waiting
    // whatever was drafted after. A look since that shows no answer of theirs outweighs it, and at the send the poster
    // looks at the page itself, so the mark decides nothing there.
    // The list handed in is their newest drafts only (live, 2026-11-18: 421 drafts in two days, likes and follows mostly,
    // pushed a reply of Nov 16 out of the newest 100, and a third reply went up under one LinkedIn comment): what went
    // up at this spot is asked of the database, whatever its age.
    const older = (await this.#d.drafts.repliesTo?.(draft.customerId, draft.platform, draft.url, draft.target ?? null).catch(() => [])) ?? [];
    const known = new Set(drafts.map((d) => d.id));
    const own = "id" in draft ? (draft as { id: string }).id : null;
    drafts = [...drafts, ...older.filter((d) => !known.has(d.id) && d.id !== own)];
    // On LinkedIn the spot is the person under a post, so a conversation there shares one: a reply to other words of
    // theirs than the ones already answered is the next turn of it, not a second reply.
    const said = (q: string | null | undefined): string => (q ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().slice(0, 60);
    const mine = said(draft.quote);
    if (draft.platform === "linkedin.com" && mine) drafts = drafts.filter((d) => d.kind !== "reply" || !said(d.quote) || said(d.quote) === mine || replyAt(d) !== spot);
    const marks = posting || unanswered ? drafts.filter((d) => !d.answeredAt) : drafts;
    const earlier = earlierReplies(marks, finds).get(spot);
    if (earlier) return posting ? "You already replied there" : secondReply(earlier);
    const open = posting ? null : drafts.find((d) => d.kind === "reply" && d.status === "open" && replyAt(d) === spot);
    return open ? `their card for a reply there is still open (draft ${open.id}): change its words with edit_card, never a second card.` : null;
  }

  /** Their replies and messages that went up to whoever a draft goes to, on its platform, newest first, without the draft itself. */
  async #toThem(draft: Draft): Promise<Draft[]> {
    const who = whoKey(draft.target);
    const older = (await this.#d.drafts.repliesTo?.(draft.customerId, draft.platform, draft.url, draft.target ?? null).catch(() => [])) ?? [];
    const recent = (await this.#d.drafts.recent(draft.customerId, 300)).filter((d) => d.platform === draft.platform && (d.kind === "reply" || d.kind === "message") && ["posted", "uncertain", "posting"].includes(d.status));
    const seen = new Set<string>();
    return [...recent, ...older]
      .filter((d) => d.id !== draft.id && !seen.has(d.id) && seen.add(d.id) && (replyAt(d) === replyAt(draft) || (who.length >= 3 && [d.target, d.author].some((p) => whoKey(p) === who))))
      .sort((a, b) => (b.sentAt ?? b.createdAt).getTime() - (a.sentAt ?? a.createdAt).getTime());
  }

  /** The last word of theirs to this person in a week that nobody answered, when there is one; null when they answered or none went. */
  async #unanswered(draft: Draft): Promise<Draft | null> {
    const last = (await this.#toThem(draft)).find((d) => (d.sentAt ?? d.createdAt).getTime() > this.#d.clock.now().getTime() - WEEK_MS);
    if (!last) return null;
    const since = last.sentAt ?? last.createdAt;
    const heard = (await Promise.all([draft.target, draft.author].filter((p): p is string => Boolean(p)).map((p) => this.#d.answeredSince?.(draft.customerId, p, since).catch(() => false) ?? false))).some(Boolean);
    return heard ? null : last;
  }

  /** Resolve a held send from the actual destination, without sending it again. */
  async verifySent(customerId: CustomerId, id: DraftId, view: BrowserView): Promise<Draft | string> {
    const d = await this.#d.drafts.get(id);
    if (!d || d.customerId !== customerId) return "No such draft.";
    if (d.status === "posted") return d;
    if (!["posting", "uncertain"].includes(d.status)) return "That draft is not a held send.";
    if (this.#d.errands.running(errand(d))) return "This send is still running. Its posting executor will verify it; do not interfere or resend.";
    if (view.visualText) return "Visual text can include an unsent draft. Keep this send held; a transcript alone is not a receipt.";
    const normalize = (s: string) => s.replace(/\s+/g, " ").trim();
    if (d.kind === "like" || d.kind === "follow") {
      // A like or a follow is seen on its control: the post's Like showing as done, the person's Follow as Following.
      // Where the page marks its posts, the like must be on the one it quotes (a reply's heart beside it is not it); a
      // follow, on the person's own button outside any post.
      const kind = d.kind as "like" | "follow";
      const shown = alreadyOn(view, d, kind) || view.controls.some((c) => doneOn(c, kind) && (kind === "follow" ? c.item === undefined : !view.items?.length));
      if (new URL(view.url).origin !== new URL(d.url).origin || !shown) return `The ${d.kind} does not show as done on its page. Keep it held.`;
    } else if (new URL(view.url).origin !== new URL(d.url).origin || !bodyShown(view.text, d.text) || view.controls.some((c) => c.value !== null && normalize(c.value) === normalize(d.text))) return "The exact posted body is not visible outside an empty composer on its destination. Keep it held.";
    const sent = await this.#d.drafts.markSent(id, view.url, "connected account", d.alone);
    if (!sent) return "Its state changed; inspect it again.";
    if (sent.kind === "reply" || sent.kind === "post") await this.#d.drafts.watch(sent.id, nextLook(sent.sentAt ?? this.#d.clock.now(), 0), 0, []);
    await this.#redraw(sent);
    this.#d.autopilot?.note(customerId, "browser", `verified the held ${draftLabel(sent)}: ${view.url}`);
    return sent;
  }

  /**
   * Sends an open draft for Quest: on its own where they trust it on the platform, or `asked`, when they told it
   * in words to post this one ("Try again"), which counts the way a tap on Post it does.
   */
  async publish(customerId: CustomerId, id: DraftId, opts: { asked?: boolean } = {}): Promise<string> {
    const d = await this.#d.drafts.get(id);
    if (!d || d.customerId !== customerId) return "No such draft.";
    if (d.status !== "open") return `Draft is ${d.status}; never send it again without resolving a held result.`;
    if (opts.asked) return (await this.#start(d, false, true)) ?? "Posting it as they asked. Wait for its verified outcome; do not make a duplicate draft.";
    if (!(await this.#d.autopilot?.alone(customerId, trustKey(d.platform, d.kind)))) return "They want to review sends on this platform. Leave it on its card, or send it with their_words when they told you in this turn to post it.";
    return (await this.#start(d, true)) ?? "Publishing the existing draft. Wait for its verified outcome; do not make a duplicate draft.";
  }

  /** A button on a draft's card. Returns the few words the press is acknowledged with. */
  async act(customerId: CustomerId, id: DraftId, action: DraftAction): Promise<string> {
    const draft = await this.#d.drafts.get(id);
    if (!draft || draft.customerId !== customerId) return "That one is no longer here";
    if (draft.status === "posted") return "Already posted";
    if (action === "retry" && ["posting", "uncertain"].includes(draft.status)) {
      if (this.#d.errands.running(errand(draft))) return "Still sending; wait for its outcome";
      if (this.#d.autopilot?.switchedOff(customerId)) return OFF_ACK;
      await this.#d.drafts.endPost(id, false);
      const reopened = await this.#d.drafts.get(id);
      if (!reopened) return "That one is no longer here";
      return (await this.#start(reopened, false)) ?? "Sending it after your check…";
    }
    if (draft.status === "posting" || draft.status === "uncertain") return "It may have gone up: look first";
    if (draft.status !== "open") return "That one is closed";
    if (this.#d.errands.running(errand(draft))) return "Already posting it";
    if (action === "post" && this.#d.autopilot?.switchedOff(customerId)) return OFF_ACK;
    // Edit asks what should change, their reply box open on the question: a toast alone left them guessing (2026-10-14).
    if (action === "edit") {
      // Changing it takes it out of the line: what goes up is what they settle on, on a tap.
      if (await this.#d.outbox.drop({ draftId: id }, "they are editing it")) await this.#redraw(draft);
      const under = draft.cardRef ?? (await this.#d.deck?.ref(customerId)) ?? null;
      const asked = under ? await this.#d.messenger.askEdit(customerId, under) : null;
      if (!asked) return "Reply to it with your changes";
      await this.#d.drafts.addRef(id, asked);
      return "";
    }
    if (action === "skip") {
      await this.#d.outbox.drop({ draftId: id }, "skipped");
      const skipped = await this.#d.drafts.skip(id);
      if (!skipped) return "Already closed";
      await this.#redraw(skipped);
      return "Skipped";
    }
    return (await this.#start(draft, false)) ?? "Posting it from your Chrome…";
  }

  /**
   * New words for a draft still on its card; the card shows them at once. Their own words (`theirs`) go on as
   * they wrote them; words rewritten from their note go through the writer, which reads that note among their last messages.
   */
  async revise(customerId: CustomerId, id: DraftId, text: string, title: string | null, theirs = false): Promise<Draft | string> {
    const draft = await this.#d.drafts.get(id);
    if (!draft || draft.customerId !== customerId) return "there is no such draft";
    if (draft.status !== "open") return draft.status === "posted" ? "it is already up" : "it was skipped";
    if (this.#d.errands.running(errand(draft))) return "it is going up right now";
    if (WORDLESS.has(draft.kind)) return `a ${draft.kind} has no words to change: skip it and draft another`;
    if (!text.trim()) return "the draft is empty";
    await this.#d.outbox.drop({ draftId: id }, "its words changed");
    const asked = { ...draft, text: text.trim(), title: title?.trim() || draft.title };
    const written = theirs ? asked : await this.#inTheirVoice(asked);
    const words = unstyled(written.text.trim());
    const revised = await this.#d.drafts.revise(id, words, title?.trim() ? unstyled((written.title ?? title).trim()) : null);
    if (!revised) return "it is no longer open";
    // Their own words in place of Quest's: this kind is not yet written the way they would.
    if (theirs) void this.#d.marks?.edited(id);
    this.#d.autopilot?.note(customerId, "Quest", `rewrote ${draftLabel(revised)}`);
    await this.#redraw(revised);
    return revised;
  }

  /**
   * Their note on an open draft's card (a reply to it, typed or said, or their answer to Edit): the writer puts it
   * into the words, and the card comes back under the note with its buttons, the older copy without them. Returns
   * what the manager should know of it; null when the message is no open draft's card or the writer could not do it,
   * and the manager takes the note. Live, 2026-10-14: a voice note on a card ("say nothing about Messaging Quest")
   * got a 👍 from the manager and no change.
   */
  async applyNote(customerId: CustomerId, ref: string, note: string): Promise<string | null> {
    const d = await this.#d.drafts.byCard(customerId, ref);
    return d ? this.#note(customerId, d, note) : null;
  }

  /** The same for the draft the deck shows (Your move), when they replied to the deck. */
  async noteOnAsk(customerId: CustomerId, ask: Ask, note: string): Promise<string | null> {
    if (ask.kind !== "draft" || ask.draft.customerId !== customerId) return null;
    const d = await this.#d.drafts.get(ask.draft.id);
    return d ? this.#note(customerId, d, note) : null;
  }

  async #note(customerId: CustomerId, d: Draft, note: string): Promise<string | null> {
    if (d.status !== "open" || !this.#d.writer || WORDLESS.has(d.kind) || this.#d.errands.running(errand(d))) return null;
    await this.#d.outbox.drop({ draftId: d.id }, "their note changes it");
    const w = await this.#d.writer.write(customerId, { ...writingJob(d), note });
    if (!w.rewritten) return null;
    const max = d.platform !== "reddit" ? TITLE_MAX : d.kind === "message" ? SUBJECT_MAX : TITLE_MAX;
    const revised = await this.#d.drafts.revise(d.id, w.text, d.title && w.title && w.title.length <= max ? w.title : d.title);
    if (!revised) return null;
    void this.#d.marks?.edited(d.id);
    this.#d.autopilot?.note(customerId, "Quest", `rewrote ${draftLabel(revised)} from their note`);
    await this.#showAgain(d, revised);
    return noteApplied(`the card of ${draftLabel(revised)} (draft ${d.id})`, revised.text);
  }

  /** The card comes back at the bottom of the chat with its buttons, the older copy without them; on the deck, the deck does. */
  async #showAgain(d: Draft, revised: Draft): Promise<void> {
    if (!d.cardRef && this.#d.deck) return this.#d.deck.changed(d.customerId, { down: askKeys.draft(d.id), last: null });
    const shown = await this.#d.messenger.showDraft(d.customerId, revised, true);
    if (shown) {
      await this.#d.drafts.moveCard(d.id, shown);
      if (d.cardRef) await this.#d.messenger.closeCard(d.customerId, d.cardRef);
    } else await this.#redraw(revised);
  }

  /** For a reply to a draft's card: which draft it was and its words now, for the manager. Null when the message is no draft's card. */
  async aboutCard(customerId: CustomerId, ref: string): Promise<string | null> {
    const d = await this.#d.drafts.byCard(customerId, ref);
    return d ? this.#about(d) : null;
  }

  async aboutAsk(customerId: CustomerId, ask: Ask): Promise<string | null> {
    if (ask.kind !== "draft" || ask.draft.customerId !== customerId) return null;
    const d = await this.#d.drafts.get(ask.draft.id);
    return d ? this.#about(d) : null;
  }

  #about(d: Draft): string {
    const state = d.status === "open" ? "open" : d.status === "posted" ? "already up" : "skipped";
    return `(Their reply to the card of ${draftLabel(d)}: draft ${d.id}, ${state}.${d.title ? ` Title: "${d.title}".` : ""} Its words now: "${d.text}")`;
  }

  /**
   * Puts it in line to go up (outbox.ts): null when it is on its way, or waits there on trust; `QUEUED` when their
   * Chrome is not there and it waits for it; otherwise why not, in the words a tap is answered with.
   */
  /** Why a platform's day has no room for this one, counting what went up in the last day, is going up or waits in line. */
  async #overDay(customerId: CustomerId, draft: Parameters<typeof dayLimit>[0], id: Draft["id"] | null): Promise<string | null> {
    return dayLimit(draft, await this.#dayCount(customerId, id, true));
  }

  /** What counts against the day's limits: what went up in the last day, is going up, and (`line`) what waits in line. */
  async #dayCount(customerId: CustomerId, id: Draft["id"] | null, line: boolean): Promise<Draft[]> {
    const since = new Date(this.#d.clock.now().getTime() - DAY_MS);
    const inLine = line ? new Set((await this.#d.outbox.waiting(customerId)).map((o) => o.draftId)) : new Set<string | null>();
    return (await this.#d.drafts.recent(customerId, 300)).filter((d) => d.id !== id && ((d.sentAt && d.sentAt >= since) || d.status === "posting" || inLine.has(d.id)));
  }

  /**
   * A day's limit full: it joins the line for when the day has room (the founder, 2026-11-15: "If I hit a limit for posts,
   * it should schedule it instead of blocking it. Your move must never block any records, it has to move forward").
   * Null when it is scheduled (the deck turns past it), else why it cannot go at all.
   */
  async #schedule(draft: Draft, alone: boolean, words: boolean, over: string, counted: readonly Draft[]): Promise<string | null> {
    const now = this.#d.clock.now();
    const at = limitFreesAt(draft, counted, now);
    if (!at) return over;
    const item = { customerId: draft.customerId, ref: { draftId: draft.id }, site: draft.platform, approved: alone ? "trust" : words ? "words" : "tap", light: draft.kind === "like" || draft.kind === "follow" } as const;
    if (!(await this.#d.outbox.schedule(item, at, "the day's limit"))) return over;
    const hours = Math.max(1, Math.round((at.getTime() - now.getTime()) / 3_600_000));
    const when = `in about ${hours} h`;
    this.#d.autopilot?.note(draft.customerId, "Quest", `scheduled ${draftLabel(draft)} ${when}: ${platformName(draft.platform)}'s day limit is full`);
    if (!alone) await this.#d.deck?.changed(draft.customerId, { last: `Scheduled ${when}: ${draftLabel(draft)}` });
    return alone ? null : `Scheduled: it goes up by itself ${when}, when ${platformName(draft.platform)}'s day has room`;
  }

  async #start(draft: Draft, alone: boolean, words = false): Promise<string | null> {
    const avoided = (await this.#d.places.listFor(draft.customerId)).find((p) => placeKeys(draft.url).includes(p.key) && p.verdict === "avoid");
    if (avoided) return `${avoided.name} is on your avoid list`;
    // By itself Quest never puts up a second reply where one went up; a tap is theirs to make.
    if (alone && draft.kind === "reply") {
      const refused = await this.#secondReply(draft, (await this.#d.drafts.recent(draft.customerId, 300)).filter((d) => d.id !== draft.id), true);
      if (refused) return refused;
    }
    // A tap holds to one post a week in a community too: two cards drafted before the rule (live, 2026-10-04).
    // Reddit's only, as when it is drafted (live, 2026-11-15: their launch news went up on four sites, and the tries
    // again on Bluesky and Peerlist were refused as copies of the one on Facebook).
    if (draft.kind === "post" && draft.platform === "reddit") {
      const weekAgo = this.#d.clock.now().getTime() - WEEK_MS;
      const up = (await this.#d.drafts.recent(draft.customerId, 50)).filter(
        (d) => d.id !== draft.id && d.kind === "post" && d.status === "posted" && (d.sentAt?.getTime() ?? 0) > weekAgo,
      );
      if (up.some((d) => d.platform === draft.platform && d.target.toLowerCase() === draft.target.toLowerCase())) return `Your post in ${draft.target} went up this week. One a week there`;
      const copy = up.find((d) => alike(d.text, draft.text));
      if (copy) return `Nearly the same post went up in r/${copy.target} this week. Twice reads as spam: Edit it first`;
    }
    // Each platform's day limit for its kind (posts, messages, likes and follows, profile changes); replies have none.
    // What waits in line or is going up counts too: "Do all" on a profile check taps them all before any is up.
    const counted = await this.#dayCount(draft.customerId, draft.id, true);
    const over = dayLimit(draft, counted);
    if (over) return this.#schedule(draft, alone, words, over, counted);
    const queued = await this.#d.outbox.enqueue({ customerId: draft.customerId, ref: { draftId: draft.id }, site: draft.platform, approved: alone ? "trust" : words ? "words" : "tap", light: draft.kind === "like" || draft.kind === "follow" });
    if (typeof queued === "string") return queued;
    if (!queued.waits || alone) {
      // On its way: the deck turns past it now, not once it is up (a post can take half a minute).
      if (!alone && this.#d.deck) {
        const now = (await this.#d.drafts.get(draft.id)) ?? draft;
        await this.#d.deck.changed(draft.customerId, { last: draftLine(now.status === "open" ? { ...now, status: "posting" } : now) });
      }
      return null;
    }
    await this.#redraw({ ...draft, waiting: true });
    return QUEUED;
  }

  errand(item: OutboxItem): string {
    return `draft:${item.draftId}`;
  }

  /**
   * Its turn in the line: what can change while it waited is looked at again (still on its card, Quest still trusted
   * there, no reply of theirs under that post since), then it goes up.
   */
  async #toSomeoneWhoSaidNo(d: Pick<Draft, "customerId" | "kind" | "url" | "target" | "author">): Promise<Refusal | null> {
    if (d.kind === "post" || d.kind === "profile") return null;
    return (await this.#d.saidNo?.who(d.customerId, d.url, [d.author, isAddress(d.target) ? null : d.target]).catch(() => null)) ?? null;
  }

  /**
   * Someone asked to be left alone: their no is kept, and whatever waits for them, on a card or in the outbox, is
   * skipped. Returns how many were.
   */
  async leaveAlone(customerId: CustomerId, url: string, person: string, words: string): Promise<number> {
    if (!this.#d.saidNo) return 0;
    await this.#d.saidNo.note(customerId, url, person, words);
    let skipped = 0;
    for (const d of (await this.#d.drafts.recent(customerId, 400)).filter((d) => d.status === "open")) {
      if (!(await this.#toSomeoneWhoSaidNo(d)) && !(await this.#d.saidNo.tagged(customerId, d.text).catch(() => null))) continue;
      await this.#d.outbox.drop({ draftId: d.id }, "they asked to be left alone");
      const closed = await this.#d.drafts.skip(d.id);
      if (closed) await this.#redraw(closed).catch(() => undefined);
      skipped += closed ? 1 : 0;
    }
    this.#d.log.info("drafts.left_alone", { customerId, person, skipped });
    return skipped;
  }

  async send(item: OutboxItem, stopping: AbortSignal): Promise<SendOutcome> {
    const draft = item.draftId ? await this.#d.drafts.get(item.draftId) : null;
    if (!draft || draft.status !== "open") return "dropped";
    // A no that came while it waited: it goes nowhere, tapped or not (words they dictated are never in doubt here: a
    // draft keeps no mark of them, and a no outweighs a tap made before it).
    if (await this.#toSomeoneWhoSaidNo(draft)) {
      const closed = await this.#d.drafts.skip(draft.id);
      if (closed) await this.#redraw(closed).catch(() => undefined);
      return "dropped";
    }
    const alone = item.approved === "trust";
    if (alone && !(await this.#d.autopilot?.alone(draft.customerId, trustKey(draft.platform, draft.kind)))) return "dropped";
    if (alone && draft.kind === "reply" && (await this.#secondReply(draft, (await this.#d.drafts.recent(draft.customerId, 300)).filter((d) => d.id !== draft.id), true))) return "dropped";
    // A scheduled one (or two taps past the limit at once) waits again while the day has no room: only what went up counts here.
    const sent = await this.#dayCount(draft.customerId, draft.id, false);
    if (dayLimit(draft, sent)) {
      const at = limitFreesAt(draft, sent, this.#d.clock.now());
      return at ? { at, reason: "the day's limit" } : "dropped";
    }
    return this.#postNow(draft, alone, stopping);
  }

  async back(item: OutboxItem): Promise<void> {
    await this.#d.deck?.changed(item.customerId);
  }

  /** Out of line after waiting days for their Chrome: its card is as it was, buttons and all. */
  async expired(item: OutboxItem): Promise<void> {
    const draft = item.draftId ? await this.#d.drafts.get(item.draftId) : null;
    if (draft?.status !== "open") return;
    this.#d.autopilot?.note(draft.customerId, "Quest", `took ${draftLabel(draft)} out of the outbox: their Chrome was away for days`);
    await this.#redraw(draft);
  }

  /**
   * At start: a draft still claimed as posting was being posted by a machine that stopped before it knew how it went
   * (Fly killed it, or it crashed), so nobody can tell whether it went up. It turns uncertain, its card offers "Not
   * there, post again", and they hear it once; it is never sent again by itself. Live, 2026-10-17: a deploy killed a
   * post on X, and its card answered every tap with "It may have gone up: look first", with no way to post it again.
   */
  async recoverPosts(): Promise<number> {
    const left = await this.#d.drafts.leftPosting();
    for (const draft of left) {
      try {
        await this.#d.drafts.endPost(draft.id, true);
        this.#d.log.warn("drafts.post_lost", { draftId: draft.id, customerId: draft.customerId });
        // Nothing said: Quest looks at its page later itself (HeldCheck).
        const held = await this.#d.drafts.get(draft.id);
        if (held) await this.#redraw(held);
      } catch (e) {
        this.#d.log.error("drafts.recover_failed", { draftId: draft.id, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return left.length;
  }

  /** Whether the site said it takes no more of this kind from them for now. */
  #atLimit(d: Pick<Draft, "customerId" | "platform" | "kind">): boolean {
    return (this.#limited.get(`${d.customerId} ${d.platform} ${d.kind}`) ?? 0) > this.#d.clock.now().getTime();
  }

  async #postNow(draft: Draft, alone: boolean, stopping?: AbortSignal): Promise<SendOutcome> {
    if (this.#atLimit(draft)) return "limited";
    if (!(await this.#d.drafts.beginPost(draft.id, alone))) return "dropped";
    const label = draftLabel(draft);
    let posted: ChromePosted;
    try {
      const files = draft.assets?.length && this.#d.files ? await this.#d.files.files(draft.customerId, draft.assets) : [];
      if (draft.assets?.length && files.length < draft.assets.length) throw new ChromeError("unavailable", "Could not read their picture from the chat to attach it; nothing was sent.");
      posted = await this.#d.poster.post(draft.customerId, chromePost(draft, files, draft.kind === "reply" ? (await this.#toThem(draft)).map((d) => d.text) : []), stopping);
    } catch (e) {
      const reason = e instanceof ChromeError ? e.reason : "error";
      const uncertain = reason === "uncertain" || reason === "timeout" || reason === "error";
      await this.#d.drafts.endPost(draft.id, uncertain);
      this.#d.log.warn("drafts.post_failed", { draftId: draft.id, reason, error: String(e) });
      // Their Chrome is not there: nothing went out, and it waits in line for the Chrome to come back, no word said.
      if (reason === "offline") {
        if (!alone) await this.#redraw({ ...draft, waiting: true });
        return "waits";
      }
      // Their Chrome took the page and never answered (frozen, or its window asleep): nothing went out, and it waits in line
      // like a Chrome that is gone (live, 2026-11-14: five replies failed so in 40 minutes and went back to cards).
      if (reason === "unavailable" && e instanceof Error && /Could not open the destination/.test(e.message) && /took too long/.test(e.message)) {
        if (!alone) await this.#redraw({ ...draft, waiting: true });
        return "waits";
      }
      // A sign-in wall: nothing more is drafted there until they signed in (their tap on the card tries again).
      if (reason === "login") this.#signedOut.set(`${draft.customerId} ${draft.platform}`, this.#d.clock.now().getTime() + SIGNED_OUT_MS);
      // The site takes no more of these for now: nothing went up, and no tap would help, so it goes by itself once the limit passed.
      if (e instanceof SiteLimit) {
        this.#limited.set(`${draft.customerId} ${draft.platform} ${draft.kind}`, this.#d.clock.now().getTime() + LIMIT_WAIT_MS);
        this.#d.autopilot?.note(draft.customerId, "Chrome", `${label} waits: ${e.message}`);
        if (!alone) await this.#d.messenger.say(draft.customerId, `${platformName(draft.platform)} takes no more of these today, so ${label} goes up by itself tomorrow.`);
        await this.#redraw({ ...draft, waiting: true });
        return "limited";
      }
      // They answered there themselves (by hand, or from their phone): the thread is theirs, nothing went up, and the card goes.
      if (e instanceof AlreadyAnswered) {
        this.#d.autopilot?.note(draft.customerId, "Quest", `left ${label}: they already answered there`);
        const closed = await this.#d.drafts.skip(draft.id, true);
        if (!alone) await this.#d.messenger.say(draft.customerId, `You already answered there yourself, so ${label} didn't go up.`);
        if (closed) await this.#redraw(closed);
        return "dropped";
      }
      // It can never go up (comments off, the post deleted): the card goes, or it would come back on every try (live,
      // 2026-11-05: a LinkedIn reply on a post with comments off failed seven times, tapped each time).
      if (reason === "gone") {
        const why = e instanceof Error ? e.message : "";
        this.#d.autopilot?.note(draft.customerId, "Quest", `dropped ${label}: ${why}`);
        const closed = await this.#d.drafts.skip(draft.id);
        if (!alone) await this.#d.messenger.say(draft.customerId, `I dropped ${label}, it can't go up: ${why}`);
        if (closed) await this.#redraw(closed);
        return "dropped";
      }
      this.#d.autopilot?.note(draft.customerId, "Chrome", `could not post ${label}: ${reason}`);
      // A like or a follow Quest does by itself that did not go is let go: left open it came back as an ask on Your move
      // (live, 2026-11-12: with likes and follows on trust everywhere, the failed ones still asked for a tap).
      if (alone && WORDLESS.has(draft.kind) && !uncertain) {
        await this.#d.drafts.skip(draft.id);
        return "dropped";
      }
      if (e instanceof TooLong) {
        await this.#shorten(draft, e);
        return "failed";
      }
      // Going up by itself, a failure says nothing: the card keeps its buttons, and a tap asks again. A send it could not see
      // land says nothing either, and waits on nobody: Quest looks at its page later itself (HeldCheck; the founder,
      // 2026-11-04: "I would rather ignore those and the agent can check on itself later").
      const action = BROWSER_ONLY.has(draft.kind);
      if (!uncertain && !alone) await this.#d.messenger.say(draft.customerId, action ? notDone(e, label, platformName(draft.platform), doneWords(draft.kind, draft.platform).button) : notPosted(e, label, platformName(draft.platform)));
      const held = await this.#d.drafts.get(draft.id);
      if (held) await this.#redraw(held);
      return uncertain ? "held" : "failed";
    }
    this.#d.log.info("drafts.posted", { draftId: draft.id, customerId: draft.customerId, kind: draft.kind, alone });
    const sent = await this.#d.drafts.markSent(draft.id, posted.url, posted.account, alone);
    if (!sent) return "sent";
    // Equivalent open cards cannot later resend what this verified record already sent, and no other card puts a second reply where this one went.
    const spot = sent.kind === "reply" ? replyAt(sent) : null;
    for (const pending of await this.#d.drafts.recent(draft.customerId, 100)) {
      const twin = (sameDestination(pending, sent) && pending.text === sent.text && pending.title === sent.title) || (spot !== null && pending.kind === "reply" && replyAt(pending) === spot);
      if (pending.id !== sent.id && pending.status === "open" && twin) {
        const closed = await this.#d.drafts.skip(pending.id);
        if (closed) await this.#redraw(closed);
      }
    }
    // The last check, after the fact: two replies of theirs in one place, to the same words, should never be. If it
    // happened anyway, replies stop there for a day and they are told (brakes.ts).
    if (sent.kind === "reply" && spot) {
      const q = (s: string | null | undefined): string => (s ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().slice(0, 60);
      const twin = (await this.#toThem(sent)).find((d) => d.status === "posted" && replyAt(d) === spot && q(d.quote) === q(sent.quote));
      if (twin) {
        this.#d.log.error("drafts.duplicate", { customerId: sent.customerId, draftId: sent.id, earlier: twin.id, platform: sent.platform });
        await this.#d.autopilot?.brake(sent.customerId, sent.platform, "reply", `two replies went up to ${sent.target} in one place`).catch(() => undefined);
      }
    }
    this.#d.autopilot?.note(draft.customerId, "Chrome", `posted ${label}${alone ? " by itself" : " on your tap"}: ${posted.url}`);
    // A reply or a post is looked at again for answers (ReplyWatch), on every site; a message's answers go to their inbox,
    // and a like, a follow or a profile has none.
    if (sent.kind === "reply" || sent.kind === "post") await this.#d.drafts.watch(sent.id, nextLook(sent.sentAt ?? this.#d.clock.now(), 0), 0, []);
    await this.#redraw(sent);
    if (!alone) await this.#d.autopilot?.approved(sent.customerId, trustKey(sent.platform, sent.kind));
    if (BROWSER_ONLY.has(sent.kind)) {
      if (!alone || sent.kind === "profile") await this.#d.events?.push(sent.customerId, { kind: "system", topic: "published", text: `Verified ${draftLabel(sent)}, draft ${sent.id}: ${sent.sentUrl}.` });
      // What went up by itself wakes no turn: the reply watch brings its answers (live, 2026-11-16: 220 wake-ups in two
      // days, and 63 runs the manager started from them, 46M tokens, doing what the watch and step two already do). A
      // message always waits for a tap, so its send still wakes the manager, since no watch follows it.
    } else if (sent.platform !== "reddit" && !alone) await this.#d.events?.push(sent.customerId, { kind: "system", topic: "published", text: `Verified ${sent.kind} on ${sent.platform}, draft ${sent.id}, to ${sent.target}: ${sent.sentUrl}. Follow this conversation through outreach; replies and outcomes matter more than the send.` });
    return "sent";
  }

  /**
   * Too long for the field it goes in (X's bio takes 160 characters): the writer cuts it to fit, and its card comes
   * back for a tap, since these are words they haven't seen. Live, 2026-10-15: a 174-character bio for X went round
   * the poster 26 times, and twice the card said only "try again".
   */
  async #shorten(draft: Draft, e: TooLong): Promise<void> {
    const label = draftLabel(draft);
    const w = this.#d.writer ? await this.#d.writer.write(draft.customerId, { ...writingJob(draft), chars: e.limit }) : null;
    const text = w?.rewritten ? unstyled(w.text.trim()) : "";
    const revised = text && text.length <= e.limit ? await this.#d.drafts.revise(draft.id, text, draft.title) : null;
    if (!revised) {
      await this.#d.messenger.say(draft.customerId, notPosted(e, label, platformName(draft.platform)));
      const held = await this.#d.drafts.get(draft.id);
      if (held) await this.#redraw(held);
      return;
    }
    this.#d.autopilot?.note(draft.customerId, "Quest", `cut ${label} to ${text.length} characters: the field takes ${e.limit}`);
    await this.#d.messenger.say(draft.customerId, `Too long: ${label} had ${e.length} characters, and the field takes ${e.limit}. I cut it to fit: tap ${doneWords(draft.kind, draft.platform).button} on the new version if it reads right.`);
    await this.#showAgain(draft, revised);
  }

  /** Its card shows what became of it, and the deck turns past it (or shows what it came to). */
  async #redraw(draft: Draft): Promise<void> {
    try {
      if (draft.cardRef) await this.#d.messenger.updateDraft(draft.customerId, draft.cardRef, draft);
      await this.#d.deck?.changed(draft.customerId, { last: draftLine(draft) });
    } catch (e) {
      this.#d.log.warn("drafts.redraw_failed", { draftId: draft.id, error: String(e) });
    }
  }
}

const errand = (d: Draft): string => `draft:${d.id}`;

/** A tap on a card's post button while they switched Quest off. */
export const OFF_ACK = "Quest is off: switch it on to post";

/** Where a reply goes, as one key (one-reply.ts). */
const replyAt = (d: Pick<Draft, "platform" | "url" | "target">): string | null => replySpot(d.url, d.platform === "reddit" ? d.target : null, d.target);

/** Words only, for telling a quote in a longer text. */
const wordsOf = (s: string): string => s.toLowerCase().replace(/[’‘]/g, "'").replace(/[^\p{L}\p{N}']+/gu, " ").trim();

const sameDestination = (a: Pick<Draft, "kind" | "platform" | "target" | "url">, b: Pick<Draft, "kind" | "platform" | "target" | "url">): boolean =>
  a.kind === b.kind && a.platform === b.platform && a.target.toLowerCase() === b.target.toLowerCase() && (a.kind === "message" || a.url === b.url);

/** Runs of three words, for telling a reworded post from a copied one. */
const triples = (s: string): Set<string> => {
  const w = s.toLowerCase().split(/[^\p{L}\p{N}']+/u).filter(Boolean);
  return new Set(w.slice(2).map((_, i) => `${w[i]} ${w[i + 1]} ${w[i + 2]}`));
};

/**
 * A person's own page rather than one post on it: x.com/<handle>, threads.com/@<handle>, instagram.com/<handle>/,
 * youtube.com/@<handle>, linkedin.com/in/<slug>.
 */
export function profileAddress(url: string): boolean {
  const u = parse(url);
  if (!u) return false;
  const parts = u.pathname.split("/").filter(Boolean);
  if (/(^|\.)linkedin\.com$/i.test(u.hostname)) return parts[0] === "in" && parts.length <= 2;
  return parts.length === 1 && !u.search && !/^(watch|shorts|p|reel|reels|status|post|search|explore|results|feed|home|notifications|messages)$/i.test(parts[0]!);
}

/** Whether two texts share most of their wording: half or more of their three-word runs. */
export function alike(a: string, b: string): boolean {
  const x = triples(a);
  const y = triples(b);
  if (!x.size || !y.size) return false;
  let shared = 0;
  for (const t of x) if (y.has(t)) shared++;
  return shared / Math.min(x.size, y.size) >= 0.5;
}
