import type { CustomerId, TaskId } from "./ids.ts";

/** What one model call used, as OpenRouter reports it. */
export interface ModelUsage {
  /** Tokens sent, the cached ones included. */
  readonly input: number;
  /** Of those, read from the provider's cache: billed at a small part of the input price. */
  readonly cached: number;
  /** Of those, written to the provider's cache. */
  readonly cacheWrite: number;
  /** Tokens written back, thinking included. */
  readonly output: number;
  /** Of those, the model's thinking. */
  readonly reasoning: number;
  /** What OpenRouter charged for the call, in dollars; null when it did not say. */
  readonly cost: number | null;
}

/** One model call, for the spend log: whom it was for, which agent made it, and what it used. */
export interface ModelCall {
  /** Null for a call made for nobody in particular (a browser picture checked on its own). */
  readonly customerId: CustomerId | null;
  readonly taskId: TaskId | null;
  /** "manager", "scout", "browser-poster", "browser-vision", … */
  readonly agent: string;
  /** The model that answered, after any fallback. */
  readonly model: string | null;
  readonly ms: number;
  readonly usage: ModelUsage;
}
