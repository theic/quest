/**
 * The Chrome Web Store package: apps/extension as Chrome loads it, zipped.
 *
 *   npm run extension:pack        -> .artifacts/extension/messaging-quest-<version>.zip
 *
 * Only what the extension runs goes in: the manifest, its pages, scripts, icons and
 * translations. Its tests and package.json stay out. Before writing, it checks that every
 * file the manifest and the popup name, every font or image a stylesheet names, and every
 * module a script imports, is in the package, and that each translated description fits
 * the store's 132 characters. The zip is the same bytes for the same files (fixed order
 * and dates), so two packs can be compared. It is a release (src/release.js says true in it).
 * The same zip is messaging.quest/quest-extension.zip, for loading unpacked.
 */
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateRawSync } from "node:zlib";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const EXTENSION = join(ROOT, "apps/extension");

/** Left out of the package: what develops and tests the extension, not what runs it. */
const LEFT_OUT = [/^test\//, /^package\.json$/, /^node_modules\//, /(^|\/)\./, /\.md$/, /\.ts$/];

/** Every file of the extension that Chrome runs, as paths inside the package, in a fixed order. */
export function packageFiles(dir = EXTENSION) {
  const files = [];
  const walk = (at) => {
    for (const name of readdirSync(at).sort()) {
      const path = join(at, name);
      const inside = relative(dir, path).split("\\").join("/");
      if (LEFT_OUT.some((re) => re.test(inside))) continue;
      if (statSync(path).isDirectory()) walk(path);
      else files.push(inside);
    }
  };
  walk(dir);
  return files;
}

/** Why this package would not work as an extension, or [] when it would. */
export function problems(files, dir = EXTENSION) {
  const has = new Set(files);
  const read = (file) => readFileSync(join(dir, file), "utf8");
  const manifest = JSON.parse(read("manifest.json"));
  const wanted = new Set([
    ...Object.values(manifest.icons ?? {}),
    ...Object.values(manifest.action?.default_icon ?? {}),
    manifest.action?.default_popup,
    manifest.side_panel?.default_path,
    manifest.background?.service_worker,
    ...(manifest.content_scripts ?? []).flatMap((s) => [...(s.js ?? []), ...(s.css ?? [])]),
    `_locales/${manifest.default_locale}/messages.json`,
  ].filter(Boolean));
  // What each page loads, and what each script imports or fetches beside it.
  for (const page of files.filter((f) => f.endsWith(".html"))) {
    for (const [, ref] of read(page).matchAll(/(?:src|href)="([^"#?:]+)"/g)) wanted.add(posix.normalize(posix.join(posix.dirname(page), ref)));
  }
  for (const sheet of files.filter((f) => f.endsWith(".css"))) {
    for (const [, ref] of read(sheet).matchAll(/url\(\s*["']?([^"')#?:]+)["']?\s*\)/g)) wanted.add(posix.normalize(posix.join(posix.dirname(sheet), ref)));
  }
  for (const script of files.filter((f) => f.endsWith(".js"))) {
    const code = read(script).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, ""); // a type named in a comment is not loaded
    for (const [, ref] of code.matchAll(/(?:from\s+|import\s*\()\s*"(\.{1,2}\/[^"]+)"/g)) wanted.add(posix.normalize(posix.join(posix.dirname(script), ref)));
  }
  const out = [...wanted].filter((f) => !has.has(f)).map((f) => `missing: ${f}`);
  for (const file of files.filter((f) => /^_locales\/[^/]+\/messages\.json$/.test(f))) {
    const description = JSON.parse(read(file)).description?.message ?? "";
    if (!description || description.length > 132) out.push(`${file}: the description must be 1 to 132 characters`);
  }
  if (!/^\d+(\.\d+){0,3}$/.test(String(manifest.version))) out.push(`manifest.json: "${manifest.version}" is not a version Chrome accepts`);
  return out;
}

/** A zip of these files (deflated, fixed dates), as Chrome and the store read one. */
export function zip(entries) {
  const DOS_TIME = 0;
  const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1; // 2026-01-01: the same bytes every time
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const path = Buffer.from(name, "utf8");
    const packed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(path.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(path.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, path, packed);
    centrals.push(central, path);
    offset += local.length + path.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** The file that says whether a copy is a release (src/release.js): false here, true in every zip. */
export const RELEASE_FILE = "src/release.js";
const DEVELOPER = "export const RELEASE = false;";

/**
 * The release zip: the Web Store's, and the one messaging.quest offers to load unpacked
 * (scripts/prepare-web-deploy.mjs). It says RELEASE = true, so even unpacked it connects only to
 * Quest's own address. Throws when the package would not work.
 */
export function releaseZip(dir = EXTENSION) {
  const files = packageFiles(dir);
  const wrong = problems(files, dir);
  const flag = readFileSync(join(dir, RELEASE_FILE), "utf8");
  if (!flag.includes(DEVELOPER)) wrong.push(`${RELEASE_FILE}: must say "${DEVELOPER}", which the zip turns to true`);
  if (wrong.length) throw new Error(`The package would not work:\n  ${wrong.join("\n  ")}`);
  const data = (name) => (name === RELEASE_FILE ? Buffer.from(flag.replace(DEVELOPER, "export const RELEASE = true;")) : readFileSync(join(dir, name)));
  const { version } = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  return { version, files, bytes: zip(files.map((name) => ({ name, data: data(name) }))) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let pack;
  try {
    pack = releaseZip();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  const out = join(ROOT, ".artifacts/extension", `messaging-quest-${pack.version}.zip`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, pack.bytes);
  console.log(`${relative(ROOT, out)}: ${pack.files.length} files, ${(pack.bytes.length / 1024).toFixed(0)} KB`);
}
