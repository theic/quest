import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { AudioFormat, ClipWord, CustomerId, Logger, SpendLog, TimedSpeech, Transcriber } from "@mq/core";
import { tidySpeech } from "../conversation/voice-text.ts";
import { FFMPEG, runFfmpeg } from "./ffmpeg.ts";

/** What Whisper hears at: mono, 16 kHz. */
const RATE = 16_000;

/** Where the model is kept once fetched: one copy for every checkout and worktree on this machine. */
const CACHE = join(homedir(), ".cache", "mq-whisper");

interface Heard {
  readonly text: string;
  readonly chunks?: readonly { readonly text: string; readonly timestamp: readonly [number | null, number | null] }[];
}

/** transformers.js's speech pipeline, and the parts of it the language is read with. */
interface Asr {
  (audio: Float32Array, opts: Record<string, unknown>): Promise<Heard | Heard[]>;
  readonly processor: (audio: Float32Array) => Promise<{ input_features: unknown }>;
  readonly model: ((inputs: Record<string, unknown>) => Promise<{ logits: { data: Float32Array; dims: number[] } }>) & {
    readonly generation_config: { readonly decoder_start_token_id: number; readonly lang_to_id: Readonly<Record<string, number>> };
  };
}

interface Loaded {
  readonly asr: Asr;
  /** The language spoken in the first 30 s: Whisper's likeliest language token after its start. */
  readonly language: (samples: Float32Array) => Promise<string>;
}

/**
 * Speech to text on this machine (MODELS=claude-cli, dev only): Whisper through transformers.js on the CPU, so voice
 * costs nothing on OpenRouter either. ffmpeg turns any recording into the samples Whisper takes; the model is fetched
 * from Hugging Face the first time (`warm` at start, so the first voice message does not wait for it). transformers.js
 * takes every recording for English unless told (a Russian one came back translated), so the language is read first,
 * from one step of the model. Whisper Small by default: Whisper reads every recording as 30 s, and Large V3 Turbo's
 * encoder takes 20 s of a laptop's CPU for that, against 3 s (FACTS.md). One recording at a time: a run takes every
 * core. Each is a `transcriber` row in the spend log, at no cost. What was said is never logged.
 */
export class LocalWhisper implements Transcriber {
  readonly #model: string;
  readonly #spend: SpendLog;
  readonly #log: Logger;
  #loaded: Promise<Loaded> | null = null;
  #line: Promise<unknown> = Promise.resolve();

  constructor(deps: { model: string; spend: SpendLog; log: Logger }) {
    this.#model = deps.model;
    this.#spend = deps.spend;
    this.#log = deps.log;
  }

  /** Loads the model now, fetching it the first time. */
  warm(): void {
    this.#load().catch(() => {});
  }

  async transcribe(audio: Uint8Array, format: AudioFormat, customerId: CustomerId | null): Promise<string> {
    return (await this.#inLine(() => this.#hear(audio, format, customerId, false))).text;
  }

  async timed(audio: Uint8Array, format: AudioFormat, customerId: CustomerId | null): Promise<TimedSpeech> {
    return this.#inLine(() => this.#hear(audio, format, customerId, true));
  }

  #inLine<T>(job: () => Promise<T>): Promise<T> {
    const run = this.#line.then(job, job);
    this.#line = run.catch(() => {});
    return run;
  }

  async #hear(audio: Uint8Array, format: AudioFormat, customerId: CustomerId | null, timed: boolean): Promise<TimedSpeech> {
    const started = Date.now();
    const samples = await toSamples(audio, format);
    const seconds = samples.length / RATE;
    const { asr, language } = await this.#load();
    let reply: Heard;
    let spoken: string;
    try {
      spoken = await language(samples);
      const out = await asr(samples, { language: spoken, task: "transcribe", chunk_length_s: 30, stride_length_s: 5, return_timestamps: timed ? "word" : false });
      reply = Array.isArray(out) ? (out[0] ?? { text: "" }) : out;
    } catch (e) {
      this.#log.warn("voice.model_failed", { ...(customerId ? { customerId } : {}), model: this.#model, format, bytes: audio.byteLength, ms: Date.now() - started, error: e instanceof Error ? e.message : String(e) });
      throw new Error(`no model could hear it: ${e instanceof Error ? e.message : String(e)}`);
    }
    const ms = Date.now() - started;
    this.#spend.record({ customerId, taskId: null, agent: "transcriber", model: `local/${this.#model}`, ms, usage: { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0, cost: 0 } });
    this.#log.info("voice.heard", { ...(customerId ? { customerId } : {}), model: `local/${this.#model}`, ms, seconds: Math.round(seconds * 10) / 10, language: spoken, cost: 0 });
    return { text: tidySpeech(reply.text ?? ""), language: spoken, seconds, words: timed ? wordsOf(reply) : [] };
  }

  #load(): Promise<Loaded> {
    this.#loaded ??= (async () => {
      const started = Date.now();
      // Loaded here and only here: production never installs it (a dev dependency).
      const { pipeline, env, Tensor } = await import("@huggingface/transformers");
      env.cacheDir = CACHE;
      // The encoder whole, the decoder quantized: on a laptop's CPU the fp16 and q8 encoders were no faster (FACTS.md).
      const asr = (await pipeline("automatic-speech-recognition", this.#model, { dtype: { encoder_model: "fp32", decoder_model_merged: "q8" } as never })) as unknown as Asr;
      const { decoder_start_token_id: start, lang_to_id: languages } = asr.model.generation_config;
      const language = async (samples: Float32Array): Promise<string> => {
        const { input_features } = await asr.processor(samples.subarray(0, RATE * 30));
        const { logits } = await asr.model({ input_features, decoder_input_ids: new Tensor("int64", BigInt64Array.of(BigInt(start)), [1, 1]) });
        const vocab = logits.dims.at(-1) ?? 0;
        const next = logits.data.subarray(logits.data.length - vocab);
        let best = "<|en|>";
        let score = -Infinity;
        for (const [token, id] of Object.entries(languages)) {
          if ((next[id] ?? -Infinity) > score) [best, score] = [token, next[id] ?? -Infinity];
        }
        return best.slice(2, -2);
      };
      this.#log.info("voice.local_ready", { model: this.#model, ms: Date.now() - started });
      return { asr, language };
    })();
    this.#loaded.catch((e) => {
      this.#loaded = null;
      this.#log.warn("voice.local_failed", { model: this.#model, error: e instanceof Error ? e.message : String(e) });
    });
    return this.#loaded;
  }
}

/** Any recording as Whisper's samples: ffmpeg decodes it to mono 16 kHz, 32-bit floats. */
async function toSamples(audio: Uint8Array, format: AudioFormat): Promise<Float32Array> {
  if (!FFMPEG) throw new Error("no ffmpeg on this platform");
  const dir = await mkdtemp(join(tmpdir(), "mq-voice-"));
  try {
    const input = join(dir, `in.${format}`);
    const output = join(dir, "out.f32");
    await writeFile(input, audio);
    await runFfmpeg(FFMPEG, ["-nostdin", "-v", "error", "-i", input, "-ac", "1", "-ar", String(RATE), "-f", "f32le", output], { timeoutMs: 120_000 });
    const raw = await readFile(output);
    // A copy, so the floats start where a Float32Array may.
    return new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Whisper's words: their text trimmed, each with a start and an end that make sense, in order. */
function wordsOf(reply: Heard): ClipWord[] {
  const out: ClipWord[] = [];
  for (const c of reply.chunks ?? []) {
    const text = c.text.trim();
    const [from, to] = c.timestamp;
    if (!text || typeof from !== "number" || !Number.isFinite(from)) continue;
    const start = Math.max(from, out.at(-1)?.end ?? 0);
    const end = typeof to === "number" && Number.isFinite(to) ? Math.max(to, start) : start;
    out.push({ start: Math.round(start * 1000) / 1000, end: Math.round(end * 1000) / 1000, text });
  }
  return out;
}
