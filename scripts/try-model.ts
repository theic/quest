/**
 * One tool-calling round trip through OpenRouter with the configured manager seat:
 * proves the key, the model and tool calling before a customer ever meets them.
 *
 *   node --experimental-strip-types scripts/try-model.ts [model id]
 */
import { tool } from "langchain";
import { z } from "zod";
import { OpenRouterModels } from "../apps/agent/src/agents/models.ts";
import { usageOf } from "../apps/agent/src/agents/usage.ts";
import { readEnvFile } from "./env-file.ts";

const env = readEnvFile();
const key = env.get("OPENROUTER_API_KEY");
if (!key) throw new Error("OPENROUTER_API_KEY missing from .env.local");
const id = process.argv[2] ?? env.get("MANAGER_MODEL") ?? "xiaomi/mimo-v2.6-pro";

const models = new OpenRouterModels(key, {
  manager: { id, fallbacks: ["deepseek/deepseek-v4.1-flash"], maxTokens: 2000, temperature: 0.2, reasoning: false },
  researcher: { id, fallbacks: [], maxTokens: 2000, temperature: 0.2, reasoning: true },
  volume: { id, fallbacks: [], maxTokens: 2000, temperature: 0.2, reasoning: false },
  writer: { id, fallbacks: [], maxTokens: 2000, temperature: 0.2, reasoning: false },
  vision: { id, fallbacks: [], maxTokens: 2000, temperature: 0.2, reasoning: false },
});
const saveSite = tool(async ({ url }) => `saved ${url}`, {
  name: "save_site",
  description: "Remember the customer's website address.",
  schema: z.object({ url: z.string() }),
});

const started = Date.now();
const model = models.modelFor("manager").bindTools!([saveSite]);
const reply = await model.invoke([
  { role: "system", content: "You are Quest. When the customer gives a website, call save_site with it." },
  { role: "user", content: "hi! my site is acme-invoicing.com" },
]);
console.log(`${id}: ${((Date.now() - started) / 1000).toFixed(1)} s`);
console.log("tool calls:", JSON.stringify(reply.tool_calls?.map((c) => ({ name: c.name, args: c.args }))));
console.log("text:", String(reply.content).slice(0, 200));
console.log("served by:", (reply.response_metadata as { model_name?: string })?.model_name ?? "(unknown)");
console.log("used:", JSON.stringify(usageOf(reply)));
