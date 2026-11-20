import { createMiddleware, modelCallLimitMiddleware } from "langchain";
import { z } from "zod";

/**
 * How many of the last model calls in a run carry a "finish up" note: a fifth of
 * the budget, at least three. Warned only in its last three of thirty steps, the
 * scout kept searching and never wrote its report (live, 2026-09-26).
 */
const warnWithin = (budget: number): number => Math.max(3, Math.ceil(budget / 5));

export const lastCallNote =
  "You are out of steps for this run. Do not call any tools. Write your final answer now from what you already have, " +
  "and say plainly what you could not finish.";

/** `finishUp` says what finishing means for this agent (the scout's is saving its finds). */
export const fewLeftNote = (step: number, budget: number, finishUp?: string): string =>
  finishUp
    ? `This is step ${step} of ${budget} in this run. Stop starting new work. ${finishUp} Then write your final answer.`
    : `This is step ${step} of ${budget} in this run. Stop starting new work: use what is left to finish, then write your final answer.`;

/**
 * Keeps a run inside its step budget and still ends it with a real answer.
 *
 * Near the end of the budget the agent is told how many steps it has left; on
 * the last one its tools are taken away, so it has to answer from what it
 * already has. The library's own call limit stays behind this as a backstop,
 * set to fail the run (and let the queue retry it) rather than end it with the
 * limit's error text as if that were a report.
 */
export function stepBudgetMiddleware(budget: number, finishUp?: string) {
  const pacing = createMiddleware({
    name: "StepBudgetMiddleware",
    stateSchema: z.object({ budgetCallsThisRun: z.number().default(0) }),
    wrapModelCall: async (request, handler) => {
      const used = (request.state as { budgetCallsThisRun?: number }).budgetCallsThisRun ?? 0;
      const left = budget - used;
      if (left <= 1) {
        return handler({ ...request, tools: [], toolChoice: undefined, systemMessage: request.systemMessage.concat(`\n\n${lastCallNote}`) });
      }
      if (left <= warnWithin(budget)) {
        return handler({ ...request, systemMessage: request.systemMessage.concat(`\n\n${fewLeftNote(used + 1, budget, finishUp)}`) });
      }
      return handler(request);
    },
    afterModel: (state) => ({ budgetCallsThisRun: ((state as { budgetCallsThisRun?: number }).budgetCallsThisRun ?? 0) + 1 }),
    afterAgent: () => ({ budgetCallsThisRun: 0 }),
  });
  return [pacing, modelCallLimitMiddleware({ runLimit: budget + 1, exitBehavior: "error" })] as const;
}

/**
 * The graph steps a run may take. Each model call passes through several nodes
 * (the model, the tools, and the middleware hooks around them), so the graph's
 * own recursion limit sits well above the budget: the budget is what ends a run.
 */
export const recursionLimitFor = (budget: number): number => (budget + 2) * 12;
