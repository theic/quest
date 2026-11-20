import { AIMessage } from "@langchain/core/messages";
import { fakeModel } from "@langchain/core/testing";
import type { ChatOpenAI } from "@langchain/openai";
import { describe, expect, it } from "vitest";
import { OpenRouterModels, type ModelSeat } from "../src/agents/models.ts";
import { usageFields, usageOf } from "../src/agents/usage.ts";
import { agentSeats } from "../src/config.ts";
import { heartbeatIdleReason, heartbeatWorth, QUIET_HEARTBEAT_BACKOFF_MS, type HeartbeatLook } from "../src/manager/heartbeat-gate.ts";
import { makeWorld } from "./world.ts";

/** OpenRouter's usage as LangChain keeps it on a reply: a MiMo step that read most of its prompt from the cache. */
const OPENROUTER_USAGE = {
  prompt_tokens: 12_000,
  completion_tokens: 40,
  total_tokens: 12_040,
  cost: 0.000_58,
  prompt_tokens_details: { cached_tokens: 11_000, cache_write_tokens: 0 },
  completion_tokens_details: { reasoning_tokens: 0 },
};

const replyUsing = (text: string, usage = OPENROUTER_USAGE) =>
  new AIMessage({ content: text, response_metadata: { model_name: "xiaomi/mimo-v2.6-pro", usage } });

const systemText = (m: { content: unknown }): string =>
  typeof m.content === "string" ? m.content : (m.content as { text?: string }[]).map((b) => b.text ?? "").join("");

async function customerIn(world: ReturnType<typeof makeWorld>, ref = "42") {
  return world.customers.create({ channel: { kind: "telegram", address: ref }, userRef: ref, displayName: "Dana", language: "en" });
}

describe("what a model call used", () => {
  it("reads OpenRouter's usage, cost and cache included", () => {
    expect(usageOf(replyUsing("ok"))).toEqual({ input: 12_000, cached: 11_000, cacheWrite: 0, output: 40, reasoning: 0, cost: 0.000_58 });
  });

  it("falls back to LangChain's counts, without a cost", () => {
    const reply = new AIMessage({
      content: "ok",
      usage_metadata: { input_tokens: 900, output_tokens: 12, total_tokens: 912, input_token_details: { cache_read: 800 }, output_token_details: { reasoning: 5 } },
    });
    expect(usageOf(reply)).toEqual({ input: 900, cached: 800, cacheWrite: 0, output: 12, reasoning: 5, cost: null });
  });

  it("says nothing for a reply that carries no usage", () => {
    expect(usageOf(new AIMessage("scripted"))).toBeNull();
    expect(usageOf(null)).toBeNull();
    expect(usageFields(null)).toEqual({});
  });

  it("rounds the cost to a hundredth of a cent for the log line", () => {
    expect(usageFields(usageOf(replyUsing("ok")))).toEqual({ tokensIn: 12_000, cached: 11_000, tokensOut: 40, reasoning: 0, cost: 0.0006 });
  });
});

describe("the spend log", () => {
  it("keeps a row for each of the manager's calls, with whom it was for", async () => {
    const manager = fakeModel().respond(replyUsing("Hi Dana, what's your site"));
    const world = makeWorld({ manager });
    const c = await customerIn(world);
    await world.events.push(c.id, { kind: "user_message", text: "hi" });

    await world.manager.serveNext();

    expect(world.spend.calls).toHaveLength(1);
    expect(world.spend.calls[0]).toMatchObject({
      customerId: c.id,
      agent: "manager",
      taskId: null,
      model: "xiaomi/mimo-v2.6-pro",
      usage: { input: 12_000, cached: 11_000, cost: 0.000_58 },
    });
  });

  it("keeps a teammate's rows under its task", async () => {
    const researcher = fakeModel().respond(replyUsing("What it is: invoicing for freelancers."));
    const world = makeWorld({ researcher });
    const c = await customerIn(world);
    const task = await world.tasks.start(c.id, "researcher", "Read the site", "Read https://acme.test and report.");

    await world.runner.runNext();

    expect(world.spend.calls).toEqual([
      expect.objectContaining({ customerId: c.id, taskId: task.id, agent: "researcher", usage: expect.objectContaining({ cost: 0.000_58 }) }),
    ]);
  });

  it("keeps nothing for a reply that did not say what it used", async () => {
    const manager = fakeModel().respond(new AIMessage("Hi Dana."));
    const world = makeWorld({ manager });
    const c = await customerIn(world);
    await world.events.push(c.id, { kind: "user_message", text: "hi" });
    await world.manager.serveNext();
    expect(world.spend.calls).toEqual([]);
  });
});

describe("the heartbeat gate", () => {
  const NOW = new Date("2026-10-07T12:00:00Z");
  const look = (over: Partial<HeartbeatLook> = {}): HeartbeatLook => ({
    active: 0,
    startsLeft: 8,
    canStart: true,
    findsWaiting: 0,
    cardsOpen: 0,
    daytime: true,
    restingUntil: null,
    now: NOW,
    ...over,
  });

  it("looks when nothing runs and work could start", () => {
    expect(heartbeatWorth(look())).toBe("nothing running, and work could start");
  });

  it("skips while work runs: its end wakes the manager anyway", () => {
    expect(heartbeatWorth(look({ active: 1 }))).toBeNull();
    expect(heartbeatIdleReason(look({ active: 1 }))).toBe("work is running");
  });

  it("skips when the day's starts are spent, or nothing can start without their Chrome", () => {
    expect(heartbeatWorth(look({ startsLeft: 0 }))).toBeNull();
    expect(heartbeatIdleReason(look({ startsLeft: 0 }))).toBe("the day's starts are spent");
    expect(heartbeatWorth(look({ canStart: false }))).toBeNull();
    expect(heartbeatIdleReason(look({ canStart: false }))).toBe("nothing can start without their Chrome");
  });

  it("looks for finds waiting with no card open, but not in their night", () => {
    expect(heartbeatWorth(look({ active: 1, findsWaiting: 3 }))).toBe("finds wait to be shown");
    expect(heartbeatWorth(look({ active: 1, findsWaiting: 3, cardsOpen: 2 }))).toBeNull();
    expect(heartbeatWorth(look({ active: 1, findsWaiting: 3, daytime: false }))).toBeNull();
  });

  it("rests after a look that moved nothing, whatever else holds", () => {
    const resting = look({ restingUntil: new Date(NOW.getTime() + 60_000) });
    expect(heartbeatWorth(resting)).toBeNull();
    expect(heartbeatIdleReason(resting)).toBe("resting after a quiet look");
    expect(heartbeatWorth(look({ restingUntil: new Date(NOW.getTime() - 1) }))).not.toBeNull();
  });
});

describe("heartbeats in a turn", () => {
  it("skips a heartbeat without a model call while a task runs", async () => {
    const manager = fakeModel();
    const world = makeWorld({ manager });
    const c = await customerIn(world);
    await world.tasks.start(c.id, "researcher", "Read the site", "Read https://acme.test.");
    await world.events.push(c.id, { kind: "heartbeat" });

    expect(await world.manager.serveNext()).toBe(true);

    expect(manager.calls).toHaveLength(0);
    expect(world.events.events.filter((e) => e.event.kind === "heartbeat").map((e) => e.status)).toEqual(["done"]);
  });

  it("skips a heartbeat while their Chrome is closed and every teammate needs it", async () => {
    const manager = fakeModel();
    const world = makeWorld({ manager });
    world.chrome.state = { ...world.chrome.state, online: false };
    const c = await customerIn(world);
    await world.events.push(c.id, { kind: "heartbeat" });

    await world.manager.serveNext();

    expect(manager.calls).toHaveLength(0);
  });

  it("rests for a few hours after a look that moved nothing, until something else wakes the manager", async () => {
    const manager = fakeModel()
      .respond(new AIMessage("Nothing worth starting now."))
      .respond(new AIMessage("Got it, I'm on it."))
      .respond(new AIMessage("Still nothing."));
    const world = makeWorld({ manager });
    const c = await customerIn(world);
    await world.transcript.recordIncoming(c.id, "telegram", "1", "tally.so");
    world.clock.advance(2 * 3_600_000);

    await world.events.push(c.id, { kind: "heartbeat" });
    await world.manager.serveNext();
    expect(manager.calls).toHaveLength(1);

    // An hour later, inside the rest: no model call.
    world.clock.advance(3_600_000);
    await world.events.push(c.id, { kind: "heartbeat" });
    await world.manager.serveNext();
    expect(manager.calls).toHaveLength(1);

    // They write: that turn ends the rest, and the next heartbeat looks again.
    await world.events.push(c.id, { kind: "user_message", text: "Focus on nonprofits" });
    await world.manager.serveNext();
    expect(manager.calls).toHaveLength(2);
    world.clock.advance(2 * 3_600_000);
    await world.events.push(c.id, { kind: "heartbeat" });
    await world.manager.serveNext();
    expect(manager.calls).toHaveLength(3);
  });

  it("does not rest after a look that did something", async () => {
    const tell = new AIMessage({ content: "", tool_calls: [{ id: "m", name: "message_user", args: { text: "Two people in r/nocode asked for exactly this today." } }] });
    const manager = fakeModel().respond(tell).respond(new AIMessage("Told them.")).respond(new AIMessage("Nothing new."));
    const world = makeWorld({ manager });
    const c = await customerIn(world);
    await world.transcript.recordIncoming(c.id, "telegram", "1", "tally.so");
    world.clock.advance(5 * 3_600_000);

    await world.events.push(c.id, { kind: "heartbeat" });
    await world.manager.serveNext();
    expect(manager.calls).toHaveLength(2);

    world.clock.advance(QUIET_HEARTBEAT_BACKOFF_MS / 3);
    await world.events.push(c.id, { kind: "heartbeat" });
    await world.manager.serveNext();
    expect(manager.calls).toHaveLength(3);
  });
});

describe("a cache-friendly prompt", () => {
  it("gives every customer the same standing prompt; what is theirs comes after it", async () => {
    const manager = fakeModel().respond(new AIMessage("Hi Dana.")).respond(new AIMessage("Hi Sam."));
    const world = makeWorld({ manager });
    const a = await customerIn(world, "41");
    const b = await customerIn(world, "42");
    await world.customers.update(a.id, { brief: "Zorblax: forms for nonprofits." });
    await world.customers.update(b.id, { brief: "Quuxify: invoicing for freelancers." });
    await world.events.push(a.id, { kind: "user_message", text: "hi" });
    await world.manager.serveNext();
    world.clock.advance(3 * 3_600_000);
    await world.events.push(b.id, { kind: "user_message", text: "hi" });
    await world.manager.serveNext();

    const [first, second] = manager.calls;
    expect(systemText(first!.messages[0]!)).toBe(systemText(second!.messages[0]!));
    expect(systemText(first!.messages[0]!)).not.toContain("Zorblax");
    expect(String(first!.messages.at(-1)!.content)).toContain("Zorblax");
    expect(String(second!.messages.at(-1)!.content)).toContain("Quuxify");
  });
});

describe("OpenRouter seats", () => {
  const seat = (id: string): ModelSeat => ({ id, fallbacks: ["z-ai/glm-5.3"], maxTokens: 1000, temperature: 0.2, reasoning: false });
  const models = new OpenRouterModels("sk-or-test-key", { manager: seat("xiaomi/mimo-v2.6-pro"), researcher: seat("xiaomi/mimo-v2.6-pro"), volume: seat("deepseek/deepseek-v4.1-flash"), writer: seat("anthropic/claude-opus-5.5"), vision: seat("anthropic/claude-haiku-5.5") });
  const kwargs = (m: unknown) => (m as ChatOpenAI).modelKwargs ?? {};

  it("sends the run's session, so OpenRouter keeps its calls with one provider", () => {
    expect(kwargs(models.modelFor("manager", { session: "task:abc" }))["session_id"]).toBe("task:abc");
    expect(kwargs(models.fallbackFor("manager", { session: "task:abc" }))["session_id"]).toBe("task:abc");
    expect(kwargs(models.modelFor("manager"))["session_id"]).toBeUndefined();
    expect(kwargs(models.modelFor("manager", { session: "x".repeat(300) }))["session_id"]).toHaveLength(256);
  });

  it("never pins a provider order, which would turn sticky routing off", () => {
    expect(kwargs(models.modelFor("researcher", { session: "s" }))["provider"]).toBeUndefined();
  });

  it("sends a cheapest-first seat to its cheapest provider at 8 bits or more, and marks Claude's cache", () => {
    const cheap = new OpenRouterModels("sk-or-test-key", {
      manager: { ...seat("anthropic/claude-haiku-5.5"), fallbacks: ["deepseek/deepseek-v4.1-flash"], cheapest: true },
      researcher: seat("xiaomi/mimo-v2.6-pro"),
      volume: { ...seat("deepseek/deepseek-v4.1-flash"), cheapest: true },
      writer: { ...seat("anthropic/claude-opus-5.5"), reasoning: true, effort: "low" },
      vision: seat("anthropic/claude-haiku-5.5"),
    });
    expect(kwargs(cheap.modelFor("volume", { session: "s" }))["provider"]).toEqual({ sort: "price", quantizations: ["fp8", "fp16", "bf16", "fp32", "unknown"] });
    expect(kwargs(cheap.modelFor("manager", { session: "s" }))["cache_control"]).toEqual({ type: "ephemeral" });
    expect(kwargs(cheap.modelFor("volume", { session: "s" }))["cache_control"]).toBeUndefined();
    expect(kwargs(cheap.modelFor("researcher", { session: "s" }))["provider"]).toBeUndefined();
  });

  it("asks a writer that cannot stop thinking for the least it does, and a seat without thinking for none", () => {
    const seats = new OpenRouterModels("sk-or-test-key", {
      manager: seat("anthropic/claude-haiku-5.5"),
      researcher: { ...seat("xiaomi/mimo-v2.6-pro"), reasoning: true },
      volume: seat("deepseek/deepseek-v4.1-flash"),
      writer: { ...seat("anthropic/claude-opus-5.5"), reasoning: true, effort: "low" },
      vision: seat("anthropic/claude-haiku-5.5"),
    });
    expect(kwargs(seats.modelFor("writer"))["reasoning"]).toEqual({ effort: "low" });
    expect(kwargs(seats.modelFor("manager"))["reasoning"]).toEqual({ enabled: false });
    expect(kwargs(seats.modelFor("researcher"))["reasoning"]).toBeUndefined();
    expect(kwargs(seats.modelFor("writer"))["cache_control"]).toEqual({ type: "ephemeral" });
  });

  it("condenses long runs on the cheap seat", () => {
    expect((models.summarizer({ session: "s" }) as ChatOpenAI).model).toBe("deepseek/deepseek-v4.1-flash");
  });
});

describe("moving a teammate to another seat", () => {
  it("parses AGENT_SEATS, and refuses a seat that does not exist", () => {
    expect(agentSeats("")).toEqual({});
    expect(agentSeats(" explorer=volume, scout = researcher ")).toEqual({ explorer: "volume", scout: "researcher" });
    expect(() => agentSeats("scout=cheap")).toThrow(/AGENT_SEATS: "scout=cheap"/);
    expect(() => agentSeats("scout")).toThrow(/AGENT_SEATS/);
  });

  it("runs a moved teammate on its new seat's model", async () => {
    const researcher = fakeModel();
    const volume = fakeModel().respond(replyUsing("What it is: invoicing for freelancers."));
    const world = makeWorld({ researcher, volume }, { seats: { researcher: "volume" } });
    const c = await customerIn(world);
    await world.tasks.start(c.id, "researcher", "Read the site", "Read https://acme.test and report.");

    await world.runner.runNext();

    expect(researcher.calls).toHaveLength(0);
    expect(volume.calls).toHaveLength(1);
    expect(world.spend.calls[0]).toMatchObject({ agent: "researcher" });
  });
});
