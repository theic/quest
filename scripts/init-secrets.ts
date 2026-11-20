/**
 * Generates the secrets the services share (the database password, the Telegram
 * webhook secret) into .env.local when they are missing, and
 * prints the SQL that gives the `mq_app` role its password as a SCRAM-SHA-256
 * verifier: a salted hash, so the password itself never leaves this machine.
 *
 *   node --experimental-strip-types scripts/init-secrets.ts
 */
import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { basename } from "node:path";
import { ENV_PATH, ensureEnvValue, readEnvFile } from "./env-file.ts";

const token = (bytes: number) => randomBytes(bytes).toString("hex");

const added = [
  ensureEnvValue("MQ_DB_PASSWORD", () => token(24)) && "MQ_DB_PASSWORD",
  ensureEnvValue("TELEGRAM_WEBHOOK_SECRET", () => token(24)) && "TELEGRAM_WEBHOOK_SECRET",
].filter(Boolean);
console.error(added.length ? `added to ${basename(ENV_PATH)}: ${added.join(", ")}` : "all secrets already present");

/** Postgres' SCRAM-SHA-256 verifier format (RFC 5802 / 7677). */
export function scramVerifier(password: string, iterations = 4096): string {
  const salt = randomBytes(16);
  const salted = pbkdf2Sync(password.normalize("NFKC"), salt, iterations, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}

const password = readEnvFile().get("MQ_DB_PASSWORD");
if (!password) throw new Error("MQ_DB_PASSWORD is missing from .env.local");
console.log(`alter role mq_app with login password '${scramVerifier(password)}' valid until 'infinity';`);
