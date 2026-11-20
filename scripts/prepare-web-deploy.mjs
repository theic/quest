/** Prepare only the public landing assets. Upload this with `vercel deploy --prebuilt`. */
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { releaseZip } from "./pack-extension.mjs";

const root = resolve(import.meta.dirname, "..");
await mkdir(join(root, ".artifacts"), { recursive: true });
const target = await mkdtemp(join(root, ".artifacts/landing-deploy-"));
await mkdir(join(target, ".vercel/output"), { recursive: true });
await cp(join(root, "apps/web/public"), join(target, ".vercel/output/static"), { recursive: true });
// The extension as this commit has it, for loading unpacked from the page's "install it from a zip".
const extension = releaseZip();
await writeFile(join(target, ".vercel/output/static/quest-extension.zip"), extension.bytes);
console.error(`quest-extension.zip: version ${extension.version}, ${(extension.bytes.length / 1024).toFixed(0)} KB`);
await cp(join(root, "apps/web/vercel-output.json"), join(target, ".vercel/output/config.json"));
await writeFile(join(target, ".vercel/project.json"), JSON.stringify({
  projectId: "prj_gA2J5XdYEvwl5nZ6JdAR8ELnC1IH",
  orgId: "team_2LaFw48cd58uAHlFMUazp6qV",
  projectName: "messaging-quest",
}, null, 2) + "\n");
console.log(target);
