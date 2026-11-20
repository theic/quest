/**
 * The local homes of secrets, one per environment (apps/agent/src/environments.ts): `.env.local` is dev's
 * (@TestPatrikBot, Supabase bglbnziyilxkxgzortuf), `.env.production.local` production's (@messagingquestbot,
 * Supabase atjukklkmfwhmbbzxaod). Both are git-ignored, so a worktree has neither: they are read from the main
 * checkout. These helpers read and extend them without ever printing a value, so scripts can move secrets around
 * (to Fly, to the database) while the terminal only ever shows names.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { botProblem, DEV, PRODUCTION, stageOfDatabase, supabaseRef, type Stage } from "../apps/agent/src/environments.ts";

const HERE = join(import.meta.dirname, "..");

/** The main checkout this one belongs to: itself, or the checkout a worktree was made from. */
export function mainCheckout(): string {
  try {
    const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: HERE, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return common ? dirname(common) : HERE;
  } catch {
    return HERE;
  }
}

/** The checkout that holds the env files: this one when it has them, else the main checkout this worktree belongs to. */
export function envHome(): string {
  if (existsSync(join(HERE, DEV.envFile)) || existsSync(join(HERE, PRODUCTION.envFile))) return HERE;
  return mainCheckout();
}

/** Where a stage's secrets live. `MQ_ENV_FILE` points a script at another file. */
export function envPath(stage: Stage = "dev"): string {
  return process.env["MQ_ENV_FILE"] ?? join(envHome(), stage === "production" ? PRODUCTION.envFile : DEV.envFile);
}

/** Dev's file, or the one `MQ_ENV_FILE` names: what the try- scripts read. */
export const ENV_PATH = envPath("dev");

export function readEnvFile(path = ENV_PATH): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || m[1] === undefined) continue;
    out.set(m[1], (m[2] ?? "").replace(/^["']|["']$/g, ""));
  }
  return out;
}

/** The bot a token belongs to, by Telegram's getMe; null when Telegram does not know it. */
export async function botOf(token: string | undefined): Promise<string | null> {
  if (!token) return null;
  const res = await fetch(`https://api.telegram.org/bot${token}/getMe`).catch(() => null);
  const body = (await res?.json().catch(() => null)) as { ok?: boolean; result?: { username?: string } } | null;
  return body?.ok ? (body.result?.username ?? null) : null;
}

/**
 * Stops unless a file's secrets are `stage`'s: its database is that stage's Supabase project and its bot that
 * stage's bot. Production's secrets never go to dev, nor dev's to production.
 */
export async function checkStage(stage: Stage, env: Map<string, string>, path: string): Promise<void> {
  const problems: string[] = [];
  const db = env.get("DATABASE_URL") ?? "";
  if (stageOfDatabase(db) !== stage) {
    const want = stage === "production" ? PRODUCTION.supabase : DEV.supabase;
    problems.push(`DATABASE_URL is Supabase ${supabaseRef(db) ?? "(none)"}, not ${stage}'s ${want}`);
  }
  const bot = await botOf(env.get("TELEGRAM_BOT_TOKEN"));
  if (!bot) problems.push("TELEGRAM_BOT_TOKEN is missing, or Telegram did not recognise it");
  else {
    const wrong = botProblem(stage, bot);
    if (wrong) problems.push(wrong);
    else if (stage === "dev" && bot !== DEV.bot) console.error(`note: dev's bot here is @${bot}, not @${DEV.bot}`);
  }
  if (problems.length) throw new Error(`${path} is not ${stage}'s:\n  - ${problems.join("\n  - ")}`);
}

/** Appends a key only if it is absent; returns true when it was added. */
export function ensureEnvValue(key: string, make: () => string, path = ENV_PATH): boolean {
  const current = readEnvFile(path);
  if (current.get(key)) return false;
  const body = existsSync(path) ? readFileSync(path, "utf8") : "";
  const sep = body === "" || body.endsWith("\n") ? "" : "\n";
  writeFileSync(path, `${body}${sep}${key}=${make()}\n`);
  return true;
}

/** Sets a key, replacing an existing line or appending a new one. */
export function setEnvValue(key: string, value: string, path = ENV_PATH): void {
  const body = existsSync(path) ? readFileSync(path, "utf8") : "";
  const re = new RegExp(`^\\s*${key}\\s*=.*$`, "m");
  const next = re.test(body)
    ? body.replace(re, `${key}=${value}`)
    : `${body}${body === "" || body.endsWith("\n") ? "" : "\n"}${key}=${value}\n`;
  writeFileSync(path, next);
}
