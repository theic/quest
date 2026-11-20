import type { Logger, SpendLog, Transcriber } from "@mq/core";
import { OpenRouterModels, type ModelProvider } from "./agents/models.ts";
import type { Config } from "./config.ts";
import { OpenRouterTranscriber } from "./infra/openrouter-transcriber.ts";

/**
 * Where the model calls go, as MODELS says: OpenRouter, or on a dev laptop the Claude CLI and a local Whisper. Those two
 * are dev dependencies, loaded only then: production installs neither, and refuses MODELS=claude-cli (environments.ts).
 */
export async function modelsFor(config: Config, deps: { log?: Logger } = {}): Promise<ModelProvider> {
  if (config.models.via === "openrouter") return new OpenRouterModels(config.models.key, config.seats);
  const log = deps.log ?? QUIET;
  if (config.models.via === "codex-cli") {
    const { CodexCliModels } = await import("./agents/codex-cli-models.ts");
    const codex = new CodexCliModels({ seats: config.seats, models: config.models.seats, callsAtOnce: config.models.callsAtOnce, log });
    log.info("models.codex_cli", { ...codex.models, callsAtOnce: config.models.callsAtOnce });
    return codex;
  }
  const { ClaudeCliModels } = await import("./agents/claude-cli-models.ts");
  const models = new ClaudeCliModels({ seats: config.seats, models: config.models.seats, callsAtOnce: config.models.callsAtOnce, log });
  log.info("models.claude_cli", { ...models.models, callsAtOnce: config.models.callsAtOnce });
  return models;
}

/** For a script's models: what went wrong, on stderr. */
const QUIET: Logger = { info: () => {}, warn: (e, d) => console.warn(e, JSON.stringify(d ?? {})), error: (e, d) => console.error(e, JSON.stringify(d ?? {})) };

/** Who hears voice messages: OpenRouter's Whisper, or the same Whisper on this machine with the Claude CLI. */
export async function transcriberFor(config: Config, deps: { spend: SpendLog; log: Logger }): Promise<Transcriber> {
  if (config.models.via === "openrouter") {
    return new OpenRouterTranscriber({ key: config.models.key, models: config.transcribeModels, spend: deps.spend, log: deps.log });
  }
  const { LocalWhisper } = await import("./infra/local-whisper.ts");
  const whisper = new LocalWhisper({ model: config.models.whisper, spend: deps.spend, log: deps.log });
  whisper.warm();
  return whisper;
}
