import type { StructuredToolInterface } from "@langchain/core/tools";
import type { Customer, CustomerId, PageReader, PlaceRepository, PostSearch, SearchLog, TaskId } from "@mq/core";
import type { ModelRole } from "../agents/models.ts";
import type { FindLedger } from "../finds/find-service.ts";
import type { PairFinder } from "../finds/pair-finder.ts";
import type { KnownPeople } from "../infra/pg-known.ts";
import type { PlayFinder } from "../finds/play-finder.ts";
import type { CustomerBrowser } from "../chrome/browser.ts";
import type { Acquaintances } from "../contacts/acquaintances.ts";
import type { DraftService } from "../drafts/draft-service.ts";
import type { SearchTrail } from "./search-trail.ts";

/** What a subagent's tools may use while working on one task. */
export interface SubagentContext {
  readonly customerId: CustomerId;
  readonly taskId: TaskId;
  readonly reader: PageReader;
  readonly posts: PostSearch;
  /** The customer as the task starts: their site, their brief. */
  readonly customer: () => Promise<Customer>;
  readonly finds: FindLedger;
  /** Where the customer's people ask, and what each place's rules allow. */
  readonly places: PlaceRepository;
  readonly browser?: CustomerBrowser;
  readonly browserSession?: string;
  readonly drafts?: DraftService;
  /** People for a play, found by code (find_people). */
  readonly finder?: PlayFinder;
  /** A page of people asking for what someone built, made for them (page_for): its address and how many are on it, or why not. */
  readonly pageFor?: (who: { readonly maker: string; readonly url: string; readonly made: string }) => Promise<{ readonly link: string; readonly people: number } | string>;
  /** People who need each other, matched by code (find_pairs). */
  readonly pairs?: PairFinder;
  /** Everyone Quest came across for any customer, public background only (mq.known_people). */
  readonly known?: KnownPeople;
  /** What this run's searches came to: a search a tool runs by code is added here, as search_posts' are. */
  readonly trail?: Pick<SearchTrail, "add">;
  /** What earlier runs' searches came to: one that found nobody is not run again. */
  readonly searchLog?: Pick<SearchLog, "recent">;
  /** The people Quest got to know for them: who each is, and how close (contacts/acquaintances.ts). */
  readonly people?: Acquaintances;
}

/**
 * One kind of background worker the manager can start tasks for. A new kind is a
 * new spec in the catalog; the runner, the queue and the manager's tools do not change.
 */
export interface SubagentSpec {
  readonly name: string;
  /** What the manager reads when deciding whom to give a task. */
  readonly description: string;
  readonly role: ModelRole;
  readonly systemPrompt: string;
  /** Model calls one run may make before it has to stop. */
  readonly stepBudget: number;
  /** What its last few steps are for, before the report (the scout: save what it judged good). */
  readonly finishUp?: string;
  /** It reads or searches the web, which happens in the customer's Chrome: no task starts while it is offline. */
  readonly needsChrome?: boolean;
  tools(ctx: SubagentContext): StructuredToolInterface[];
  /** What a fresh task reads after the manager's instructions (the brief, earlier decisions), so it never has to ask for it. */
  opening?(ctx: SubagentContext): Promise<string>;
  /** Facts from the record added to the report (what was saved), so the manager never has to trust the agent's own count. */
  facts?(ctx: SubagentContext): Promise<string>;
}

export class SubagentCatalog {
  readonly #specs = new Map<string, SubagentSpec>();

  constructor(specs: readonly SubagentSpec[]) {
    for (const s of specs) this.#specs.set(s.name, s);
  }

  get(name: string): SubagentSpec | undefined {
    return this.#specs.get(name);
  }

  names(): string[] {
    return [...this.#specs.keys()];
  }

  /** One line per subagent, for the manager's tool descriptions. */
  describe(): string {
    return [...this.#specs.values()].map((s) => `- ${s.name}: ${s.description}`).join("\n");
  }
}
