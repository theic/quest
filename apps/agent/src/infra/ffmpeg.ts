import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import ffmpegModule from "ffmpeg-static";

/**
 * ffmpeg-static's binary for this platform (a CommonJS module that exports its path). Its Linux build has no drawtext (no
 * harfbuzz), so words go on as an ASS subtitle track, which libass draws everywhere (FACTS.md, "Videos for posts").
 */
export const FFMPEG = ffmpegModule as unknown as string | null;

/** A bold font with Latin and Cyrillic, and its family: the image's (fonts-dejavu-core, apps/agent/Dockerfile), then a laptop's own. */
const FONTS: readonly VideoFont[] = [
  { file: "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", family: "DejaVu Sans" },
  { file: "C:/Windows/Fonts/arialbd.ttf", family: "Arial" },
  { file: "/System/Library/Fonts/Supplemental/Arial Bold.ttf", family: "Arial" },
  { file: "/Library/Fonts/Arial Bold.ttf", family: "Arial" },
];

export interface VideoFont {
  readonly file: string;
  readonly family: string;
}

export const findFont = (): VideoFont | null => FONTS.find((f) => existsSync(f.file)) ?? null;

export interface RunOptions {
  readonly cwd?: string;
  readonly signal?: AbortSignal;
  /** Past this it is killed: a run that goes on longer has gone wrong. */
  readonly timeoutMs: number;
  /** How many characters of what it said are kept (the end of it); a failure shows the last 2,000. */
  readonly keep?: number;
  /** With `-progress pipe:1` in the arguments: how far it has got, in seconds of output, as it goes. */
  readonly onProgress?: (seconds: number) => void;
}

/**
 * Runs ffmpeg; resolves with the end of what it said (its report goes to stderr: probes, silencedetect and loudnorm print
 * there), rejects with that when it fails, is stopped, or runs too long. ffmpeg exits 1 on `-i file` with no output:
 * `allowExit1` takes that as an answer.
 */
export function runFfmpeg(bin: string, args: readonly string[], opts: RunOptions & { readonly allowExit1?: boolean }): Promise<string> {
  const keep = opts.keep ?? 2_000;
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(new Error("ffmpeg: stopped by a restart"));
    const child = spawn(bin, args, { ...(opts.cwd ? { cwd: opts.cwd } : {}), stdio: ["ignore", opts.onProgress ? "pipe" : "ignore", "pipe"] });
    let said = "";
    let why: string | null = null;
    child.stderr?.on("data", (b: Buffer) => (said = (said + b.toString()).slice(-keep)));
    if (opts.onProgress) {
      let rest = "";
      child.stdout?.on("data", (b: Buffer) => {
        rest += b.toString();
        const lines = rest.split("\n");
        rest = lines.pop() ?? "";
        for (const line of lines) {
          // out_time_us is microseconds, whatever the older out_time_ms was called.
          const us = /^out_time_(?:us|ms)=(\d+)/.exec(line)?.[1];
          if (us) opts.onProgress!(Number(us) / 1_000_000);
        }
      });
    }
    const stop = (reason: string) => () => {
      why = reason;
      child.kill("SIGKILL");
    };
    const late = setTimeout(stop("it took too long"), opts.timeoutMs);
    const stopped = stop("stopped by a restart");
    opts.signal?.addEventListener("abort", stopped, { once: true });
    child.on("error", (e) => reject(e));
    child.on("close", (code) => {
      clearTimeout(late);
      opts.signal?.removeEventListener("abort", stopped);
      if (code === 0 || (opts.allowExit1 && code === 1 && !why)) resolve(said);
      else reject(new Error(`ffmpeg: ${why ?? (said.slice(-2_000).trim() || `exit ${code}`)}`));
    });
  });
}
