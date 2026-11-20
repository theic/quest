import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BaseChatModel, type BaseChatModelCallOptions, type BindToolsInput } from "@langchain/core/language_models/chat_models";
import { AIMessageChunk, type BaseMessage, type ToolCall } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { convertToOpenAITool } from "@langchain/core/utils/function_calling";
import type { Logger } from "@mq/core";
import { limitError, modelRest } from "../lib/model-rest.ts";
import { Gate, oneObject, prompt, schemaOf, toolChoice, workDir, type Block, type FunctionTool } from "./claude-cli-models.ts";
import type { ModelProvider, ModelRole, ModelRun, ModelSeat } from "./models.ts";

/**
 * MODELS=codex-cli: every model call goes to the ChatGPT subscription logged in on this computer, through the Codex
 * CLI (`codex exec`), for the local edition (docs/next-goal-open-source.md). One call is one fresh, ephemeral Codex
 * turn in an empty folder, its sandbox read-only, its user config left out.
 *
 * Codex has no tool that ends its turn, so Quest's tools are not offered as tools: they are written into the prompt,
 * and the answer comes in one JSON shape (`--output-schema`), what to say and the calls to make, each call's arguments
 * as a JSON string that the tool's own schema checks. Spiked 2026-11-19 (FACTS.md, "The local edition"): a structured
 * answer in 10 s, two tool calls in 9 s, a picture read in 5 s.
 */

/** How long one call may take, its CLI's start included, before it counts as stalled. */
const STALL_MS: Readonly<Record<ModelRole, number>> = { manager: 150_000, researcher: 200_000, volume: 200_000, writer: 120_000, vision: 150_000 };

const NOTE =
  "You act only through the tools listed below, never by running commands or reading files. Answer in the given JSON shape: " +
  '"say" is what you write now (null for nothing), "calls" the tools you call now, each with its arguments as one JSON object written as a string.';

/** Codex's own model for every seat unless CODEX_CLI_SEATS names one ("writer=gpt-6"). */
export class CodexCliModels implements ModelProvider {
  readonly #seats: Readonly<Record<ModelRole, ModelSeat>>;
  readonly #models: Readonly<Partial<Record<ModelRole, string>>>;
  readonly #gate: Gate;
  readonly #bin: string;
  readonly #log: Logger;

  constructor(deps: { seats: Readonly<Record<ModelRole, ModelSeat>>; models?: Partial<Record<ModelRole, string>>; callsAtOnce: number; log: Logger; bin?: string }) {
    this.#seats = deps.seats;
    this.#models = deps.models ?? {};
    this.#gate = new Gate(deps.callsAtOnce);
    this.#bin = deps.bin ?? codexBin();
    this.#log = deps.log;
  }

  get models(): Readonly<Partial<Record<ModelRole, string>>> {
    return this.#models;
  }

  modelFor(role: ModelRole, _run?: ModelRun): BaseChatModel {
    return new CodexCliChat({ bin: this.#bin, model: this.#models[role] ?? null, seat: this.#seats[role], stallMs: STALL_MS[role], gate: this.#gate, log: this.#log });
  }

  fallbackFor(): BaseChatModel | null {
    return null;
  }

  summarizer(run?: ModelRun): BaseChatModel {
    return this.modelFor("volume", run);
  }
}

/**
 * The codex to run: CODEX_BIN, else the one on PATH, else the one the Codex app keeps (Windows:
 * %LOCALAPPDATA%\OpenAI\Codex\bin\<build>\codex.exe).
 */
export function codexBin(): string {
  if (process.env["CODEX_BIN"]) return process.env["CODEX_BIN"];
  if (spawnSync("codex", ["--version"], { stdio: "ignore", shell: process.platform === "win32" }).status === 0) return "codex";
  const apps = process.env["LOCALAPPDATA"] ? join(process.env["LOCALAPPDATA"], "OpenAI", "Codex", "bin") : null;
  if (apps && existsSync(apps)) {
    for (const build of readdirSync(apps)) {
      const exe = join(apps, build, process.platform === "win32" ? "codex.exe" : "codex");
      if (existsSync(exe)) return exe;
    }
  }
  return "codex";
}

interface CodexCallOptions extends BaseChatModelCallOptions {
  readonly tools?: readonly FunctionTool[];
}

interface ChatDeps {
  readonly bin: string;
  readonly model: string | null;
  readonly seat: ModelSeat;
  readonly stallMs: number;
  readonly gate: Gate;
  readonly log: Logger;
}

class CodexCliChat extends BaseChatModel<CodexCallOptions> {
  readonly #d: ChatDeps;

  constructor(deps: ChatDeps) {
    super({});
    this.#d = deps;
  }

  _llmType(): string {
    return "codex-cli";
  }

  override bindTools(tools: BindToolsInput[], kwargs?: Partial<CodexCallOptions>) {
    const bound = tools.map((t) => convertToOpenAITool(t) as FunctionTool);
    const only = bound.length === 1 && kwargs === undefined ? bound[0]?.function.name : undefined;
    return this.withConfig({ ...kwargs, tools: bound, ...(only ? { tool_choice: only } : {}) } as Partial<CodexCallOptions>);
  }

  async _generate(messages: BaseMessage[], options: this["ParsedCallOptions"]): Promise<ChatResult> {
    const choice = toolChoice(options.tool_choice);
    const all = choice === "none" ? [] : (options.tools ?? []);
    const shape = typeof choice === "object" ? (all.find((t) => t.function.name === choice.name) ?? null) : null;
    const tools = shape ? [shape] : all;
    const must = shape ? `Answer by calling ${shape.function.name}, once.` : choice === "any" && tools.length ? "Answer by calling one of the tools." : null;
    const { system, content } = await prompt(messages, must);

    const resting = modelRest.until();
    if (resting) throw limitError(resting.toISOString());
    const release = await this.#d.gate.take(options.signal);
    const dir = mkdtempSync(join(workDir(), "codex-"));
    try {
      const { text, pictures } = flatten(content, dir);
      const body = [system, tools.length ? `${NOTE}\n\nTools:\n${tools.map(describe).join("\n")}` : "", text].filter(Boolean).join("\n\n");
      const schema = tools.length ? turnSchema(tools) : null;
      if (schema) writeFileSync(join(dir, "schema.json"), JSON.stringify(schema));
      const out = await this.#run(body, pictures, schema ? join(dir, "schema.json") : null, dir, options.signal);
      return { generations: [{ text: out.text, message: out.message }] };
    } finally {
      rmSync(dir, { recursive: true, force: true });
      release();
    }
  }

  #run(body: string, pictures: string[], schema: string | null, dir: string, signal?: AbortSignal): Promise<{ text: string; message: AIMessageChunk }> {
    const d = this.#d;
    const last = join(dir, "last.txt");
    const args = [
      "exec",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--skip-git-repo-check",
      "-s",
      "read-only",
      "--json",
      "-C",
      dir,
      "-o",
      last,
      ...(d.model ? ["-m", d.model] : []),
      "-c",
      `model_reasoning_effort="${!d.seat.reasoning || d.seat.effort === "minimal" ? "low" : (d.seat.effort ?? "medium")}"`,
      ...(schema ? ["--output-schema", schema] : []),
      ...pictures.flatMap((p) => ["-i", p]),
      "-",
    ];
    return new Promise((resolve, reject) => {
      const child = spawn(d.bin, args, { cwd: dir, env: cliEnv(), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (b: Buffer) => (stdout += b.toString()));
      child.stderr.on("data", (b: Buffer) => (stderr += b.toString()));
      const stop = () => child.kill();
      const stalled = setTimeout(stop, d.stallMs);
      signal?.addEventListener("abort", stop, { once: true });
      child.on("error", (e) => {
        clearTimeout(stalled);
        reject(new Error(`codex-cli: could not start ${d.bin}: ${e.message}`));
      });
      child.on("close", (code) => {
        clearTimeout(stalled);
        signal?.removeEventListener("abort", stop);
        if (signal?.aborted) return reject(new Error("aborted"));
        const said = existsSync(last) ? readFileSync(last, "utf8").trim() : "";
        const events = stdout.split(/\r?\n/).flatMap((l) => {
          try {
            return [JSON.parse(l) as { type?: string; usage?: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number }; message?: string; error?: { message?: string } }];
          } catch {
            return [];
          }
        });
        const failure = [...events.filter((e) => e.type === "error" || e.type === "turn.failed").map((e) => e.message ?? e.error?.message ?? ""), stderr].join(" ");
        if (/usage limit|rate limit|429/i.test(failure) && !said) {
          const until = new Date(Date.now() + 60 * 60_000).toISOString();
          d.log.warn("codex_cli.limit", { resetsAt: until });
          modelRest.note(until);
          return reject(limitError(until));
        }
        if (/not logged in|login|unauthorized|401/i.test(failure) && !said) return reject(new Error("codex-cli: not logged in; run `codex login` once"));
        if (code !== 0 && !said) return reject(new Error(`codex-cli: exited ${code}: ${failure.trim().slice(0, 300) || "no answer"}`));
        if (!said && code === null) return reject(new Error(`codex-cli: did not answer in ${Math.round(d.stallMs / 1000)} s`));
        const usage = events.findLast((e) => e.type === "turn.completed")?.usage ?? {};
        try {
          resolve(answer(said, schema !== null, usage, d.model ?? "default"));
        } catch (e) {
          reject(e);
        }
      });
      child.stdin.end(body);
    });
  }
}

/** The answer as LangChain takes it: the words, and the calls with their arguments parsed. */
function answer(said: string, structured: boolean, u: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number }, model: string): { text: string; message: AIMessageChunk } {
  let text = said;
  const calls: ToolCall[] = [];
  if (structured) {
    const parsed = JSON.parse(said) as { say: string | null; calls: { tool: string; args: string }[] };
    text = parsed.say ?? "";
    parsed.calls.forEach((c, i) => {
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(c.args) as Record<string, unknown>;
      } catch {
        args = { _unreadable: c.args };
      }
      calls.push({ id: `codex_${Date.now().toString(36)}_${i}`, name: c.tool, args, type: "tool_call" });
    });
  }
  const input = u.input_tokens ?? 0;
  const cached = u.cached_input_tokens ?? 0;
  const output = u.output_tokens ?? 0;
  const message = new AIMessageChunk({
    content: text,
    ...(calls.length ? { tool_calls: calls } : {}),
    usage_metadata: { input_tokens: input, output_tokens: output, total_tokens: input + output, input_token_details: { cache_read: cached } },
    response_metadata: { model_name: `codex-cli/${model}`, usage: { prompt_tokens: input, completion_tokens: output, cost: 0, prompt_tokens_details: { cached_tokens: cached } } },
  });
  return { text, message };
}

/** One answer's shape: what to say, and the calls, each naming one of the tools. */
function turnSchema(tools: readonly FunctionTool[]): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      say: { type: ["string", "null"] },
      calls: {
        type: "array",
        items: {
          type: "object",
          properties: { tool: { type: "string", enum: tools.map((t) => t.function.name) }, args: { type: "string" } },
          required: ["tool", "args"],
          additionalProperties: false,
        },
      },
    },
    required: ["say", "calls"],
    additionalProperties: false,
  };
}

/** A tool as the prompt lists it: its name, what it does, and its arguments' JSON Schema. */
function describe(t: FunctionTool): string {
  const { schema, shapes } = oneObject(schemaOf(t));
  return `- ${t.function.name}: ${t.function.description ?? ""}${shapes ? ` One of these shapes (? is optional): ${shapes}.` : ""}\n  arguments: ${JSON.stringify(schema)}`;
}

/** The blocks as one text, each picture saved as a file for `-i` and named where it was. */
function flatten(blocks: readonly Block[], dir: string): { text: string; pictures: string[] } {
  const pictures: string[] = [];
  const parts = blocks.map((b) => {
    if (b.type === "text") return b.text;
    const file = join(dir, `picture-${pictures.length + 1}.${b.source.media_type.split("/")[1]?.replace("jpeg", "jpg") ?? "png"}`);
    writeFileSync(file, Buffer.from(b.source.data, "base64"));
    pictures.push(file);
    return `[picture ${pictures.length}, attached]`;
  });
  return { text: parts.join("\n"), pictures };
}

/** What Codex needs to run and find its login (CODEX_HOME, the user's folders), never the agent's secrets or an API key. */
function cliEnv(): Record<string, string> {
  const keep = /^(PATH|PATHEXT|SYSTEMROOT|SYSTEMDRIVE|WINDIR|COMSPEC|USERPROFILE|USERNAME|USER|HOME|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|PROGRAMDATA|PROGRAMFILES|TEMP|TMP|TMPDIR|LANG|LC_ALL|XDG_[A-Z_]+|HTTPS?_PROXY|NO_PROXY|CODEX_HOME|NODE_EXTRA_CA_CERTS)$/i;
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && keep.test(k)) env[k] = v;
  return env;
}
