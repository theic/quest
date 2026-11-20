/**
 * Quest, the local edition (npm start): everything on this computer but the public people it finds. Its database is a
 * folder (~/.quest/db, PGlite: infra/local-db.ts), its models the Claude or ChatGPT subscription signed in here, and the
 * extension in this Chrome pairs with it at http://localhost:8787 (quest-server.js, LOCAL_SERVER).
 *
 * What it keeps is ~/.quest/settings.json (QUEST_HOME moves it): the models, the port, a secret that signs the links to
 * its pages, and their own Telegram bot's token if they want Telegram too. Made on the first start; edit it to change.
 *
 *   npm start
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { startLocalDb } from "../apps/agent/src/infra/local-db.ts";
import { codexBin } from "../apps/agent/src/agents/codex-cli-models.ts";

interface Settings {
  /** Which subscription thinks for Quest: "claude-cli" (Claude) or "codex-cli" (ChatGPT, through Codex). */
  models: "claude-cli" | "codex-cli";
  /** The extension pairs with this port only (quest-server.js): change it and the store extension cannot connect. */
  port: number;
  secret: string;
  /** Anonymous: what the shared database of people knows this install by (it only counts what it may send). */
  installKey: string;
  /** Their own bot (BotFather's token), for Quest in Telegram too. Optional. */
  telegramToken?: string;
}

const home = process.env["QUEST_HOME"] ?? join(homedir(), ".quest");
const file = join(home, "settings.json");
mkdirSync(home, { recursive: true });

/** Claude if this computer is signed in to it, else Codex if it is, else Claude (`npm run claude:login` signs in). */
function signedIn(): Settings["models"] {
  if (existsSync(join(homedir(), ".claude", ".credentials.json")) || process.env["CLAUDE_CODE_OAUTH_TOKEN"]) return "claude-cli";
  if (existsSync(join(process.env["CODEX_HOME"] ?? join(homedir(), ".codex"), "auth.json"))) return "codex-cli";
  return "claude-cli";
}

const settings: Settings = existsSync(file)
  ? (JSON.parse(readFileSync(file, "utf8")) as Settings)
  : { models: signedIn(), port: 8787, secret: randomBytes(24).toString("base64url"), installKey: randomBytes(18).toString("base64url") };
// Settings from before a field was added get it now.
settings.installKey ??= randomBytes(18).toString("base64url");
writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });

if (settings.models === "codex-cli" && spawnSync(codexBin(), ["--version"], { stdio: "ignore" }).status !== 0) {
  console.error("Quest thinks with Codex here, and no codex was found. Install Codex (or the Codex app) and sign in, then npm start again.");
  process.exit(1);
}

const db = await startLocalDb({ dataDir: join(home, "db"), migrations: join(import.meta.dirname, "..", "supabase", "migrations"), port: settings.port + 1 });

Object.assign(process.env, {
  MQ_ENV: "local",
  PORT: String(settings.port),
  DATABASE_URL: db.url,
  MODELS: settings.models,
  QUEST_SECRET: settings.secret,
  QUEST_INSTALL_KEY: settings.installKey,
  TELEGRAM_MODE: "polling",
  // A laptop's subscription costs nothing a call: Quest keeps working every minute their Chrome is open.
  ALWAYS_EXPLORING: process.env["ALWAYS_EXPLORING"] ?? "1",
  ...(settings.telegramToken ? { TELEGRAM_BOT_TOKEN: settings.telegramToken } : {}),
});
// The agent reads its settings from the environment only: no .env file is looked for.
delete process.env["MQ_ENV_FILE"];

console.log(`Quest is starting on http://localhost:${settings.port} (thinking with ${settings.models === "codex-cli" ? "ChatGPT, through Codex" : "Claude"}).`);
console.log(`Open Quest's side panel in Chrome and press "Start talking". Settings: ${file}`);
await import("../apps/agent/src/main.ts");
