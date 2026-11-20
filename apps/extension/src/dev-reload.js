/**
 * The dev extension runs the extension beside the dev agent. Chrome loads one folder unpacked, once (.dev/extension in
 * the main checkout), and `npm run dev` copies the extension of whichever checkout runs it there, again on every
 * change, and writes the folder's stamp last (dev-build.json, scripts/dev-extension.ts). Chrome reads an unpacked
 * extension's files from disk, so the worker sees a new stamp as soon as it is written, and reloads itself between
 * jobs: the reload button in chrome://extensions. A release, or an unpacked folder with no stamp (apps/extension
 * loaded as it is), never reloads itself.
 */
export const STAMP = "dev-build.json";
/** How often a dev worker looks at its stamp while it is awake; the poll alarm looks too, every 30 s. */
export const STAMP_EVERY_MS = 2000;

/**
 * The build a stamp names, or null when there is none to read (no stamp, or one half written).
 * @param {typeof fetch} fetchFn
 * @param {string} url
 */
export async function stampedBuild(fetchFn, url) {
  try {
    const res = await fetchFn(url, { cache: "no-store" });
    if (!res.ok) return null;
    const build = (await res.json())?.build;
    return typeof build === "string" && build ? build : null;
  } catch {
    return null;
  }
}

/**
 * Asks whether the folder now holds another build than the one this extension was loaded with. That one is kept in
 * session storage, which Chrome clears when it reloads the extension, so a worker that slept and woke on new files
 * still knows what it was loaded with, and a reload never repeats.
 * @param {{ read: () => Promise<string | null>, session: { get(key: string): Promise<Record<string, unknown>>, set(items: Record<string, unknown>): Promise<void> } }} deps
 * @returns {() => Promise<boolean>}
 */
export function followStamp({ read, session }) {
  /** @type {string | undefined} */
  let loaded;
  return async () => {
    const now = await read();
    if (!now) return false;
    if (loaded === undefined) {
      const kept = (await session.get("devBuild")).devBuild;
      loaded = typeof kept === "string" ? kept : now;
      if (loaded === now) await session.set({ devBuild: now });
    }
    return loaded !== now;
  };
}
