import { AIMessage } from "@langchain/core/messages";
import { fakeModel } from "@langchain/core/testing";
import { ChromeError, HostGuard, TooLong, customerId, trustKey, type BrowserControl, type BrowserJob, type BrowserTransport, type BrowserView, type ChromePost } from "@mq/core";
import { describe, expect, it } from "vitest";
import { ChromeBroker } from "../src/chrome/broker.ts";
import { CustomerBrowser, browserTools, newWords, position } from "../src/chrome/browser.ts";
import { BrowserPoster } from "../src/chrome/browser-poster.ts";
import { actsAs, alreadyOn, doneOn, itemQuotes, likeTarget, quotedItem } from "../src/chrome/posted-body.ts";
import { SiteLanes } from "../src/chrome/site-lanes.ts";
import { draftFor } from "../src/drafts/draft-service.ts";
import { Outcome } from "../src/http/chrome-outcome.ts";
import { draftButtons, draftCardHtml } from "../src/telegram/draft-card.ts";
import { makeWorld, telegramSender } from "./world.ts";

const ID = customerId("customer-a");
const guard = new HostGuard({ resolve: async () => ["8.8.8.8"], unresolved: "refuse" });
const call = (name: string, args: unknown, id: string) => new AIMessage({ content: "", tool_calls: [{ name, args: args as Record<string, unknown>, id }] });
const noReddit = { post: async () => { throw new Error("Reddit's adapter must not be used"); } };
const button = (ref: string, label: string, extra: Partial<BrowserControl> = {}): BrowserControl => ({ ref, role: "button", label, value: null, href: null, ...extra });

/** An X post's page: the post, a reply under it, a Like on each; its Like reads as X's does in English unless told otherwise. */
class PostPage implements BrowserTransport {
  readonly jobs: BrowserJob[] = [];
  liked = false;
  replyLiked = false;
  readonly words: { readonly like: string; readonly liked: string };
  constructor(words = { like: "12 Likes. Like", liked: "13 Likes. Liked" }) {
    this.words = words;
  }
  async browser(_id: unknown, job: BrowserJob): Promise<BrowserView> {
    this.jobs.push(job);
    if (job.action.kind === "click" && job.action.ref === "like-post") this.liked = !this.liked;
    if (job.action.kind === "click" && job.action.ref === "like-reply") this.replyLiked = !this.replyLiked;
    return {
      url: "https://x.com/Panlytics_ai/status/2110184412830892047",
      title: "Ari on X",
      text: "Ari @Panlytics_ai Got our first 5 paying customers this week! Bob @bob congrats, what worked?",
      items: ["Ari @Panlytics_ai Got our first 5 paying customers this week!", "Bob @bob congrats, what worked?"],
      controls: [
        button("reply-post", "3 Replies. Reply", { item: 0 }),
        button("like-post", this.liked ? this.words.liked : this.words.like, { item: 0 }),
        button("like-reply", this.replyLiked ? "1 Like. Liked" : "0 Likes. Like", { item: 1 }),
      ],
    };
  }
}
const like: Extract<ChromePost, { platform: "browser" }> = { platform: "browser", kind: "like", url: "https://x.com/Panlytics_ai/status/2110184412830892047", target: "@Panlytics_ai", author: "@Panlytics_ai", quote: "Got our first 5 paying customers this week!", title: null, text: "" };

describe("a like, a follow and a profile edit, done as the customer", () => {
  it("likes the post with the quote by code, never the reply beside it, and knows it is done by its control", async () => {
    const page = new PostPage();
    const model = fakeModel();
    const poster = new BrowserPoster({ browser: new CustomerBrowser(page, guard), reddit: noReddit, models: { modelFor: () => model } });

    expect(await poster.post(ID, like)).toEqual({ url: like.url, account: "connected account" });
    expect(page.liked).toBe(true);
    expect(page.replyLiked).toBe(false);
    expect(model.calls).toHaveLength(0);
    expect(page.jobs.filter((j) => j.action.kind === "click")).toHaveLength(1);
  });

  it("never presses a like that is already on: a second press would take it off", async () => {
    const page = new PostPage();
    page.liked = true;
    const model = fakeModel().respond(call("publish", { ref: "like-post" }, "again")).respond(new AIMessage("Done."));
    const poster = new BrowserPoster({ browser: new CustomerBrowser(page, guard), reddit: noReddit, models: { modelFor: () => model } });

    expect(await poster.post(ID, like)).toEqual({ url: like.url, account: "connected account" });
    expect(page.liked).toBe(true);
    expect(page.jobs.filter((j) => j.action.kind === "click")).toEqual([]);
  });

  it("follows the person it was asked to, not another on the page", async () => {
    class Profile implements BrowserTransport {
      following = new Set<string>();
      async browser(_id: unknown, job: BrowserJob): Promise<BrowserView> {
        if (job.action.kind === "click") this.following.add(job.action.ref);
        const follow = (who: string) => button(who, this.following.has(who) ? `Following @${who}` : `Follow @${who}`);
        return { url: "https://x.com/Panlytics_ai", title: "Ari (@Panlytics_ai) / X", text: "Ari @Panlytics_ai Building Panlytics. Who to follow Bob @bob", controls: [follow("bob"), follow("Panlytics_ai")] };
      }
    }
    const page = new Profile();
    const model = fakeModel().respond(call("publish", { ref: "bob" }, "wrong")).respond(call("publish", { ref: "Panlytics_ai" }, "right")).respond(new AIMessage("Following."));
    const poster = new BrowserPoster({ browser: new CustomerBrowser(page, guard), reddit: noReddit, models: { modelFor: () => model } });
    const follow = { ...like, kind: "follow", url: "https://x.com/Panlytics_ai", quote: null } as const;

    expect(await poster.post(ID, follow)).toMatchObject({ url: "https://x.com/Panlytics_ai" });
    expect([...page.following]).toEqual(["Panlytics_ai"]);
  });

  it("changes their bio and knows it saved when their profile shows the new words", async () => {
    // Live, 2026-10-15: asked many times to update the founder's X bio, Quest never managed it.
    const BIO = "Building Voca Vela: a voice tutor for 39 languages. 41 tried it, 0 paying yet. Building in public.";
    class EditProfile implements BrowserTransport {
      bio = "Founder.";
      typed = "";
      saved = false;
      async browser(_id: unknown, job: BrowserJob): Promise<BrowserView> {
        if (job.action.kind === "fill") this.typed = job.action.text;
        if (job.action.kind === "click" && job.action.ref === "save") { this.bio = this.typed; this.saved = true; }
        if (this.saved) return { url: "https://x.com/theIcreator", title: "Serhii (@theIcreator) / X", text: `Serhii @theIcreator ${this.bio} Joined 2019`, controls: [button("edit", "Edit profile")] };
        return {
          url: "https://x.com/settings/profile",
          title: "Edit profile / X",
          text: `Serhii @theIcreator Founder. Edit profile`,
          controls: [{ ref: "bio", role: "textbox", label: "Bio", value: this.typed || this.bio, href: null, limit: 160 }, button("save", "Save")],
        };
      }
    }
    const page = new EditProfile();
    const model = fakeModel().respond(call("prepare", { kind: "fill", ref: "bio", text: BIO }, "fill")).respond(call("publish", { ref: "save" }, "save")).respond(new AIMessage("Saved."));
    const poster = new BrowserPoster({ browser: new CustomerBrowser(page, guard), reddit: noReddit, models: { modelFor: () => model } });

    expect(await poster.post(ID, { platform: "browser", kind: "profile", url: "https://x.com/settings/profile", target: "bio", title: null, text: BIO })).toEqual({ url: "https://x.com/theIcreator", account: "connected account" });
    expect(page.bio).toBe(BIO);
  });

  it("stops at once when the extension says the words are too long for their field", async () => {
    // The bug behind the failed bio: the field's limit never reached the poster, so it went round prepare until its
    // steps ran out. The extension's own refusal says the numbers: that is enough to stop.
    class Refusing implements BrowserTransport {
      async browser(_id: unknown, job: BrowserJob): Promise<BrowserView> {
        if (job.action.kind === "fill") throw new ChromeError("refused", "This field takes at most 160 characters, and the words have 174. Nothing was typed.");
        return { url: "https://x.com/settings/profile", title: "Edit profile / X", text: "Edit profile", controls: [{ ref: "bio", role: "textbox", label: "Bio", value: "", href: null }, button("save", "Save")] };
      }
    }
    const text = "x".repeat(174);
    const model = fakeModel().respond(call("prepare", { kind: "fill", ref: "bio", text }, "fill")).respond(call("prepare", { kind: "fill", ref: "bio", text }, "again")).respond(new AIMessage("No."));
    const poster = new BrowserPoster({ browser: new CustomerBrowser(new Refusing(), guard), reddit: noReddit, models: { modelFor: () => model } });

    const failed = poster.post(ID, { platform: "browser", kind: "profile", url: "https://x.com/settings/profile", target: "bio", title: null, text });
    await expect(failed).rejects.toBeInstanceOf(TooLong);
    await expect(failed).rejects.toMatchObject({ limit: 160, length: 174 });
    expect(model.calls).toHaveLength(1);
  });

  it("keeps every field of the extension's answer the agent uses: a field's limit, a toggle's state, which post a control is in", () => {
    const parsed = Outcome.parse({
      ok: true,
      view: {
        url: "https://x.com/settings/profile",
        title: "Edit profile",
        text: "Bio",
        controls: [{ ref: "0:a:1", role: "textbox", label: "Bio", value: "", href: null, limit: 160 }, { ref: "0:a:2", role: "button", label: "12 Likes. Like", value: null, href: null, pressed: false, item: 0 }],
        items: ["Ari: first 5 customers"],
        scroll: { y: 0, height: 4000, viewport: 800 },
        loading: false,
      },
    });
    expect(parsed).toMatchObject({ view: { controls: [{ limit: 160 }, { pressed: false, item: 0 }], items: ["Ari: first 5 customers"], scroll: { y: 0, height: 4000, viewport: 800 }, loading: false } });
  });

  it("knows a like or a follow done by the words or the state of its control", () => {
    expect(doneOn({ label: "13 Likes. Liked" }, "like")).toBe(true);
    expect(doneOn({ label: "12 Likes. Like" }, "like")).toBe(false);
    expect(doneOn({ label: "React Like", pressed: true }, "like")).toBe(true);
    // LinkedIn's new layout, as its activity page read live on 2026-11-04.
    expect(actsAs({ label: "Reaction button state: no reaction" }, "like")).toBe(true);
    expect(doneOn({ label: "Reaction button state: no reaction" }, "like")).toBe(false);
    expect(doneOn({ label: "Reaction button state: like" }, "like")).toBe(true);
    expect(actsAs({ label: "Reactions" }, "like")).toBe(false);
    expect(doneOn({ label: "upvote", pressed: false }, "like")).toBe(false);
    expect(doneOn({ label: "Unfollow @ari" }, "follow")).toBe(true);
    expect(doneOn({ label: "Follow @ari" }, "follow")).toBe(false);
    expect(itemQuotes("Ari @Panlytics_ai Got our first 5 paying customers this week!", "our first 5 paying customers")).toBe(true);
    expect(itemQuotes("Bob @bob congrats, what worked?", "our first 5 paying customers")).toBe(false);
  });

  it("finds a LinkedIn post by its quote when the item's start is all header", () => {
    // As read live, 2026-11-05: one author's posts, the same header, the post's words from character 186.
    const head = "Feed post Jean-Luc Rominger • 3rd+ VP of Engineering | Scale-up & Leading High-Performance Engineering Teams | Supply Chain Expert & in love with continuous improvement";
    const posts = ["4h Follow 57,500 lines of specification later, the product finally works.", "2w Follow Hiring two engineers this month."];
    const items = posts.map((p) => `${head} ${p}`.slice(0, 200));
    const text = posts.map((p) => `${head} ${p} Like Comment Repost`).join(" ");
    expect(itemQuotes(items[0], "57,500 lines of specification later")).toBe(false);
    expect(quotedItem({ items, text }, "57,500 lines of specification later")).toBe(0);
    expect(quotedItem({ items, text }, "Hiring two engineers this month")).toBe(1);
    expect(quotedItem({ items, text }, "not on the page at all, anywhere")).toBe(-1);
  });

  it("takes a like quoting a reply with no Like of its own, on the post's own page, as the post's", () => {
    // As Threads showed it live, 2026-11-05: the thread's post, liked already, and heyfabee_'s answer with no Like drawn.
    const url = "https://www.threads.com/@heyfabee_/post/DfXTfAeGngV";
    const view = {
      url,
      items: ["heyfabee_ 4h Finally shipped the pigeon game", "heyfabee_ 1h You got good eyes 😂"],
      controls: [button("like-post", "Unlike 3", { item: 0 })],
    };
    const post = { quote: "You got good eyes", target: "heyfabee_", url };
    expect(likeTarget(view, post)).toBe(0);
    expect(alreadyOn(view, post, "like")).toBe(true);
    // In a feed the quote's own post is still the only one.
    expect(likeTarget({ ...view, url: "https://www.threads.com/" }, post)).toBe(1);
  });

  it("knows them on X in Ukrainian, as its controls read there", () => {
    expect(actsAs({ label: "17 Уподобань. Уподобання" }, "like")).toBe(true);
    expect(doneOn({ label: "17 Уподобань. Уподобання" }, "like")).toBe(false);
    expect(doneOn({ label: "18 Уподобують. Уподобали" }, "like")).toBe(true);
    expect(actsAs({ label: "3 Відповідей. Відповідь" }, "like")).toBe(false);
    expect(actsAs({ label: "Читати @makerthree" }, "follow")).toBe(true);
    expect(doneOn({ label: "Читати @makerthree" }, "follow")).toBe(false);
    expect(doneOn({ label: "Підписки @makerthree" }, "follow")).toBe(true);
    expect(doneOn({ label: "Не читати @makerthree" }, "follow")).toBe(true);
    // "Читати" is also "read": only alone or before a handle is it a Follow.
    expect(actsAs({ label: "Читати далі" }, "follow")).toBe(false);
  });

  it("likes a post on X in Ukrainian by code, as its controls read there", async () => {
    const page = new PostPage({ like: "12 Уподобань. Уподобання", liked: "13 Уподобують. Уподобали" });
    const model = fakeModel();
    const poster = new BrowserPoster({ browser: new CustomerBrowser(page, guard), reddit: noReddit, models: { modelFor: () => model } });

    expect(await poster.post(ID, like)).toEqual({ url: like.url, account: "connected account" });
    expect(page.liked).toBe(true);
    expect(model.calls).toHaveLength(0);
    expect(page.jobs.filter((j) => j.action.kind === "click")).toHaveLength(1);
  });
});

describe("drafts that put no words anywhere", () => {
  it("make a like card with its post's words, Like it and Skip, counted apart from posts and trusted apart", async () => {
    const world = makeWorld();
    const c = await world.customers.create({ channel: telegramSender().channel, userRef: "42", displayName: "Dana", language: "en" });
    expect(draftFor(c.id, { platform: "browser", kind: "like", url: like.url, target: "@Panlytics_ai", text: "" })).toBe("A like needs a short quote of the post it likes, exactly as you read it.");
    const offered = await world.drafts.offer(c.id, { platform: "browser", kind: "like", url: like.url, target: "@Panlytics_ai", author: "Panlytics_ai", quote: like.quote, text: "ignored" });
    if (typeof offered === "string") throw new Error(offered);
    expect(offered.draft).toMatchObject({ kind: "like", platform: "x.com", text: "", author: "@Panlytics_ai" });
    expect(draftButtons(offered.draft).flat().map((b) => b.text)).toEqual(["Like it", "Skip"]);
    expect(draftCardHtml(offered.draft)).toContain("<b>Like on x.com</b> · @Panlytics_ai");
    expect(trustKey("x.com", "like")).toBe("x.com likes");

    await world.drafts.act(c.id, offered.draft.id, "post");
    await world.errands.stop();
    expect(world.poster.posts.at(-1)?.post).toMatchObject({ platform: "browser", kind: "like", quote: like.quote });
    const done = await world.draftStore.get(offered.draft.id);
    expect(done?.status).toBe("posted");
    expect(draftCardHtml(done!)).toContain("Liked");
    expect(await world.trust.approved(c.id, "x.com likes")).toBe(1);
    expect(await world.trust.approved(c.id, "x.com")).toBe(0);
    expect(await world.drafts.offer(c.id, { platform: "browser", kind: "like", url: like.url, target: "@Panlytics_ai", quote: like.quote, text: "" })).toContain("Already done");
  });

  it("go through the page on Reddit too, where Reddit's own forms take only words", () => {
    const upvote = draftFor(ID, { platform: "browser", kind: "like", url: "https://www.reddit.com/r/SaaS/comments/abc/first_customers/", target: "u/dana", quote: "How did you get your first customers?", text: "" });
    expect(upvote).toMatchObject({ platform: "reddit", kind: "like" });
    expect(draftFor(ID, { platform: "browser", kind: "reply", url: "https://www.reddit.com/r/SaaS/comments/abc/x/", target: "u/dana", quote: "q", text: "hi" })).toContain("Use the Reddit draft fields");
  });

  it("are refused while browsing: a like only happens as a recorded draft", async () => {
    const page = new PostPage();
    const tools = Object.fromEntries(browserTools(new CustomerBrowser(page, guard), ID).map((t) => [t.name, t]));
    await tools["browser_open"]!.invoke({ url: like.url });
    expect(await tools["browser_act"]!.invoke({ kind: "click", ref: "like-post" })).toContain("kind like or follow");
    expect(page.liked).toBe(false);
  });
});

describe("one at a time on a site", () => {
  it("runs what acts as them in the order it asked, across their sites too", async () => {
    const lanes = new SiteLanes();
    const order: string[] = [];
    const waits: (string | null)[] = [];
    let release!: () => void;
    let started!: () => void;
    const begun = new Promise<void>((r) => (started = r));
    const first = lanes.run(ID, "x.com", "post:1", async () => { order.push("x1 start"); started(); await new Promise<void>((r) => (release = r)); order.push("x1 end"); });
    const second = lanes.run(ID, "x.com", "post:2", async () => void order.push("x2"), (s) => waits.push(s));
    const elsewhere = lanes.run(ID, "linkedin.com", "post:3", async () => void order.push("linkedin"));
    await begun;
    expect(lanes.view(ID)).toEqual([{ site: "x.com", holder: "post:1", waiting: ["post:2", "post:3"] }]);
    release();
    await Promise.all([first, second, elsewhere]);
    expect(order).toEqual(["x1 start", "x1 end", "x2", "linkedin"]);
    expect(waits).toEqual(["x.com", null]);
    expect(lanes.view(ID)).toEqual([]);
  });

  it("starts a task kept to a site only once the one working there is done", async () => {
    const world = makeWorld();
    const c = await world.customers.create({ channel: telegramSender().channel, userRef: "42", displayName: "Dana", language: "en" });
    const a = await world.tasks.start(c.id, "outreach", "Replies on X", "Reply on X.", "x.com");
    const b = await world.tasks.start(c.id, "outreach", "Likes on X", "Like on X.", "x.com");
    const other = await world.tasks.start(c.id, "researcher", "Read the site", "Read it.");
    world.clock.advance(1);
    const one = await world.taskStore.claim("w", 60_000, 5);
    const two = await world.taskStore.claim("w", 60_000, 5);
    const three = await world.taskStore.claim("w", 60_000, 5);
    expect([one?.task.id, two?.task.id, three]).toEqual([a.id, other.id, null]);
    await world.taskStore.finish(a.id, "w", { status: "succeeded", result: "done" });
    expect((await world.taskStore.claim("w", 60_000, 5))?.task.id).toBe(b.id);
  });

  it("hands the extension posts first, then sessions' steps in the order they asked, then reading", async () => {
    // No site pauses here: the order by kind is what this is about (each site's pace has its own tests in chrome.test.ts).
    const broker = new ChromeBroker({ onlineWindowMs: 45_000, jobTimeoutMs: 90_000, queueTimeoutMs: 120_000, frontHoldMs: 0 }, Date.now, { pace: () => null });
    await broker.next(ID, 1).catch(() => null);
    const read = broker.read(ID, { url: "https://example.org/a", take: {} });
    const stepA = broker.browser(ID, { session: "a", url: "https://x.com/a", action: { kind: "snapshot" } });
    const stepB = broker.browser(ID, { session: "b", url: "https://x.com/b", action: { kind: "snapshot" } });
    const post = broker.post(ID, { platform: "reddit", url: "https://www.reddit.com/r/x/comments/1/t/", parent: "t3_1", text: "hi" });
    expect(broker.view(ID)).toMatchObject({ online: true, doing: null, waiting: 4 });
    const kinds: string[] = [];
    for (let i = 0; i < 4; i++) {
      const job = (await broker.next(ID, 1))!;
      kinds.push(job.kind === "browser" ? `browser:${job.browser.session}` : job.kind ?? "read");
      broker.complete(ID, job.id, { ok: false, reason: "refused", message: "test" });
    }
    expect(kinds).toEqual(["post", "browser:a", "browser:b", "read"]);
    await Promise.allSettled([read, stepA, stepB, post]);
  });
});

describe("working a page", () => {
  /** A feed that draws more as it is scrolled, and a post list that comes in late. */
  class Feed implements BrowserTransport {
    at = 0;
    looks = 0;
    clicks = 0;
    readonly posts = Array.from({ length: 12 }, (_, i) => `Post number ${i + 1} about getting the first customers for a small product.`);
    async browser(_id: unknown, job: BrowserJob): Promise<BrowserView> {
      this.looks++;
      if (job.action.kind === "scroll") this.at = Math.min(this.at + 4, 8);
      if (job.action.kind === "click") this.clicks++;
      const shown = this.posts.slice(Math.max(0, this.at - 1), this.at + 4);
      const late = this.looks < 3 ? "" : " Replies (12)";
      return {
        url: "https://x.com/search?q=first+customers",
        title: "Search / X",
        text: shown.join(" ") + late,
        controls: [button("dead", "Show more"), { ref: "next", role: "a", label: "Next", value: null, href: "https://x.com/next" }],
        scroll: { y: this.at * 200, height: 1600 + 800, viewport: 800 },
      };
    }
  }
  const tools = (feed: Feed) => Object.fromEntries(browserTools(new CustomerBrowser(feed, guard, undefined, { sleep: async () => undefined }), ID).map((t) => [t.name, t]));

  it("scrolls several screens of a feed in one step, with every new word on the way, and says where it is", async () => {
    const feed = new Feed();
    const t = tools(feed);
    await t["browser_open"]!.invoke({ url: "https://x.com/search?q=first+customers" });
    const read = JSON.parse(await t["browser_act"]!.invoke({ kind: "scroll", direction: "down", pages: 3 }));
    // What the screen before showed, the last result had; what comes after, this one has, each word once.
    for (const n of [4, 8, 12]) expect(read.text).toContain(`Post number ${n} `);
    expect(read.text.split("Post number 8 ").length).toBe(2);
    expect(read.position).toBe("end of the page");
    expect(read.note).toBe("This is the end of the page: nothing more loads below.");
    expect(position({ scroll: { y: 400, height: 2400, viewport: 800 } })).toBe("25% down, more below");
    expect(newWords("one two three ".repeat(10), `${"one two three ".repeat(10)}four five six seven eight nine ten`)).toContain("four five six");
  });

  it("waits for words that come in late, and says when a click changed nothing", async () => {
    const feed = new Feed();
    const t = tools(feed);
    await t["browser_open"]!.invoke({ url: "https://x.com/search?q=first+customers" });
    const waited = JSON.parse(await t["browser_act"]!.invoke({ kind: "wait", text: "Replies", seconds: 5 }));
    expect(waited.text).toContain("Replies (12)");
    expect(waited.note).toBeUndefined();
    const dead = JSON.parse(await t["browser_act"]!.invoke({ kind: "click", ref: "dead" }));
    expect(feed.clicks).toBe(1);
    expect(dead.note).toContain("Nothing on the page changed after that");
  });

  it("brings the page back with fresh refs when a control went stale", async () => {
    class Changing extends Feed {
      override async browser(id: unknown, job: BrowserJob): Promise<BrowserView> {
        if (job.action.kind === "click") throw new ChromeError("refused", "The page changed. Inspect it again before acting.");
        return super.browser(id, job);
      }
    }
    const t = tools(new Changing());
    await t["browser_open"]!.invoke({ url: "https://x.com/search?q=first+customers" });
    const fresh = JSON.parse(await t["browser_act"]!.invoke({ kind: "click", ref: "dead" }));
    expect(fresh.note).toContain("That control was stale");
    expect(fresh.controls).toHaveLength(2);
  });

  it("knows a YouTube channel subscribed to by its bell", () => {
    const bell = { ref: "1", role: "button", label: "Current setting is personalized notifications. Tap to change your notification setting for ZazaG Dev", value: "" };
    const view = { url: "https://www.youtube.com/@ZazaGDev", controls: [bell], items: [] } as never;
    expect(alreadyOn(view, { target: "@ZazaGDev" }, "follow")).toBe(true);
    expect(alreadyOn(view, { target: "@someoneelse" }, "follow")).toBe(false);
  });
});

describe("one thing in front of their window", () => {
  it("keeps the front with the session at work: another session's step waits for its hold, plain reading goes on", async () => {
    let now = 1_000_000;
    const broker = new ChromeBroker({ onlineWindowMs: 45_000, jobTimeoutMs: 90_000, queueTimeoutMs: 120_000 }, () => now, { pace: () => null });
    await broker.next(ID, 1).catch(() => null);
    const a1 = broker.browser(ID, { session: "a", url: "https://x.com/a", action: { kind: "snapshot" } });
    const b1 = broker.browser(ID, { session: "b", url: "https://www.instagram.com/b", action: { kind: "snapshot" } });
    const drawn = broker.read(ID, { url: "https://x.com/notifications", take: {}, drawn: true });
    const read = broker.read(ID, { url: "https://example.org/a", take: {} });
    const view = { ok: true as const, view: { url: "https://x.com/a", title: "", text: "", controls: [] } };
    const first = (await broker.next(ID, 1, undefined, "0"))!;
    expect(first.kind === "browser" && first.browser.session).toBe("a");
    // While a's step is in their Chrome, only the background read is handed out.
    const second = (await broker.next(ID, 1, undefined, "1"))!;
    expect(second.kind).toBeUndefined();
    expect(await broker.next(ID, 1, undefined, "2")).toBeNull();
    broker.complete(ID, first.id, view);
    // Between a's steps the front is still a's: b and the drawn read wait, a's next step goes at once.
    expect(await broker.next(ID, 1, undefined, "2")).toBeNull();
    const a2 = broker.browser(ID, { session: "a", action: { kind: "snapshot" } });
    const third = (await broker.next(ID, 1, undefined, "2"))!;
    expect(third.kind === "browser" && third.browser.session).toBe("a");
    broker.complete(ID, third.id, view);
    // a closes: the front is free at once.
    const closed = broker.browser(ID, { session: "a", action: { kind: "close" } });
    const fourth = (await broker.next(ID, 1, undefined, "2"))!;
    broker.complete(ID, fourth.id, view);
    const fifth = (await broker.next(ID, 1, undefined, "2"))!;
    expect(fifth.kind === "browser" && fifth.browser.session).toBe("b");
    broker.complete(ID, fifth.id, view);
    // b never closed: its hold lapses, and the drawn read gets the front.
    expect(await broker.next(ID, 1, undefined, "2")).toBeNull();
    now += 41_000;
    const sixth = (await broker.next(ID, 1, undefined, "2"))!;
    expect(sixth.kind).toBeUndefined();
    broker.complete(ID, sixth.id, { ok: false, reason: "refused", message: "test" });
    broker.complete(ID, second.id, { ok: false, reason: "refused", message: "test" });
    await Promise.allSettled([a1, b1, a2, closed, drawn, read]);
  });
});
