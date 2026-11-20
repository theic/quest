/**
 * Everything the local edition needs before `npm start`, checked and done where it can be (AGENTS.md walks an agent
 * through it): Node, the packages, a subscription signed in on this computer, the database folder, Quest starting with
 * the computer (on Windows, a line in the Startup folder; `--no-autostart` leaves it), and the extension.
 *
 *   npm run setup [-- --no-autostart]
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const STORE = "https://chromewebstore.google.com/detail/messaging-quest/kojgkphccdbkkclgadbdheblpebmiapj";
const root = resolve(import.meta.dirname, "..");
const home = process.env["QUEST_HOME"] ?? join(homedir(), ".quest");
const ok = (line: string) => console.log(`  ok    ${line}`);
const todo = (line: string) => console.log(`  todo  ${line}`);
let left = 0;

console.log("Quest, the local edition: setting up\n");

const [major, minor] = process.versions.node.split(".").map(Number) as [number, number];
if (major > 22 || (major === 22 && minor >= 12)) ok(`Node ${process.versions.node}`);
else {
  todo(`Node ${process.versions.node} is too old: install Node 22.12 or newer (nodejs.org), then run this again`);
  process.exit(1);
}

if (!existsSync(join(root, "node_modules", "@electric-sql", "pglite"))) {
  console.log("  ...   installing packages (npm install), once");
  const npm = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["install"], { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
  if (npm.status !== 0) {
    todo("npm install failed: see above");
    process.exit(1);
  }
}
ok("packages installed");
// Loaded only now: it needs the packages, which a fresh clone did not have until the install above.
const { codexBin } = await import("../apps/agent/src/agents/codex-cli-models.ts");

// Which subscription Quest thinks with: Claude if this computer is signed in to it, else ChatGPT through Codex.
const claude = existsSync(join(homedir(), ".claude", ".credentials.json"));
const codex = existsSync(join(process.env["CODEX_HOME"] ?? join(homedir(), ".codex"), "auth.json")) && spawnSync(codexBin(), ["--version"], { stdio: "ignore" }).status === 0;
if (claude) ok("Claude is signed in here: Quest thinks with your Claude subscription");
else if (codex) ok("Codex is signed in here: Quest thinks with your ChatGPT subscription");
else {
  left++;
  todo("sign in to a subscription Quest can think with: `npm run claude:login` (Claude), or install Codex and run `codex login` (ChatGPT)");
}

mkdirSync(home, { recursive: true });
ok(`Quest keeps its data in ${home}`);

// Starts with the computer, so it keeps working while their Chrome is open.
if (!process.argv.includes("--no-autostart") && process.platform === "win32" && process.env["APPDATA"]) {
  const startup = join(process.env["APPDATA"], "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
  const cmd = join(startup, "Quest.cmd");
  // Best effort: a Startup folder that is not there (a redirected APPDATA) must not end the setup.
  try {
    writeFileSync(cmd, `@echo off\r\ncd /d "${root}"\r\nstart "Quest" /min cmd /c "npm start >> "%USERPROFILE%\\.quest\\quest.log" 2>&1"\r\n`);
    ok(`Quest starts with Windows (${cmd}; delete it to stop that)`);
  } catch {
    todo(`could not make Quest start with Windows (no Startup folder at ${startup}): run \`npm start\` in this folder after a restart`);
  }
} else if (process.platform !== "win32") {
  todo("to start Quest with the computer, add `npm start` in this folder to your login items");
}

left++;
todo(`add Quest to Chrome from the Chrome Web Store (${STORE}), then open its side panel: it finds Quest on this computer by itself`);

console.log(`\nThen: npm start${left > 1 ? " (after the todo above)" : ""}, and press "Start talking" in Quest's side panel.`);
