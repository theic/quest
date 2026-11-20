import type { TranscriptEntry } from "@mq/core";

/**
 * Reactions on the customer's messages, the way a friend uses them: a 👍 for a clear instruction
 * instead of "Got it", a 🎉 for a first sale, a 😢 for bad news. One at most on a message, now and
 * then, chosen from what the message means, never on a schedule.
 *
 * The emoji a bot may set are Telegram's own short list (core.telegram.org/bots/api#reactiontypeemoji);
 * these are the ones a person working with a friend would use. Telegram wants ❤ and ✍ without the
 * emoji presentation mark.
 */
export const REACTIONS = ["👍", "👌", "🫡", "✍", "🤝", "❤", "🙏", "🤗", "🎉", "🏆", "🔥", "💯", "👏", "😁", "🤣", "😢", "💔", "👀", "🤔"] as const;

/** Reactions that only say "understood": wrong on a question, which wants an answer. */
const NODS: ReadonlySet<string> = new Set(["👍", "👌", "🫡", "✍", "🤝"]);

/** Whether a reaction says "understood": a reply beside it owes something new. */
export const isNod = (emoji: string): boolean => NODS.has(emoji);

/** The emoji as Telegram takes it, or null when it is not one Quest uses. */
export function reactionEmoji(raw: string): string | null {
  const e = raw.trim().replace(/️/g, "");
  return (REACTIONS as readonly string[]).includes(e) ? e : null;
}

/** Whether a message asks something: a reaction is no answer to it. */
export const isQuestion = (text: string): boolean => /[?？؟](\s|$)/u.test(text);

/**
 * Why a reaction would be wrong here, or null when it fits. `before` is the chat before this turn,
 * oldest first: two of their messages in a row with a reaction already, and this one goes without.
 */
export function reactionRefusal(emoji: string, message: { text: string; reaction?: string | null }, before: readonly TranscriptEntry[]): string | null {
  if (message.reaction) return `that message already has your ${message.reaction}`;
  if (NODS.has(emoji) && isQuestion(message.text)) return "it is a question: answer it, a nod is no answer";
  const theirs = before.filter((e) => e.direction === "in").slice(-2);
  if (theirs.length === 2 && theirs.every((e) => e.reaction)) return "you reacted to their last two messages: let this one be, reactions on every message mean nothing";
  return null;
}

const NOD_WORDS = /^(got it|noted|done|ok(ay)?|sure|will do|on it|understood|roger|sounds good|perfect|cool|alright|all right|deal|makes sense|no problem|yep|yes|right)\b/i;

/**
 * Whether a reply opens by saying "understood" again: next to a reaction, the rest may be news, but
 * the opening is the reaction twice (the real model, 2026-10-07, beside its 👍 on "No Reddit today
 * please": "Done: Reddit's off the table for today and the queued search is cancelled.").
 */
export const opensWithANod = (text: string): boolean => NOD_WORDS.test(text.trim().replace(/^[^\p{L}]+/u, ""));

/**
 * Whether a reply only says "understood" ("Got it, no Reddit today."): next to a reaction it says the
 * same thing twice, and the reaction is enough. A time, a number, a link or a question is news, not a nod.
 */
export function onlyANod(text: string): boolean {
  const t = text.trim().replace(/^[^\p{L}]+/u, "");
  if (!t) return true;
  if (/[?？؟\p{N}]|https?:\/\//u.test(t) || /\b(back|within|tomorrow|tonight|afternoon|later|but|because|instead)\b/i.test(t)) return false;
  return t.split(/\s+/).length <= 8 && (NOD_WORDS.test(t) || SAID_BACK.test(t));
}

/** Their words said back, then the nod: "Lisbon, got it." (the real model, 2026-10-31, to "lisbon"). */
const SAID_BACK = /^[\p{L}' -]{1,40}[,:]\s*(got it|noted|done|ok(ay)?|will do|on it|understood|perfect|cool|makes sense)[.!]*$/iu;
