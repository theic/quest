import { interrupt } from "@langchain/langgraph";
import { tool } from "langchain";
import { z } from "zod";

/** What an `ask_human` interrupt carries to the question queue. */
export interface AskHumanRequest {
  readonly question: string;
  readonly options: readonly string[];
  readonly why: string | null;
}

export const isAskHumanRequest = (v: unknown): v is AskHumanRequest =>
  typeof v === "object" && v !== null && typeof (v as AskHumanRequest).question === "string";

/**
 * Stops the subagent's run until a human answers. The run's state is saved at
 * this exact call, the worker is freed, and when the answer comes the run picks
 * up here with the answer as this tool's result.
 */
export const askHumanTool = tool(
  async ({ question, options, why }) => {
    const answer = interrupt<AskHumanRequest, string>({ question, options: options ?? [], why: why ?? null });
    return String(answer);
  },
  {
    name: "ask_human",
    description:
      "Ask the customer a question you cannot answer from what you have read. Your work pauses until they answer, " +
      "which can take hours, so ask only what would change your result, one question at a time. " +
      "Offer 2-4 short options when the answer is a choice.",
    schema: z.object({
      question: z.string().min(3).max(400).describe("The question, in plain words the customer understands."),
      options: z.array(z.string().min(1).max(60)).max(4).optional().describe("Short answer choices, if it is a choice."),
      why: z.string().max(300).optional().describe("One line on why you need to know; shown to your manager, not the customer."),
    }),
  },
);
