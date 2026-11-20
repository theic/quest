/**
 * Does OpenRouter's cache hold the manager's standing prompt between calls? Sends the real system
 * prompt twice in one session (two different turns), then once with no session, for each seat's
 * model, and prints what each call used: input, cached, cost. About a cent in all.
 *
 *   node --experimental-strip-types scripts/try-cache.ts [model id …]
 *   MQ_ENV_FILE=<path to .env.local> …   (when the key lives in another checkout)
 *   MQ_CHEAPEST=1 …   (each call to the cheapest provider first, as a seat with `cheapest` sends it)
 */
import { randomUUID } from "node:crypto";
import { OpenRouterModels, type ModelSeat } from "../apps/agent/src/agents/models.ts";
import { usageOf } from "../apps/agent/src/agents/usage.ts";
import { managerPrompt } from "../apps/agent/src/manager/prompt.ts";
import { explorerSpec } from "../apps/agent/src/tasks/explorer.ts";
import { outreachSpec } from "../apps/agent/src/tasks/outreach.ts";
import { researcherSpec } from "../apps/agent/src/tasks/researcher.ts";
import { scoutSpec } from "../apps/agent/src/tasks/scout.ts";
import { SubagentCatalog } from "../apps/agent/src/tasks/subagents.ts";
import { ENV_PATH, readEnvFile } from "./env-file.ts";

const env = readEnvFile(ENV_PATH);
const key = env.get("OPENROUTER_API_KEY");
if (!key) throw new Error("OPENROUTER_API_KEY missing from .env.local");
const ids = process.argv.slice(2).length ? process.argv.slice(2) : ["xiaomi/mimo-v2.6-pro", "deepseek/deepseek-v4.1-flash"];

const system = managerPrompt(new SubagentCatalog([researcherSpec(), scoutSpec(), explorerSpec(), outreachSpec()]).describe());
console.log(`standing prompt: ${system.length} characters`);

for (const id of ids) {
  const seat: ModelSeat = { id, fallbacks: [], maxTokens: 50, temperature: 0, reasoning: false, cheapest: process.env["MQ_CHEAPEST"] === "1" };
  const models = new OpenRouterModels(key, { manager: seat, researcher: seat, volume: seat, writer: seat, vision: seat });
  const session = `cache-check:${randomUUID()}`;
  const ask = async (label: string, turn: string, withSession: boolean) => {
    const started = Date.now();
    const model = models.modelFor("manager", withSession ? { session } : undefined);
    const reply = await model.invoke([
      { role: "system", content: system },
      { role: "user", content: `${turn}\nReply with the single word OK.` },
    ]);
    const u = usageOf(reply);
    const served = (reply.response_metadata as { model_name?: string })?.model_name ?? "?";
    const provider = (reply.response_metadata as { provider?: string })?.provider ?? "";
    console.log(
      `${id} ${label}: ${((Date.now() - started) / 1000).toFixed(1)} s, in ${u?.input ?? "?"}, cached ${u?.cached ?? "?"}, out ${u?.output ?? "?"}, ` +
        `cost ${u?.cost?.toFixed(6) ?? "?"} (${served}${provider ? ` at ${provider}` : ""})`,
    );
  };
  await ask("turn 1, session", `Turn ${randomUUID()}: a heartbeat, nothing new.`, true);
  await ask("turn 2, same session", `Turn ${randomUUID()}: a task finished.`, true);
  await ask("turn 3, same session", `Turn ${randomUUID()}: the customer wrote.`, true);
  await ask("turn 4, no session", `Turn ${randomUUID()}: their evening came.`, false);
}
