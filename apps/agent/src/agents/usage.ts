import type { ModelUsage } from "@mq/core";

/** OpenRouter's usage object, which LangChain keeps whole on the reply's `response_metadata.usage`. */
interface OpenRouterUsage {
  readonly prompt_tokens?: number;
  readonly completion_tokens?: number;
  readonly cost?: number;
  readonly prompt_tokens_details?: { readonly cached_tokens?: number | null; readonly cache_write_tokens?: number | null } | null;
  readonly completion_tokens_details?: { readonly reasoning_tokens?: number | null } | null;
}

/** LangChain's own counts, for a reply that did not carry OpenRouter's. */
interface LangChainUsage {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly input_token_details?: { readonly cache_read?: number; readonly cache_creation?: number };
  readonly output_token_details?: { readonly reasoning?: number };
}

const count = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0);

/**
 * What a model call used, read from the reply LangChain hands back. OpenRouter sends its usage, cost
 * included, with every response (no request flag needed since 2026); LangChain's counts stand in
 * when it is missing, without a cost. Null when the reply says nothing about usage (a scripted model).
 */
export function usageOf(reply: unknown): ModelUsage | null {
  const r = reply as { response_metadata?: { usage?: OpenRouterUsage }; usage_metadata?: LangChainUsage } | null | undefined;
  const raw = r?.response_metadata?.usage;
  if (raw && typeof raw.prompt_tokens === "number") {
    return {
      input: count(raw.prompt_tokens),
      cached: count(raw.prompt_tokens_details?.cached_tokens),
      cacheWrite: count(raw.prompt_tokens_details?.cache_write_tokens),
      output: count(raw.completion_tokens),
      reasoning: count(raw.completion_tokens_details?.reasoning_tokens),
      cost: typeof raw.cost === "number" && Number.isFinite(raw.cost) ? raw.cost : null,
    };
  }
  const lc = r?.usage_metadata;
  if (lc && typeof lc.input_tokens === "number") {
    return {
      input: count(lc.input_tokens),
      cached: count(lc.input_token_details?.cache_read),
      cacheWrite: count(lc.input_token_details?.cache_creation),
      output: count(lc.output_tokens),
      reasoning: count(lc.output_token_details?.reasoning),
      cost: null,
    };
  }
  return null;
}

/** A call's usage as log fields: short names, the cost rounded to a hundredth of a cent. */
export function usageFields(usage: ModelUsage | null): Record<string, number | null> {
  if (!usage) return {};
  return {
    tokensIn: usage.input,
    cached: usage.cached,
    tokensOut: usage.output,
    reasoning: usage.reasoning,
    cost: usage.cost === null ? null : Math.round(usage.cost * 10_000) / 10_000,
  };
}
