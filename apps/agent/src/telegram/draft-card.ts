import { forLanguage, textPrefix } from "@mq/i18n";
import { isAddress, type Draft, type DraftAction } from "@mq/core";
import type { TgCallbackButton } from "./bot-api.ts";

/** A draft's buttons carry `d:<draft id>:<p|e|s>`: post it, edit it, or skip it. */
export const draftData = (id: string, action: DraftAction): string => `d:${id}:${action[0]}`;

const DRAFT = /^d:([0-9a-f-]{36}):([pesr])$/;
const ACTIONS: Readonly<Record<string, DraftAction>> = { p: "post", e: "edit", s: "skip", r: "retry" };

/** The action a draft button stands for, or null if the data is not a draft button. */
export function parseDraftData(data: string): { draftId: string; action: DraftAction } | null {
  const m = DRAFT.exec(data);
  if (!m || m[1] === undefined || m[2] === undefined) return null;
  return { draftId: m[1], action: ACTIONS[m[2]]! };
}

const escape = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const attr = (s: string): string => escape(s).replace(/"/g, "&quot;");
const clip = (s: string, max: number): string => (s.length > max ? `${textPrefix(s, max - 1)}…` : s);
const user = (name: string): string => `u/${name.replace(/^u\//i, "")}`;

/**
 * The card's first line: where it goes and to whom. A target that is only the page's address is
 * left out: the card's last line links there already, and a long address said it twice.
 */
function head(d: Draft, locale: string): string {
  const t = forLanguage(locale);
  const platform = d.platform === "reddit" ? "Reddit" : d.platform;
  if (d.kind === "like" || d.kind === "follow" || d.kind === "profile") {
    const what = t(d.kind === "like" ? "Like" : d.kind === "follow" ? (connects(d) ? "Ask to connect" : "Follow") : "Profile");
    const whom = d.kind === "profile" ? (isAddress(d.target) ? null : d.target) : (d.author ?? (isAddress(d.target) ? null : d.target));
    return `<b>${t("{kind} on {platform}", { kind: what, platform: escape(platform) })}</b>${whom ? ` · ${escape(whom)}` : ""}`;
  }
  if (d.platform !== "reddit") {
    const whom = isAddress(d.target) ? d.author : d.target;
    return `<b>${t("{kind} on {platform}", { kind: t(d.kind === "message" ? "Message" : d.kind === "post" ? "New post" : "Reply"), platform: escape(d.platform) })}</b>${whom ? ` · ${escape(whom)}` : ""}`;
  }
  switch (d.kind) {
    case "reply":
      return `<b>${t("Reply on Reddit")}</b>${d.author ? ` · ${escape(user(d.author))}` : ""}`;
    case "post":
      return `<b>${t("New post")}</b> · r/${escape(d.target)}`;
    case "message":
      return `<b>${t("Private message")}</b> · ${escape(user(d.target))}`;
  }
}

const LINK: Readonly<Record<Draft["kind"], string>> = { reply: "Open what it answers", post: "Open the community", message: "Open their post", like: "Open the post", follow: "Open their profile", profile: "Open the page" };

/** What the card's main button says, and the line once it is done. */
const DONE: Readonly<Record<Draft["kind"], { readonly button: string; readonly done: string }>> = {
  reply: { button: "Post it", done: "Posted" },
  post: { button: "Post it", done: "Posted" },
  message: { button: "Send it", done: "Sent" },
  like: { button: "Like it", done: "Liked" },
  follow: { button: "Follow", done: "Followed" },
  profile: { button: "Update it", done: "Updated" },
};
/** A follow on LinkedIn is a connection request. */
const connects = (d: Draft): boolean => d.kind === "follow" && /(^|.)linkedin.com$|^linkedin$/i.test(d.platform);
const words = (d: Draft) => (connects(d) ? { button: "Ask to connect", done: "Connection request sent" } : DONE[d.kind]);

/**
 * The card, in Telegram's HTML: whose words it answers (a short quote), then the draft, as it would
 * go up, and nothing else. A post shows its title, a message its subject.
 */
export function draftCardHtml(d: Draft, locale = "en"): string {
  const t = forLanguage(locale);
  const lines = [
    head(d, locale),
    d.quote ? `<blockquote>${escape(clip(d.quote, 300))}</blockquote>` : null,
    d.kind === "post" && d.title ? `<b>${escape(d.title)}</b>` : null,
    d.kind === "message" && d.title ? `<b>${t("Subject:")}</b> ${escape(d.title)}` : null,
    // A like or a follow has no words of its own: the quote above, or the name, says what it is.
    ...(d.text ? ["", escape(clip(d.text, 3000))] : []),
    // Their pictures go up with it: the card says so, since it shows only the words.
    d.assets?.length ? `${t(d.assets.length === 1 ? "With your picture" : "With {count} of your pictures", { count: d.assets.length })}` : null,
    "",
    // A post elsewhere goes up where its address is (X's composer, their profile), which is no community.
    d.kind === "message" && !d.quote ? null : `<a href="${attr(d.url)}">${t(d.kind === "post" && d.platform !== "reddit" ? "Open the page" : LINK[d.kind])}</a>`,
  ];
  if (d.status === "posted") {
    const how = t(d.kind === "message" ? "Sent" : d.kind === "reply" || d.kind === "post" ? (d.alone ? "Quest posted it" : "Posted") : d.alone ? "Quest did it" : words(d).done);
    // A browser post knows no account name: "Posted as connected account" said nothing (2026-10-14).
    const as = d.sentAs && d.sentAs !== "connected account" ? ` ${t("as {account}", { account: escape(d.platform === "reddit" ? user(d.sentAs) : d.sentAs) })}` : "";
    lines.push("", d.sentUrl ? `${how}${as}: <a href="${attr(d.sentUrl)}">${t("see it")}</a>` : `${how}${as}`);
  }
  if (d.status === "skipped") lines.push("", `${t("Skipped")}`);
  if (d.status === "posting") lines.push("", t("Sending started; awaiting confirmation. Held against duplicate sends."));
  if (d.status === "uncertain") lines.push("", t("I can't tell if it went up. Look before posting it again."));
  // In the outbox (drafts/outbox.ts): their Chrome is closed, and it goes when the Chrome is back.
  if (d.status === "open" && d.waiting) lines.push("", t("Waiting for your Chrome. It goes up once Chrome is open."));
  return lines.filter((l) => l !== null).join("\n");
}

/** Post it, Edit and Skip while the draft is open; nothing after. */
export function draftButtons(d: Draft, locale = "en"): TgCallbackButton[][] {
  const t = forLanguage(locale);
  if (d.status === "uncertain" || d.status === "posting") return [[{ text: t("Not there, post again"), callback_data: draftData(d.id, "retry") }]];
  if (d.status !== "open") return [];
  // A like or a follow has no words to edit.
  const edit = d.kind === "like" || d.kind === "follow" ? [] : [{ text: t("Edit"), callback_data: draftData(d.id, "edit") }];
  // Waiting for their Chrome: it is already on its way, so only changing it or calling it off is left.
  if (d.waiting) return [[...edit, { text: t("Skip"), callback_data: draftData(d.id, "skip") }]];
  return [[{ text: t(words(d).button), callback_data: draftData(d.id, "post") }, ...edit, { text: t("Skip"), callback_data: draftData(d.id, "skip") }]];
}
