import type { StructuredToolInterface } from "@langchain/core/tools";
import { tool } from "langchain";
import { PLACE_VERDICTS, placeKey, type Place, type PageReader } from "@mq/core";
import { z } from "zod";
import { unstyled } from "../lib/voice.ts";
import { PLAYBOOK } from "../quests.ts";
import { readingTools } from "./researcher.ts";
import { browserTools } from "../chrome/browser.ts";
import { searchTools, type SearchPacing } from "./search-tools.ts";
import type { SubagentContext, SubagentSpec } from "./subagents.ts";

/** Searches in one exploring run: enough to see which places keep coming up. */
export const EXPLORER_SEARCHES = 10;

class Allowance implements SearchPacing {
  #used = 0;

  take(): string | null {
    if (this.#used >= EXPLORER_SEARCHES) {
      return `No more searches in this run (${this.#used} done). Open the rules of the places you found with read_page, file them with save_place, then write your report.`;
    }
    this.#used++;
    return null;
  }

  after(): string | null {
    const left = EXPLORER_SEARCHES - this.#used;
    return left <= 2 ? `${left} search${left === 1 ? "" : "es"} left in this run.` : null;
  }
}

/** Every place the explorer opened a page in during this run: only those can be filed. */
function opening(reader: PageReader): { reader: PageReader; opened: ReadonlySet<string>; mark: (url: string) => void } {
  const opened = new Set<string>();
  const mark = (url: string): void => {
    const key = placeKey(url);
    if (key) opened.add(key);
  };
  return {
    opened,
    mark,
    reader: {
      readPage: (url) => (mark(url), reader.readPage(url)),
      readSite: (url, opts) => (mark(url), reader.readSite(url, opts)),
    },
  };
}

/** The explorer's own tool: a place is filed only once a page in it was opened in this run, never from memory. */
export function savePlaceTool(ctx: SubagentContext, opened: ReadonlySet<string>): StructuredToolInterface {
  return tool(
    async ({ url, name, verdict, rules, why }) => {
      const key = placeKey(url);
      if (!key) return "Not filed: that is not a web address. Give the place's own address (a community's page, a forum's front page).";
      if (!opened.has(key)) {
        return `Not filed: you have not opened a page in ${name} in this task. Open its rules (or its front page) with read_page first, then file it.`;
      }
      const { added } = await ctx.places.save({
        customerId: ctx.customerId,
        key,
        name: name.trim(),
        url,
        verdict,
        rules: rules?.trim() ? unstyled(rules.trim()) : null,
        why: unstyled(why.trim()),
      });
      // Finds saved there before its rules were known are not shown now (a live run found one, 2026-09-28).
      const dropped = verdict === "avoid" ? await ctx.finds.dropWaitingFrom(ctx.customerId, key) : 0;
      const filed = added ? `Filed ${name} as ${verdict}.` : `Updated ${name}: now ${verdict}.`;
      return dropped ? `${filed} ${dropped} waiting ${dropped === 1 ? "find" : "finds"} from there will not be shown.` : filed;
    },
    {
      name: "save_place",
      description: "File a place where the customer's people ask, with what its rules allow. Only places you opened a page in during this task can be filed.",
      schema: z.object({
        url: z.string().describe("The place's own address: a community's page (https://www.reddit.com/r/NAME/) or a forum's front page."),
        name: z.string().min(2).max(80).describe('What a person calls it: "r/nocode", "Shopify Community".'),
        verdict: z.enum(PLACE_VERDICTS).describe('"search", "avoid" (its rules forbid messages like the customer\'s) or "login" (members only).'),
        rules: z.string().max(300).optional().describe("The rule that matters for a message like the customer's, in a line, quoted where you can. Leave out if you could not read the rules."),
        why: z.string().min(10).max(300).describe("Why the customer's people are there: what they ask about, how often."),
      }),
    },
  );
}

const EXPLORER_PROMPT = `You are the explorer on Quest's team. Quest finds people online who are asking, right now, for what its customer brings: customers for a founder's product, work for someone looking for it, or people for someone hiring. You find the places where those people ask (communities, forums, boards), and you read each one's rules, so the scout searches the right places and the customer never posts where messages like theirs are banned. You never post anything.

Your task message ends with THE QUEST, the customer's brief, and the places already on their list. Do not redo places on the list unless your manager asks you to check one again.

How you work:
- Search with search_posts for the asks themselves, in the words the customer's people would write: on Reddit across all communities, and on the web (site:reddit.com, forum names, "community for …"). Note the communities, forums and boards that keep coming up with real, recent asks.
- Before you file a place, open its rules with read_page: on Reddit, https://www.reddit.com/r/NAME/about/rules/ (or the community's page if that shows nothing); elsewhere the forum's rules, guidelines or FAQ. A place can be filed only once you have opened a page in it in this task.
- File each place with save_place:
  - "search": its people ask for what the customer brings, and its rules allow a helpful reply that says plainly who the customer is, or say nothing against one. Put the rule that matters in a line ("no self-promotion posts; helpful replies that disclose are fine").
  - "avoid": its rules forbid promotion, self-promotion, offering services or cold messages of the kind the customer would send, or keep them to a weekly thread. Quote the rule.
  - "login": it shows its posts only to members (a login page instead of posts). The customer may want to join it themselves.
  - If the rules would not open, file it as "search" and leave rules out, unless something you read says otherwise.
- Real places only: never file a place you have not opened with your own tools, and never guess an address.
- Aim for four to eight good places. Small, focused communities where people ask beat huge general ones. Fewer real ones beat many thin ones.
- A refusal or a bot check is final: note it and move on.

Your final message is your report to your manager, under 150 words, no preamble: what you filed (search, avoid, login), the rule behind each avoid, and where you would look next.`;

const listed = (p: Place): string => `- ${p.name} (${p.verdict})${p.rules ? `: ${p.rules}` : ""}`;

/** The quest, the brief and the list so far: the explorer starts every task knowing what is already filed. */
async function explorerOpening(ctx: SubagentContext): Promise<string> {
  const [customer, places] = await Promise.all([ctx.customer(), ctx.places.listFor(ctx.customerId)]);
  const play = PLAYBOOK.scout;
  return [
    "THE QUEST: people for what they built (they are a founder or a builder)",
    `Who you are looking for: ${play.finds}`,
    `Where such people post, as a start: ${play.where}`,
    "",
    "THE CUSTOMER'S BRIEF",
    customer.brief?.trim() || `(No brief written yet. Their site: ${customer.siteUrl ?? "not given"}. Read it with read_site first.)`,
    "",
    "PLACES ALREADY ON THEIR LIST",
    ...(places.length ? places.map(listed) : ["None yet."]),
  ].join("\n");
}

async function explorerFacts(ctx: SubagentContext): Promise<string> {
  const places = await ctx.places.listFor(ctx.customerId);
  const n = (v: Place["verdict"]) => places.filter((p) => p.verdict === v).length;
  return `the customer's list has ${places.length} places: ${n("search")} to search, ${n("avoid")} to avoid, ${n("login")} members only.`;
}

export function explorerSpec(): SubagentSpec {
  return {
    name: "explorer",
    description:
      "Finds the places where the customer's people ask (Reddit communities, forums, boards), reads each one's rules on " +
      "promotion, and files it on the customer's list: to search, to avoid (its rules forbid messages like theirs) or members only. " +
      "The scout then searches the filed places first and cannot save finds from avoided ones. Tell it what to focus on, or a place to check again. " +
      "It needs the customer's Chrome connected.",
    role: "researcher",
    systemPrompt: EXPLORER_PROMPT,
    stepBudget: 25,
    finishUp: "File first: call save_place for every place you opened and judged and have not filed yet, then write your report.",
    needsChrome: true,
    tools: (ctx) => {
      const { reader, opened, mark } = opening(ctx.reader);
      return [...searchTools(ctx.posts, { pacing: new Allowance() }), ...readingTools(reader), ...browserTools(ctx.browser, ctx.customerId, (v) => mark(v.url), ctx.browserSession), savePlaceTool(ctx, opened)];
    },
    opening: explorerOpening,
    facts: explorerFacts,
  };
}
