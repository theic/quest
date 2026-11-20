import { ToolMessage, type BaseMessage } from "@langchain/core/messages";

/**
 * A run that works a site carries every page it looked at: live, 2026-10-15, an outreach run on X opened 22 pages
 * and acted 15 times, its prompt grew 5,000 to 7,000 tokens a step from 9,000 to 170,000, and six steps past
 * 150,000 that missed the provider's cache cost $0.41 of the run's $0.64 (FACTS.md). A page is the page as it was
 * then: the last few say where the run is, and an older one is only its address. So each model call sees the last
 * KEEP_PAGES to KEEP_PAGES + BATCH - 1 pages whole and every older one as a line; the older ones are folded BATCH at
 * a time, so the prompt's start stays the same for several steps and stays in the cache.
 */

/** Tools whose answer is a page as it was then: a newer look supersedes it. A site read is several pages, up to 24,000 characters. */
export const PAGE_TOOLS: ReadonlySet<string> = new Set(["browser_open", "browser_act", "read_visual", "read_page", "read_site", "inspect", "prepare"]);

/** The newest pages a model call always sees whole. */
export const KEEP_PAGES = 2;
/** How many older pages are folded at once: the prompt's start changes once every BATCH pages, not every step. */
export const BATCH = 4;
/** A page shorter than this is left as it is: a refusal or a note costs nothing to keep. */
const FOLD_OVER = 1_500;

const textOf = (content: ToolMessage["content"]): string =>
  typeof content === "string" ? content : content.map((p) => (typeof p === "string" ? p : "text" in p && typeof p.text === "string" ? p.text : "")).join("");

/** The line an older page becomes: where it was, so the run can open it again if it needs its words. */
export function pageLine(name: string, text: string): string {
  let where = "";
  try {
    const page = JSON.parse(text) as { url?: unknown; title?: unknown };
    where = [typeof page.url === "string" ? page.url : "", typeof page.title === "string" && page.title ? `"${page.title.slice(0, 120)}"` : ""].filter(Boolean).join(" ");
  } catch {
    where = text.match(/https?:\/\/\S+/)?.[0] ?? "";
  }
  return `[${name}: a page from earlier${where ? `, ${where}` : ""}. Its words are no longer shown; open it again if you need them.]`;
}

/**
 * The messages a model call sees: the same, with every page but the newest folded to a line, BATCH at a time.
 * Nothing else changes (a tool call keeps its answer, only shorter), and the run's own history keeps every page.
 */
export function agePages(messages: readonly BaseMessage[]): BaseMessage[] {
  const pages = messages.flatMap((m, i) => (ToolMessage.isInstance(m) && PAGE_TOOLS.has(m.name ?? "") ? [i] : []));
  const folded = Math.max(0, Math.floor((pages.length - KEEP_PAGES) / BATCH) * BATCH);
  if (!folded) return [...messages];
  const fold = new Set(pages.slice(0, folded));
  return messages.map((m, i) => {
    if (!fold.has(i) || !ToolMessage.isInstance(m)) return m;
    const text = textOf(m.content);
    if (text.length < FOLD_OVER) return m;
    return new ToolMessage({ content: pageLine(m.name ?? "page", text), tool_call_id: m.tool_call_id, name: m.name, ...(m.id ? { id: m.id } : {}) });
  });
}
