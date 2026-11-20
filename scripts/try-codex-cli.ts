/**
 * MODELS=codex-cli, live: a reply, a tool call and a structured answer from the ChatGPT subscription logged in on this
 * computer (agents/codex-cli-models.ts). Nothing is written and nothing goes to OpenRouter.
 *
 *   node --experimental-strip-types scripts/try-codex-cli.ts
 */
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { CodexCliModels, codexBin } from "../apps/agent/src/agents/codex-cli-models.ts";
import type { ModelSeat } from "../apps/agent/src/agents/models.ts";

const seat: ModelSeat = { id: "codex", fallbacks: [], maxTokens: 4000, temperature: 0.3, reasoning: false };
const log = { info: () => {}, warn: (e: string, d?: unknown) => console.warn(e, d), error: (e: string, d?: unknown) => console.error(e, d) };
const models = new CodexCliModels({ seats: { manager: seat, researcher: seat, volume: seat, writer: seat, vision: seat }, callsAtOnce: 2, log });
console.log("codex:", codexBin());
const timed = async <T>(name: string, f: () => Promise<T>) => {
  const t0 = Date.now();
  const out = await f();
  console.log(`${name} (${((Date.now() - t0) / 1000).toFixed(1)} s):`, JSON.stringify(out).slice(0, 400));
};

const m = models.modelFor("manager");
await timed("reply", async () => (await m.invoke([{ role: "system", content: "You are terse." }, { role: "user", content: "Say hi to a founder in five words." }])).content);

const saveSite = tool(async () => "saved", { name: "save_site", description: "Remember their website address.", schema: z.object({ url: z.string() }) });
const remember = tool(async () => "kept", { name: "remember", description: "Keep one sentence for good.", schema: z.object({ kind: z.enum(["fact", "decision"]), text: z.string() }) });
await timed("tools", async () => {
  const r = await m.bindTools!([saveSite, remember], {}).invoke([
    { role: "system", content: "You are Quest. Act with your tools." },
    { role: "user", content: "My product is tallyreport.dev, I only want users from X, never Reddit." },
  ]);
  return { said: r.content, calls: r.tool_calls?.map((c) => ({ name: c.name, args: c.args })) };
});

await timed("structured", async () =>
  models
    .modelFor("volume")
    .withStructuredOutput(z.object({ fit: z.boolean(), why: z.string() }), { name: "judge" })
    .invoke("A post: 'any tool to turn Stripe exports into a monthly MRR report?'. Does it fit a maker of exactly that?"),
);
