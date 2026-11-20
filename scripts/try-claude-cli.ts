/**
 * The dev switch MODELS=claude-cli, live, on this laptop's Claude login: a writer's reply, an agent run through Quest's
 * own harness (two tool calls at once, their answers, then its reply), structured output on a picture, and the local
 * Whisper hearing a recording. Each with how long it took and what it used. Nothing is written or sent, and nothing
 * goes to OpenRouter.
 *
 *   node --experimental-strip-types scripts/try-claude-cli.ts [models] [picture:<png or jpeg>] [voice:<ogg, mp3, wav ...>] ...
 *
 * With no arguments: the model checks alone. The CLI logs in once, with npm run claude:login.
 */
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { MemorySaver } from "@langchain/langgraph";
import type { AudioFormat, Logger } from "@mq/core";
import { z } from "zod";
import { buildAgent, finalText } from "../apps/agent/src/agents/harness.ts";
import { usageOf } from "../apps/agent/src/agents/usage.ts";
import { loadConfig } from "../apps/agent/src/config.ts";
import { modelsFor, transcriberFor } from "../apps/agent/src/model-source.ts";
import { readEnvFile } from "./env-file.ts";

const args = process.argv.slice(2);
const config = loadConfig({ ...process.env, ...Object.fromEntries(readEnvFile()), MODELS: "claude-cli" });
const log: Logger = { info: (e, d) => console.log(`  · ${e} ${JSON.stringify(d ?? {})}`), warn: (e, d) => console.log(`  ! ${e} ${JSON.stringify(d ?? {})}`), error: (e, d) => console.log(`  !! ${e} ${JSON.stringify(d ?? {})}`) };
const models = await modelsFor(config, { log });
const spend = { record: (c: { agent: string; model: string | null; ms: number }) => console.log(`  · spend row: ${c.agent} ${c.model} ${c.ms} ms`) };

const used = (out: unknown): string => {
  const u = usageOf(out);
  return u ? `${u.input} in (${u.cached} cached, ${u.cacheWrite} written), ${u.output} out, cost ${u.cost}` : "no usage";
};
const timed = async <T>(label: string, job: () => Promise<T>): Promise<T> => {
  const started = Date.now();
  const out = await job();
  console.log(`  ${label}: ${((Date.now() - started) / 1000).toFixed(1)} s`);
  return out;
};

if (!args.length || args.includes("models")) {
  console.log("\n1. The writer: one reply, no tools");
  const reply = await timed("answered", () =>
    models.modelFor("writer").invoke([new SystemMessage("You write short, casual replies as a founder on Reddit. One or two sentences, no emoji."), new HumanMessage("Reply to: 'Is there anything that tracks freelance invoices without a monthly fee?'")]),
  );
  console.log(`  "${String(reply.content).trim()}"\n  ${used(reply)}`);

  console.log("\n2. An agent through the harness: two tool calls at once, then its reply");
  const seen: string[] = [];
  const weather = tool(async ({ city }: { city: string }) => `${city}: 7°C, light rain`, {
    name: "weather",
    description: "Today's weather in a city.",
    schema: z.object({ city: z.string().describe("The city's name") }),
  });
  const agent = buildAgent(
    {
      name: "try-claude-cli",
      model: models.modelFor("manager"),
      systemPrompt: "You help a founder plan their day. Use the weather tool for every city you are asked about, both at once, then answer in one sentence.",
      tools: [weather],
      stepBudget: 6,
      scratch: false,
      onTool: (name, a) => seen.push(`${name}(${JSON.stringify(a)})`),
      onModel: (call) => console.log(`  · model call ${call.ms} ms, ${call.model}, ${call.error ?? "ok"}, ${call.usage ? `${call.usage.input} in (${call.usage.cached} cached)` : "no usage"}`),
    },
    new MemorySaver(),
  );
  const run = await timed("run", () => agent.invoke({ messages: [new HumanMessage("Should I take an umbrella in Kyiv and in Lviv today?")] }, { configurable: { thread_id: `try-claude-cli:${Date.now()}` } }));
  console.log(`  tools: ${seen.join(", ") || "none"}\n  "${finalText(run)}"`);

  console.log("\n3. Structured output: the vision seat, a schema to answer with");
  const picture = args.find((a) => a.startsWith("picture:"))?.slice("picture:".length);
  const image = picture ? `data:image/${extname(picture).toLowerCase() === ".png" ? "png" : "jpeg"};base64,${readFileSync(picture).toString("base64")}` : null;
  const looked = await timed("answered", () =>
    models
      .modelFor("vision")
      .withStructuredOutput(z.object({ what: z.string().describe("What the input shows, in one sentence"), words: z.array(z.string()).describe("Every line of text in it") }), { name: "observation", includeRaw: true })
      .invoke([
        new SystemMessage("Say what you are shown."),
        new HumanMessage({ content: image ? [{ type: "image_url", image_url: { url: image } }] : "A sticky note that says: call Anna at 15:00, ship the landing page." }),
      ]),
  );
  console.log(`  ${JSON.stringify(looked.parsed)}\n  ${used(looked.raw)}`);
}

for (const file of args.filter((a) => a.startsWith("voice:")).map((a) => a.slice("voice:".length))) {
  console.log(`\n4. The local Whisper: ${file}`);
  const transcriber = await transcriberFor(config, { spend: spend as never, log });
  const format = extname(file).slice(1).toLowerCase() as AudioFormat;
  const audio = new Uint8Array(readFileSync(file));
  const plain = await timed("heard (first time: the model loads, and is fetched once)", () => transcriber.transcribe(audio, format, null));
  console.log(`  "${plain}"`);
  const speech = await timed("heard with each word's time", () => transcriber.timed(audio, format, null));
  console.log(`  ${speech.seconds.toFixed(1)} s of speech, ${speech.words.length} words: ${speech.words.slice(0, 6).map((w) => `${w.text}@${w.start}`).join(" ")} ...`);
}
process.exit(0);
