/**
 * Copies production's secrets from .env.production.local to its Fly app, through flyctl's stdin, so no value is
 * ever printed or passed on a command line. The Fly app is production, so only production's file goes there: the
 * script stops unless the file's database is production's Supabase project and its bot @messagingquestbot.
 *
 *   node --experimental-strip-types scripts/fly-secrets.ts agent [--stage]
 */
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { PRODUCTION } from "../apps/agent/src/environments.ts";
import { checkStage, envPath, readEnvFile } from "./env-file.ts";

const APPS = {
  agent: { name: PRODUCTION.flyApp, keys: ["DATABASE_URL", "TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET", "OPENROUTER_API_KEY"], optional: ["TAVILY_API_KEY", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"] },
} as const;

const which = process.argv[2] as keyof typeof APPS | undefined;
if (!which || !(which in APPS)) throw new Error("usage: fly-secrets.ts agent [--stage]");
const app = APPS[which];
const path = envPath("production");
const env = readEnvFile(path);
const missing = app.keys.filter((k) => !env.get(k));
if (missing.length) throw new Error(`missing from ${path}: ${missing.join(", ")}`);
await checkStage("production", env, path);
// Optional ones go along when they are in the file.
const sent = [...app.keys, ...app.optional.filter((k) => env.get(k))];

const flyctl = process.env["FLYCTL"] ?? join(homedir(), ".fly", "bin", process.platform === "win32" ? "flyctl.exe" : "flyctl");
const args = ["secrets", "import", "-a", app.name, ...(process.argv.includes("--stage") ? ["--stage"] : [])];
const child = spawn(flyctl, args, { stdio: ["pipe", "inherit", "inherit"] });
child.stdin.end(sent.map((k) => `${k}=${env.get(k)}`).join("\n") + "\n");
child.on("exit", (code) => {
  console.log(code === 0 ? `set on ${app.name}: ${sent.join(", ")}` : `flyctl exited with ${code}`);
  process.exit(code ?? 1);
});
