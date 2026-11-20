import type { CustomerId, Logger, SpendLog, TaskId } from "@mq/core";
import type { ModelCallEnd } from "./harness.ts";
import { usageFields } from "./usage.ts";

/** Whom a run's model calls are for: what each call's log line and spend row carry. */
export interface SpendTags {
  readonly customerId: CustomerId | null;
  readonly taskId?: TaskId | null;
  /** "manager", "scout", "browser-poster", … */
  readonly agent: string;
}

/**
 * A finished model call: the log line each agent always wrote (`manager.model`, `tasks.model`, …),
 * now with its tokens and cost, and a row in the spend log when the reply said what it used.
 */
export function noteModelCall(log: Logger | undefined, event: string, spend: SpendLog | undefined, tags: SpendTags, call: ModelCallEnd): void {
  log?.info(event, {
    ...(tags.customerId ? { customerId: tags.customerId } : {}),
    ...(tags.taskId ? { taskId: tags.taskId } : {}),
    ms: call.ms,
    model: call.model,
    error: call.error,
    ...usageFields(call.usage),
  });
  if (call.usage) {
    spend?.record({ customerId: tags.customerId, taskId: tags.taskId ?? null, agent: tags.agent, model: call.model, ms: call.ms, usage: call.usage });
  }
}
