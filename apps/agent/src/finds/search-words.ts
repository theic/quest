import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { CustomerId, ModelUsage } from "@mq/core";
import type { ModelProvider, ModelRole } from "../agents/models.ts";
import { usageOf } from "../agents/usage.ts";
import { communityName } from "../chrome/reddit.ts";
import { PLAYBOOK } from "../quests.ts";

/**
 * What to search for, once, from the brief: the words people type when they ask for what the customer brings, and
 * the Reddit communities where they ask. One call on a cheap seat, where a teammate tries phrasings a step at a time.
 */
export const searchWordsSystem = (count: number): string => `You plan searches for Quest, which finds people online who are asking, right now, for what its customer brings. From the quest and the customer's brief, write what those people type when they post about it: their words, not the customer's marketing words.
- queries: ${count} searches of 2 to 5 words each, all different: the kind of tool or person they look for ("form builder for waitlist"), their problem in their own words ("typeform too expensive"), and leaving what they use now ("typeform alternative"). No quotes, no operators, no brand names of the customer's own product.
- communities: up to 4 subreddit names (without r/) where these people ask for help, smallest and closest first.
Return only JSON: {"queries":["…"],"communities":["…"]}`;
export const SEARCH_WORDS_SYSTEM = searchWordsSystem(6);

/** The same for a play: the people it names, whatever they post (a launch, a question, a complaint), in their own words. */
export const playWordsSystem = (count: number): string => `You plan searches for Quest, which finds the people its customer wants to reach, as THE PLAY says. From the play and the customer's brief, write what those people type when they post: their words, the way they would put it, not the customer's marketing words.
- queries: ${count} searches of 2 to 5 words each, all different, each a different way those people say it (for founders who just shipped: "just launched my", "shipped my first app", "building in public day"). When THE PLAY names a kind of product, a need or a field, every search carries it ("launched my expense tracker", "built an expense tracker app", "budget app beta"): the bare way of saying it finds everyone else. No quotes, no operators, no brand names of the customer's own product. A site's search wants every word to be in the post, so the fewest words such a post must contain find the most: "first users", "zero signups", "launched crickets", "no traction" beat a whole sentence nobody typed that way. Half the searches are two words, each from another angle: the feeling ("nobody cares"), the number ("0 users", "3 signups"), the ask ("how do you get"), the tag they use ("buildinpublic users").
- communities: up to 4 subreddit names (without r/) where these people post, smallest and closest first.
Return only JSON: {"queries":["…"],"communities":["…"]}`;

export interface SearchWords {
  readonly queries: readonly string[];
  readonly communities: readonly string[];
  readonly usage: ModelUsage | null;
}

export function parseWords(raw: string, count = 8): { queries: string[]; communities: string[] } {
  try {
    const v = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)) as { queries?: unknown; communities?: unknown };
    const strings = (a: unknown): string[] => (Array.isArray(a) ? a.filter((s): s is string => typeof s === "string" && s.trim().length > 0).map((s) => s.trim()) : []);
    return {
      queries: [...new Set(strings(v.queries).map((q) => q.replace(/["“”]/g, "").slice(0, 80)))].slice(0, count),
      communities: strings(v.communities).flatMap((c) => communityName(c) ?? []).slice(0, 4),
    };
  } catch {
    return { queries: [], communities: [] };
  }
}

/**
 * The searches for the brief, or for a play when one is given (who to find, in the manager's words), with what the
 * customer decided and the searches that already worked or found nobody: those are not written again.
 */
export async function searchWords(
  models: ModelProvider,
  ask: { brief: string; play?: string; rules?: string; tried?: string; customerId?: CustomerId | null },
  seat: ModelRole = "volume",
  count = 6,
): Promise<SearchWords> {
  const play = PLAYBOOK.scout;
  const reply = await models.modelFor(seat, { customerId: ask.customerId ?? null }).invoke([
    new SystemMessage(ask.play ? playWordsSystem(count) : searchWordsSystem(count)),
    new HumanMessage(
      [
        ask.play ? `THE PLAY: who to find: ${ask.play.trim().slice(0, 1_500)}` : `THE QUEST: what a find is: ${play.finds}`,
        ...(ask.play ? [] : [`Where they post: ${play.where}`]),
        "",
        "THE CUSTOMER'S BRIEF",
        ask.brief.trim().slice(0, 4_000),
        ...(ask.rules?.trim() ? ["", "WHAT THE CUSTOMER DECIDED, AND WHAT THE TEAM LEARNED", ask.rules.trim().slice(0, 1_500)] : []),
        ...(ask.tried?.trim() ? ["", "SEARCHES ALREADY RUN (write other words)", ask.tried.trim().slice(0, 1_500)] : []),
      ].join("\n"),
    ),
  ]);
  const text = typeof reply.content === "string" ? reply.content : reply.content.map((p) => ("text" in p && typeof p.text === "string" ? p.text : "")).join("");
  return { ...parseWords(text, count), usage: usageOf(reply) };
}
