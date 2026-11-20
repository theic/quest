/**
 * Tells Bing (and the other IndexNow engines: Yandex, Seznam, Naver, Yep) that the landing's pages changed,
 * so they recrawl them now rather than whenever they next pass. Run it after www points at a new deployment.
 * The key is public by design: it is the 32-hex .txt file in apps/web/public, which the engines fetch to
 * check that the request comes from the site. Google does not take IndexNow; it reads sitemap.xml.
 */
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const HOST = "www.messaging.quest";
const pub = resolve(import.meta.dirname, "../apps/web/public");
const keyFile = (await readdir(pub)).find((name) => /^[0-9a-f]{32}\.txt$/.test(name));
if (!keyFile) throw new Error("no IndexNow key file in apps/web/public");
const key = keyFile.slice(0, -4);
const urlList = [...(await readFile(join(pub, "sitemap.xml"), "utf8")).matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);

const response = await fetch("https://api.indexnow.org/indexnow", {
  method: "POST",
  headers: { "Content-Type": "application/json; charset=utf-8" },
  body: JSON.stringify({ host: HOST, key, keyLocation: `https://${HOST}/${keyFile}`, urlList }),
});
console.log(`IndexNow ${response.status} ${response.statusText} for ${urlList.length} pages: ${urlList.join(" ")}`);
if (response.status >= 300) process.exit(1);
