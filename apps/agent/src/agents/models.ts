import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ChatOpenAI } from "@langchain/openai";
import type { CustomerId } from "@mq/core";

/**
 * A seat an agent sits in. Each seat has its own model, measured for its job. `volume` is the cheap
 * seat (DeepSeek V4.1 Flash by default: $0.049 to $0.45 a million input tokens depending on the
 * provider, against MiMo's $0.435; FACTS.md) for work where a slip costs little: condensing a long
 * run today, any agent moved there with `AGENT_SEATS`. `writer` writes every word that goes out as
 * the customer (drafts/writer.ts): no tools, a few hundred tokens a call, so the best writer measured.
 */
export type ModelRole = "manager" | "researcher" | "volume" | "writer" | "vision";

export const MODEL_ROLES: readonly ModelRole[] = ["manager", "researcher", "volume", "writer", "vision"];

/**
 * One run, as OpenRouter sees it: its calls carry the run's `session_id`, so OpenRouter sends them
 * all to the provider that served the first one (sticky routing, from the first call rather than
 * after a cache hit was noticed), and that provider's cache holds the run's growing prompt.
 */
export interface ModelRun {
  /** Stable for the run: "manager:<customer>:<event>", "task:<id>". OpenRouter takes up to 256 characters. */
  readonly session?: string;
  readonly customerId?: CustomerId | null;
}

export interface ModelSeat {
  readonly id: string;
  /** OpenRouter tries these in order when the first is down or full. */
  readonly fallbacks: readonly string[];
  readonly maxTokens: number;
  readonly temperature: number;
  /**
   * Whether the model thinks before it answers. Off for the manager: on its real prompt MiMo
   * thought for 4,300 tokens and 125 s a step, and answered in 7 to 10 s with it off, choosing
   * the same kind of moves (FACTS.md, 2026-09-29). On for the teammates, who judge fit.
   */
  readonly reasoning: boolean;
  /**
   * How hard a thinking model thinks, when `reasoning` is on; unset, the provider's own default. The writer's models
   * cannot turn thinking off ("Reasoning is mandatory": Claude Opus, Sonnet and Fable 5.x, GPT-6.1, Gemini 4, Grok 4.7,
   * 2026-10-14), and at "low" Claude Opus 5.5 thought for 190 tokens a message.
   */
  readonly effort?: "minimal" | "low" | "medium" | "high";
  /**
   * Send each call to the model's cheapest provider first (OpenRouter's price sort, which counts the discounts
   * providers run: 30 to 51% off DeepSeek V4.1 Flash on six of them, 2026-10-14), among those serving it at 8 bits
   * or more. The order is the same for every call, so a run stays with one provider and its cache.
   */
  readonly cheapest?: boolean;
}

/** The precisions a cheapest-first call may be served at: 4-bit providers are the cheapest, and the ones that drift. */
export const SERVED_AT = ["fp8", "fp16", "bf16", "fp32", "unknown"] as const;

export interface ModelProvider {
  modelFor(role: ModelRole, run?: ModelRun): BaseChatModel;
  /** The seat's next model, for a call the first one did not answer in time; none in tests. */
  fallbackFor?(role: ModelRole, run?: ModelRun): BaseChatModel | null;
  /** The model that condenses a run grown too long: the cheap seat. None in tests: the agent's own model does it. */
  summarizer?(run?: ModelRun): BaseChatModel;
}

/**
 * How long one call may take before it counts as stalled. A manager step answers in seconds and a
 * researcher step reading pages in well under a minute; MiMo's providers now and then hold a
 * request open without answering (live, 2026-09-27 and 2026-09-29: six minutes each, as 120 s
 * three times over). A stalled call fails fast and goes to the next model instead.
 */
const STALL_MS: Readonly<Record<ModelRole, number>> = { manager: 60_000, researcher: 90_000, volume: 90_000, writer: 45_000, vision: 60_000 };

/**
 * OpenRouter, spoken to through its OpenAI-compatible endpoint. OpenRouter takes
 * at most three models in its fallback list (a fourth is answered with a 400), and
 * falls back only when a provider answers with an error, never when it stalls: that
 * is what `fallbackFor` is for.
 */
export class OpenRouterModels implements ModelProvider {
  readonly #apiKey: string;
  readonly #seats: Readonly<Record<ModelRole, ModelSeat>>;

  constructor(apiKey: string, seats: Readonly<Record<ModelRole, ModelSeat>>) {
    this.#apiKey = apiKey;
    this.#seats = seats;
  }

  modelFor(role: ModelRole, run?: ModelRun): BaseChatModel {
    const seat = this.#seats[role];
    return this.#chat(seat, [seat.id, ...seat.fallbacks], STALL_MS[role], run);
  }

  fallbackFor(role: ModelRole, run?: ModelRun): BaseChatModel | null {
    const seat = this.#seats[role];
    const [next, ...rest] = seat.fallbacks;
    return next ? this.#chat({ ...seat, id: next }, [next, ...rest], STALL_MS[role], run) : null;
  }

  summarizer(run?: ModelRun): BaseChatModel {
    return this.modelFor("volume", run);
  }

  #chat(seat: ModelSeat, list: readonly string[], timeout: number, run?: ModelRun): BaseChatModel {
    const models = list.slice(0, 3);
    return new ChatOpenAI({
      model: seat.id,
      apiKey: this.#apiKey,
      temperature: seat.temperature,
      maxTokens: seat.maxTokens,
      timeout,
      // Retries belong to the agent's middleware: the next model first, then the whole step again.
      maxRetries: 0,
      useResponsesApi: false,
      configuration: {
        baseURL: "https://openrouter.ai/api/v1",
        defaultHeaders: { "HTTP-Referer": "https://messaging.quest", "X-Title": "Messaging Quest" },
      },
      modelKwargs: {
        ...(models.length > 1 ? { models } : {}),
        ...(seat.reasoning ? (seat.effort ? { reasoning: { effort: seat.effort } } : {}) : { reasoning: { enabled: false } }),
        ...(seat.cheapest ? { provider: { sort: "price", quantizations: [...SERVED_AT] } } : {}),
        // Claude reads its cache only where the request marks one; marked at the top, OpenRouter keeps the mark at the
        // end of the prompt as a run grows (measured 2026-10-14: 19,500 tokens $0.0024 written, then $0.0002 read).
        ...(models.some((m) => m.startsWith("anthropic/")) ? { cache_control: { type: "ephemeral" } } : {}),
        // Never `provider.order`: OpenRouter's own order wins over sticky routing, and the cache goes cold.
        ...(run?.session ? { session_id: run.session.slice(0, 256) } : {}),
      },
    });
  }
}
