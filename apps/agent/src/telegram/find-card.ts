import { forLanguage, textPrefix } from "@mq/i18n";
import { SKIP_REASON_WORDS, SKIP_REASONS, sourceLabel, platformFor, type Find, type FindAction, type SkipReason } from "@mq/core";
import type { TgCallbackButton } from "./bot-api.ts";

/**
 * A find's buttons carry `f:<find id>:<code>`, well under Telegram's 64 bytes.
 * One letter per action: keep, skip, replied, post, edit, and the four skip reasons.
 */
const DECISION_CODES = { k: "kept", s: "skipped", r: "replied" } as const;
const REASON_CODES: Readonly<Record<string, SkipReason>> = { b: "not_my_buyer", t: "off_topic", o: "too_old", x: "other" };
const REASON_CODE: Readonly<Record<SkipReason, string>> = { not_my_buyer: "b", off_topic: "t", too_old: "o", other: "x" };
const POST_CODE = "p";
const EDIT_CODE = "e";

export const findData = (id: string, code: string): string => `f:${id}:${code}`;

const FIND = /^f:([0-9a-f-]{36}):([ksrpebtoxy])$/;

/** The action a find button stands for, or null if the data is not a find button. */
export function parseFindData(data: string): { findId: string; action: FindAction } | null {
  const m = FIND.exec(data);
  if (!m || m[1] === undefined || m[2] === undefined) return null;
  const code = m[2];
  if (code === POST_CODE) return { findId: m[1], action: { kind: "post" } };
  if (code === "y") return { findId: m[1], action: { kind: "retry_post" } };
  if (code === EDIT_CODE) return { findId: m[1], action: { kind: "edit" } };
  if (code in DECISION_CODES) return { findId: m[1], action: { kind: "decide", decision: DECISION_CODES[code as keyof typeof DECISION_CODES] } };
  const reason = REASON_CODES[code];
  return reason ? { findId: m[1], action: { kind: "reason", reason } } : null;
}

const escape = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const clip = (s: string, max: number): string => (s.length > max ? `${textPrefix(s, max - 1)}…` : s);

/** "3 days ago": how fresh the ask is matters more than its date. */
export function age(postedAt: Date | null, now: Date, locale = "en"): string | null {
  if (!postedAt) return null;
  if (locale !== "en") {
    const days = Math.max(0, Math.floor((now.getTime() - postedAt.getTime()) / 86_400_000));
    const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
    return days < 14 ? rtf.format(-days, "day") : days < 60 ? rtf.format(-Math.round(days / 7), "week") : days < 365 ? rtf.format(-Math.round(days / 30), "month") : rtf.format(-Math.floor(days / 365), "year");
  }
  const days = Math.floor((now.getTime() - postedAt.getTime()) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.round(days / 7)} weeks ago`;
  if (days < 365) return `${Math.round(days / 30)} months ago`;
  return "over a year ago";
}

const footer = (f: Find, locale: string): string | null => {
  const t = forLanguage(locale);
  switch (f.status) {
    case "kept":
      return `${t("Kept")}`;
    case "replied":
      return f.sentUrl
        ? `${t(f.sentAlone ? "Quest posted it" : "Posted")}${f.sentAs && f.sentAs !== "connected account" ? ` ${t("as {account}", { account: `${platformFor(f.url) === "reddit" ? "u/" : ""}${escape(f.sentAs)}` })}` : ""}: <a href="${escape(f.sentUrl).replace(/"/g, "&quot;")}">${t("see it")}</a>`
        : `${t("You replied")}`;
    case "skipped":
      return f.skipReason ? `${t("Skipped")}: ${t(SKIP_REASON_WORDS[f.skipReason]).toLocaleLowerCase(locale)}` : `${t("Skipped")}`;
    default:
      return null;
  }
};

/** The card, in Telegram's HTML. */
export function findCardHtml(f: Find, now = new Date(), locale = "en"): string {
  const t = forLanguage(locale);
  const head = [sourceLabel(f.source, f.url), f.author, age(f.postedAt, now, locale)].filter(Boolean).map((s) => escape(String(s)));
  const lines = [
    `<b>${head[0]}</b>${head.length > 1 ? ` · ${head.slice(1).join(" · ")}` : ""}`,
    f.title ? `<b>${escape(clip(f.title, 200))}</b>` : null,
    `<blockquote>${escape(clip(f.quote, 700))}</blockquote>`,
    `<i>${escape(clip(f.why, 400))}</i>`,
    "",
    `<b>${t("Reply:")}</b> ${escape(clip(f.reply, 1500))}`,
    "",
    `<a href="${escape(f.url).replace(/"/g, "&quot;")}">${t("Open the post")}</a>`,
  ];
  const end = footer(f, locale);
  if (end) lines.push("", end);
  if (f.postState === "posting") lines.push("", t("Sending started; awaiting confirmation."));
  if (f.postState === "uncertain") lines.push("", t("I can't tell if it went up. Look before posting it again."));
  // In the outbox (drafts/outbox.ts): their Chrome is closed, and the reply goes when the Chrome is back.
  if (f.waiting && !f.sentAt) lines.push("", t("Waiting for your Chrome. It goes up once Chrome is open."));
  return lines.filter((l) => l !== null).join("\n");
}

/**
 * Which buttons a card carries: decide while it is open, why after a skip, none
 * after that. Where Quest can post the reply (a Reddit thread), "Post it" leads,
 * and stays on a kept card.
 */
export function findButtons(f: Find, locale = "en"): TgCallbackButton[][] {
  const t = forLanguage(locale);
  if (f.postState === "posting" || f.postState === "uncertain") return [[{ text: t("Not there, post again"), callback_data: findData(f.id, "y") }]];
  // Its reply waits for their Chrome: already on its way, so only changing it, calling it off, or saying they replied.
  if (f.waiting && !f.sentAt) {
    return [
      [{ text: t("Edit"), callback_data: findData(f.id, EDIT_CODE) }],
      [
        { text: t("Skip"), callback_data: findData(f.id, "s") },
        { text: t("I replied"), callback_data: findData(f.id, "r") },
      ],
    ];
  }
  const post: TgCallbackButton[][] =
    (f.replyTo || platformFor(f.url) !== "reddit") && !f.sentAt
      ? [
          [
            { text: t("Post it"), callback_data: findData(f.id, POST_CODE) },
            { text: t("Edit"), callback_data: findData(f.id, EDIT_CODE) },
          ],
        ]
      : [];
  if (f.status === "shown" || f.status === "new") {
    return [
      ...post,
      [
        { text: t("Keep"), callback_data: findData(f.id, "k") },
        { text: t("Skip"), callback_data: findData(f.id, "s") },
        { text: t("I replied"), callback_data: findData(f.id, "r") },
      ],
    ];
  }
  if (f.status === "kept") return post;
  if (f.status === "skipped" && !f.skipReason) {
    const row = (reasons: readonly SkipReason[]): TgCallbackButton[] =>
      reasons.map((r) => ({ text: t(SKIP_REASON_WORDS[r]), callback_data: findData(f.id, REASON_CODE[r]) }));
    return [row(SKIP_REASONS.slice(0, 2)), row(SKIP_REASONS.slice(2))];
  }
  return [];
}
