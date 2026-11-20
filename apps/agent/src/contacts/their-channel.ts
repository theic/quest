/**
 * Where someone asked to be answered (the founder, 2026-11-20, on a maker who wrote "sure, email me at …" and got the
 * page's link under his post instead: "the person specifically asked to switch channels"). An address they give in
 * their words, or "dm me", is where the next word goes, never the thread.
 */

const EMAIL = /\b[a-z0-9][a-z0-9._%+-]*@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\b/i;
const TO_EMAIL = /\b(e-?mail|mail) me\b|\b(drop|send|shoot) me (an? )?(e-?mail|line)\b|\bmy (e-?mail|inbox)\b/i;
const TO_DM = /\b(dm|pm|inbox|message) me\b|\b(send|drop|shoot) me (a |an )?(dm|pm|message)\b|\b(in|via|by|over|let'?s (take|move) (this|it) to) (dms?|pms?|private( messages?)?)\b|\bcheck (your|ur) (dms?|inbox)\b/i;

/** The email address in their words, or null. */
export function emailIn(text: string | null | undefined): string | null {
  return (text ?? "").match(EMAIL)?.[0]?.replace(/[.,;:]+$/, "") ?? null;
}

/** Where their words ask to be answered: an address, "dm", or null for here. */
export function theirChannel(words: string | null | undefined): { email: string } | "dm" | null {
  const email = emailIn(words);
  if (email) return { email };
  if (TO_EMAIL.test(words ?? "")) return null; // "email me" with no address: the thread is the only way to ask for it
  return TO_DM.test(words ?? "") ? "dm" : null;
}

/** Gmail's compose page for a new email to them, which the poster fills and sends (platforms.ts). */
export const emailCompose = (to: string, subject: string): string =>
  `https://mail.google.com/mail/u/0/?view=cm&fs=1&to=${encodeURIComponent(to)}&su=${encodeURIComponent(subject)}`;

/** Why a reply or a message answering their words goes elsewhere, or null when it may go as drafted. */
export function elsewhere(kind: string, url: string, quote: string | null | undefined): string | null {
  const where = theirChannel(quote);
  if (!where) return null;
  if (typeof where === "object") {
    if (/^https?:\/\/mail\.google\.com\//i.test(url) || /^https?:\/\/outlook\./i.test(url)) return null;
    return `They asked to be emailed (${where.email}): answer them there, not here. Draft kind message to ${emailCompose(where.email, "SUBJECT")} with the subject in title (a few words of what it is about), target ${where.email}, and the words as you would have said them.`;
  }
  if (kind === "message") return null;
  return "They asked for a private message: answer them there, not under the post. Draft kind message to their profile's address, with these words of theirs as the quote.";
}
