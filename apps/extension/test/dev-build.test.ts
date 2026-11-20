import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildOf, STAMP as WRITTEN, stampOf, syncExtension } from "../../../scripts/dev-extension.ts";
import { EXTENSION, packageFiles } from "../../../scripts/pack-extension.mjs";
import { followStamp, STAMP, stampedBuild } from "../src/dev-reload.js";

const dirs: string[] = [];
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "mq-dev-extension-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** chrome.storage.session as Chrome keeps it: in memory, cleared when the extension reloads. */
function session() {
  const items = new Map<string, unknown>();
  return {
    items,
    get: async (key: string) => (items.has(key) ? { [key]: items.get(key) } : {}),
    set: async (patch: Record<string, unknown>) => void Object.entries(patch).forEach(([k, v]) => items.set(k, v)),
  };
}

describe("the dev extension's folder", () => {
  it("gets what Chrome runs from the checkout, and its stamp last", () => {
    const to = scratch();
    const first = syncExtension(to);
    expect(first).toEqual({ build: buildOf(EXTENSION), changed: true });
    for (const file of packageFiles()) expect(readFileSync(join(to, file)).equals(readFileSync(join(EXTENSION, file))), file).toBe(true);
    expect(existsSync(join(to, "test")) || existsSync(join(to, "package.json"))).toBe(false);
    expect(stampOf(to)).toBe(first.build);
    // The same files are the same build: nothing is written again, so the extension does not reload for nothing.
    expect(syncExtension(to)).toEqual({ build: first.build, changed: false });
  });

  it("follows a change in the checkout: new bytes, a new file, a file gone", () => {
    const from = scratch();
    cpSync(EXTENSION, from, { recursive: true });
    const to = scratch();
    const first = syncExtension(to, from);

    writeFileSync(join(from, "src", "popup.js"), "// changed\n");
    writeFileSync(join(from, "src", "added.js"), "export {};\n");
    rmSync(join(from, "src", "awake.js"));
    const next = syncExtension(to, from);
    expect(next.changed).toBe(true);
    expect(next.build).not.toBe(first.build);
    expect(readFileSync(join(to, "src", "popup.js"), "utf8")).toBe("// changed\n");
    expect(existsSync(join(to, "src", "added.js"))).toBe(true);
    expect(existsSync(join(to, "src", "awake.js"))).toBe(false);
    expect(JSON.parse(readFileSync(join(to, WRITTEN), "utf8"))).toMatchObject({ build: next.build, from });
  });

  it("is stamped under the name the extension reads", () => {
    expect(WRITTEN).toBe(STAMP);
  });
});

describe("the dev extension following its folder", () => {
  it("reloads once for a new build, never for the one it was loaded with", async () => {
    let onDisk: string | null = "aaa";
    const store = session();
    const newBuild = followStamp({ read: async () => onDisk, session: store });
    expect(await newBuild()).toBe(false);
    expect(await newBuild()).toBe(false);
    onDisk = "bbb";
    expect(await newBuild()).toBe(true);

    // chrome.runtime.reload() clears session storage: the reloaded worker starts on the new build and stays.
    store.items.clear();
    const reloaded = followStamp({ read: async () => onDisk, session: store });
    expect(await reloaded()).toBe(false);
    expect(await reloaded()).toBe(false);
  });

  it("knows a build that came while its worker slept", async () => {
    const store = session();
    await followStamp({ read: async () => "aaa", session: store })();
    // The worker slept; the folder changed; a new worker of the same extension wakes up.
    expect(await followStamp({ read: async () => "bbb", session: store })()).toBe(true);
  });

  it("does nothing without a stamp: a release, or apps/extension loaded as it is", async () => {
    const store = session();
    const newBuild = followStamp({ read: async () => null, session: store });
    expect(await newBuild()).toBe(false);
    expect(store.items.size).toBe(0);
  });

  it("reads a stamp fresh from disk, and none from a stamp it cannot read", async () => {
    const asked: unknown[] = [];
    const answer = (body: string, ok = true) => async (url: string, init: unknown) => (asked.push([url, init]), new Response(body, { status: ok ? 200 : 404 }));
    expect(await stampedBuild(answer(JSON.stringify({ build: "abc123" })) as typeof fetch, "chrome-extension://id/dev-build.json")).toBe("abc123");
    expect(asked[0]).toEqual(["chrome-extension://id/dev-build.json", { cache: "no-store" }]);
    expect(await stampedBuild(answer("", false) as typeof fetch, "x")).toBeNull();
    expect(await stampedBuild(answer('{"build":') as typeof fetch, "x")).toBeNull();
    expect(await stampedBuild((async () => Promise.reject(new TypeError("Failed to fetch"))) as typeof fetch, "x")).toBeNull();
  });
});
