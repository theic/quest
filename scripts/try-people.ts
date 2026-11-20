/**
 * The shared database of people, both ways, against a hosted agent (dev's at http://localhost:8080 unless given): an
 * install key is refused without one, reads the last week back, sends a few of those same public posts again (nothing
 * made up lands in the table), checks a private address is refused, and times it.
 *
 *   node --experimental-strip-types scripts/try-people.ts [server]
 */
import { randomBytes } from "node:crypto";

const server = (process.argv[2] ?? "http://localhost:8080").replace(/\/+$/, "");
const key = `try-${randomBytes(12).toString("base64url")}`;
const h = { "x-quest-install": key, "content-type": "application/json" };

const none = await fetch(`${server}/people/recent`);
console.log("without a key:", none.status);

let t0 = Date.now();
const recent = (await (await fetch(`${server}/people/recent?days=7&limit=500`, { headers: h })).json()) as { posts: { side: string; url: string; author: string; text: string; source: string; postedAt: string | null }[] };
const asks = recent.posts.filter((p) => p.side === "ask").length;
console.log(`read back: ${recent.posts.length} posts (${asks} asks, ${recent.posts.length - asks} launches) in ${Date.now() - t0} ms`);

t0 = Date.now();
const again = recent.posts.slice(0, 5);
const sent = await fetch(`${server}/people/seen`, { method: "POST", headers: h, body: JSON.stringify({ posts: again }) });
console.log("sent the same 5 again:", sent.status, await sent.text(), `${Date.now() - t0} ms`);

const bad = again[0] ? [{ ...again[0], url: "http://192.168.1.10/x" }] : [];
const refused = await fetch(`${server}/people/seen`, { method: "POST", headers: h, body: JSON.stringify({ posts: bad }) });
console.log("a private address:", refused.status);
