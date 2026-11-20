/** Supervised live model test of a canvas workspace with content/receipts hidden from DOM inspection.
 * Run, open the printed loopback URL in the internal browser, and drive the broker's jobs through it.
 * This harness permits ONLY its own local fixture origin; normal production HostGuard stays strict.
 */
import { readFile } from "node:fs/promises";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { customerId, ReadError } from "@mq/core";
import { modelsFor } from "../apps/agent/src/model-source.ts";
import { BROKER_DEFAULTS, ChromeBroker, type JobOutcome } from "../apps/agent/src/chrome/broker.ts";
import { CustomerBrowser } from "../apps/agent/src/chrome/browser.ts";
import { BrowserPoster } from "../apps/agent/src/chrome/browser-poster.ts";
import { BrowserVision } from "../apps/agent/src/chrome/browser-vision.ts";
import { loadConfig } from "../apps/agent/src/config.ts";
import { JsonLogger } from "../apps/agent/src/infra/system.ts";
import { readEnvFile } from "./env-file.ts";

const port = Number(process.argv[2] ?? 8091);
const base = `http://127.0.0.1:${port}`;
const id = customerId("visual-fixture");
const broker = new ChromeBroker({ ...BROKER_DEFAULTS, jobTimeoutMs: 300000, queueTimeoutMs: 300000 });
const config = loadConfig(Object.fromEntries(readEnvFile()));
const models = await modelsFor(config);
const vision = new BrowserVision(models);
const browser = new CustomerBrowser(broker, { check: async (raw) => { const url = new URL(raw); if (url.origin !== base) throw new ReadError("blocked", "This fixture test permits only its own loopback origin."); return url; } }, vision);
const log = new JsonLogger({ test: "opaque-workspace" });
const poster = new BrowserPoster({ browser, reddit: broker, models, vision, log });
let result: unknown = null;
const app = new Hono();
app.get("/opaque", async (c) => c.html(await readFile(new URL("../apps/agent/test/fixtures/opaque-workspace.html", import.meta.url), "utf8")));
app.get("/next", async (c) => { const job = await broker.next(id, 20000, c.req.raw.signal); return job ? c.json(job) : c.body(null, 204); });
app.post("/result/:id", async (c) => broker.complete(id, c.req.param("id"), await c.req.json<JobOutcome>()) ? c.body(null, 204) : c.body(null, 410));
app.get("/status", (c) => c.json({ result }));
app.post("/start", async (c) => {
  if (result) return c.json({ error: "Already started" }, 409);
  result = { state: "running" };
  await broker.next(id, 0);
  void poster.post(id, { platform: "browser", kind: "message", url: `${base}/opaque`, target: "Alex (demo contact)", title: null, text: "Quest visual PR test: hello from pictured controls." })
    .then(posted => { result = { state: "verified", posted }; log.info("visual.verified", { url: posted.url }); })
    .catch(e => { result = { state: "failed", error: e.message }; log.error("visual.failed", { error: e.message }); });
  return c.json({ started: true });
});
const server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" });
console.log(`Visual fixture: ${base}/opaque`);
process.on("SIGINT", () => { server.close(); process.exit(0); });
