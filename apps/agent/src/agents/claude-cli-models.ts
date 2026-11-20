import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query, type McpServerConfig, type Options, type SDKMessage, type SDKResultMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { BaseChatModel, type BaseChatModelCallOptions, type BindToolsInput } from "@langchain/core/language_models/chat_models";
import { AIMessageChunk, type AIMessage, type BaseMessage, type ToolCall } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { convertToOpenAITool } from "@langchain/core/utils/function_calling";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Logger } from "@mq/core";
import { limitError, modelRest } from "../lib/model-rest.ts";
import type { ModelProvider, ModelRole, ModelRun, ModelSeat } from "./models.ts";

/**
 * Dev only (MODELS=claude-cli, dev's default): every model call goes to the Claude subscription logged in on this
 * laptop, through the Claude Code CLI the Agent SDK ships, so testing on @TestPatrikBot costs nothing on OpenRouter.
 * Production refuses it (environments.ts): the subscription is the founder's own, never the customers'.
 *
 * The CLI is an agent of its own, and Quest's agents need a model that only names its tool calls. So each call is one
 * turn of a fresh CLI: Claude Code's prompt and tools out, Quest's system prompt as it is, the conversation so far
 * written out in one message, and Quest's tools offered through an MCP server of this process whose every tool ends
 * the turn (`claude/endTurn`): the calls come back to LangGraph, which runs them, and nothing runs in the CLI.
 */

/** The tools' MCP server, as the model sees it: `mcp__quest__<tool>`. */
const SERVER = "quest";

/** How long one call may take, its CLI's start included (about a second), before it counts as stalled. */
const STALL_MS: Readonly<Record<ModelRole, number>> = { manager: 120_000, researcher: 180_000, volume: 180_000, writer: 90_000, vision: 120_000 };

/** Added to the system prompt, so a written-out history reads as the model's own and its next step goes through the tools. */
const CLI_NOTE =
  "Each of your steps starts fresh, so the conversation so far is written out in the user's message: <message from=\"you\"> is what you wrote, " +
  "<tool_call> a tool you called and <tool_result> what it answered. To act, call the tools themselves; never write a tool call out as text.";

/**
 * The Claude each seat runs on the CLI (the founder, 2026-11-05: "switch dev to sonnet and haiku, the usage grows too
 * fast. But the writing and decision quality should not drop"): Sonnet where Quest decides, writes as them and checks
 * people (production's writer is Sonnet too), Haiku for the poster's clicks and pictures (production's vision seat) and
 * the judges and summaries (production's is DeepSeek Flash). Over a day on Opus, its manager and the poster were 36M of
 * the 49M tokens in. The writer went back to Opus the same day (the founder: "The posting became too template'y"): a
 * few short calls a run, so it costs little of what Opus cost before; Fable 5.2 from 2026-11-17 to 19, then Opus 5.5 again (the founder). CLAUDE_CLI_SEATS
 * moves one.
 */
export const CLAUDE_SEATS: Readonly<Record<ModelRole, string>> = {
  manager: "claude-sonnet-5-5",
  writer: "claude-opus-5-5",
  researcher: "claude-sonnet-5-5",
  volume: "claude-haiku-5-5",
  vision: "claude-haiku-5-5",
};

export class ClaudeCliModels implements ModelProvider {
  readonly #seats: Readonly<Record<ModelRole, ModelSeat>>;
  readonly #models: Readonly<Record<ModelRole, string>>;
  readonly #gate: Gate;
  readonly #log: Logger;

  constructor(deps: { seats: Readonly<Record<ModelRole, ModelSeat>>; models?: Partial<Record<ModelRole, string>>; callsAtOnce: number; log: Logger }) {
    this.#seats = deps.seats;
    const pick = (role: ModelRole) => deps.models?.[role] ?? CLAUDE_SEATS[role];
    this.#models = { manager: pick("manager"), researcher: pick("researcher"), volume: pick("volume"), writer: pick("writer"), vision: pick("vision") };
    this.#gate = new Gate(deps.callsAtOnce);
    this.#log = deps.log;
  }

  /** Which model each seat runs, for the start log. */
  get models(): Readonly<Record<ModelRole, string>> {
    return this.#models;
  }

  modelFor(role: ModelRole, _run?: ModelRun): BaseChatModel {
    return new ClaudeCliChat({ model: this.#models[role], seat: this.#seats[role], stallMs: STALL_MS[role], gate: this.#gate, log: this.#log });
  }

  // One CLI, one subscription: a stalled call is the harness's to retry, with nowhere else to go.
  fallbackFor(): BaseChatModel | null {
    return null;
  }

  summarizer(run?: ModelRun): BaseChatModel {
    return this.modelFor("volume", run);
  }
}

/** A tool as OpenAI's format has it: what `convertToOpenAITool` makes of a LangChain tool or a plain schema. */
export interface FunctionTool {
  readonly type: "function";
  readonly function: { readonly name: string; readonly description?: string; readonly parameters?: Record<string, unknown> };
}

interface ClaudeCliCallOptions extends BaseChatModelCallOptions {
  readonly tools?: readonly FunctionTool[];
}

interface ChatDeps {
  readonly model: string;
  readonly seat: ModelSeat;
  readonly stallMs: number;
  readonly gate: Gate;
  readonly log: Logger;
}

/** An Anthropic content block, as the CLI's user message takes it. */
export type Block = { type: "text"; text: string } | { type: "image"; source: { type: "base64"; media_type: string; data: string } };

class ClaudeCliChat extends BaseChatModel<ClaudeCliCallOptions> {
  readonly #d: ChatDeps;

  constructor(deps: ChatDeps) {
    super({});
    this.#d = deps;
  }

  _llmType(): string {
    return "claude-cli";
  }

  // createAgent always passes its options; LangChain's own withStructuredOutput binds its one tool with none, and must get
  // that tool's call back, so a lone tool bound without options is the answer's shape (see #answer).
  override bindTools(tools: BindToolsInput[], kwargs?: Partial<ClaudeCliCallOptions>) {
    const bound = tools.map((t) => convertToOpenAITool(t) as FunctionTool);
    const only = bound.length === 1 && kwargs === undefined ? bound[0]?.function.name : undefined;
    return this.withConfig({ ...kwargs, tools: bound, ...(only ? { tool_choice: only } : {}) } as Partial<ClaudeCliCallOptions>);
  }

  async _generate(messages: BaseMessage[], options: this["ParsedCallOptions"]): Promise<ChatResult> {
    const choice = toolChoice(options.tool_choice);
    const tools = choice === "none" ? [] : (options.tools ?? []);
    // A tool the call must answer with is the answer's shape: the CLI's own structured output, checked against its schema.
    const shape = typeof choice === "object" ? tools.find((t) => t.function.name === choice.name) ?? null : null;
    const { system, content, written } = await prompt(messages, choice === "any" && tools.length ? "Answer by calling one of the tools." : null);

    // The limit was met and is not over: no CLI is started to hear it again (live, 2026-11-10: 283 times in 43 minutes).
    const resting = modelRest.until();
    if (resting) throw limitError(resting.toISOString());
    const release = await this.#d.gate.take(options.signal);
    const abort = new AbortController();
    const stop = () => abort.abort();
    options.signal?.addEventListener("abort", stop, { once: true });
    const stalled = setTimeout(stop, this.#d.stallMs);
    try {
      const run = query({ prompt: once(content), options: this.#options(written ? [system, CLI_NOTE].filter(Boolean).join("\n\n") : system, shape ? [] : tools, shape, abort) });
      const out = await this.#read(run, abort, shape);
      return { generations: [{ text: out.text, message: out.message }] };
    } catch (e) {
      if (options.signal?.aborted) throw new Error("aborted");
      if (abort.signal.aborted) throw new Error(`claude-cli: ${this.#d.model} did not answer in ${Math.round(this.#d.stallMs / 1000)} s`);
      throw e;
    } finally {
      clearTimeout(stalled);
      options.signal?.removeEventListener("abort", stop);
      release();
    }
  }

  #options(system: string, tools: readonly FunctionTool[], shape: FunctionTool | null, abort: AbortController): Options {
    const seat = this.#d.seat;
    return {
      model: this.#d.model,
      systemPrompt: system,
      // None of Claude Code's own tools, settings, hooks, plugins, project files or saved sessions.
      tools: [],
      settingSources: [],
      strictMcpConfig: true,
      persistSession: false,
      verbatimPrompts: true,
      cwd: workDir(),
      env: cliEnv(seat),
      abortController: abort,
      // Claude 5 models think when told not to (a manager step with reasoning off came back with thinking): a seat without
      // reasoning thinks as little as they can.
      thinking: { type: "adaptive" as const },
      ...(!seat.reasoning || seat.effort === "minimal" ? { effort: "low" as const } : seat.effort ? { effort: seat.effort } : {}),
      ...(shape ? { outputFormat: { type: "json_schema" as const, schema: oneObject(schemaOf(shape)).schema } } : {}),
      ...(tools.length
        ? { mcpServers: { [SERVER]: toolServer(tools) }, allowedTools: [`mcp__${SERVER}`], permissionMode: "dontAsk" as const, maxTurns: 1 }
        : { permissionMode: "dontAsk" as const }),
    };
  }

  /**
   * The turn's answer: its words and the tools it called (none of them run here), or the shape's structured output. One
   * API answer may come as several messages, a block each. The first answer that says or calls something is the one: a
   * later one after it is the CLI going on, which it must not. One with neither (only thinking, or an attempt the CLI
   * retried) gives way to the next; live, 2026-11-03, keeping it lost the reply to "how's it going so far?".
   */
  async #read(run: AsyncIterable<SDKMessage>, abort: AbortController, shape: FunctionTool | null): Promise<{ text: string; message: AIMessageChunk }> {
    let current: string | null = null;
    let answered = this.#d.model;
    let text = "";
    let error: string | null = null;
    let limit: string | null = null;
    let result: SDKResultMessage | null = null;
    const calls: ToolCall[] = [];
    const passed: string[] = [];
    for await (const m of run) {
      if (m.type === "assistant" && m.parent_tool_use_id === null) {
        if (m.message.id !== current) {
          if (current !== null && (text.trim() || calls.length)) continue;
          if (current !== null) passed.push(error ?? "nothing said");
          current = m.message.id;
          text = "";
          error = null;
          calls.length = 0;
        }
        answered = m.message.model || answered;
        if (m.error) error = m.error;
        for (const block of m.message.content) {
          if (block.type === "text") text += block.text;
          else if (block.type === "tool_use") calls.push({ id: block.id, name: block.name.replace(`mcp__${SERVER}__`, ""), args: (block.input ?? {}) as Record<string, unknown>, type: "tool_call" });
        }
      } else if (m.type === "rate_limit_event" && m.rate_limit_info.status === "rejected") {
        limit = m.rate_limit_info.resetsAt ? new Date(m.rate_limit_info.resetsAt * 1000).toISOString() : "later";
      } else if (m.type === "result") {
        result = m;
        break;
      }
    }
    if (abort.signal.aborted) throw new Error("aborted");
    if (passed.length) this.#d.log.info("claude_cli.passed_over", { model: this.#d.model, passed, said: text.trim().length, calls: calls.length });
    if (limit) {
      this.#d.log.warn("claude_cli.limit", { model: this.#d.model, resetsAt: limit });
      modelRest.note(limit);
      throw limitError(limit);
    }
    if (error === "authentication_failed") throw new Error("claude-cli: not logged in; run npm run claude:login once");
    if (!result) throw new Error(`claude-cli: ${this.#d.model} ended without an answer${error ? ` (${error})` : ""}`);
    // maxTurns ends the turn after the calls when the CLI does not end it at them itself: that is the answer too.
    const done = result.subtype === "success" || (result.subtype === "error_max_turns" && calls.length > 0);
    if (!done || (result.subtype === "success" && result.is_error && !calls.length)) {
      const why = result.subtype === "success" ? result.result : result.errors.join("; ");
      this.#d.log.warn("claude_cli.failed", { model: this.#d.model, subtype: result.subtype, error, why: why?.slice(0, 300) ?? null });
      throw new Error(`claude-cli: ${this.#d.model} failed: ${error ?? why?.slice(0, 200) ?? result.subtype}`);
    }
    if (shape) {
      const parsed = result.subtype === "success" ? result.structured_output : undefined;
      if (!parsed || typeof parsed !== "object") throw new Error(`claude-cli: ${this.#d.model} gave no ${shape.function.name}`);
      calls.splice(0, calls.length, { id: `${result.session_id}:${shape.function.name}`, name: shape.function.name, args: parsed as Record<string, unknown>, type: "tool_call" });
      text = "";
    }
    const u = result.usage;
    const cacheRead = u.cache_read_input_tokens ?? 0;
    const cacheWrite = u.cache_creation_input_tokens ?? 0;
    const input = (u.input_tokens ?? 0) + cacheRead + cacheWrite;
    // A chunk, as the providers answer: LangChain's structured output takes nothing else (a plain AIMessage parsed to null).
    const message = new AIMessageChunk({
      content: text,
      ...(calls.length ? { tool_calls: calls } : {}),
      usage_metadata: { input_tokens: input, output_tokens: u.output_tokens ?? 0, total_tokens: input + (u.output_tokens ?? 0), input_token_details: { cache_read: cacheRead, cache_creation: cacheWrite } },
      // Read by usage.ts as OpenRouter's would be. Nothing was paid: the subscription's estimate is not a cost.
      response_metadata: {
        model_name: `claude-cli/${answered}`,
        usage: { prompt_tokens: input, completion_tokens: u.output_tokens ?? 0, cost: 0, prompt_tokens_details: { cached_tokens: cacheRead, cache_write_tokens: cacheWrite } },
      },
    });
    return { text, message };
  }
}

/** What the call must answer with: anything, nothing, any one of its tools, or the one named. */
export function toolChoice(raw: unknown): "auto" | "none" | "any" | { name: string } {
  if (raw === undefined || raw === null || raw === "auto") return "auto";
  if (raw === "none") return "none";
  if (raw === "any" || raw === "required") return "any";
  if (typeof raw === "string") return { name: raw };
  const named = (raw as { function?: { name?: string }; name?: string }).function?.name ?? (raw as { name?: string }).name;
  return named ? { name: named } : "auto";
}

/**
 * The system prompt, and everything else as one user message: a lone first message as it is (a writer's or a judge's
 * ask), a run's history written out, a block a message so the cache keeps what an earlier step already sent.
 */
export async function prompt(messages: readonly BaseMessage[], must: string | null): Promise<{ system: string; content: Block[]; written: boolean }> {
  const system: string[] = [];
  const rest: BaseMessage[] = [];
  for (const m of messages) {
    if (m.getType() === "system" && !rest.length) system.push(textOf(m.content));
    else rest.push(m);
  }
  const content: Block[] = [];
  const written = !(rest.length === 1 && rest[0]?.getType() === "human");
  if (!written) {
    content.push(...(await blocksOf(rest[0]?.content)));
  } else {
    content.push({ type: "text", text: "The conversation so far:" });
    for (const m of rest) {
      const type = m.getType();
      if (type === "human") content.push({ type: "text", text: `<message from="user">\n${textOf(m.content)}\n</message>` }, ...(await imagesOf(m.content)));
      else if (type === "system") content.push({ type: "text", text: `<message from="system">\n${textOf(m.content)}\n</message>` });
      else if (type === "ai") {
        const said = textOf(m.content).trim();
        const calls = (m as AIMessage).tool_calls ?? [];
        content.push({ type: "text", text: [said ? `<message from="you">\n${said}\n</message>` : "", ...calls.map((c) => `<tool_call id="${c.id ?? ""}" name="${c.name}">${JSON.stringify(c.args)}</tool_call>`)].filter(Boolean).join("\n") || "<message from=\"you\"></message>" });
      } else if (type === "tool") {
        const t = m as BaseMessage & { tool_call_id?: string; name?: string };
        content.push({ type: "text", text: `<tool_result id="${t.tool_call_id ?? ""}" name="${t.name ?? ""}">\n${textOf(m.content)}\n</tool_result>` }, ...(await imagesOf(m.content)));
      }
    }
    content.push({ type: "text", text: "Your next step." });
  }
  if (must) content.push({ type: "text", text: must });
  if (!content.length) content.push({ type: "text", text: "(nothing)" });
  return { system: system.join("\n\n"), content, written };
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((p) => (typeof p === "string" ? p : (p as { type?: string; text?: string }).type === "text" ? ((p as { text?: string }).text ?? "") : "")).join("");
}

async function blocksOf(content: unknown): Promise<Block[]> {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  const out: Block[] = [];
  for (const p of Array.isArray(content) ? content : []) {
    if (typeof p === "string") out.push({ type: "text", text: p });
    else if ((p as { type?: string }).type === "text") out.push({ type: "text", text: (p as { text?: string }).text ?? "" });
    else out.push(...(await imagesOf([p])));
  }
  return out;
}

/** Pictures in LangChain's shapes (`image_url`, a data URL or an address; `image` with base64) as Anthropic's. */
async function imagesOf(content: unknown): Promise<Block[]> {
  const out: Block[] = [];
  for (const p of Array.isArray(content) ? content : []) {
    const part = p as { type?: string; image_url?: string | { url?: string }; data?: string; mimeType?: string; mime_type?: string; url?: string };
    if (part.type === "image_url") {
      const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
      if (url) out.push(await imageFrom(url));
    } else if (part.type === "image") {
      if (part.data) out.push({ type: "image", source: { type: "base64", media_type: part.mimeType ?? part.mime_type ?? "image/jpeg", data: part.data } });
      else if (part.url) out.push(await imageFrom(part.url));
    }
  }
  return out;
}

async function imageFrom(url: string): Promise<Block> {
  const data = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (data) return { type: "image", source: { type: "base64", media_type: data[1] ?? "image/jpeg", data: data[2] ?? "" } };
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`claude-cli: the picture answered HTTP ${res.status}`);
  return { type: "image", source: { type: "base64", media_type: res.headers.get("content-type")?.split(";")[0] ?? "image/jpeg", data: Buffer.from(await res.arrayBuffer()).toString("base64") } };
}

async function* once(content: Block[]): AsyncIterable<SDKUserMessage> {
  yield { type: "user", message: { role: "user", content: content as never }, parent_tool_use_id: null };
}

/** A tool's parameters as a JSON Schema the CLI takes for structured output: an object, without the dialect line. */
export function schemaOf(tool: FunctionTool): Record<string, unknown> {
  const { $schema: _dialect, ...schema } = tool.function.parameters ?? { type: "object", properties: {} };
  return schema;
}

type Json = Record<string, unknown>;

/**
 * Claude takes a tool's parameters only as one object. A union at the top (`browser_act`'s and the poster's `prepare`:
 * one shape for each kind of action) left the tool out of the CLI's list, so no run could click or type, and live,
 * 2026-11-03, the poster gave up on X and Instagram with "the fill tool isn't available". The shapes become one object,
 * with every field of each, required only where all of them require it; the description names each shape, and the
 * tool's own schema still checks every call.
 */
export function oneObject(schema: Json): { schema: Json; shapes: string | null } {
  const variants = (schema.oneOf ?? schema.anyOf) as Json[] | undefined;
  if (!Array.isArray(variants) || !variants.every((v) => v.type === "object")) return { schema, shapes: null };
  const fields = (v: Json) => (v.properties ?? {}) as Record<string, Json>;
  const properties: Record<string, Json> = {};
  const tags = new Map<string, unknown[]>();
  for (const v of variants) {
    for (const [name, p] of Object.entries(fields(v))) {
      if ("const" in p) tags.set(name, [...(tags.get(name) ?? []), p.const]);
      else properties[name] ??= p;
    }
  }
  for (const [name, values] of tags) properties[name] = { ...(values.every((x) => typeof x === "string") ? { type: "string" } : {}), enum: values };
  const required = Object.keys(properties).filter((name) => variants.every((v) => ((v.required ?? []) as string[]).includes(name)));
  const shape = (v: Json) => {
    const own = fields(v);
    const needs = new Set((v.required ?? []) as string[]);
    const tag = Object.entries(own).filter(([, p]) => "const" in p).map(([name, p]) => `${name} "${String(p.const)}"`);
    const rest = Object.keys(own).filter((name) => !("const" in own[name]!)).map((name) => (needs.has(name) ? name : `${name}?`));
    return rest.length ? `${tag.join(", ")} with ${rest.join(", ")}` : tag.join(", ");
  };
  const { oneOf: _one, anyOf: _any, ...rest } = schema;
  return { schema: { ...rest, type: "object", properties, ...(required.length ? { required } : {}) }, shapes: variants.map(shape).join("; ") };
}

/**
 * Quest's tools as an MCP server in this process, for one call. Each ends the turn when called (`claude/endTurn`), and
 * answers nothing: LangGraph runs the call from the reply.
 */
function toolServer(tools: readonly FunctionTool[]): McpServerConfig {
  const server = new Server({ name: SERVER, version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => {
      const { schema, shapes } = oneObject(schemaOf(t));
      const description = t.function.description ?? "";
      return {
        name: t.function.name,
        description: shapes ? `${description}\n\nOne of these shapes (? is optional): ${shapes}.` : description,
        inputSchema: { type: "object", ...schema } as { type: "object" },
        _meta: { "claude/endTurn": true, "anthropic/alwaysLoad": true },
      };
    }),
  }));
  server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: "text", text: "Taken." }] }));
  // The SDK connects what it is handed; its own McpServer type wraps a Server like this one.
  return { type: "sdk", name: SERVER, instance: server } as unknown as McpServerConfig;
}

/**
 * The CLI's environment: what it needs to run and find its login, never the agent's secrets, and never an API key,
 * which would bill the API instead of the subscription.
 */
function cliEnv(seat: ModelSeat): Record<string, string> {
  const keep = /^(PATH|PATHEXT|SYSTEMROOT|SYSTEMDRIVE|WINDIR|COMSPEC|USERPROFILE|USERNAME|USER|HOME|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|PROGRAMDATA|PROGRAMFILES|TEMP|TMP|TMPDIR|LANG|LC_ALL|XDG_[A-Z_]+|HTTPS?_PROXY|NO_PROXY|CLAUDE_CONFIG_DIR|CLAUDE_CODE_OAUTH_TOKEN|NODE_EXTRA_CA_CERTS)$/i;
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && keep.test(k)) env[k] = v;
  return {
    ...env,
    CLAUDE_AGENT_SDK_CLIENT_APP: "messaging-quest-dev/1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
    // The seat's limit, with room for thinking where the seat thinks.
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(seat.maxTokens + (seat.reasoning ? 8_000 : 0)),
  };
}

let made: string | null = null;
/** An empty folder of its own: no project's CLAUDE.md or settings around it. */
export function workDir(): string {
  if (!made) {
    made = join(tmpdir(), "mq-claude-cli");
    mkdirSync(made, { recursive: true });
  }
  return made;
}

/** At most so many CLIs at once: each is a process of its own, a few hundred MB. */
export class Gate {
  readonly #size: number;
  #busy = 0;
  readonly #waiting: (() => void)[] = [];

  constructor(size: number) {
    this.#size = Math.max(1, size);
  }

  /** A place, kept until the function it gives back is called; a call that waits for one and is aborted leaves the line. */
  async take(signal?: AbortSignal): Promise<() => void> {
    if (this.#busy < this.#size) this.#busy++;
    else {
      // A place given up goes straight to the next in line, still counted as busy.
      await new Promise<void>((resolve, reject) => {
        const go = () => {
          signal?.removeEventListener("abort", quit);
          resolve();
        };
        const quit = () => {
          const i = this.#waiting.indexOf(go);
          if (i >= 0) this.#waiting.splice(i, 1);
          reject(new Error("aborted"));
        };
        this.#waiting.push(go);
        signal?.addEventListener("abort", quit, { once: true });
      });
    }
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const next = this.#waiting.shift();
      if (next) next();
      else this.#busy--;
    };
  }
}
