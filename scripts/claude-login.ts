/**
 * Logs in, once, the Claude Code CLI the Agent SDK ships, with the Claude subscription: what MODELS=claude-cli runs on
 * (CLAUDE.md, "Production and dev"). The login is kept in ~/.claude, for every checkout.
 *
 *   npm run claude:login            # opens the browser to sign in
 *   npm run claude:login -- status  # whether it is logged in
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const platform = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
const bin = join(dirname(require.resolve(`${platform}/package.json`)), process.platform === "win32" ? "claude.exe" : "claude");
const args = process.argv.slice(2);
const run = spawnSync(bin, ["auth", ...(args.length ? args : ["login", "--claudeai"])], { stdio: "inherit" });
process.exit(run.status ?? 1);
