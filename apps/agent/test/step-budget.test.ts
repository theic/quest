import { AIMessage, SystemMessage } from "@langchain/core/messages";
import { fakeModel } from "@langchain/core/testing";
import { MemorySaver } from "@langchain/langgraph";
import { tool } from "langchain";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildAgent, finalText } from "../src/agents/harness.ts";
import { fewLeftNote, lastCallNote } from "../src/agents/step-budget.ts";
import { MAX_CALLS_A_STEP } from "../src/agents/tool-calls.ts";

const look = tool(async ({ url }) => `read ${url}`, {
  name: "read_page",
  description: "Read a page.",
  schema: z.object({ url: z.string() }),
});

const systemText = (call: { messages: unknown[] }): string =>
  call.messages
    .filter((m): m is SystemMessage => m instanceof SystemMessage)
    .map((m) => m.text)
    .join("\n");

function agentWith(model: ReturnType<typeof fakeModel>, stepBudget: number) {
  return buildAgent({ name: "researcher", model: model as never, systemPrompt: "You research.", tools: [look], stepBudget, retryDelayMs: 1 }, new MemorySaver());
}

describe("the step budget", () => {
  it("lets a run use its whole budget without tripping the graph's recursion limit", async () => {
    // The live run that found this: a budget of 20 hit "Recursion limit of 90" first.
    // Plain tool-call messages: respondWithTools echoes its whole input as text, which doubles every step.
    let model = fakeModel();
    for (let i = 0; i < 19; i++) model = model.respond(new AIMessage({ content: "", tool_calls: [{ id: `c${i}`, name: "read_page", args: { url: `https://a.test/${i}` } }] }));
    model = model.respond(new AIMessage("Report: 19 pages read."));

    const result = await agentWith(model, 20).invoke({ messages: [{ role: "user", content: "Read them all." }] }, { configurable: { thread_id: "t1" } });

    expect(finalText(result)).toBe("Report: 19 pages read.");
    expect(model.calls).toHaveLength(20);
  });

  it("warns near the end and makes the last step an answer, never the limit's error text", async () => {
    const model = fakeModel()
      .respondWithTools([{ name: "read_page", args: { url: "https://a.test/1" } }])
      .respondWithTools([{ name: "read_page", args: { url: "https://a.test/2" } }])
      .respond(new AIMessage("Report: two pages read; the third was out of reach."));

    const result = await agentWith(model, 3).invoke({ messages: [{ role: "user", content: "Read everything." }] }, { configurable: { thread_id: "t2" } });

    expect(finalText(result)).toBe("Report: two pages read; the third was out of reach.");
    expect(systemText(model.calls[1]!)).toContain(fewLeftNote(2, 3));
    expect(systemText(model.calls[2]!)).toContain(lastCallNote);
    expect(systemText(model.calls[0]!)).toContain(fewLeftNote(1, 3));
  });

  it("takes tool calls written out as text for no answer at all", () => {
    const leaked = new AIMessage(
      "<tool_call>search_posts<arg_key>query</arg_key><arg_value>waitlist form tool</arg_value><arg_key>source</arg_key><arg_value>hackernews</arg_value></tool_call>",
    );
    expect(finalText({ messages: [new AIMessage("Searching now."), leaked] })).toBe("");
    expect(finalText({ messages: [new AIMessage("Report: two finds.")] })).toBe("Report: two finds.");
  });

  it("fails the run, rather than reporting, if the model still will not stop", async () => {
    let model = fakeModel();
    for (let i = 0; i < 5; i++) model = model.respondWithTools([{ name: "read_page", args: { url: `https://a.test/${i}` } }]);

    await expect(
      agentWith(model, 2).invoke({ messages: [{ role: "user", content: "Read." }] }, { configurable: { thread_id: "t3" } }),
    ).rejects.toThrow(/Model call limits exceeded/);
  });
});

describe("one model step's tool calls", () => {
  it("runs each call once and no more than a step may make, however many the model asks for", async () => {
    // Live, 2026-10-08: one manager step of about 130 calls, most of them the same browser_open.
    const read: string[] = [];
    const counted = tool(async ({ url }) => (read.push(url), `read ${url}`), { name: "read_page", description: "Read a page.", schema: z.object({ url: z.string() }) });
    const calls = [
      ...Array.from({ length: 40 }, (_, i) => ({ id: `same${i}`, name: "read_page", args: { url: "https://a.test/thread" } })),
      ...Array.from({ length: 12 }, (_, i) => ({ id: `other${i}`, name: "read_page", args: { url: `https://a.test/${i}` } })),
    ];
    const model = fakeModel()
      .respond(new AIMessage({ content: "", tool_calls: calls, additional_kwargs: { tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })) } }))
      .respond(new AIMessage("Done."));
    let dropped = 0;
    const agent = buildAgent(
      { name: "manager", model: model as never, systemPrompt: "You manage.", tools: [counted], stepBudget: 5, retryDelayMs: 1, onTrimmed: (n) => (dropped += n) },
      new MemorySaver(),
    );

    const result = await agent.invoke({ messages: [{ role: "user", content: "Check the thread." }] }, { configurable: { thread_id: "t9" } });

    expect(finalText(result)).toBe("Done.");
    expect(read).toEqual(["https://a.test/thread", ...Array.from({ length: 7 }, (_, i) => `https://a.test/${i}`)]);
    expect(dropped).toBe(44);
    const step = model.calls[1]!.messages.find((m) => AIMessage.isInstance(m) && (m.tool_calls?.length ?? 0) > 0) as AIMessage;
    expect(step.tool_calls).toHaveLength(MAX_CALLS_A_STEP);
    expect((step.additional_kwargs.tool_calls as unknown[]).length).toBe(MAX_CALLS_A_STEP);
  });
});
