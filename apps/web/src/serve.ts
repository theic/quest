import { readFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { releaseZip } from "../../../scripts/pack-extension.mjs";

/** The Chrome extension as a zip, for loading unpacked: beside the page, at /quest-extension.zip. */
export const EXTENSION_ZIP = "quest-extension.zip";

/**
 * messaging.quest is static files in `public/`, with no build step. This serves them
 * for a preview on the laptop; any static host can serve the same folder.
 */
export const PUBLIC_DIR = resolve(fileURLToPath(new URL("../public/", import.meta.url)));

const TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".mp4": "video/mp4",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
};

/** The file a request path names inside `root`, or null when it would leave it. */
export function fileFor(root: string, pathname: string): string | null {
  let path: string;
  try {
    path = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  // The root as the platform spells it, so "C:/site" and "C:\site" both contain C:\site\index.html.
  const base = resolve(root);
  const file = resolve(base, `.${path.endsWith("/") ? `${path}index.html` : path}`);
  return file.startsWith(base + sep) ? file : null;
}

/**
 * Serves the site the way messaging.quest does (vercel-output.json): `/privacy` is privacy.html,
 * and any page that is not here gets the note for the earlier web app's addresses, as a 404.
 */
export function siteServer(root = PUBLIC_DIR): Server {
  // A byte range when one is asked for, as a video seeking or looping asks, the way the host answers it.
  const send = async (res: ServerResponse, file: string, status: number, range?: string) => {
    const body = await readFile(file);
    const head = { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store", "Accept-Ranges": "bytes" };
    const want = status === 200 ? /^bytes=(\d*)-(\d*)$/.exec(range ?? "") : null;
    if (want && (want[1] || want[2])) {
      const start = want[1] ? Number(want[1]) : Math.max(0, body.length - Number(want[2]));
      const end = want[1] && want[2] ? Math.min(Number(want[2]), body.length - 1) : body.length - 1;
      if (start > end || start >= body.length) {
        res.writeHead(416, { ...head, "Content-Range": `bytes */${body.length}` });
        return res.end();
      }
      res.writeHead(206, { ...head, "Content-Range": `bytes ${start}-${end}/${body.length}` });
      return res.end(body.subarray(start, end + 1));
    }
    res.writeHead(status, head);
    res.end(body);
  };
  return createServer(async (req, res) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname.replace(/(.)\/$/, "$1");
    // Not a file in public/: the deploy packs the extension into it (scripts/prepare-web-deploy.mjs), and so does this.
    if (pathname === `/${EXTENSION_ZIP}`) {
      res.writeHead(200, { "Content-Type": "application/zip", "Cache-Control": "no-store" });
      return res.end(releaseZip().bytes);
    }
    const file = fileFor(root, pathname);
    for (const candidate of file ? [file, ...(extname(file) ? [] : [`${file}.html`])] : []) {
      try {
        return await send(res, candidate, 200, req.headers.range);
      } catch {
        // The next spelling, then the note.
      }
    }
    try {
      await send(res, resolve(root, "moved.html"), 404);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 4180);
  siteServer().listen(port, "127.0.0.1", () => console.log(`messaging.quest preview: http://127.0.0.1:${port}`));
}
