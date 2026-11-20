import { pageLogin, type BrowserView } from "@mq/core";

/** Words as they are compared here: case, curly quotes and punctuation aside. */
const norm = (s: string): string =>
  s.toLowerCase().replace(/[’‘]/g, "'").replace(/[^\p{L}\p{N}'@]+/gu, " ").trim();

/** A conversation list's line for a message they sent: "You: …" (LinkedIn's and X's lists), in the languages Quest speaks. */
const YOU = /^(?:you|me|я|ви|вы|tú|tu|você|vous|du|你|आप|أنت)\s*[:：]/iu;

/** What follows a sender's name on a message's header line: a time, a day, "sent the following message…", or nothing. */
const HEADER_REST = /^(?:sent\b|at\b|today\b|yesterday\b|\d|(?:mon|tue|wed|thu|fri|sat|sun)|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec))/;

/** Whether a line is a message's header naming this sender: the name alone, or the name and a time. */
const header = (line: string, name: string): boolean => {
  const l = norm(line);
  if (l === name) return true;
  if (!l.startsWith(`${name} `)) return false;
  const rest = l.slice(name.length + 1);
  return rest.split(" ").length <= 9 && HEADER_REST.test(rest);
};

/** How far above a quote a message's header is looked for: a few lines of one message. */
const HEADER_LINES = 12;

/**
 * Whose words a quote is on a page, by what the page says right above it: the header of the message it is in
 * ("Serhii Lahutin", "Serhii Lahutin 9:15 AM", "Serhii Lahutin sent the following message at 9:15 AM"), or a
 * list's "You: …". `mine` are the customer's names there, `others` the other person's. Null when the page does
 * not say, or the quote is not on it.
 */
export function whoseWords(quote: string, text: string, mine: readonly string[], others: readonly string[]): "mine" | "theirs" | null {
  const start = norm(quote).split(" ").filter(Boolean).slice(0, 5).join(" ");
  if (start.length < 4) return null;
  const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const at = lines.findIndex((l) => norm(l).includes(start));
  if (at < 0) return null;
  const line = lines[at]!;
  if (YOU.test(line)) return "mine";
  const names = (xs: readonly string[]): string[] => [...new Set(xs.map(norm).filter((n) => n.length >= 3))];
  const my = names(mine);
  const theirs = names(others);
  // "Name: words" on one line, as some chats and lists show it.
  const before = norm(line.slice(0, Math.max(0, line.indexOf(":"))));
  if (line.includes(":") && before) {
    if (my.includes(before)) return "mine";
    if (theirs.includes(before)) return "theirs";
  }
  for (let i = at - 1; i >= Math.max(0, at - HEADER_LINES); i--) {
    if (my.some((n) => header(lines[i]!, n))) return "mine";
    if (theirs.some((n) => header(lines[i]!, n))) return "theirs";
  }
  return null;
}

/** Their name on a site, from the page's own link to their profile: x.com/dana_builds is "dana_builds", linkedin.com/in/dana-k is "dana-k". */
export function handleFrom(view: Pick<BrowserView, "url" | "controls">): string | null {
  const profile = pageLogin(view).profile;
  if (!profile) return null;
  try {
    const parts = new URL(profile).pathname.split("/").filter(Boolean);
    const name = parts[0] === "in" || parts[0] === "user" || parts[0] === "u" ? parts[1] : parts[0];
    return name && name.length >= 3 ? decodeURIComponent(name) : null;
  } catch {
    return null;
  }
}

/**
 * Why a draft answering `quote` is refused, or null: the words are the customer's own on a page read (their own
 * message in a thread, read as the other person's answer). Live, 2026-10-19: Quest opened a LinkedIn thread whose
 * last message was the founder's own, and drafted "thanks for the reply" to the person he had written to.
 */
export function ownWordsRefusal(quote: string | null | undefined, pages: readonly Pick<BrowserView, "url" | "text" | "controls">[], name: string | null, other: string | null): string | null {
  if (!quote?.trim()) return null;
  const mine = (page: Pick<BrowserView, "url" | "controls">): string[] => {
    const words = (name ?? "").trim().split(/\s+/).filter(Boolean);
    return [name ?? "", handleFrom(page) ?? "", words.length > 1 ? `${words[0]} ${words[words.length - 1]}` : ""].filter(Boolean);
  };
  const others = [other ?? ""].map((o) => o.replace(/^[@]|^u\//i, "")).filter(Boolean);
  // The latest page that has the words says whose they are.
  for (const page of [...pages].reverse()) {
    const whose = whoseWords(quote, page.text, mine(page), others);
    if (whose === "theirs") return null;
    if (whose === "mine") {
      return (
        `those words are the customer's own: on ${page.url} they sit under their own name. That is a message they sent, not an answer to them. ` +
        "Answer only words the other person wrote; when the last message in a thread is theirs, there is nothing to answer yet."
      );
    }
  }
  return null;
}
