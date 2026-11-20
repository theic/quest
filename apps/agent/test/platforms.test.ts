import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Draft } from "@mq/core";
import { browserTools, BROWSING } from "../src/chrome/browser.ts";
import { dayLimit, limitsPage } from "../src/drafts/day-limits.ts";
import { writingTells } from "../src/drafts/tells.ts";
import { writingPrompt } from "../src/drafts/writer.ts";
import { glassRoutes } from "../src/http/glass-routes.ts";
import type { PgGlass } from "../src/infra/pg-glass.ts";
import { silentLogger } from "../src/infra/system.ts";
import { limitKind, OTHER_SITE, platformGuide, platformOf, PLATFORMS } from "../src/platforms.ts";
import { siteBriefing } from "../src/tasks/site-pin.ts";
import { makeWorld, telegramSender } from "./world.ts";

type Sent = Pick<Draft, "kind" | "platform" | "url">;
const sent = (kind: Draft["kind"], platform: string, n: number): Sent[] => Array.from({ length: n }, () => ({ kind, platform, url: `https://${platform}/` }));

describe("what Quest knows about a platform", () => {
  it("knows a platform by its key, any of its hosts or an address on it", () => {
    expect(platformOf("reddit")?.key).toBe("reddit");
    expect(platformOf("https://old.reddit.com/r/SaaS/")?.key).toBe("reddit");
    expect(platformOf("twitter.com")?.key).toBe("x");
    expect(platformOf("https://www.linkedin.com/in/me/")?.key).toBe("linkedin");
    expect(platformOf("mail.google.com")?.key).toBe("email");
    expect(platformOf("https://studio.youtube.com/channel/x")?.key).toBe("youtube");
    expect(platformOf("threads.com")?.key).toBe("threads");
    expect(platformOf("habr.com")).toBeNull();
    expect(platformOf("")).toBeNull();
  });

  it("writes every platform down whole: where things are, its rules, how words read, and limits a person keeps", () => {
    for (const p of PLATFORMS) {
      expect(p.where && p.rules && p.writing, p.key).toBeTruthy();
      expect(platformGuide(p)).toContain(`ABOUT ${p.name.toUpperCase()}`);
      for (const n of Object.values(p.limits)) expect(n >= 0 && n <= 100, p.key).toBe(true);
      // No dashes as punctuation in standing text the writer and the team read.
      expect(`${p.where}${p.rules}${p.writing}`, p.key).not.toMatch(/[—–]/);
    }
    expect(new Set(PLATFORMS.map((p) => p.key)).size).toBe(PLATFORMS.length);
    expect(BROWSING).toContain("x.com/settings/profile");
    expect(BROWSING).toContain("linkedin.com/in/me/");
  });

  it("gives a pinned task its site's rules, and the writer how words read there", () => {
    expect(siteBriefing("linkedin.com")).toContain("ABOUT LINKEDIN");
    expect(siteBriefing("linkedin.com")).toContain("first comment");
    expect(siteBriefing("example.org")).not.toContain("ABOUT");
    const prompt = writingPrompt({ kind: "reply", platform: "x.com", place: null, author: null, quote: null, draft: "Hi", title: null });
    expect(prompt).toContain("How words read on X: 280 characters a post");
  });

  it("brings a site's rules with its first page in a run, once", async () => {
    const view = { url: "https://x.com/home", title: "Home", text: "Home", controls: [] };
    const browser = { open: async () => view, navigate: async () => view, act: async () => view, close: async () => undefined, readVisual: async () => view, free: async () => undefined } as never;
    const [open] = browserTools(browser, "c1" as never);
    const first = JSON.parse(String(await open!.invoke({ url: "https://x.com/home" }))) as { site?: string };
    expect(first.site).toContain("ABOUT X");
    expect(first.site).toContain("automation rules");
    const again = JSON.parse(String(await open!.invoke({ url: "https://x.com/home" }))) as { site?: string };
    expect(again.site).toBeUndefined();
  });
});

describe("day limits", () => {
  it("count new posts, messages, likes and follows, and profile changes on each platform apart, and never replies", () => {
    expect(limitKind("reply")).toBeNull();
    expect(dayLimit({ kind: "reply", platform: "reddit", url: "https://reddit.com/" }, sent("reply", "reddit", 200))).toBeNull();

    const reddit = PLATFORMS.find((p) => p.key === "reddit")!.limits.posts;
    expect(dayLimit({ kind: "post", platform: "reddit", url: "https://www.reddit.com/r/SaaS/" }, sent("post", "reddit", reddit - 1))).toBeNull();
    expect(dayLimit({ kind: "post", platform: "reddit", url: "https://www.reddit.com/r/SaaS/" }, sent("post", "reddit", reddit))).toBe(
      `That's ${reddit} posts on Reddit today, its limit. Post this one yourself, or tap again tomorrow`,
    );
    // Reddit's posts are full; a post on X and a message on Reddit are not.
    expect(dayLimit({ kind: "post", platform: "x.com", url: "https://x.com/compose/post" }, sent("post", "reddit", reddit))).toBeNull();
    expect(dayLimit({ kind: "message", platform: "reddit", url: "https://www.reddit.com/message/compose/" }, sent("post", "reddit", reddit))).toBeNull();

    const linkedin = PLATFORMS.find((p) => p.key === "linkedin")!.limits.posts;
    expect(dayLimit({ kind: "post", platform: "linkedin.com", url: "https://www.linkedin.com/feed/" }, sent("post", "linkedin.com", linkedin))).toBe(
      "That's 2 posts on LinkedIn today, its limit. Post this one yourself, or tap again tomorrow",
    );
    const x = PLATFORMS.find((p) => p.key === "x")!.limits.actions;
    expect(dayLimit({ kind: "like", platform: "x.com", url: "https://x.com/a/status/1" }, [...sent("like", "x.com", x - 1), ...sent("follow", "x.com", 1)])).toBe(
      `That's ${x} likes and follows on X today, its limit. Tap again tomorrow`,
    );
    expect(dayLimit({ kind: "message", platform: "youtube.com", url: "https://www.youtube.com/" }, [])).toBe("Quest does no messages on YouTube");
    expect(dayLimit({ kind: "post", platform: "habr.com", url: "https://habr.com/" }, sent("post", "habr.com", OTHER_SITE.limits.posts))).toBe(
      `That's ${OTHER_SITE.limits.posts} posts on Other sites today, its limit. Post this one yourself, or tap again tomorrow`,
    );
  });

  it("lists the common platforms first, then the ones they picked or posted on, with what went up today", () => {
    const page = limitsPage([...sent("post", "x.com", 2), ...sent("message", "mail.google.com", 3), ...sent("post", "bsky.app", 1)], ["hackernews"]);
    expect(page.map((p) => p.key)).toEqual(["reddit", "x", "linkedin", "instagram", "facebook", "threads", "tiktok", "youtube", "email", "hackernews", "bluesky", "other"]);
    expect(page.find((p) => p.key === "x")?.used).toEqual({ posts: 2, messages: 0, actions: 0, profile: 0 });
    expect(page.find((p) => p.key === "email")?.used.messages).toBe(3);
  });
});

describe("how they write, held", () => {
  it("takes an exclamation mark out when they never use one", () => {
    expect(writingTells("that fixed it!", { kind: "reply", platform: "reddit", exclaim: false })).toContain("it has an exclamation mark, and they never use them: none");
    expect(writingTells("that fixed it!", { kind: "reply", platform: "reddit" })).toEqual([]);
  });
});

describe("their page's Settings", () => {
  it("shows each platform's day limits and how they write", async () => {
    const world = makeWorld();
    const c = await world.customers.create({ channel: telegramSender().channel, userRef: "42", displayName: "Dana", language: "en" });
    await world.customers.update(c.id, { activatedAt: new Date() });
    const at = world.clock.now();
    for (const [key, choice, answer] of [["where", "linkedin", "LinkedIn"]] as const) {
      await world.customers.profileAsked(c.id, key, null, at);
      await world.customers.profileAnswered(c.id, key, { choice, answer, at });
    }
    const glass = { snapshot: async () => ({ trust: [], sentToday: [{ kind: "post", platform: "linkedin.com", url: "https://www.linkedin.com/feed/" }] }) } as unknown as PgGlass;
    const now = Date.now();
    const app = glassRoutes({ botToken: TOKEN, customers: world.customers, glass, chrome: { status: async () => ({ online: true, linked: true, device: "Chrome", lastSeenAt: null }) } as never, log: silentLogger, now: () => now });
    const initData = signed({ auth_date: String(Math.floor(now / 1000) - 60), user: JSON.stringify({ id: 42, first_name: "Dana" }) });
    const res = await app.request("/glass/data", { method: "POST", body: JSON.stringify({ initData }), headers: { "content-type": "application/json" } });
    const data = (await res.json()) as { limits: { key: string; used: { posts: number }; limits: { posts: number } }[] };
    expect(data.limits.find((p) => p.key === "linkedin")).toMatchObject({ used: { posts: 1 }, limits: { posts: 2 } });
  });
});

const TOKEN = "123456:test-token-not-a-real-one";
function signed(fields: Record<string, string>, token = TOKEN): string {
  const check = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  return new URLSearchParams({ ...fields, hash: createHmac("sha256", secret).update(check).digest("hex") }).toString();
}
