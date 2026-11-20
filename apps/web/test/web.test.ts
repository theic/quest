import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { Window } from "happy-dom";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UNSUBSCRIBE_PATH } from "../../agent/src/http/unsubscribe-routes.ts";
import { stockPhrases } from "../../agent/src/lib/voice.ts";
import { EXTENSION_ZIP, fileFor, PUBLIC_DIR, siteServer } from "../src/serve.ts";

const page = (): Document => {
  const window = new Window({ url: "https://messaging.quest/" });
  return new window.DOMParser().parseFromString(readFileSync(join(PUBLIC_DIR, "index.html"), "utf8"), "text/html") as unknown as Document;
};
const hrefs = (doc: Document, selector: string): string[] => [...doc.querySelectorAll(selector)].map((a) => a.getAttribute("href") ?? "");
const STORE = "https://chromewebstore.google.com/detail/messaging-quest/kojgkphccdbkkclgadbdheblpebmiapj";

describe("the landing page", () => {
  it("sends every Telegram link to one bot, on the Founder quest, the one that builds a product's name", () => {
    const links = hrefs(page(), 'a[href^="https://t.me/"]').map((href) => new URL(href));
    const bots = new Set(links.map((url) => url.pathname.slice(1)));

    // The production bot. @TestPatrikBot is the dev database's, and never a customer's.
    expect([...bots]).toEqual(["messagingquestbot"]);
    const starts = new Set(links.map((url) => url.searchParams.get("start")));
    // A link's tag says where they came from; Quest serves founders and builders only (2026-10-29).
    expect([...starts]).toEqual(["founder"]);
  });

  it("opens on what Quest is and does, not its name: one line as the title, the networks, one start button and what it takes", () => {
    const doc = page();
    const hero = doc.querySelector(".hero");
    const words = (el: Element | null | undefined) => (el?.textContent ?? "").trim().split(/\s+/).length;

    // The Visor alone is in the corner, named for a screen reader; the title is the line.
    expect(doc.querySelector(".site-head .logo")?.textContent).toBe("");
    expect(doc.querySelector(".site-head .logo img")?.getAttribute("alt")).toBe("Messaging Quest");
    expect(hero?.querySelectorAll("h1")).toHaveLength(1);
    // The founder's post: who says it, the sentence and the video attached, nothing else on the first screen; its numbers are growth.json's.
    const week: { started: number; back: number; as: string } = JSON.parse(readFileSync(join(PUBLIC_DIR, "growth.json"), "utf8")).week;
    expect(hero?.querySelector("h1")?.textContent).toBe(`This is Quest, a growth hire for solo founders. It works in my browser. Last week it started ${week.started} conversations and ${week.back} people wrote back.`);
    expect(hero?.querySelectorAll("h1 svg")).toHaveLength(0);
    expect([hero?.children.length, hero?.querySelector("figcaption img")?.getAttribute("src"), hero?.querySelector("figcaption")?.textContent]).toEqual([1, "/serhii.jpg", "Serhii Lahutin @serhiilahutin"]);
    expect(hero?.querySelectorAll("h2, h3")).toHaveLength(0);
    expect(hero?.querySelector("figure.quote > #watch video")).not.toBeNull();
    // Under the words, Chrome's own button to the store (a phone gets the free start on t.me); the video is right under it.
    expect([...(hero?.querySelectorAll(".post-go a") ?? [])].map((a) => [a.textContent?.trim(), a.classList.contains("hide-phone"), a.classList.contains("only-phone")])).toEqual([["Run it yourself, free", false, false], ["Add to Chrome", true, false], ["Start free, no card", false, true]]);
  });

  it("starts every way in on t.me, whose own page offers the Telegram app or Telegram Web", () => {
    expect(hrefs(page(), 'a[href^="https://web.telegram.org/"]')).toEqual([]);
  });

  it("tells a phone, a Chromium desktop and any other browser apart before the page paints", () => {
    const script = [...page().querySelectorAll("head script:not([src])")].map((s) => s.textContent ?? "").find((text) => text.includes("dataset.device")) ?? "";
    const device = (userAgent: string, maxTouchPoints = 0): string | undefined => {
      const root = { classList: { add: () => undefined }, dataset: {} as { device?: string } };
      new Function("document", "navigator", script)({ documentElement: root }, { userAgent, maxTouchPoints });
      return root.dataset.device;
    };
    const chrome = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
    const safariMac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";

    expect(device(chrome)).toBe("chrome");
    expect(device(`${chrome} Edg/130.0.0.0`)).toBe("chrome");
    expect(device("Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0")).toBe("other");
    expect(device(safariMac)).toBe("other");
    expect(device("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1", 5)).toBe("phone");
    expect(device("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36", 5)).toBe("phone");
    // An iPad asks for the desktop site, and says so only with its touch points.
    expect(device(safariMac, 5)).toBe("phone");
  });

  it("never sends a phone to the Web Store, and says on the page where each step happens", () => {
    const doc = page();
    const stores = [...doc.querySelectorAll("#top a[data-store], #start a[data-store]")];

    expect(stores.length).toBeGreaterThan(0);
    // Hidden on a phone, or, for Step 2 (which a phone still reads), not a link there.
    for (const link of stores) expect(link.classList.contains(link.matches(".setup-step") ? "off-phone" : "hide-phone"), link.outerHTML.slice(0, 80)).toBe(true);
    expect(readFileSync(join(PUBLIC_DIR, "site.css"), "utf8")).toContain('[data-device="phone"] .off-phone { pointer-events: none; }');
  });

  it("lands every link inside the page on a section that exists", () => {
    const doc = page();
    const targets = hrefs(doc, 'a[href^="#"]').map((href) => href.slice(1));

    expect(targets.length).toBeGreaterThan(0);
    for (const id of targets) expect(doc.getElementById(id), `#${id}`).not.toBeNull();
  });

  it("speaks in Quest's voice: no dashes, no stock phrases, none of the words the manager may not use", () => {
    const text = page().body.textContent ?? "";
    const banned = ["leads", "icp", "funnel", "campaign", "outreach", "opportunities", "24/7", "instantly", "real time", "seamless", "unlock", "elevate", "streamline", "empower", "leverage", "journey", "landscape"];

    expect(text).toContain("Start free, no card");
    expect(text).not.toMatch(/[—–]/);
    expect(stockPhrases(text)).toEqual([]);
    expect(banned.filter((word) => new RegExp(`\\b${word}\\b`, "i").test(text))).toEqual([]);
  });

  it("says it starts free with no card, and names no price or trial", () => {
    const doc = page();
    const text = doc.body.textContent ?? "";

    expect(text).toContain("Start free, no card");
    expect(doc.querySelector("#pricing")).toBeNull();
    expect(doc.querySelector("main")?.textContent).not.toMatch(/\$\d{2,}/);
    expect(text).not.toMatch(/\bads?\b|\bfeatured\b|\bsponsor/i);
    expect(text).not.toMatch(/\btrial (period|ends|expires)|\bfree for \d+ days\b/i);
  });

  it("follows the video with the founder's accounts grown from zero, real replies, then the price and the one step that starts it", () => {
    const doc = page();
    const sections = [...doc.querySelectorAll("main > section")].map((s) => s.id);

    expect(sections).toEqual(["top", "public", "replies", "faq", "start"]);
    // The wheel scrolls the page as it is: nothing pins a section or stretches one to play through (the title
    // screen alone is a screen tall, and holds the founder's post with the video attached).
    const css = readFileSync(join(PUBLIC_DIR, "site.css"), "utf8");
    expect(css.replace(/\.hero \{[^}]*\}/, "")).not.toMatch(/position: sticky|\d+svh;/);
  });

  it("draws each profile's logo in the page", () => {
    const doc = page();
    for (const net of doc.querySelectorAll(".foot-profiles li")) {
      const id = net.querySelector("use")?.getAttribute("href") ?? "";
      expect(doc.querySelector(`symbol${id}`)?.querySelector("path, circle, use"), id).not.toBeNull();
    }
  });

  it("puts the graph right under the video with a title of its own, and the replies right under the graph with none", () => {
    const doc = page();

    expect(doc.querySelector("#how")).toBeNull();
    expect([...doc.querySelectorAll("#public > :is(.eyebrow, h2)")].map((el) => el.textContent)).toEqual(["I run Quest on my own accounts. 1 in 4 replies gets an answer."]);
    expect(doc.querySelector("#public .multiplier")).toBeNull();
    expect(doc.querySelector("#replies")?.querySelectorAll("h2, .eyebrow")).toHaveLength(0);
  });

  it("wears the Visor: in the corner and in the footer, and in the icon", () => {
    const doc = page();
    const marks = [...doc.querySelectorAll(".logo img")].map((img) => img.getAttribute("src"));

    expect(marks).toEqual(["/quest.svg", "/quest.svg"]);
    for (const name of ["quest.svg", "favicon.svg"]) expect(readFileSync(join(PUBLIC_DIR, name), "utf8"), name).toContain('class="screen"');
  });

  it("adds Quest to Chrome from its Web Store listing, with the zip as the second way in", () => {
    const doc = page();
    const stores = [...doc.querySelectorAll("a[data-store]")];

    // The first post, the last call and the footer, each to the listing itself (no account or language in the address).
    expect(stores.map((a) => a.closest("#top, #start, footer")?.id || "footer")).toEqual(["top", "start", "footer"]);
    for (const store of stores) expect([store.getAttribute("href"), store.getAttribute("target"), store.getAttribute("rel")]).toEqual([STORE, "_blank", "noopener"]);
    expect([...doc.querySelectorAll('a[href*="chromewebstore.google.com"]')]).toEqual(stores);
    // The lime goes to Telegram; the store is a plain link beside it.
    expect(doc.querySelector("#start a[data-store]")?.classList.contains("pill-accent")).toBe(false);
    expect(doc.querySelector('script[type="application/ld+json"]')?.textContent).toContain(`"installUrl": "${STORE}"`);
    // The zip's steps are a text link beside it, nothing louder; nothing says the store is off any more.
    const zip = [...doc.querySelectorAll('[commandfor="install"][command="show-modal"]')];
    expect(zip.map((b) => [b.closest("#start")?.id, b.className, b.textContent])).toEqual([["start", "text-link hide-phone", "or install it from a zip"]]);
    expect(doc.querySelectorAll(".pill-off, .pill-tag, .in-review")).toHaveLength(0);
    // The bot's install and connect pages lead with the listing too, the zip a text link to the same dialog.
    for (const name of ["chrome.html", "connect.html"]) {
      const html = readFileSync(join(PUBLIC_DIR, "..", "..", "agent", "public", name), "utf8");
      expect(html.indexOf(`href="${STORE}"`), name).toBeGreaterThan(0);
      expect(html.indexOf(`href="${STORE}"`), name).toBeLessThan(html.indexOf('class="text-link" type="button" commandfor="install" command="show-modal"'));
      expect(html.indexOf('command="show-modal"'), name).toBeLessThan(html.indexOf("quest-extension.zip"));
    }
  });

  it("counts visits with PostHog on www only, through our own /ingest, keeping nothing on the device, and says so in the privacy policy", async () => {
    for (const name of ["index.html", "privacy.html", "terms.html"]) expect(readFileSync(join(PUBLIC_DIR, name), "utf8"), name).toContain('<script type="module" src="/analytics.js"></script>');
    const script = readFileSync(join(PUBLIC_DIR, "analytics.js"), "utf8");
    expect(script).toMatch(/const KEY = "phc_\w{20,}";/);
    for (const option of ['api_host: "/ingest"', 'persistence: "memory"', 'person_profiles: "identified_only"', "disable_session_recording: true"]) expect(script).toContain(option);
    // The deploy passes /ingest to PostHog's EU Cloud, before the files and the 404.
    const routes: { src?: string; dest?: string; handle?: string }[] = JSON.parse(readFileSync(join(PUBLIC_DIR, "..", "vercel-output.json"), "utf8")).routes;
    const ingest = routes.filter((r) => r.src?.startsWith("/ingest/"));
    expect(ingest.map((r) => new URL(r.dest ?? "").host)).toEqual(["eu-assets.i.posthog.com", "eu-assets.i.posthog.com", "eu.i.posthog.com"]);
    expect(routes.indexOf(ingest[2]!)).toBeLessThan(routes.findIndex((r) => r.handle === "filesystem"));
    // The steps that make a customer each get a name, with where on the page they were taken.
    const { step, SITE } = await import("../public/analytics.js");
    expect(SITE).toBe("www.messaging.quest");
    const doc = page();
    const named = (selector: string) => step(doc.querySelector(selector));
    expect(named("#top a[data-store]")).toEqual(["add_to_chrome_clicked", { place: "top" }]);
    expect(named("#top .only-phone")).toEqual(["start_clicked", { place: "top", via: "app" }]);
    expect(named("footer a[href^='https://t.me/']")).toEqual(["start_clicked", { place: "footer", via: "app" }]);
    expect(named("#start a[data-store]")).toEqual(["add_to_chrome_clicked", { place: "start" }]);
    expect(named("footer a[data-store] span")).toEqual(["add_to_chrome_clicked", { place: "footer" }]);
    expect(named('#start [commandfor="install"]')).toEqual(["zip_steps_opened", { place: "start" }]);
    expect(named("#start a.link-card b")).toEqual(["repo_opened", { place: "start" }]);
    expect(named("#top .self-host")).toEqual(["repo_opened", { place: "top" }]);
    expect(named('#install a[href="/quest-extension.zip"]')).toEqual(["zip_downloaded", { place: "install" }]);
    expect(named("#replies a.card-link")?.[0]).toBe("feed_item_opened");
    expect(named("#watch button.sound")).toEqual(["video_sound_clicked", { on: true }]);
    expect(named("#public h2")).toBeNull();
    const privacy = readFileSync(join(PUBLIC_DIR, "privacy.html"), "utf8");
    expect(privacy).toContain("<td>PostHog</td>");
    expect(privacy).not.toContain("runs no analytics");
  });

  it("plays the product video from our own file: muted, looping, with a speaker for the sound, and the browser's controls without a script", () => {
    const frame = page().querySelector("#watch .watch-frame");
    const video = frame?.querySelector("video");

    // One wide cut for every width: a phone plays it too, in a wide frame.
    const sources = [...(video?.querySelectorAll("source") ?? [])].map((s) => [s.getAttribute("src"), s.getAttribute("type"), s.getAttribute("media")]);
    expect(sources).toEqual([["/video.mp4", "video/mp4", null]]);
    expect(video?.hasAttribute("src")).toBe(false);
    expect(video?.getAttribute("poster")).toBe("/video-poster.webp");
    // Small enough to stream as it plays: just under two minutes in thirteen megabytes, its first frame under fifty
    // kilobytes. The upright cut and its poster are gone.
    expect(statSync(join(PUBLIC_DIR, "video.mp4")).size).toBeLessThan(13_000_000);
    for (const gone of ["video-tall.mp4", "video-poster-tall.webp"]) expect(existsSync(join(PUBLIC_DIR, gone)), gone).toBe(false);
    expect(statSync(join(PUBLIC_DIR, "video-poster.webp")).size).toBeLessThan(50_000);
    for (const attr of ["controls", "muted", "loop", "playsinline"]) expect(video?.hasAttribute(attr), attr).toBe(true);
    expect(video?.getAttribute("preload")).toBe("none");
    expect(video?.getAttribute("data-i18n-aria-label")).toBe(video?.getAttribute("aria-label"));
    // The speaker says in words that a click turns the sound on; the picture does that too, then pauses.
    const sound = frame?.querySelector("button.sound");
    expect([sound?.getAttribute("role"), sound?.getAttribute("aria-checked"), sound?.getAttribute("aria-label"), sound?.hasAttribute("hidden")]).toEqual(["switch", "false", "Sound", true]);
    expect(sound?.textContent?.trim()).toBe("Click for sound");
    const hit = frame?.querySelector("button.watch-hit");
    expect([hit?.getAttribute("aria-pressed"), hit?.getAttribute("aria-label"), hit?.hasAttribute("hidden")]).toEqual(["false", "Pause the video", true]);
    // The script takes the browser's controls away and shows the two buttons; nothing comes from YouTube.
    const script = readFileSync(join(PUBLIC_DIR, "watch.js"), "utf8");
    expect(script).toContain("video.controls = false");
    expect(script).not.toMatch(/youtube/i);
  });

  it("installs from a zip: the zip's steps, and a prompt for an assistant", () => {
    const doc = page();
    const dialog = doc.querySelector("dialog#install");
    const zipUrl = "https://www.messaging.quest/quest-extension.zip";

    expect(dialog?.querySelector('a[href="/quest-extension.zip"][download]')).not.toBeNull();
    expect(dialog?.querySelector("[data-copy]")?.getAttribute("data-copy")).toBe("chrome://extensions");
    const prompt = dialog?.querySelector(".install-prompt")?.textContent ?? "";
    expect(prompt).toContain(zipUrl);
    const asks = [...(dialog?.querySelectorAll("a[data-ask]") ?? [])];
    expect(asks.map((a) => new URL(a.getAttribute("href") ?? "").host)).toEqual(["chatgpt.com", "claude.ai"]);
    for (const a of asks) expect(new URL(a.getAttribute("href") ?? "").searchParams.get("q"), a.textContent ?? "").toBe(prompt);
    // The bot's own pages give the same steps, with the same words, so one translation serves all three.
    const steps = [...(dialog?.querySelectorAll(".install-steps [data-i18n]:not(button)") ?? [])].map((el) => el.getAttribute("data-i18n"));
    for (const name of ["chrome.html", "connect.html"]) {
      const html = readFileSync(join(PUBLIC_DIR, "..", "..", "agent", "public", name), "utf8");
      expect(html, name).toContain(`href="${zipUrl}"`);
      for (const step of steps) expect(html, `${name}: ${step}`).toContain(`data-i18n="${step}"`);
      expect(html, name).not.toContain("apps/extension");
    }
    // The deploy puts the zip beside the page.
    expect(readFileSync(join(PUBLIC_DIR, "..", "..", "..", "scripts", "prepare-web-deploy.mjs"), "utf8")).toContain(`static/${EXTENSION_ZIP}`);
  });

  it("shows the founder's own accounts under a title that says how often a reply is answered, and a live feed of real replies under it, answered first", () => {
    const doc = page();
    type Item = { d: string; net: string; kind: string; href: string; text?: string; back?: number };
    const growth: { from: string; updated: string; accounts: Record<string, string>; followers: Record<string, [string, number][]>; items: Item[] } =
      JSON.parse(readFileSync(join(PUBLIC_DIR, "growth.json"), "utf8"));
    const network: Record<string, [RegExp, string[]]> = {
      x: [/^https:\/\/x\.com\/\w+(\/status\/\d+)?$/, ["post", "reply", "like", "follow"]],
      instagram: [/^https:\/\/www\.instagram\.com\/(p\/[\w-]+\/|[\w.]+\/((reel|p)\/[\w-]+\/)?)$/, ["post", "comment", "like", "follow"]],
      youtube: [/^https:\/\/www\.youtube\.com\/(watch\?v=[\w-]{11}|channel\/[\w-]+\/posts|@[\w.-]+)$/, ["video", "post", "comment", "like", "follow"]],
      reddit: [/^https:\/\/www\.reddit\.com\/(r|user)\/[\w/]+\/$/, ["comment", "like", "follow"]],
      threads: [/^https:\/\/www\.threads\.com\/@[\w.]+(\/post\/[\w-]+)?$/, ["post", "reply", "like", "follow"]],
      linkedin: [/^https:\/\/www\.linkedin\.com\/((in|company)\/[\w-]+\/(recent-activity\/all\/)?|feed\/update\/urn:li:\w+:\d+\/)$/, ["comment", "like", "follow"]],
      tiktok: [/^https:\/\/www\.tiktok\.com\/@[\w.]+(\/(video|photo)\/\d+)?$/, ["comment", "like", "follow"]],
      bluesky: [/^https:\/\/bsky\.app\/profile\/[\w.-]+(\/post\/\w+)?$/, ["reply", "post", "like", "follow"]],
    };
    const day = /^\d{4}-\d{2}-\d{2}$/;

    // Every item a day in the range, newest first, on a network the graph draws, linking where it went up.
    expect([growth.from, growth.updated].every((d) => day.test(d))).toBe(true);
    const dates = growth.items.map((item) => item.d);
    expect(dates).toEqual([...dates].sort().reverse());
    expect(dates.every((d) => d >= growth.from && d <= growth.updated)).toBe(true);
    for (const item of growth.items) {
      const [link, kinds] = network[item.net] ?? [];
      expect(link, item.href).toBeDefined();
      expect(item.href).toMatch(link!);
      expect(kinds, item.href).toContain(item.kind);
      // The words as posted, without the @names X puts in front or its links; a like or a follow has none.
      if (item.kind === "like" || item.kind === "follow") expect(item.text, item.href).toBeUndefined();
      else {
        expect(item.text?.length, item.href).toBeGreaterThan(0);
        expect(item.text, item.href).not.toMatch(/^@|https?:\/\//);
        expect(item.text, item.href).not.toMatch(/not a (real )?human|i'm (an|the) ai/i);
      }
      if (item.back !== undefined) expect(Number.isInteger(item.back) && item.back >= 0, item.href).toBe(true);
    }
    // Followers as read off the profiles, on the days they were read.
    for (const [net, points] of Object.entries(growth.followers)) {
      expect(Object.keys(network), net).toContain(net);
      for (const [d, n] of points) expect(day.test(d) && Number.isInteger(n), `${net} ${d}`).toBe(true);
    }

    // The feed is turned by growth.js; no chart stands in the section.
    expect(doc.querySelectorAll('script[type="module"][src="/growth.js"]').length).toBe(1);
    expect(doc.querySelector("#public figure, #replies .reel-nav")).toBeNull();
    // The title says how often a reply is answered, held to growth.json; no figures stand under it.
    const wrote = (growth as unknown as { wrote: { people: number; words: number } }).wrote;
    const back = (growth as unknown as { back: Record<string, [string, number][]> }).back;
    expect(doc.querySelector("#public h2 em")?.textContent).toBe(`1 in ${Math.round(wrote.words / wrote.people)} replies gets an answer.`);
    expect(doc.querySelector("#public .figures")).toBeNull();
    expect(doc.querySelector("#public .lede")).toBeNull();
    // Who wrote back, a network a band: each day in the range, and never more people than the figure says.
    expect(Object.keys(back).toSorted()).toEqual(["bluesky", "instagram", "linkedin", "threads", "tiktok", "x", "youtube"]);
    const wroteBack = Object.values(back).flat();
    expect(wroteBack.every(([d, n]) => d >= growth.from && d <= growth.updated && Number.isInteger(n) && n > 0)).toBe(true);
    expect(wroteBack.reduce((sum, [, n]) => sum + n, 0)).toBeLessThanOrEqual(wrote.people);
    // Twenty-five of them with their words, in the order they light; the note beside them says what 25 of 100 stands for.
    const said = (growth as unknown as { said: { net: string; text: string }[] }).said;
    const drawn = (growth as unknown as { drawn: { of: number; answered: number; note: string } }).drawn;
    expect([drawn.of, drawn.answered, said.length]).toEqual([100, 25, 25]);
    expect(said.every((one) => Object.keys(back).includes(one.net) && one.text && !/@|https?:/.test(one.text))).toBe(true);
    expect(drawn.note).toMatch(/146 people.*611/);
    expect(doc.querySelector("#public .growth-tab, #public .growth-legend, #public .growth-plot")).toBeNull();

    // Real replies, each a card that links to the post it answered: their words, the reply as it went out (it is in
    // growth.json), and the answer it got. The answered come first.
    const cards = [...doc.querySelectorAll("#replies .reel-track > li.card")];
    expect(cards).toHaveLength(12);
    const answered = cards.map((card) => card.classList.contains("card-answered"));
    expect(answered[0]).toBe(true);
    expect(answered).toEqual([...answered].sort((a, b) => Number(b) - Number(a)));
    for (const card of cards) {
      const link = card.querySelector("a.card-link");
      const href = link?.getAttribute("href") ?? "";
      const mine = card.querySelector(".card-mine");
      const net = /net-(\w+)/.exec(card.className)?.[1] ?? "";
      expect([link?.getAttribute("target"), link?.getAttribute("rel")]).toEqual(["_blank", "noopener"]);
      expect(card.querySelector(".card-logo use")?.getAttribute("href")).toBe(`#logo-${net}`);
      expect(growth.items.some((item) => item.net === net && item.href === href && item.text === mine?.textContent), href).toBe(true);
      for (const words of card.querySelectorAll(".card-theirs, .card-mine, .card-back > span:last-child")) {
        expect([words.getAttribute("lang"), words.getAttribute("dir")]).toEqual(["en", "ltr"]);
        expect(words.textContent?.length).toBeGreaterThan(0);
      }
      expect(card.querySelector(".card-back") !== null).toBe(card.classList.contains("card-answered"));
    }

    // The accounts it runs, at the bottom of the page; the channel the one the structured data names.
    const profiles = [...doc.querySelectorAll("footer .foot-profiles a")].map((a) => a.getAttribute("href"));
    for (const account of Object.values(growth.accounts)) expect(profiles).toContain(account);
    expect(doc.querySelector('script[type="application/ld+json"]')?.textContent).toContain(growth.accounts.youtube);
  });

  it("keeps a pause for the moving background, in the footer, which the script names and shows", () => {
    const pause = page().querySelector("footer button#pause");
    const script = readFileSync(join(PUBLIC_DIR, "atmosphere.js"), "utf8");

    expect(pause?.hasAttribute("hidden")).toBe(true);
    expect(script).toContain('document.querySelector("#pause")');
    expect(script).toContain('"Pause motion Ⅱ"');
    expect(script).toContain('new CustomEvent("motion"');
  });

  it("loads only files that are in public/, the fonts too", () => {
    const doc = page();
    const sources = [
      ...hrefs(doc, "link[href]:not([rel=canonical]):not([rel=me])"),
      ...[...doc.querySelectorAll("script[src], img[src], video[src], video source[src]")].map((s) => s.getAttribute("src") ?? ""),
      ...[...doc.querySelectorAll("video[poster]")].map((v) => v.getAttribute("poster") ?? ""),
    ];
    const local = [...new Set(sources.filter((url) => url.startsWith("/")))];

    expect(sources.filter((url) => !url.startsWith("/"))).toEqual([]);
    expect(local.toSorted()).toEqual(["/analytics.js", "/apple-touch-icon.png", "/atmosphere.css", "/favicon.ico", "/favicon.svg", "/fonts/fonts.css", "/growth.js", "/i18n/browser.css", "/i18n/browser.js", "/install.js", "/landing-art.js", "/quest.svg", "/serhii.jpg", "/site.css", "/unfold.js", "/video-poster.webp", "/video.mp4", "/watch.js"]);
    for (const url of local) expect(existsSync(join(PUBLIC_DIR, url)), url).toBe(true);
  });

  it("serves its fonts itself: every page, the faces' files and their licence, cached for a year, and Google asked for nothing", () => {
    for (const name of ["index.html", "privacy.html", "terms.html", "moved.html", "experiments.html"]) {
      const html = readFileSync(join(PUBLIC_DIR, name), "utf8");
      expect(html, name).toContain('<link rel="stylesheet" href="/fonts/fonts.css">');
      expect(html, name).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
    }
    // No preload: on a slow phone the face arrived before the first paint and made it wait for a layout in it,
    // where the fallback paints at once and the face swaps in (font-display: swap).
    for (const name of ["index.html", "privacy.html", "terms.html"]) expect(readFileSync(join(PUBLIC_DIR, name), "utf8"), name).not.toContain('rel="preload"');
    expect(readFileSync(join(PUBLIC_DIR, "fonts/fonts.css"), "utf8").match(/font-display: swap;/g)?.length).toBe(3);
    const faces = readFileSync(join(PUBLIC_DIR, "fonts/fonts.css"), "utf8");
    const files = [...faces.matchAll(/url\("([^"]+)"\)/g)].map((m) => m[1]!);
    expect(files).toEqual(["/fonts/dm-sans-latin.woff2", "/fonts/jetbrains-mono-latin.woff2", "/fonts/jetbrains-mono-cyrillic.woff2"]);
    for (const file of files) expect(readFileSync(join(PUBLIC_DIR, file)).subarray(0, 4).toString(), file).toBe("wOF2");
    expect(readFileSync(join(PUBLIC_DIR, "fonts/OFL.txt"), "utf8")).toContain("SIL OPEN FONT LICENSE Version 1.1");
    const routes: { src?: string; headers?: Record<string, string>; continue?: boolean; handle?: string }[] = JSON.parse(readFileSync(join(PUBLIC_DIR, "..", "vercel-output.json"), "utf8")).routes;
    const cached = routes.find((r) => r.src === "/fonts/(.*)");
    expect(cached?.headers?.["Cache-Control"]).toBe("public, max-age=31536000, immutable");
    expect(cached?.continue).toBe(true);
    expect(routes.indexOf(cached!)).toBeLessThan(routes.findIndex((r) => r.handle === "filesystem"));
    expect(readFileSync(join(PUBLIC_DIR, "privacy.html"), "utf8")).not.toContain("Google Fonts");
  });

  it("keeps the page's own thread free for scrolling: the weather's flow steps in a worker, and the weather starts after load", async () => {
    const art = readFileSync(join(PUBLIC_DIR, "landing-art.js"), "utf8");
    expect(art).toContain('addEventListener("load", go, { once: true })');
    // Never on a phone, with data saving on, on a small machine, or where frames already run late.
    expect(art).toContain('dataset.device === "phone"');
    expect(art).toContain("saveData");
    expect(art).toContain('import("./atmosphere.js")');
    expect(art).not.toMatch(/^import /m);
    expect(readFileSync(join(PUBLIC_DIR, "atmosphere.js"), "utf8")).toContain('new Worker(new URL("./gas-worker.js", import.meta.url), { type: "module" })');
    // The bed and its glow don't wait for the weather.
    expect(readFileSync(join(PUBLIC_DIR, "atmosphere.css"), "utf8")).toMatch(/^\.ink-bed \{[^}]*position: fixed;[^}]*radial-gradient/m);
    // The worker answers each step with the flow's picture and its numbers, as the grid would have here.
    const replies: { map: Uint8Array; dye: Uint8Array; metrics: { inputs: number; cols: number; rows: number } }[] = [];
    const scope = globalThis as unknown as { onmessage?: (event: { data: unknown }) => void; postMessage?: (data: unknown) => void };
    scope.postMessage = (data) => { replies.push(data as (typeof replies)[number]); };
    await import("../public/gas-worker.js");
    scope.onmessage!({ data: { aspect: 1.6, rows: 40 } });
    scope.onmessage!({ data: { dt: 1 / 60, inputs: [["scroll", 0.2], ["tap", 0.7, 0.5]] } });
    scope.onmessage!({ data: { dt: 1 / 60, inputs: [] } });
    delete scope.onmessage; delete scope.postMessage;
    expect(replies.length).toBe(2);
    expect(replies[1]!.metrics).toMatchObject({ inputs: 2, cols: 64, rows: 40 });
    expect(replies[1]!.map.length).toBe(64 * 40 * 4);
    expect(replies[1]!.dye.length).toBe(64 * 40 * 4);
  });

  it("paints the title screen before laying out the sections below it, then lays them out after load, one at a time", () => {
    const css = readFileSync(join(PUBLIC_DIR, "site.css"), "utf8");
    // Only where the cards' shadows can reach past their section (overflow-clip-margin); elsewhere as before.
    const deferred = css.slice(css.indexOf("@supports (overflow-clip-margin: 1px)"));
    expect(deferred).toMatch(/^@supports \(overflow-clip-margin: 1px\) \{\n  \.public, \.replies, \.faq, \.start \{ content-visibility: auto; contain-intrinsic-block-size: auto var\(--about\); overflow-clip-margin: 96px; \}/);
    const doc = page();
    expect(doc.querySelectorAll('script[type="module"][src="/unfold.js"]').length).toBe(1);
    for (const section of ["public", "replies", "faq", "start"]) expect(doc.querySelector(`main > section#${section}`), section).not.toBeNull();
    const unfold = readFileSync(join(PUBLIC_DIR, "unfold.js"), "utf8");
    expect(unfold).toContain('section.style.contentVisibility = "visible"');
    expect(unfold).toContain("requestIdleCallback");
  });
});

describe("messaging.quest for search engines, link previews and AI assistants", () => {
  const SITE = "https://www.messaging.quest";
  const meta = (doc: Document, key: string): string => doc.querySelector(`meta[property="${key}"], meta[name="${key}"]`)?.getAttribute("content") ?? "";
  const read = (name: string): string => readFileSync(join(PUBLIC_DIR, name), "utf8");
  /** A PNG's size, from its header. */
  const pngSize = (bytes: Buffer): [number, number] => [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
  const doc = (name: string): Document => {
    const window = new Window({ url: `${SITE}/` });
    return new window.DOMParser().parseFromString(read(name), "text/html") as unknown as Document;
  };

  it("names one address for each page, the one the sitemap lists", () => {
    const sitemap = [...read("sitemap.xml").matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);

    expect(sitemap).toEqual([`${SITE}/`, `${SITE}/privacy`, `${SITE}/terms`]);
    for (const [name, url] of [["index.html", `${SITE}/`], ["privacy.html", `${SITE}/privacy`], ["terms.html", `${SITE}/terms`]] as const) {
      const d = doc(name);
      expect(d.querySelector('link[rel="canonical"]')?.getAttribute("href"), name).toBe(url);
      expect(meta(d, "og:url"), name).toBe(url);
      expect(meta(d, "robots"), name).not.toContain("noindex");
    }
  });

  it("lets every crawler in, and points it to the sitemap", () => {
    const robots = read("robots.txt");

    expect(robots).toMatch(/^User-agent: \*$/m);
    expect(robots).not.toMatch(/^Disallow: *\S/m);
    expect(robots).toContain(`Sitemap: ${SITE}/sitemap.xml`);
  });

  it("describes the page as the brand assistant it is, in the static HTML crawlers read", () => {
    const d = page();
    const title = d.title;
    const description = meta(d, "description");

    expect(title).toContain("Messaging Quest");
    expect(title.toLowerCase()).toContain("brand");
    expect(description.length).toBeGreaterThan(70);
    expect(description.length).toBeLessThanOrEqual(160);
    expect(meta(d, "og:title")).toBe(title);
    expect(meta(d, "og:description")).toBe(description);
    expect(meta(d, "twitter:card")).toBe("summary_large_image");
  });

  it("shows a 1200 x 630 picture in link previews, on every page", () => {
    for (const name of ["index.html", "privacy.html", "terms.html"]) {
      const d = doc(name);
      const image = meta(d, "og:image");
      // og.png, at an address with a version (raised when the picture changes), so previews fetch it afresh.
      expect(image, name).toMatch(new RegExp(`^${SITE.replace(/\./g, "\\.")}/og\\.png\\?v=\\d+$`));
      expect(image, name).toBe(meta(doc("index.html"), "og:image"));
      expect(meta(d, "twitter:card"), name).toBe("summary_large_image");
      // X's own tags, the same as the Open Graph ones.
      expect([meta(d, "twitter:image"), meta(d, "twitter:title"), meta(d, "twitter:description")], name).toEqual([image, meta(d, "og:title"), meta(d, "og:description")]);
    }
    expect(pngSize(readFileSync(join(PUBLIC_DIR, "og.png")))).toEqual([1200, 630]);
    expect([meta(page(), "og:image:width"), meta(page(), "og:image:height")]).toEqual(["1200", "630"]);
    expect(readFileSync(join(PUBLIC_DIR, "og.png")).length).toBeLessThan(300_000);
  });

  it("gives browsers and crawlers the Visor as an icon in every size they ask for", () => {
    expect(pngSize(readFileSync(join(PUBLIC_DIR, "apple-touch-icon.png")))).toEqual([180, 180]);
    expect(pngSize(readFileSync(join(PUBLIC_DIR, "icon-512.png")))).toEqual([512, 512]);
    const ico = readFileSync(join(PUBLIC_DIR, "favicon.ico"));
    expect([ico.readUInt16LE(2), ico.readUInt16LE(4)]).toEqual([1, 2]);
    expect([ico.readUInt8(6), ico.readUInt8(22)]).toEqual([32, 48]);
  });

  it("tells search engines who makes Quest, what it does and that it starts free, in structured data", () => {
    const blocks = [...page().querySelectorAll('script[type="application/ld+json"]')].map((s) => JSON.parse(s.textContent ?? ""));
    const graph = blocks.flatMap((b) => b["@graph"] ?? [b]) as Record<string, any>[];
    const byType = (type: string) => graph.find((n) => n["@type"] === type);

    expect(graph.map((n) => n["@type"]).toSorted()).toEqual(["FAQPage", "Organization", "SoftwareApplication", "WebSite"]);
    // The questions as the page asks and answers them, word for word.
    const asked = [...page().querySelectorAll("#faq .faq-item")].map((item) => [item.querySelector("h3")?.textContent, item.querySelector("p:not(.by)")?.textContent]);
    expect(byType("FAQPage")?.mainEntity.map((q: any) => [q.name, q.acceptedAnswer.text])).toEqual(asked);
    expect(byType("WebSite")?.name).toBe("Messaging Quest");
    expect(byType("SoftwareApplication")?.offers).toMatchObject([{ name: "Free", price: "0" }, { name: "Credit packs", lowPrice: "20", highPrice: "100" }]);
    expect(byType("SoftwareApplication")?.featureList.length).toBeGreaterThanOrEqual(page().querySelectorAll("#vs tbody tr").length);
    const ours = JSON.stringify(blocks).match(/https:\/\/www\.messaging\.quest\/[\w.-]+\.(png|svg)/g) ?? [];
    expect(ours.length).toBeGreaterThan(1);
    for (const url of ours) expect(existsSync(join(PUBLIC_DIR, new URL(url).pathname)), url).toBe(true);
  });

  it("gives AI assistants a plain summary that matches the page: the networks, the start link and the price", () => {
    const llms = read("llms.txt");
    const networks = ["X", "LinkedIn", "Reddit", "Instagram", "YouTube", "TikTok", "Threads", "Facebook"];

    expect(llms.split("\n")[0]).toBe("# Messaging Quest");
    expect(llms).toMatch(/^> .{100,}/m);
    for (const name of networks) expect(llms, name).toContain(name);
    expect(llms).toContain("https://t.me/messagingquestbot?start=founder");
    expect(llms).toContain("Free ($0)");
    expect(llms).toContain("$100 gives $140");
    expect(llms).toContain("https://github.com/theic/quest");
    for (const link of llms.matchAll(/\]\((https:\/\/www\.messaging\.quest\/[^)]*)\)/g)) {
      const path = new URL(link[1] ?? "").pathname;
      expect(existsSync(join(PUBLIC_DIR, path === "/" ? "index.html" : `${path}.html`)), path).toBe(true);
    }
  });

  it("keeps the IndexNow key at the address its name gives, so Bing can check it", () => {
    const keys = readdirSync(PUBLIC_DIR).filter((name) => /^[0-9a-f]{32}\.txt$/.test(name));

    expect(keys).toHaveLength(1);
    expect(read(keys[0] ?? "")).toBe(keys[0]?.slice(0, -4));
  });
});

describe("the preview server", () => {
  const server = siteServer();
  let base = "";
  beforeAll(async () => {
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((done) => server.close(() => done())));

  it("serves the page at / and each file with its type", async () => {
    const home = await fetch(`${base}/`);
    const css = await fetch(`${base}/site.css`);

    expect(home.status).toBe(200);
    expect(home.headers.get("content-type")).toContain("text/html");
    expect(await home.text()).toContain("Your brand, <em>on autopilot.</em>");
    expect(css.headers.get("content-type")).toContain("text/css");
  });

  it("serves the extension's release zip at the address the deploy gives it", async () => {
    const res = await fetch(`${base}/${EXTENSION_ZIP}`);
    const bytes = Buffer.from(await res.arrayBuffer());

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))).toBe(true);
  });

  it("serves the video as video, and a part of it when a range is asked for, the way a player seeks", async () => {
    const whole = await fetch(`${base}/video.mp4`);
    expect(whole.headers.get("content-type")).toBe("video/mp4");
    expect(whole.headers.get("accept-ranges")).toBe("bytes");
    await whole.arrayBuffer(); // read to the end before the next request, so the two never share a connection mid-file

    const part = await fetch(`${base}/video.mp4`, { headers: { range: "bytes=0-99" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toMatch(/^bytes 0-99\/\d+$/);
    expect((await part.arrayBuffer()).byteLength).toBe(100);
  });

  it("answers 404 for a missing file, and never reads outside public/", async () => {
    expect((await fetch(`${base}/nope.html`)).status).toBe(404);
    expect((await fetch(`${base}/%2e%2e/package.json`)).status).toBe(404);
    expect(fileFor(PUBLIC_DIR, "/../package.json")).toBeNull();
    expect(fileFor(PUBLIC_DIR, "/%E0%A4%A")).toBeNull();
    expect(fileFor(PUBLIC_DIR, "/")).toBe(join(PUBLIC_DIR, "index.html"));
    expect(fileFor(PUBLIC_DIR.replaceAll("\\", "/") + "/", "/site.css")).toBe(join(PUBLIC_DIR, "site.css"));
  });

  it("serves the policies at clean addresses, and the note for the old web app's pages as a 404", async () => {
    for (const [path, heading] of [["/privacy", "Privacy policy"], ["/terms/", "Terms"]] as const) {
      const res = await fetch(`${base}${path}`);
      expect(res.status, path).toBe(200);
      expect(await res.text(), path).toContain(`<h1>${heading}</h1>`);
    }
    const old = await fetch(`${base}/login`);
    expect(old.status).toBe(404);
    expect(await old.text()).toContain("Quest lives in <em>Telegram</em> now.");
  });
});

describe("messaging.quest after the cutover", () => {
  type Route = { src?: string; dest?: string; status?: number; headers?: Record<string, string>; handle?: string };
  const routes = (JSON.parse(readFileSync(join(PUBLIC_DIR, "..", "vercel-output.json"), "utf8")) as { routes: Route[] }).routes;
  const pages = ["privacy.html", "terms.html", "moved.html"];

  it("sends nothing to the old web app, and every page a route names is in public/", () => {
    for (const r of routes) {
      expect(JSON.stringify(r)).not.toContain("messaging-quest.vercel.app");
      if (r.dest?.startsWith("/")) expect(existsSync(join(PUBLIC_DIR, r.dest)), r.dest).toBe(true);
      const location = r.headers?.["Location"];
      if (location) expect(existsSync(join(PUBLIC_DIR, `${location.split("#")[0]}.html`)), location).toBe(true);
    }
    expect(routes.at(-1)).toEqual({ src: "/(.*)", status: 404, dest: "/moved.html" });
  });

  it("passes the old emails' unsubscribe links to the agent, at the path it serves them on", () => {
    const unsubscribe = routes.find((r) => r.src === UNSUBSCRIBE_PATH);
    expect(unsubscribe?.dest).toBe(`https://mq-v2-agent.fly.dev${UNSUBSCRIBE_PATH}`);
  });

  it("names only the production bot and one address to write to, on every page", () => {
    for (const name of ["index.html", ...pages]) {
      const html = readFileSync(join(PUBLIC_DIR, name), "utf8");
      expect(html, name).not.toContain("TestPatrikBot");
      for (const bot of html.matchAll(/t\.me\/(\w+)/g)) expect(bot[1], name).toBe("messagingquestbot");
      for (const mail of html.matchAll(/mailto:([^"]+)/g)) expect(mail[1], name).toBe("hello@messaging.quest");
    }
  });
});
