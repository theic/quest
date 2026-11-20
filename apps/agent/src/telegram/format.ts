/**
 * Models write light Markdown. Telegram's HTML mode is the forgiving one to
 * target: escape everything, then turn back on the few marks worth keeping.
 * Anything Telegram still refuses is sent again as plain text (see TelegramChannel).
 */

import { textPrefix } from "@mq/i18n";

export const MAX_MESSAGE = 4000;

const escapeHtml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function toTelegramHtml(markdown: string): string {
  const codeSpans: string[] = [];
  let text = markdown.replace(/`([^`\n]+)`/g, (_, code: string) => {
    codeSpans.push(`<code>${escapeHtml(code)}</code>`);
    return `\u0000${codeSpans.length - 1}\u0000`;
  });
  text = escapeHtml(text)
    .replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
    .replace(/^\s*[-*]\s+/gm, "• ")
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, label: string, url: string) => `<a href="${url.replace(/"/g, "&quot;")}">${label}</a>`);
  return text.replace(/\u0000(\d+)\u0000/g, (_, i: string) => codeSpans[Number(i)] ?? "");
}

/** The words without any marks, for when Telegram will not take the HTML. */
export function toPlainText(markdown: string): string {
  return markdown
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, "$1 ($2)");
}

/** Splits a long text at paragraph, then line, then word boundaries, each part under `max`. */
export function splitMessage(text: string, max = MAX_MESSAGE): string[] {
  if (!Number.isInteger(max) || max < 2) throw new RangeError("Message limit must be at least 2");
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    const window = rest.slice(0, max);
    const cut = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf("\n"), window.lastIndexOf(" "));
    let at = cut > max / 2 ? cut : max;
    // Preserve emoji, accents and conjuncts across scripts. An oversized single
    // combining sequence still advances, so pathological input cannot loop forever.
    at = textPrefix(rest, at).length || at;
    parts.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}
