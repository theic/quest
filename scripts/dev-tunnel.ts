/**
 * The Mini App on the dev bot. Telegram opens a Mini App only at an https address, and the dev agent is
 * http://localhost:8080, so `npm run dev` puts a Cloudflare quick tunnel in front of it (no account, no setup: a
 * *.trycloudflare.com address of its own) and the agent sets @TestPatrikBot's Quest button to it (MINI_APP_URL).
 *
 * The tunnel outlives `npm run dev`, and the next start takes it up again (`keptTunnel`), so the address stays the same
 * across restarts. Telegram tells a client of a new button address only while that client is connected: live,
 * 2026-11-04, after a day of restarts, a Telegram Web tab opened an address two starts old and found nothing there.
 * A network drop can end its address for good (cloudflared then retries forever), so dev-agent.ts looks at it every
 * minute (`tunnelAnswers`) and replaces one that stays dead.
 *
 * The tunnel carries the Mini App only: a gate on this computer passes its page, its four signed routes and the
 * translations it loads, and answers 404 to anything else. The rest of the agent stays on this computer, CHROME_DEBUG's
 * unsigned routes above all. The pages a chat button opens (the Chrome setup's, the credits page) are only sent back
 * to this computer: Telegram takes no localhost address on a button, so the dev bot's buttons name the tunnel's.
 *
 * cloudflared is the one on PATH, else `.dev/bin` in the main checkout, fetched from Cloudflare's own releases on
 * GitHub the first time.
 */
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

/**
 * What the Mini App asks of the agent (apps/agent/public/glass.html, http/glass-routes.ts, http/server.ts's /i18n),.
 */
export const MINI_APP_PATH = /^\/(glass|glass\/(data|power|front|language)|report\/[\w.-]+\/\d{4}-\d{2}-\d{2}|i18n\/[\w.\/-]+)$/;

/**
 * The agent's pages a chat button opens (telegram-channel.ts sends the tunnel's address for them): the gate sends the
 * browser on to the same page at the agent's own address on this computer, where the extension's connect script runs
 * (it reads only Quest's own addresses and localhost). A redirect, so nothing of the agent's goes through the tunnel.
 */
export const LOCAL_PAGE = /^\/(chrome|connect|plan\/[\w.-]+)$/;

const allowed = (method: string): boolean => ["GET", "HEAD", "POST"].includes(method);

/** The gate's own answer to what it does not pass, so a tunnel that reaches it can be told from Cloudflare's errors. */
const GATE = "x-mq-gate";

/**
 * A local address that passes the Mini App's requests to the agent, and nothing else. On `port` (any free one when 0):
 * the same port every start lets a kept tunnel reach the next start's gate.
 */
export function miniAppGate(agentPort: number, port = 0): Promise<{ url: string; close(): void }> {
  const server = createServer((req, res) => {
    // The path as the agent will read it (dot segments resolved), so what is checked is what is asked for.
    const url = new URL(req.url ?? "/", "http://gate");
    if ((req.method === "GET" || req.method === "HEAD") && LOCAL_PAGE.test(url.pathname)) {
      // The address's #code stays with the browser, which keeps it across the redirect.
      res.writeHead(302, { location: `http://localhost:${agentPort}${url.pathname}${url.search}` }).end();
      return;
    }
    if (!MINI_APP_PATH.test(url.pathname) || !allowed(req.method ?? "")) {
      res.writeHead(404, { [GATE]: "1" }).end();
      return;
    }
    const upstream = request({ host: "127.0.0.1", port: agentPort, method: req.method, path: url.pathname + url.search, headers: req.headers }, (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    });
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => server.close() });
    });
  });
}

/** cloudflared's release for each platform (github.com/cloudflare/cloudflared/releases). */
const RELEASES: Record<string, string> = {
  "win32-x64": "cloudflared-windows-amd64.exe",
  "win32-arm64": "cloudflared-windows-amd64.exe",
  "win32-ia32": "cloudflared-windows-386.exe",
  "darwin-x64": "cloudflared-darwin-amd64.tgz",
  "darwin-arm64": "cloudflared-darwin-arm64.tgz",
  "linux-x64": "cloudflared-linux-amd64",
  "linux-arm64": "cloudflared-linux-arm64",
};

/** The cloudflared to run: the one on PATH, else the one in `binDir`, fetched there the first time. */
export async function cloudflared(binDir: string, say: (line: string) => void): Promise<string> {
  if (spawnSync("cloudflared", ["--version"], { stdio: "ignore" }).status === 0) return "cloudflared";
  const exe = join(binDir, process.platform === "win32" ? "cloudflared.exe" : "cloudflared");
  if (existsSync(exe)) return exe;
  const release = RELEASES[`${process.platform}-${process.arch}`];
  if (!release) throw new Error(`there is no cloudflared release for ${process.platform}-${process.arch}: install it and put it on PATH`);
  const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/${release}`;
  say(`fetching cloudflared, once, from ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  mkdirSync(binDir, { recursive: true });
  const part = join(binDir, `${release}.part`);
  writeFileSync(part, Buffer.from(await res.arrayBuffer()));
  if (release.endsWith(".tgz")) {
    const tar = spawnSync("tar", ["-xzf", part, "-C", binDir]);
    rmSync(part, { force: true });
    if (tar.status !== 0 || !existsSync(exe)) throw new Error(`could not unpack ${release}`);
  } else renameSync(part, exe);
  if (process.platform !== "win32") chmodSync(exe, 0o755);
  return exe;
}

/** The address a quick tunnel's log gives it, or null. */
export const tunnelAddress = (log: string): string | null => /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(log)?.[0] ?? null;

/** The tunnel left running, noted in `dir` (the main checkout's .dev): its address and where it leads. */
type Kept = { url: string; local: string };
const keptFile = (dir: string) => join(dir, "tunnel.json");

/** The cloudflareds that run a tunnel to `local`, known by their command line (none is a child of this process). */
function tunnelPids(local: string): number[] {
  const out =
    process.platform === "win32"
      ? spawnSync(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-Command", `Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'cloudflared.exe' -and $_.CommandLine -like '*--url ${local}*' } | ForEach-Object { $_.ProcessId }`],
          { encoding: "utf8", windowsHide: true },
        ).stdout
      : spawnSync("pgrep", ["-f", "--", `--url ${local}`], { encoding: "utf8" }).stdout;
  return (out ?? "").split(/\s+/).filter(Boolean).map(Number);
}

const stopTunnels = (local: string) => {
  for (const pid of tunnelPids(local)) {
    try {
      process.kill(pid);
    } catch {
      // Gone meanwhile.
    }
  }
};

/** Whether Cloudflare carries a request through the tunnel to the gate (the gate's own 404, `GATE`). */
export async function tunnelAnswers(url: string): Promise<boolean> {
  const res = await fetch(`${url}/`, { signal: AbortSignal.timeout(10_000) }).catch(() => null);
  return Boolean(res?.headers.get(GATE));
}

/**
 * The tunnel an earlier start left running, when it still leads to `local` and Cloudflare still carries a request
 * through it to the gate (the gate's own 404, `GATE`: a tunnel that is gone, or whose name no longer resolves after the
 * network dropped, answers otherwise). Else null, and any still running to that address is stopped.
 */
export async function keptTunnel(dir: string, local: string): Promise<{ url: string } | null> {
  let kept: Kept | null = null;
  try {
    kept = JSON.parse(readFileSync(keptFile(dir), "utf8")) as Kept;
  } catch {
    // None noted.
  }
  if (kept?.local === local && tunnelPids(local).length && (await tunnelAnswers(kept.url))) return { url: kept.url };
  stopTunnels(local);
  if (kept && kept.local !== local) stopTunnels(kept.local);
  rmSync(keptFile(dir), { force: true });
  return null;
}

/**
 * A quick tunnel to a local address, once Cloudflare's edge holds a connection to it (before that its address answers
 * nothing), noted in `dir` for the next start; its log is `dir`/tunnel.log. It is started through a shell that exits at
 * once, so it is nobody's child: no Ctrl+C reaches it, and nor does a stop that ends a whole tree of processes (live,
 * 2026-11-04: a cloudflared only detached ended with the stack).
 */
export function quickTunnel(bin: string, local: string, dir: string): Promise<{ url: string }> {
  mkdirSync(dir, { recursive: true });
  const logFile = join(dir, "tunnel.log");
  try {
    rmSync(logFile, { force: true });
  } catch {
    // Still held by a cloudflared on its way out; the new one writes after it.
  }
  const args = ["tunnel", "--no-autoupdate", "--logfile", logFile, "--url", local];
  // Windows: cmd's start, written out whole (Node would quote start's empty title so that cmd waits for input).
  const launcher =
    process.platform === "win32"
      ? spawn("cmd.exe", ["/d", "/s", "/c", `"start "" /b "${bin}" ${args.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ")}"`], {
          windowsVerbatimArguments: true,
          detached: true,
          windowsHide: true,
          stdio: "ignore",
        })
      : spawn("sh", ["-c", '"$@" &', "sh", bin, ...args], { detached: true, stdio: "ignore" });
  launcher.unref();
  const log = () => {
    try {
      return readFileSync(logFile, "utf8");
    } catch {
      return "";
    }
  };
  const last = () => log().trim().split(/\r?\n/).slice(-3).join(" / ");
  return new Promise((resolve, reject) => {
    const until = Date.now() + 45_000;
    const look = setInterval(() => {
      const text = log();
      const url = tunnelAddress(text);
      if (url && /Registered tunnel connection/.test(text)) {
        clearInterval(look);
        writeFileSync(keptFile(dir), JSON.stringify({ url, local } satisfies Kept));
        resolve({ url });
      } else if (Date.now() > until) {
        clearInterval(look);
        stopTunnels(local);
        reject(new Error(`no tunnel after 45 s: ${last() || "cloudflared wrote nothing"}`));
      }
    }, 250);
    launcher.on("error", (e) => {
      clearInterval(look);
      reject(e);
    });
  });
}
