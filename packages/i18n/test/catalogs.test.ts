import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import { catalogs, LOCALES, forLanguage } from "../src/server.js";

const root = resolve(import.meta.dirname, "../../..");
const english: Record<string, string> = catalogs.en;
const placeholders = (s: string) => (s.match(/\{[a-zA-Z]\w*\}/g) ?? []).sort();
const tags = (s: string) => (s.match(/<[^>]+>/g) ?? []).sort();

describe("complete translation catalogs", () => {
  for (const locale of LOCALES) it(`${locale}: every source, placeholder and trusted HTML tag is present`, () => {
    const translated: Record<string, string> = catalogs[locale as keyof typeof catalogs];
    expect(Object.keys(translated).sort()).toEqual(Object.keys(english).sort());
    for (const [source, value] of Object.entries(translated)) {
      expect(value.trim(), source).not.toBe("");
      expect(value, source).not.toMatch(/�|\bundefined\b|\bnull\b/);
      expect(placeholders(value), source).toEqual(placeholders(source));
      expect(tags(value), source).toEqual(tags(source));
      if (locale !== "en") expect(value.replace(/<[^>]+>/g, ""), source).not.toMatch(/ask me first|Connect Chrome|Post it|Career\s*\/\s*Freelance|Founder\s*\/\s*CMO|\bRecruiting\b/);
    }
  });

  it("en: the source, every text its own translation, so a page in English fetches no catalog", () => {
    for (const [source, value] of Object.entries(english)) expect(value, source).toBe(source);
    expect(readFileSync(resolve(root, "packages/i18n/src/browser.js"), "utf8")).toContain('if (wanted !== "en")');
  });

  it("covers HTML copy and accessibility labels on every surface", () => {
    for (const file of ["apps/web/public/index.html", "apps/web/public/experiments.html", "apps/agent/public/glass.html", "apps/agent/public/chrome.html", "apps/agent/public/connect.html", "apps/extension/popup.html"]) {
      const window = new Window();
      window.document.write(readFileSync(resolve(root, file), "utf8"));
      for (const element of window.document.querySelectorAll("*")) {
        for (const attribute of element.attributes) if (attribute.name.startsWith("data-i18n")) expect(english[attribute.value ?? ""], `${file}: ${attribute.value}`).toBeDefined();
      }
    }
  });

  it("ships identical browser runtime and translations with the site and extension", () => {
    for (const destination of ["apps/web/public/i18n", "apps/extension/i18n"]) {
      for (const file of ["browser.js", "browser.css", "language.js", ...LOCALES.map((l) => `locales/${l}.json`)]) {
        expect(readFileSync(resolve(root, destination, file), "utf8")).toBe(readFileSync(resolve(root, "packages/i18n/src", file), "utf8"));
      }
    }
  });

  it("keeps Telegram command descriptions within the API limit", () => {
    for (const locale of LOCALES) for (const text of ["Start over with Quest", "Choose or switch your quest", "Connect your Chrome, where Quest reads the web", "Show or hide Quest's tab in this chat", "Your credits and today's use", "Change language (automatic by default)"]) {
      expect([...forLanguage(locale)(text)].length).toBeLessThanOrEqual(256);
    }
  });
});
