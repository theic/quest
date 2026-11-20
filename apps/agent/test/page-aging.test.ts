import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { agePages, BATCH, KEEP_PAGES, pageLine } from "../src/agents/page-aging.ts";

/** A run that opened `n` pages of X, with a search between them. */
function run(n: number): BaseMessage[] {
  const out: BaseMessage[] = [new HumanMessage("Find founders on X asking for first users.")];
  for (let i = 0; i < n; i++) {
    const tool = i % 2 ? "browser_act" : "browser_open";
    out.push(new AIMessage({ content: "", tool_calls: [{ id: `c${i}`, name: tool, args: {} }] }));
    out.push(new ToolMessage({ tool_call_id: `c${i}`, name: tool, content: JSON.stringify({ url: `https://x.com/search?q=first+users&p=${i}`, title: `Search ${i}`, text: "post ".repeat(1_000) }) }));
    out.push(new AIMessage({ content: "", tool_calls: [{ id: `s${i}`, name: "save_find", args: {} }] }));
    out.push(new ToolMessage({ tool_call_id: `s${i}`, name: "save_find", content: "Saved." }));
  }
  return out;
}

const pages = (messages: readonly BaseMessage[]) => messages.filter((m) => ToolMessage.isInstance(m) && m.name?.startsWith("browser")).map((m) => String(m.content));
const whole = (messages: readonly BaseMessage[]) => pages(messages).filter((c) => c.startsWith("{")).length;

describe("older pages go as a line", () => {
  it("keep the newest pages whole and fold the older ones a few at a time", () => {
    expect(whole(agePages(run(KEEP_PAGES + BATCH - 1)))).toBe(KEEP_PAGES + BATCH - 1);
    const aged = agePages(run(KEEP_PAGES + BATCH));
    expect(whole(aged)).toBe(KEEP_PAGES);
    expect(pages(aged)[0]).toBe('[browser_open: a page from earlier, https://x.com/search?q=first+users&p=0 "Search 0". Its words are no longer shown; open it again if you need them.]');
    // Twenty pages: never more than KEEP_PAGES + BATCH - 1 whole, and the prompt is a fraction of the run's history.
    const long = run(20);
    const size = (m: readonly BaseMessage[]) => m.reduce((s, x) => s + String(x.content).length, 0);
    expect(whole(agePages(long))).toBeLessThan(KEEP_PAGES + BATCH);
    expect(size(agePages(long))).toBeLessThan(size(long) / 3);
  });

  it("change the prompt's start only every few pages, so the provider's cache holds", () => {
    const at = (n: number) => agePages(run(n)).map((m) => String(m.content));
    const six = at(KEEP_PAGES + BATCH);
    const seven = at(KEEP_PAGES + BATCH + 1);
    expect(seven.slice(0, six.length)).toEqual(six);
  });

  it("leave everything else alone: other tools, short answers, and the pairing of calls and answers", () => {
    const messages = run(KEEP_PAGES + BATCH);
    const aged = agePages(messages);
    expect(aged).toHaveLength(messages.length);
    aged.forEach((m, i) => {
      if (ToolMessage.isInstance(m)) expect(m.tool_call_id).toBe((messages[i] as ToolMessage).tool_call_id);
      if (ToolMessage.isInstance(m) && m.name === "save_find") expect(m.content).toBe("Saved.");
    });
    const refusal = [new AIMessage({ content: "", tool_calls: [{ id: "r", name: "browser_open", args: {} }] }), new ToolMessage({ tool_call_id: "r", name: "browser_open", content: "Browser could not act: offline" })];
    expect(String(agePages([...refusal, ...run(KEEP_PAGES + BATCH)])[1]!.content)).toBe("Browser could not act: offline");
    expect(pageLine("read_page", "Reddit thread at https://www.reddit.com/r/SaaS/comments/1/ with 40 comments")).toContain("https://www.reddit.com/r/SaaS/comments/1/");
  });
});
