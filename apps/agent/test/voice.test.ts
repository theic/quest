import { customerId, type Logger } from "@mq/core";
import { describe, expect, it } from "vitest";
import { audioFormat } from "../src/conversation/voice-text.ts";
import { OpenRouterTranscriber } from "../src/infra/openrouter-transcriber.ts";
import { MemorySpend } from "./fakes.ts";

const C = customerId("00000000-0000-4000-8000-000000000001");

type Answer = { status?: number; body: unknown } | Error;

function transcriber(models: string[], answers: Answer[]) {
  const calls: { url: string; headers: Record<string, string>; body: { model: string; input_audio: { data: string; format: string } } }[] = [];
  const lines: { level: string; event: string; data?: Record<string, unknown> }[] = [];
  const fetchImpl = (async (url: string, init: { headers: Record<string, string>; body: string }) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    const a = answers.shift();
    if (!a) throw new Error("no answer scripted");
    if (a instanceof Error) throw a;
    return new Response(JSON.stringify(a.body), { status: a.status ?? 200 });
  }) as unknown as typeof fetch;
  const log: Logger = {
    info: (event, data) => void lines.push({ level: "info", event, ...(data ? { data } : {}) }),
    warn: (event, data) => void lines.push({ level: "warn", event, ...(data ? { data } : {}) }),
    error: (event, data) => void lines.push({ level: "error", event, ...(data ? { data } : {}) }),
  };
  const spend = new MemorySpend();
  return { t: new OpenRouterTranscriber({ key: "sk-or-secret", models, spend, log, fetch: fetchImpl }), calls, lines, spend };
}

describe("hearing a voice message through OpenRouter", () => {
  it("sends the recording as base64 with its format, mends Whisper's spacing, and logs the cost but never the words", async () => {
    const { t, calls, lines, spend } = transcriber(
      ["openai/whisper-large-v3-turbo"],
      [{ body: { text: " Hey Quest.  Quick one.  Send me the best three tonight.", usage: { seconds: 13.19, cost: 0.0000439 } } }],
    );

    const words = await t.transcribe(new Uint8Array([79, 103, 103, 83]), "ogg", C);

    expect(words).toBe("Hey Quest. Quick one. Send me the best three tonight.");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://openrouter.ai/api/v1/audio/transcriptions");
    expect(calls[0]!.headers.authorization).toBe("Bearer sk-or-secret");
    expect(calls[0]!.body).toEqual({ model: "openai/whisper-large-v3-turbo", input_audio: { data: "T2dnUw==", format: "ogg" } });
    expect(spend.calls).toEqual([
      { customerId: C, taskId: null, agent: "transcriber", model: "openai/whisper-large-v3-turbo", ms: expect.any(Number), usage: { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0, cost: 0.0000439 } },
    ]);
    expect(lines.map((l) => l.event)).toEqual(["voice.heard"]);
    expect(JSON.stringify(lines)).not.toMatch(/Quick one|sk-or-secret/);
  });

  it("goes to the next model when one fails or does not answer, and says so when none could", async () => {
    const { t, calls, lines, spend } = transcriber(
      ["openai/whisper-large-v3-turbo", "openai/gpt-4o-mini-transcribe"],
      [
        { status: 400, body: { error: { message: "Provider returned 400", code: 400 } } },
        { body: { text: "Привет, Квест.", usage: { input_tokens: 131, output_tokens: 44, cost: 0.00038 } } },
      ],
    );

    expect(await t.transcribe(new Uint8Array([1]), "ogg", C)).toBe("Привет, Квест.");
    expect(calls.map((c) => c.body.model)).toEqual(["openai/whisper-large-v3-turbo", "openai/gpt-4o-mini-transcribe"]);
    expect(lines.map((l) => `${l.level} ${l.event}`)).toEqual(["warn voice.model_failed", "info voice.heard"]);
    expect(spend.calls[0]).toMatchObject({ model: "openai/gpt-4o-mini-transcribe", usage: { input: 131, output: 44, cost: 0.00038 } });

    const down = transcriber(["a/one", "b/two"], [new Error("socket hang up"), { status: 502, body: { error: { message: "Bad gateway" } } }]);
    await expect(down.t.transcribe(new Uint8Array([1]), "mp3", null)).rejects.toThrow("no model could hear it: HTTP 502: Bad gateway");
    expect(down.spend.calls).toHaveLength(0);
  });
});

describe("audioFormat", () => {
  it("knows a recording's encoding from its mime type, else its name", () => {
    expect(audioFormat("audio/ogg", null)).toBe("ogg");
    expect(audioFormat("audio/mpeg", "pitch.mp3")).toBe("mp3");
    expect(audioFormat("audio/x-m4a", null)).toBe("m4a");
    expect(audioFormat("audio/mp4", null)).toBe("m4a");
    expect(audioFormat("audio/x-wav", null)).toBe("wav");
    expect(audioFormat(null, "Memo.FLAC")).toBe("flac");
    expect(audioFormat("audio/x-ms-wma", "demo.wma")).toBeNull();
    expect(audioFormat(null, null)).toBeNull();
  });
});
