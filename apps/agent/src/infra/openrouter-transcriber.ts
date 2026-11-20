import type { AudioFormat, ClipWord, CustomerId, Logger, SpendLog, TimedSpeech, Transcriber } from "@mq/core";
import { tidySpeech } from "../conversation/voice-text.ts";

/** What OpenRouter's speech-to-text answers (openrouter.ai/docs/guides/overview/multimodal/stt). */
interface SttReply {
  readonly text?: string;
  /** With `verbose_json`: the language heard, how long it ran, and each word with its time (Whisper through OpenRouter, FACTS.md). */
  readonly language?: string;
  readonly duration?: number;
  readonly words?: readonly { readonly word?: string; readonly start?: number; readonly end?: number }[];
  /** `seconds` for a model priced by the second (Whisper), tokens for one priced by the token. */
  readonly usage?: { readonly seconds?: number; readonly input_tokens?: number; readonly output_tokens?: number; readonly cost?: number };
  readonly error?: { readonly message?: string; readonly code?: number };
}

/**
 * How long one model may take. OpenRouter's providers stop at 60 s of work; a 13 s voice
 * message took 1.4 s (FACTS.md), so this is only ever reached by a provider that hangs.
 */
const MODEL_TIMEOUT_MS = 70_000;

/**
 * Speech to text through OpenRouter's `/audio/transcriptions`: the recording goes as base64 in
 * JSON, the words come back as `text`. The models are tried in order (OpenRouter itself already
 * moves between a model's providers); each call is a row in the spend log, as `transcriber`.
 * What was said is never logged.
 */
export class OpenRouterTranscriber implements Transcriber {
  readonly #key: string;
  readonly #models: readonly string[];
  readonly #spend: SpendLog;
  readonly #log: Logger;
  readonly #fetch: typeof fetch;

  constructor(deps: { key: string; models: readonly string[]; spend: SpendLog; log: Logger; fetch?: typeof fetch }) {
    if (!deps.models.length) throw new Error("OpenRouterTranscriber needs at least one model");
    this.#key = deps.key;
    this.#models = deps.models;
    this.#spend = deps.spend;
    this.#log = deps.log;
    this.#fetch = deps.fetch ?? fetch;
  }

  async transcribe(audio: Uint8Array, format: AudioFormat, customerId: CustomerId | null): Promise<string> {
    const data = Buffer.from(audio).toString("base64");
    let last = "no model was tried";
    for (const model of this.#models) {
      const started = Date.now();
      try {
        return tidySpeech((await this.#ask(JSON.stringify({ model, input_audio: { data, format } }), model, customerId, started)).text ?? "");
      } catch (e) {
        last = e instanceof Error ? e.message : String(e);
        this.#log.warn("voice.model_failed", { ...(customerId ? { customerId } : {}), model, format, bytes: audio.byteLength, ms: Date.now() - started, error: last });
      }
    }
    throw new Error(`no model could hear it: ${last}`);
  }

  /**
   * The same with each word's time (`verbose_json` and word timestamps; a model or provider that refuses them is passed over,
   * and the words come back empty when no model gives times, with the text alone). An hour of speech is 12 calls of 5 minutes:
   * OpenRouter's providers stop at 60 s of work a request.
   */
  async timed(audio: Uint8Array, format: AudioFormat, customerId: CustomerId | null): Promise<TimedSpeech> {
    const data = Buffer.from(audio).toString("base64");
    let last = "no model was tried";
    let plain: TimedSpeech | null = null;
    for (const model of this.#models) {
      const started = Date.now();
      try {
        const reply = await this.#ask(JSON.stringify({ model, input_audio: { data, format }, response_format: "verbose_json", timestamp_granularities: ["word"] }), model, customerId, started);
        const words = wordsOf(reply);
        const speech: TimedSpeech = { text: tidySpeech(reply.text ?? ""), language: reply.language ?? null, seconds: reply.duration ?? reply.usage?.seconds ?? 0, words };
        if (words.length || !speech.text) return speech;
        plain ??= speech;
      } catch (e) {
        last = e instanceof Error ? e.message : String(e);
        this.#log.warn("voice.model_failed", { ...(customerId ? { customerId } : {}), model, format, bytes: audio.byteLength, ms: Date.now() - started, timed: true, error: last });
      }
    }
    if (plain) return plain;
    throw new Error(`no model could hear it: ${last}`);
  }

  async #ask(body: string, model: string, customerId: CustomerId | null, started: number): Promise<SttReply> {
    const send = this.#fetch;
    const res = await send("https://openrouter.ai/api/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.#key}`,
        "content-type": "application/json",
        "HTTP-Referer": "https://messaging.quest",
        "X-Title": "Messaging Quest",
      },
      body,
      signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
    });
    let reply: SttReply;
    try {
      reply = (await res.json()) as SttReply;
    } catch {
      throw new Error(`HTTP ${res.status}, and not JSON`);
    }
    if (!res.ok || reply.error || typeof reply.text !== "string") {
      throw new Error(`HTTP ${res.status}: ${reply.error?.message ?? "no text in the answer"}`);
    }
    const ms = Date.now() - started;
    const u = reply.usage ?? {};
    this.#spend.record({
      customerId,
      taskId: null,
      agent: "transcriber",
      model,
      ms,
      usage: { input: u.input_tokens ?? 0, cached: 0, cacheWrite: 0, output: u.output_tokens ?? 0, reasoning: 0, cost: u.cost ?? null },
    });
    this.#log.info("voice.heard", { ...(customerId ? { customerId } : {}), model, ms, seconds: u.seconds ?? null, cost: u.cost ?? null });
    return reply;
  }
}

/** Whisper's words: their text trimmed, with a start and an end that make sense, in order. */
export function wordsOf(reply: SttReply): ClipWord[] {
  const out: ClipWord[] = [];
  for (const w of reply.words ?? []) {
    const text = (w.word ?? "").trim();
    if (!text || typeof w.start !== "number" || typeof w.end !== "number" || !Number.isFinite(w.start) || !Number.isFinite(w.end)) continue;
    const start = Math.max(w.start, out.at(-1)?.end ?? 0);
    out.push({ start: Math.round(start * 1000) / 1000, end: Math.round(Math.max(w.end, start) * 1000) / 1000, text });
  }
  return out;
}
