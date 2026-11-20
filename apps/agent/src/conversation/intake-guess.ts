import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { Customer, IntakeQuestion, Logger, MemoryRepository, SpendLog, Transcript } from "@mq/core";
import type { ModelProvider } from "../agents/models.ts";
import { usageOf } from "../agents/usage.ts";
import { clip } from "../lib/sleeper.ts";
import type { IntakeGuesser } from "./intake.ts";

/**
 * Where they show up is read, not asked (the founder, 2026-10-24: "I already shared info about my project"): by the end
 * of the takes Quest has their own words (the voice message or lines they started with), the brief from their site, and
 * the sites their Chrome is signed in to. One small call on the volume seat reads it from those; nothing they said, no
 * answer.
 */
export const GUESS_SYSTEM = `Someone hired an assistant to find people online for them. Read the answer to each question below from what is known about them.
- Guess only what their own words, their brief or the facts plainly support. When nothing does, leave the question out: a wrong guess costs more than none.
- Use the option ids given: every id that is supported.
- For where they show up: the platforms they named, and those their Chrome is signed in to that suit the work.
Return only JSON: {"<question key>":["<option id>",…],…}`;

export function guessPrompt(c: Customer, questions: readonly IntakeQuestion[], said: readonly string[], facts: readonly string[]): string {
  return [
    `Their brief:\n"""\n${clip(c.brief ?? "", 3_000)}\n"""`,
    said.length ? `What they told the assistant, in their own words:\n${said.map((s) => `- "${clip(s, 1_200)}"`).join("\n")}` : "",
    facts.length ? `Facts:\n${facts.map((f) => `- ${f}`).join("\n")}` : "",
    "The questions:",
    ...questions.map((q) => `${q.key}: ${q.text} (every one that applies)\n${q.options.map((o) => `  - ${o.id}: ${o.label}`).join("\n")}`),
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function parseGuesses(raw: string, questions: readonly IntakeQuestion[]): Record<string, string[]> {
  try {
    const v = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)) as Record<string, unknown>;
    const out: Record<string, string[]> = {};
    for (const q of questions) {
      const ids = v[q.key];
      if (!Array.isArray(ids)) continue;
      const known = [...new Set(ids.filter((id): id is string => typeof id === "string" && q.options.some((o) => o.id === id)))];
      if (known.length) out[q.key] = known;
    }
    return out;
  } catch {
    return {};
  }
}

export class ModelIntakeGuesser implements IntakeGuesser {
  readonly #models: ModelProvider;
  readonly #transcript: Pick<Transcript, "recent">;
  readonly #memory: Pick<MemoryRepository, "list">;
  readonly #spend: SpendLog | undefined;
  readonly #log: Logger;

  constructor(deps: { models: ModelProvider; transcript: Pick<Transcript, "recent">; memory: Pick<MemoryRepository, "list">; spend?: SpendLog; log: Logger }) {
    this.#models = deps.models;
    this.#transcript = deps.transcript;
    this.#memory = deps.memory;
    this.#spend = deps.spend;
    this.#log = deps.log;
  }

  async guess(c: Customer, questions: readonly IntakeQuestion[]): Promise<Record<string, string[]>> {
    const asked = questions.filter((q) => q.options.length);
    if (!asked.length) return {};
    const [recent, memories] = await Promise.all([this.#transcript.recent(c.id, 40), this.#memory.list(c.id, 60)]);
    // Their own words: what they wrote or said, not the notes of what they tapped.
    const said = recent.filter((e) => e.direction === "in" && !e.text.startsWith("(")).map((e) => e.text).slice(-6);
    const facts = memories.filter((m) => m.kind !== "lesson").map((m) => m.text);
    const started = Date.now();
    const out = await this.#models.modelFor("volume", { customerId: c.id }).invoke([new SystemMessage(GUESS_SYSTEM), new HumanMessage(guessPrompt(c, asked, said, facts))]);
    const usage = usageOf(out);
    if (usage) this.#spend?.record({ customerId: c.id, taskId: null, agent: "intake-guess", model: (out as { response_metadata?: { model_name?: string } }).response_metadata?.model_name ?? null, ms: Date.now() - started, usage });
    const guesses = parseGuesses(typeof out.content === "string" ? out.content : out.content.map((p) => ("text" in p && typeof p.text === "string" ? p.text : "")).join(""), asked);
    this.#log.info("intake.guessed", { customerId: c.id, guessed: Object.keys(guesses).length, of: asked.length });
    return guesses;
  }
}
