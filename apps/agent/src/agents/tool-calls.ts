import { AIMessage } from "@langchain/core/messages";

/**
 * The most tool calls one model step may make. Past this a step is a model repeating itself, not
 * working: the scout searches four ways at once and the manager sets a place, reacts and remembers
 * in one step, but nothing needs more.
 */
export const MAX_CALLS_A_STEP = 8;

const callKey = (c: { name: string; args?: unknown }): string => `${c.name} ${JSON.stringify(c.args ?? {})}`;

/**
 * A model step with its tool calls cut to what it can mean: each call once, and no more than
 * MAX_CALLS_A_STEP. Live on Telegram, 2026-10-08, MiMo answered "Get back to me in 5 min with which
 * one I should DM first" with one step of about 130 calls, most of them browser_open on the same
 * thread, which held the turn and the customer's Chrome for minutes. Anything else passes unchanged.
 */
export function trimToolCalls(out: unknown, max = MAX_CALLS_A_STEP): { out: unknown; dropped: number } {
  if (!AIMessage.isInstance(out) || !out.tool_calls?.length) return { out, dropped: 0 };
  const seen = new Set<string>();
  const kept = out.tool_calls.filter((c) => {
    const key = callKey(c);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, max);
  const dropped = out.tool_calls.length - kept.length;
  if (!dropped) return { out, dropped: 0 };
  const ids = new Set(kept.map((c) => c.id));
  // The provider's own copy of the calls goes back to it with the history: it must match the calls kept.
  const raw = out.additional_kwargs?.tool_calls as { id?: string }[] | undefined;
  const fields = {
    content: out.content,
    tool_calls: kept,
    ...(out.id ? { id: out.id } : {}),
    ...(out.name ? { name: out.name } : {}),
    additional_kwargs: { ...out.additional_kwargs, ...(raw ? { tool_calls: raw.filter((c) => ids.has(c.id)) } : {}) },
    response_metadata: out.response_metadata,
    ...(out.usage_metadata ? { usage_metadata: out.usage_metadata } : {}),
  };
  const message = new AIMessage(fields as ConstructorParameters<typeof AIMessage>[0]);
  return { out: message, dropped };
}
