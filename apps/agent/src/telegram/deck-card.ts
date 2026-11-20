import { customerLocale, forLanguage, systemMessage, textPrefix } from "@mq/i18n";
import type { Ask, DeckView, Draft } from "@mq/core";
import { trustOffer } from "../asks/deck.ts";
import { platformName } from "../drafts/autopilot.ts";
import type { TgInlineButton } from "./bot-api.ts";
import { draftButtons, draftCardHtml } from "./draft-card.ts";
import { findButtons, findCardHtml } from "./find-card.ts";
import { choiceData, deckData, ideaData } from "./updates.ts";

const escape = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const attr = (s: string): string => escape(s).replace(/"/g, "&quot;");
const clip = (s: string, max: number): string => (s.length > max ? `${textPrefix(s, max - 1)}…` : s);
/** A group's lines shown on the deck; their page has every one. */
const GROUP_LINES = 8;

/** A like's or a follow's line in a group: whose post or who, linked, and the post's first words; a profile change's: the field and its new words. */
const groupLine = (d: Draft): string => {
  if (d.kind === "profile") return `• <b>${escape(d.target)}</b>: “${escape(clip(d.text, 160))}”`;
  const name = escape(d.author ?? (d.kind === "follow" ? d.target : "") ?? "");
  const link = `<a href="${attr(d.url)}">${name || escape(platformName(d.platform))}</a>`;
  return d.kind === "like" && d.quote ? `• ${link}: “${escape(clip(d.quote, 90))}”` : `• ${link}`;
};

/** A site as a button names it: "X", "Threads", "LinkedIn"; else its host. */
const SITE_NAMES: Readonly<Record<string, string>> = {
  reddit: "Reddit",
  "x.com": "X",
  "threads.com": "Threads",
  "threads.net": "Threads",
  "linkedin.com": "LinkedIn",
  "instagram.com": "Instagram",
  "tiktok.com": "TikTok",
  "youtube.com": "YouTube",
  "facebook.com": "Facebook",
  "bsky.app": "Bluesky",
};
const siteName = (url: string, platform: string): string => {
  try {
    const host = new URL(url).hostname.replace(/^(www|old|m|mobile)\./, "").replace(/^twitter\.com$/, "x.com");
    return SITE_NAMES[host] ?? SITE_NAMES[platform] ?? host;
  } catch {
    return SITE_NAMES[platform] ?? platform;
  }
};

/**
 * A reply or a message on the deck: what it answers and the words that go up, nothing else (the founder, 2026-11-04:
 * "only a quote and the reply text, no distractions. Links can be added as buttons").
 */
const replyHtml = (quote: string | null, text: string, to: string | null = null): string =>
  [to ? `<i>${escape(to)}</i>` : null, quote ? `<blockquote>${escape(clip(quote, 500))}</blockquote>` : null, escape(clip(text, 3000))].filter(Boolean).join("\n\n");

/**
 * Whom it goes to as the site writes them: "u/maya" on Reddit; elsewhere a handle (a message's target) as "@maya", and
 * an author as given, which may be a display name.
 */
const handle = (platform: string, who: string | null, isHandle = false): string | null => {
  const name = who?.trim();
  if (!name) return null;
  if (platform === "reddit") return /^u\//i.test(name) ? name : `u/${name}`;
  return isHandle && /^[\w.]+$/.test(name) ? `@${name}` : name;
};

/** The button that opens what it answers, named by whom and where: "@maya on X". */
const openButton = (url: string, platform: string, who: string | null, language: string | null, isHandle = false): TgInlineButton[] => {
  const t = forLanguage(language);
  const where = siteName(url, platform);
  const name = handle(platform, who, isHandle);
  return [{ text: textPrefix(name ? t("{name} on {site}", { name, site: where }) : t("Open on {site}", { site: where }), 60), url }];
};

/**
 * A private message's ask says whom it goes to, and its button opens their profile (live, 2026-11-05: a message to
 * @georgesh0 on Threads, with no quote, showed only its words, and the founder could not tell whom he was writing to).
 */
const messageTo = (d: Draft, language: string | null): string | null =>
  d.kind === "message" ? forLanguage(language)("Private message to {name}", { name: handle(d.platform, d.target ?? d.author, Boolean(d.target)) ?? siteName(d.url, d.platform) }) : null;

/** Whether an ask shows as a reply only: a find's reply, or a draft of words to someone, while it waits on them. */
const replyOnly = (a: Ask): boolean =>
  (a.kind === "find" && !a.find.waiting && a.find.postState !== "posting") ||
  (a.kind === "draft" && (a.draft.kind === "reply" || a.draft.kind === "message") && a.draft.status === "open" && !a.draft.waiting);

/** The ask as its card showed it, and its own buttons (the same data as the card's, so the same services answer them). */
export function askBody(a: Ask, now: Date, language: string | null): { readonly html: string; readonly buttons: TgInlineButton[][] } {
  const t = forLanguage(language);
  const locale = customerLocale(language);
  switch (a.kind) {
    case "find":
      if (replyOnly(a)) return { html: replyHtml(a.find.quote, a.find.reply), buttons: [...findButtons(a.find, locale), openButton(a.find.url, a.find.source.split(":")[0] ?? "", a.find.author, language)] };
      return { html: findCardHtml(a.find, now, locale), buttons: findButtons(a.find, locale) };
    case "draft":
      if (replyOnly(a)) {
        const d = a.draft;
        const who = d.kind === "message" ? (d.target ?? d.author) : d.author;
        return { html: replyHtml(d.quote, d.text, messageTo(d, language)), buttons: [...draftButtons(d, locale), openButton(d.url, d.platform, who, language, d.kind === "message" && Boolean(d.target))] };
      }
      return { html: draftCardHtml(a.draft, locale), buttons: draftButtons(a.draft, locale) };
    case "trust": {
      const offer = trustOffer(a.platform);
      return {
        html: escape(t(offer.text, { platform: offer.platform })),
        buttons: [[{ text: t("Yes, go ahead"), callback_data: deckData("yes", a.key) }, { text: t("Keep asking me"), callback_data: deckData("no", a.key) }]],
      };
    }
    case "question": {
      const q = a.question;
      const how = q.options.length ? "Tap an answer, or reply to this message in your own words." : "Reply to this message with your answer.";
      return {
        html: `<b>${escape(q.text)}</b>\n\n<i>${escape(t(how))}</i>`,
        buttons: q.options.map((o, i) => [{ text: textPrefix(o, 60), callback_data: choiceData(q.id, i) }]),
      };
    }
    case "idea": {
      const i = a.idea;
      const head = i.platform ? t("Idea for a post on {place}", { place: i.platform }) : t("Idea for a post");
      return {
        html: [`<b>${escape(head)}</b>`, escape(i.text), i.assets.length ? `${escape(t("With your picture"))}` : null].filter(Boolean).join("\n"),
        buttons: [[{ text: t("Write it"), callback_data: ideaData(i.id, "yes") }, { text: t("Not this one"), callback_data: ideaData(i.id, "no") }]],
      };
    }
    case "group": {
      const n = a.drafts.length;
      const head =
        a.what === "profile"
          ? t("Profile check on {platform}", { platform: platformName(a.platform) })
          : t(a.what === "like" ? "{count} likes on {platform}" : "{count} follows on {platform}", { count: n, platform: platformName(a.platform) });
      const more = n > GROUP_LINES ? t("…and {count} more", { count: n - GROUP_LINES }) : null;
      return {
        html: [`<b>${escape(head)}</b>`, ...a.drafts.slice(0, GROUP_LINES).map(groupLine), more ? escape(more) : null].filter(Boolean).join("\n"),
        buttons: [
          [{ text: t("Do all {count}", { count: n }), callback_data: deckData("all", a.key) }],
          [
            { text: t("One by one"), callback_data: deckData("one", a.key) },
            { text: t("Skip all"), callback_data: deckData("none", a.key) },
          ],
        ],
      };
    }
  }
}

/** An ask in parts, for a surface that draws its own card (the extension's popup): whom it goes to, what it answers, the words. */
export interface AskParts {
  /** "Private message to @maya"; null for a reply. */
  readonly head: string | null;
  /** The post's own address, named "@maya on X". */
  readonly link: { readonly label: string; readonly url: string } | null;
  readonly quote: string | null;
  /** The words that go up, for a reply or a message. */
  readonly text: string | null;
  /** Anything else (a group, a question, an offer) as its card shows it. */
  readonly html: string | null;
  /** Its buttons that ask Quest, in the card's order: the first is the one most taps want. */
  readonly buttons: readonly { readonly text: string; readonly data: string }[];
}

export function askParts(a: Ask, now: Date, language: string | null): AskParts {
  const body = askBody(a, now, language);
  const flat = body.buttons.flat();
  const buttons = flat.flatMap((b) => ("callback_data" in b ? [{ text: b.text, data: b.callback_data }] : []));
  const url = flat.find((b): b is Extract<TgInlineButton, { url: string }> => "url" in b);
  const link = url ? { label: url.text, url: url.url } : null;
  if (!replyOnly(a)) return { head: null, link, quote: null, text: null, html: body.html, buttons };
  if (a.kind === "find") return { head: null, link, quote: a.find.quote, text: a.find.reply, html: null, buttons };
  const d = (a as Extract<Ask, { kind: "draft" }>).draft;
  return { head: d.kind === "message" ? forLanguage(language)("Private message") : null, link, quote: d.quote, text: d.text, html: null, buttons };
}

/**
 * The deck in Telegram's HTML: "Your move · 2 of 6", what the last tap did, then the ask as its card shows it. A reply
 * shows only what it answers and its words; the tap's own answer says what the last one did.
 */
export function deckHtml(view: DeckView, now: Date, language: string | null): string {
  const t = forLanguage(language);
  const head = `<b>${escape(t("Your move"))}</b>${view.total > 1 ? ` · ${escape(t("{position} of {total}", { position: view.position, total: view.total }))}` : ""}`;
  const last = view.last ? `<i>${escape(systemMessage(language, view.last))}</i>` : null;
  if (!view.ask) return [head, last, `${escape(t("Nothing waits on you. New ones come here."))}`].filter(Boolean).join("\n\n");
  if (replyOnly(view.ask)) return askBody(view.ask, now, language).html;
  return [[head, last].filter(Boolean).join("\n"), askBody(view.ask, now, language).html].join("\n\n");
}

/** The ask's own buttons, then ‹ and › to move without deciding, and their page when the line is long. */
export function deckButtons(view: DeckView, language: string | null): TgInlineButton[][] {
  if (!view.ask) return [];
  const t = forLanguage(language);
  const nav: TgInlineButton[] = [
    ...(view.prev ? [{ text: "‹", callback_data: deckData("move", view.prev) }] : []),
    ...(view.next ? [{ text: "›", callback_data: deckData("move", view.next) }] : []),
  ];
  return [...askBody(view.ask, new Date(), language).buttons, ...(nav.length ? [nav] : [])];
}
