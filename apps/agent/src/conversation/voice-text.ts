import type { AudioFormat } from "@mq/core";

/**
 * The longest recording Quest listens to. OpenRouter's providers give up after 60 s of work
 * (its speech-to-text guide); a voice message of a few minutes was heard in under 2 s (FACTS.md).
 */
export const MAX_VOICE_SECONDS = 20 * 60;

/** What a mime type's subtype or a file's extension says about the encoding. */
const FORMATS: Readonly<Record<string, AudioFormat>> = {
  ogg: "ogg",
  oga: "ogg",
  opus: "ogg",
  mp3: "mp3",
  mpeg: "mp3",
  mpga: "mp3",
  m4a: "m4a",
  "x-m4a": "m4a",
  mp4: "m4a",
  aac: "aac",
  wav: "wav",
  wave: "wav",
  "x-wav": "wav",
  flac: "flac",
  "x-flac": "flac",
  webm: "webm",
};

/** How a recording is encoded, from its mime type, else its name; null for a kind Quest cannot send to be heard. */
export function audioFormat(mime: string | null, name: string | null): AudioFormat | null {
  const subtype = /^audio\/([a-z0-9.+-]+)/i.exec(mime ?? "")?.[1]?.toLowerCase();
  const extension = /\.([a-z0-9]+)$/i.exec(name ?? "")?.[1]?.toLowerCase();
  return (subtype && FORMATS[subtype]) || (extension && FORMATS[extension]) || null;
}

/** Whisper's spacing, mended: no space before the first word, one between sentences. */
export const tidySpeech = (s: string): string => s.replace(/\s+/g, " ").trim();
