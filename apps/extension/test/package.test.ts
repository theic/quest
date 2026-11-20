import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { EXTENSION, packageFiles, problems, RELEASE_FILE, releaseZip, zip } from "../../../scripts/pack-extension.mjs";

/** The files in a zip, read back the way any unzip does: through its central directory. */
function unzip(bytes: Buffer): Map<string, Buffer> {
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = bytes.readUInt16LE(end + 10);
  let at = bytes.readUInt32LE(end + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    const packed = bytes.readUInt32LE(at + 20);
    const nameLength = bytes.readUInt16LE(at + 28);
    const local = bytes.readUInt32LE(at + 42);
    const name = bytes.toString("utf8", at + 46, at + 46 + nameLength);
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    out.set(name, inflateRawSync(bytes.subarray(start, start + packed)));
    at += 46 + nameLength + bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32);
  }
  return out;
}

describe("the Chrome Web Store package", () => {
  it("carries what Chrome runs and nothing that only develops or tests it", () => {
    const files = packageFiles();
    for (const f of ["manifest.json", "popup.html", "src/background.js", "src/connect.js", "icons/icon-128.png", "icons/visor.svg", "fonts/dm-sans-latin.woff2", "fonts/OFL.txt", "_locales/en/messages.json", "i18n/browser.js", "i18n/locales/uk.json"]) expect(files, f).toContain(f);
    expect(files.filter((f) => f.startsWith("test/") || f === "package.json" || f.endsWith(".ts"))).toEqual([]);
    expect(problems(files)).toEqual([]);
  });

  it("refuses a package that leaves out a module a script imports", () => {
    const files = packageFiles().filter((f) => f !== "src/quest-server.js");
    expect(problems(files)).toContain("missing: src/quest-server.js");
  });

  it("refuses a package that leaves out a font the popup's stylesheet names", () => {
    const files = packageFiles().filter((f) => f !== "fonts/dm-sans-latin.woff2");
    expect(problems(files)).toEqual(["missing: fonts/dm-sans-latin.woff2"]);
  });

  it("makes every zip a release, which connects only to Quest even loaded unpacked, and leaves the repository's copy a developer's", () => {
    const { bytes, files, version } = releaseZip();
    const back = unzip(bytes);
    const flag = back.get(RELEASE_FILE)?.toString("utf8") ?? "";

    expect([...back.keys()]).toEqual(files);
    expect(flag).toMatch(/^export const RELEASE = true;$/m);
    expect(flag).not.toContain("RELEASE = false");
    expect(readFileSync(join(EXTENSION, RELEASE_FILE), "utf8")).toContain("export const RELEASE = false;");
    expect(JSON.parse(back.get("manifest.json")?.toString("utf8") ?? "{}").version).toBe(version);
    for (const name of files.filter((f) => f !== RELEASE_FILE)) expect(back.get(name)?.equals(readFileSync(join(EXTENSION, name))), name).toBe(true);
  });

  it("zips the files whole, the same bytes every time", () => {
    const entries = ["manifest.json", "icons/icon-16.png", "src/background.js"].map((name) => ({ name, data: readFileSync(join(EXTENSION, name)) }));
    const bytes = zip(entries);
    const back = unzip(bytes);
    expect([...back.keys()]).toEqual(entries.map((e) => e.name));
    for (const { name, data } of entries) expect(back.get(name)?.equals(data), name).toBe(true);
    expect(zip(entries).equals(bytes)).toBe(true);
  });
});
