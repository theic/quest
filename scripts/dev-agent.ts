/**
 * The whole dev stack on this laptop, in one command:
 *
 *   - the dev agent: @TestPatrikBot by polling, dev's database, its pages at http://localhost:8080. It reads .env.local
 *     (the main checkout's, from a worktree), runs this checkout's apps/agent/src/main.ts as dev, and main refuses
 *     production's database, bot and address (environments.ts): it never touches production's agent or bot.
 *   - the Mini App: a quick tunnel that carries only the Mini App (dev-tunnel.ts), so @TestPatrikBot gets its Quest
 *     button as production's bot has. The tunnel stays up when this stops, and the next start takes it up again, so
 *     the button keeps its address. One that stays dead while the network is up is replaced, and the agent restarted
 *     on the new address. A MINI_APP_URL of your own (in the shell or the file) is used instead.
 *   - the dev extension: this checkout's apps/extension, copied into the one folder Chrome loads unpacked
 *     (.dev/extension in the main checkout) now and on every change, and Chrome reloads it by itself (dev-extension.ts).
 *
 *   npm run dev                       # what the shell sets wins over the file: CHROME_DEBUG=1 npm run dev
 */
import { spawn } from "node:child_process";
import { join } from "node:path";
import { DEV } from "../apps/agent/src/environments.ts";
import { devExtensionDir, syncExtension, watchExtension } from "./dev-extension.ts";
import { envPath, mainCheckout, readEnvFile } from "./env-file.ts";
import { cloudflared, keptTunnel, miniAppGate, quickTunnel, tunnelAnswers } from "./dev-tunnel.ts";

/** How often the tunnel is looked at, and how many looks in a row it may miss with the network up before it is replaced. */
const TUNNEL_LOOK_MS = 60_000;
const TUNNEL_MISSES = 3;

const say = (line: string) => console.error(`dev: ${line}`);
const path = envPath("dev");
const file = readEnvFile(path);
if (!file.get("DATABASE_URL")) throw new Error(`${path} has no DATABASE_URL: copy .env.example to .env.local and fill it in`);
const setting = (key: string) => process.env[key] ?? file.get(key);
const port = Number(setting("PORT") || 8080);
say(`secrets from ${path}`);

// The extension first: Chrome may reload it before the agent is up, and pairs again by itself once it is.
// DEV_EXTENSION=0 leaves the folder as it is: a checkout that does not touch the extension (or an older one than the
// build Chrome now runs) does not swap it.
const extension = devExtensionDir();
const withExtension = setting("DEV_EXTENSION") !== "0";
const copied = withExtension ? syncExtension(extension) : null;
const watcher = withExtension ? watchExtension(extension, (build) => say(`extension build ${build} copied; Chrome reloads it within a few seconds`)) : null;

// The Mini App: an address of their own, else a tunnel of ours.
let miniApp = setting("MINI_APP_URL") || null;
let gate: Awaited<ReturnType<typeof miniAppGate>> | null = null;
let tunnel: { url: string } | null = null;
const dir = join(mainCheckout(), ".dev");
if (!miniApp) {
  try {
    // The port after the agent's, the same every start, so the tunnel left running leads here again.
    gate = await miniAppGate(port, port + 1).catch(() => miniAppGate(port));
    tunnel = await keptTunnel(dir, gate.url);
    if (tunnel) say(`the Mini App keeps its address: the tunnel from the last start still answers`);
    else {
      const bin = await cloudflared(join(dir, "bin"), say);
      tunnel = await quickTunnel(bin, gate.url, dir);
    }
    miniApp = `${tunnel.url}/glass`;
  } catch (e) {
    gate?.close();
    gate = null;
    say(`no Mini App this time: ${e instanceof Error ? e.message : String(e)}. The rest runs; MINI_APP_URL can name an https address of your own.`);
  }
}

// The laptop stays up while the stack runs: Quest works through the night, and an idle Windows laptop goes to sleep after
// its timeout (a closed lid is Windows' own setting: FACTS.md, "Working at night"). KEEP_AWAKE=0 lets it sleep.
const awake = process.platform === "win32" && setting("KEEP_AWAKE") !== "0" ? keepAwake() : null;

const main = join(import.meta.dirname, "..", "apps", "agent", "src", "main.ts");
let restarting = false;
let child = startAgent();
// Ctrl+C reaches the agent too: it puts its running work back on the queue, and this waits for it.
process.on("SIGINT", () => undefined);
process.on("SIGTERM", () => child.kill("SIGTERM"));

// Once the agent answers, what runs where, in one place.
// Three minutes: the local Whisper alone takes most of one to load (live, 2026-11-04: 92 s to the first answer).
if (await healthy(`http://127.0.0.1:${port}/health`, 180_000)) {
  const reachable = tunnel ? await healthy(`${miniApp}`, 30_000) : true;
  const bot = (await telegram("getMe").catch(() => null))?.username ?? DEV.bot;
  console.error(
    [
      "",
      "dev stack up",
      `  bot        @${bot} (polled; send it /start)`,
      `  agent      http://localhost:${port}`,
      `  Mini App   ${miniApp ? `${miniApp}${reachable ? "" : " (not answering yet)"}: the Quest button by the bot's message box` : "none (see above)"}`,
      `  extension  ${extension}`,
      copied ? `             build ${copied.build}, from this checkout; copied again on every change, and Chrome reloads it` : "             left as it was (DEV_EXTENSION=0)",
      `             once: chrome://extensions, Developer mode on, Load unpacked, that folder; then /connect in the bot`,
      "",
    ].join("\n"),
  );
}

if (tunnel && gate) void watchTunnel(tunnel.url, gate.url);

/** The agent, on the Mini App's address of the moment. It reads that once, so a new address needs a new agent. */
function startAgent() {
  const agent = spawn(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", main], {
    stdio: "inherit",
    env: { ...Object.fromEntries(file), ...process.env, MQ_ENV: "dev", ...(miniApp ? { MINI_APP_URL: miniApp } : {}) },
  });
  agent.on("exit", (code, signal) => {
    if (restarting) {
      restarting = false;
      child = startAgent();
      return;
    }
    awake?.kill();
    watcher?.close();
    // The tunnel and the Quest button stay as they are for the next start (Cloudflare's 502 meanwhile): a client told of
    // a change while it was not connected never hears of it, so every change of the button can leave one behind.
    gate?.close();
    process.exit(code ?? (signal ? 1 : 0));
  });
  return agent;
}

/**
 * Replaces a tunnel that stays dead. Live, 2026-11-07: a network drop ended the address, cloudflared retried "Tunnel not
 * found" forever, and the Mini App was gone until someone restarted the stack. Looks only count with the network up, and
 * three of them give a tunnel that is only reconnecting its time, since every new address can leave a client behind.
 */
async function watchTunnel(first: string, local: string): Promise<void> {
  let url = first;
  let missed = 0;
  for (;;) {
    await new Promise((r) => setTimeout(r, TUNNEL_LOOK_MS));
    if (await tunnelAnswers(url)) missed = 0;
    else if (!(await online())) missed = 0;
    else if (++missed >= TUNNEL_MISSES) {
      try {
        const next = (await keptTunnel(dir, local)) ?? (await quickTunnel(await cloudflared(join(dir, "bin"), say), local, dir));
        missed = 0;
        if (next.url === url) continue;
        url = next.url;
        miniApp = `${url}/glass`;
        say(`the tunnel died: the Mini App is at ${miniApp} now, and the agent restarts on it`);
        restarting = true;
        child.kill("SIGTERM");
      } catch (e) {
        say(`the tunnel died, and no new one yet: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
}

/** Whether this computer reaches Cloudflare at all, so a dropped network is not taken for a dead tunnel. */
async function online(): Promise<boolean> {
  const res = await fetch("https://www.cloudflare.com/cdn-cgi/trace", { signal: AbortSignal.timeout(10_000) }).catch(() => null);
  return Boolean(res?.ok);
}

/** A process that asks Windows to stay up for as long as it runs (ES_CONTINUOUS | ES_SYSTEM_REQUIRED; the screen may go off). */
function keepAwake() {
  const hold =
    "Add-Type -Name P -Namespace W -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint f);';" +
    "[void][W.P]::SetThreadExecutionState([uint32]2147483649); while ($true) { Start-Sleep 3600 }";
  return spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", hold], { stdio: "ignore", windowsHide: true });
}

async function healthy(url: string, within: number): Promise<boolean> {
  const until = Date.now() + within;
  while (Date.now() < until && child.exitCode === null) {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) }).catch(() => null);
    if (res?.ok) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function telegram(method: string, body: unknown = {}): Promise<{ username?: string } | null> {
  const res = await fetch(`https://api.telegram.org/bot${setting("TELEGRAM_BOT_TOKEN")}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  return ((await res.json()) as { result?: { username?: string } }).result ?? null;
}
