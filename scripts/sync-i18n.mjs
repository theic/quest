/** The static site and unpacked Chrome extension ship the same reviewed catalogs. */
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { LOCALES } from "../packages/i18n/src/language.js";
for (const target of ["apps/web/public/i18n", "apps/extension/i18n"]) {
  await mkdir(target, { recursive: true });
  for (const name of ["browser.js", "browser.css", "language.js", "locales"]) {
    await cp(`packages/i18n/src/${name}`, `${target}/${name}`, { recursive: true });
  }
}
// Chrome's own extensions page uses browser locale, independently of the popup override.
for (const locale of LOCALES) {
  const catalog = JSON.parse(await readFile(`packages/i18n/src/locales/${locale}.json`, "utf8"));
  const dir = `apps/extension/_locales/${locale === "zh" ? "zh_CN" : locale === "pt" ? "pt_BR" : locale}`;
  await mkdir(dir, { recursive: true });
  await writeFile(`${dir}/messages.json`, JSON.stringify({ description: { message: catalog["Find the right people with Quest."] } }, null, 2) + "\n");
}
