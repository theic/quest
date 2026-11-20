/**
 * The dev extension, kept beside the dev agent. Chrome loads one folder unpacked, once: `.dev/extension` in the main
 * checkout, the same whichever checkout or worktree runs `npm run dev`. The dev agent copies its own checkout's
 * apps/extension there (what Chrome runs, as the release zip takes it: scripts/pack-extension.mjs), again on every
 * change while it runs, and writes the folder's stamp (dev-build.json) last. The extension looks at its stamp every
 * 2 s and reloads itself on a new one (apps/extension/src/dev-reload.js), so the extension Chrome runs is always the
 * one beside the agent: no reload button, and a worktree's extension runs while its agent does.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { dirname, join, relative } from "node:path";
import { mainCheckout } from "./env-file.ts";
import { EXTENSION, packageFiles } from "./pack-extension.mjs";

/** The file the extension reads to know which build its folder holds (dev-reload.js has the same name). */
export const STAMP = "dev-build.json";

/** Where Chrome loads the dev extension from. */
export const devExtensionDir = (home = mainCheckout()): string => join(home, ".dev", "extension");

/** A build's id: the hash of every file Chrome runs, by name and bytes, so the same files are the same build. */
export function buildOf(from: string, files: readonly string[] = packageFiles(from)): string {
  const hash = createHash("sha256");
  for (const file of files) hash.update(file).update("\0").update(readFileSync(join(from, file))).update("\0");
  return hash.digest("hex").slice(0, 12);
}

/** The build a folder's stamp names, or null. */
export function stampOf(dir: string): string | null {
  try {
    const build = (JSON.parse(readFileSync(join(dir, STAMP), "utf8")) as { build?: unknown }).build;
    return typeof build === "string" ? build : null;
  } catch {
    return null;
  }
}

/**
 * Copies a checkout's extension into the dev folder: files that differ, files that are new, and away with files it no
 * longer has, then the stamp, last, so the extension reloads onto a whole build. Nothing is written when the folder
 * already holds this build.
 */
export function syncExtension(to: string, from = EXTENSION): { build: string; changed: boolean } {
  const files = packageFiles(from);
  const build = buildOf(from, files);
  if (stampOf(to) === build) return { build, changed: false };
  mkdirSync(to, { recursive: true });
  for (const file of files) {
    const data = readFileSync(join(from, file));
    const target = join(to, file);
    if (existsSync(target) && readFileSync(target).equals(data)) continue;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data);
  }
  const keep = new Set([...files, STAMP]);
  for (const file of filesUnder(to)) if (!keep.has(file)) rmSync(join(to, file), { force: true });
  writeFileSync(join(to, STAMP), `${JSON.stringify({ build, from, at: new Date().toISOString() }, null, 2)}\n`);
  return { build, changed: true };
}

/** Copies the extension again whenever its files change (a moment after the last change), until closed. */
export function watchExtension(to: string, onCopy: (build: string) => void, from = EXTENSION): FSWatcher {
  let timer: NodeJS.Timeout | undefined;
  const copy = () => {
    try {
      const { build, changed } = syncExtension(to, from);
      if (changed) onCopy(build);
    } catch (e) {
      console.error(`dev extension: could not copy it (${e instanceof Error ? e.message : String(e)}); it is copied again on the next change`);
    }
  };
  return watch(from, { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(copy, 300);
  });
}

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => relative(dir, join(e.parentPath, e.name)).split("\\").join("/"));
}
