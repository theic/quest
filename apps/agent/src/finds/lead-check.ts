import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { CustomerId } from "@mq/core";
import type { ModelProvider } from "../agents/models.ts";

/**
 * A second, stricter look at the people a page will list, by what each one's own post says (the founder, 2026-11-20:
 * "double check the leads you find"). Live, the same day: a page for a tutors' template listed a tutor's joke about
 * being called a nerd. The first judge reads a batch for a launch; this one reads only the page's few, against what
 * the maker made, and keeps only someone who plainly needs it now.
 */
const LEAD_CHECK_SYSTEM = `You check a short list of people before it is shown to a maker as people who need what they made.
For each post, say yes only when its author plainly has the need the product meets, in their own words: they ask for such a thing, say they are looking, or describe the problem it solves as theirs, now. A joke, a passing mention, an opinion on the topic, someone who makes or sells the same kind of thing, a promotion, or a post that only shares news: no. When in doubt: no.
Answer JSON only: {"keep":[the numbers of the posts that are a yes]}`;

const textOf = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((c) => (typeof c === "string" ? c : (c as { text?: string }).text ?? "")).join("") : "";

/** The people who pass, in their order; all of them when the check could not be made (the first judge stands). */
export async function leadCheck<T extends { readonly quote: string; readonly author?: string | null }>(models: ModelProvider, customerId: CustomerId, made: string, people: readonly T[]): Promise<T[]> {
  if (!people.length) return [];
  try {
    const human = [`WHAT THE MAKER MADE: ${made.replace(/\s+/g, " ").slice(0, 600)}`, "POSTS", ...people.map((p, i) => `${i + 1}. ${p.author ?? "someone"}: ${p.quote.replace(/\s+/g, " ").slice(0, 400)}`)].join("\n");
    const reply = await models.modelFor("volume", { customerId }).invoke([new SystemMessage(LEAD_CHECK_SYSTEM), new HumanMessage(human)]);
    const raw = textOf(reply.content);
    const keep = (JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)) as { keep?: unknown }).keep;
    if (!Array.isArray(keep)) return [...people];
    const nums = new Set(keep.map((k) => Number(String(k).replace(/[^0-9]/g, ""))));
    return people.filter((_, i) => nums.has(i + 1));
  } catch {
    return [...people];
  }
}
