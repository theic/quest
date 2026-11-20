/**
 * One X page read as the team reads it now: through a laptop agent run with CHROME_DEBUG=1 (`CHROME_DEBUG=1 npm run
 * dev`), cut into posts by `chrome/sites.ts`, with a profile's header and whom the page is read as. Prints what a model
 * would get, and its size beside the page's own words. Nothing is saved or sent.
 *
 *   node --experimental-strip-types scripts/try-x-page.ts <customer id> <x.com address> [...more addresses]
 */
import type { ChromeRead } from "@mq/core";
import { postsText, X } from "../apps/agent/src/chrome/sites.ts";

const [id, ...urls] = process.argv.slice(2);
if (!id || !urls.length) throw new Error("usage: try-x-page.ts <customer id> <x.com address> [...]");
const AGENT = process.env.MQ_AGENT ?? "http://127.0.0.1:8080";

for (const url of urls) {
  const started = Date.now();
  const res = await fetch(`${AGENT}/debug/chrome/read`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ customerId: id, job: X.job(url) }) });
  const r = (await res.json()) as ChromeRead & { error?: string };
  if (!res.ok || r.error) {
    console.log(`${url}: ${r.error ?? `HTTP ${res.status}`}`);
    continue;
  }
  const posts = X.postsFrom(r, new Date());
  const about = X.aboutFrom?.(r) ?? null;
  const text = [about, postsText(posts)].filter(Boolean).join("\n\n");
  console.log(`\n=== ${url} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
  console.log(`page words ${r.text.length} chars; cut ${text.length} chars; ${posts.length} posts; rows: ${Object.entries(r.rows).map(([k, v]) => `${k} ${v.length}`).join(", ")}; read as ${X.accountFrom?.(r) ?? "?"}`);
  console.log(text.slice(0, 2_500));
}
