import { AIMessage } from "@langchain/core/messages";
import { fakeModel } from "@langchain/core/testing";
import { customerId, HostGuard, type BrowserJob, type BrowserTransport, type BrowserView, type ChromePost, type Logger, type NewFind } from "@mq/core";
import { describe, expect, it } from "vitest";
import { ChromeBroker } from "../src/chrome/broker.ts";
import { CustomerBrowser } from "../src/chrome/browser.ts";
import { BrowserPoster } from "../src/chrome/browser-poster.ts";
import { Errands } from "../src/lifecycle/errands.ts";
import { draftButtons, draftCardHtml } from "../src/telegram/draft-card.ts";
import { findButtons } from "../src/telegram/find-card.ts";
import { makeWorld, telegramSender } from "./world.ts";

// Each card its own message (`cards`), as before Your move (asks/deck.ts): cards already in a chat still work so.

type World = ReturnType<typeof makeWorld>;

const ID = customerId("11111111-1111-4111-8111-111111111111");
const BODY = "I build a form tool that keeps your intake simple.";
const SHORT = { finishMs: 20, stopMs: 200 };

/** What the errands said about themselves. */
function recording(): Logger & { readonly events: string[] } {
  const events: string[] = [];
  return { events, info: (e) => events.push(e), warn: (e) => events.push(e), error: (e) => events.push(e) };
}

const customerIn = (world: World) => world.customers.create({ channel: telegramSender().channel, userRef: "42", displayName: "Dana", language: "en" });

const reply = { platform: "browser", kind: "reply", url: "https://x.com/rdominguezibar/status/2095574318272954478", target: "https://x.com/rdominguezibar/status/2095574318272954478", title: null, quote: "Which form tool do you use for your waitlist?", text: BODY } as const;

describe("errands when the agent stops", () => {
  it("lets work that finishes in time finish", async () => {
    const errands = new Errands(recording(), SHORT);
    let done = false;
    errands.run("quick", async () => {
      await new Promise((r) => setTimeout(r, 5));
      done = true;
    });
    await errands.stop();
    expect(done).toBe(true);
  });

  it("stops what is still running when its time is up, and waits for it to give its claim back", async () => {
    const log = recording();
    const errands = new Errands(log, SHORT);
    let released = false;
    errands.run("post:1", (stop) => new Promise<void>((resolve) => stop.addEventListener("abort", () => {
      released = true;
      resolve();
    })));
    await errands.stop();
    expect(released).toBe(true);
    expect(errands.busy).toBe(false);
    expect(log.events).toEqual(["errand.stopping"]);
  });

  it("gives up on work that ignores the stop, so the rest of the shutdown still runs", async () => {
    const log = recording();
    const errands = new Errands(log, SHORT);
    errands.run("post:1", () => new Promise<void>(() => undefined));
    const started = Date.now();
    await errands.stop();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(log.events).toEqual(["errand.stopping", "errand.left_running"]);
  });
});

describe("a post job in the Chrome broker, stopped", () => {
  const post: ChromePost = { platform: "reddit", url: "https://www.reddit.com/r/SaaS/comments/abc1/x/", parent: "t1_c1", text: BODY };

  it("is taken back while it waits for the Chrome, and nothing is handed to it", async () => {
    const broker = new ChromeBroker();
    expect(await broker.next(ID, 0)).toBeNull(); // the Chrome was here a moment ago
    const stop = new AbortController();
    const posting = broker.post(ID, post, stop.signal);
    stop.abort();
    await expect(posting).rejects.toMatchObject({ reason: "unavailable" });
    expect(await broker.next(ID, 0)).toBeNull();
  });

  it("may have gone up once the Chrome took it", async () => {
    const broker = new ChromeBroker();
    const poll = broker.next(ID, 1_000);
    const stop = new AbortController();
    const posting = broker.post(ID, post, stop.signal);
    const job = await poll;
    expect(job).toMatchObject({ kind: "post" });
    stop.abort();
    await expect(posting).rejects.toMatchObject({ reason: "uncertain" });
    expect(broker.complete(ID, job!.id, { ok: true, posted: { url: post.url, account: "dana" } })).toBe(false); // nobody waits on it now
  });
});

describe("the browser poster, stopped", () => {
  /** A messages page whose `stuck` step never answers, as a Chrome that cannot reach a stopping agent. */
  class Workspace implements BrowserTransport {
    readonly jobs: BrowserJob[] = [];
    body = "";
    submitted = 0;
    readonly stuck: (job: BrowserJob) => boolean;
    constructor(stuck: (job: BrowserJob) => boolean) {
      this.stuck = stuck;
    }
    async browser(_id: unknown, job: BrowserJob): Promise<BrowserView> {
      this.jobs.push(job);
      if (job.action.kind === "fill") this.body = job.action.text;
      if (job.action.kind === "click" && job.action.ref === "send") this.submitted++;
      if (this.stuck(job)) return new Promise<BrowserView>(() => undefined);
      return { url: "https://workspace.example.com/messages/alex", title: "Alex", text: "alex@example.com", controls: [{ ref: "to", role: "textbox", label: "To", value: "alex@example.com", href: null }, { ref: "body", role: "textbox", label: "Message", value: this.body, href: null }, { ref: "send", role: "button", label: "Send", value: null, href: null }] };
    }
  }
  const message: ChromePost = { platform: "browser", kind: "message", url: "https://workspace.example.com/messages/alex", target: "alex@example.com", title: null, text: BODY };
  const call = (name: string, args: unknown, id: string) => new AIMessage({ content: "", tool_calls: [{ name, args: args as Record<string, unknown>, id }] });
  const posterFor = (w: Workspace) => {
    const model = fakeModel().respond(call("prepare", { kind: "fill", ref: "body", text: BODY }, "fill")).respond(call("publish", { ref: "send" }, "send")).respond(new AIMessage("done"));
    return new BrowserPoster({ browser: new CustomerBrowser(w, new HostGuard({ resolve: async () => ["8.8.8.8"], unresolved: "refuse" })), reddit: { post: async () => { throw new Error("no Reddit"); } }, models: { modelFor: () => model } });
  };
  /** Posts, and stops the agent once the stuck step was asked for. */
  async function stoppedAt(w: Workspace): Promise<unknown> {
    const stop = new AbortController();
    const posting = posterFor(w).post(ID, message, stop.signal);
    while (!w.jobs.some(w.stuck)) await new Promise((r) => setTimeout(r, 1));
    stop.abort();
    return posting.then(() => "posted", (e: unknown) => e);
  }

  it("sends nothing when the agent stops while the page opens", async () => {
    const w = new Workspace((job) => job.action.kind !== "fill" && job.action.kind !== "click" && w.jobs.length === 1);
    expect(await stoppedAt(w)).toMatchObject({ reason: "unavailable" });
    expect(w.body).toBe("");
  });

  it("sends nothing when the agent stops while it types", async () => {
    const w = new Workspace((job) => job.action.kind === "fill");
    expect(await stoppedAt(w)).toMatchObject({ reason: "unavailable" });
    expect(w.submitted).toBe(0);
  });

  it("holds the post for them to look when the agent stops once it pressed Send", async () => {
    const w = new Workspace((job) => job.action.kind === "click" && job.action.ref === "send");
    expect(await stoppedAt(w)).toMatchObject({ reason: "uncertain" });
    expect(w.submitted).toBe(1);
  });
});

describe("a post the agent stops in the middle of", () => {
  it("goes back on its card when nothing was sent, and they hear it can go up with another tap", async () => {
    const world = makeWorld({}, { cards: true, errands: SHORT });
    const c = await customerIn(world);
    const offered = await world.drafts.offer(c.id, reply);
    if (typeof offered === "string") throw new Error(offered);
    world.poster.hold = new Promise(() => undefined); // their Chrome never gets to it
    await world.drafts.act(c.id, offered.draft.id, "post");
    await world.errands.stop();

    expect((await world.draftStore.get(offered.draft.id))?.status).toBe("open");
    expect(world.channel.sent.at(-1)?.text).toContain("and nothing was sent. Tap Post it to try again");
    world.poster.hold = null;
    await world.drafts.act(c.id, offered.draft.id, "post");
    await world.errands.stop();
    expect((await world.draftStore.get(offered.draft.id))?.status).toBe("posted");
  });

  it("is held for them to look when it may have gone up", async () => {
    const world = makeWorld({}, { cards: true, errands: SHORT });
    const c = await customerIn(world);
    const offered = await world.drafts.offer(c.id, reply);
    if (typeof offered === "string") throw new Error(offered);
    world.poster.hold = new Promise(() => undefined);
    world.poster.stoppedAs = "uncertain";
    await world.drafts.act(c.id, offered.draft.id, "post");
    await world.errands.stop();

    expect((await world.draftStore.get(offered.draft.id))?.status).toBe("uncertain");
    expect(draftButtons(world.channel.drafts.at(-1)!.draft).flat().map((b) => b.text)).toEqual(["Not there, post again"]);
  });

  it("keeps a post waiting its turn in line through the stop, and sends it when its turn comes", async () => {
    const world = makeWorld({}, { cards: true, errands: SHORT, outbox: { siteGapMs: 240_000, acrossGapMs: 60_000 } });
    const c = await customerIn(world);
    world.autopilot.alone = async () => true;
    // One went up by itself on x.com a moment ago: the next waits its four minutes there.
    const first = await world.drafts.offer(c.id, reply);
    if (typeof first === "string") throw new Error(first);
    await world.errands.stop();
    expect(world.poster.posts).toHaveLength(1);
    const second = await world.drafts.offer(c.id, { ...reply, url: "https://x.com/danabuilds/status/2095574318272954999", target: "https://x.com/danabuilds/status/2095574318272954999", quote: "any other form tools worth a look?" });
    if (typeof second === "string") throw new Error(second);
    expect(second.alone).toBe(true);

    await world.errands.stop(); // the agent stops while it waits: nothing is cut off, nothing goes
    expect(world.poster.posts).toHaveLength(1);
    expect((await world.draftStore.get(second.draft.id))?.status).toBe("open");
    expect(await world.outboxStore.of({ draftId: second.draft.id })).toMatchObject({ status: "queued", approved: "trust", reason: "its turn: a person's pace" });

    world.clock.advance(240_001);
    await world.outbox.kick();
    await world.errands.stop();
    expect(world.poster.posts).toHaveLength(2);
    expect((await world.draftStore.get(second.draft.id))?.status).toBe("posted");
  });
});

describe("posts a stopped machine left claimed", () => {
  it("turn uncertain at start, with Not there, post again on their card, and say nothing", async () => {
    const world = makeWorld({}, { cards: true });
    const c = await customerIn(world);
    const offered = await world.drafts.offer(c.id, reply);
    if (typeof offered === "string") throw new Error(offered);
    await world.draftStore.beginPost(offered.draft.id); // the machine that took the tap was killed mid-post

    expect(await world.drafts.recoverPosts()).toBe(1);
    const held = await world.draftStore.get(offered.draft.id);
    expect(held?.status).toBe("uncertain");
    // Quest looks at its page later itself (HeldCheck): nothing for them to check.
    expect(world.channel.sent.some((m) => /lost track|Have a look/.test(m.text))).toBe(false);
    const card = world.channel.drafts.at(-1)!;
    expect(card).toMatchObject({ ref: offered.draft.cardRef, redraw: true });
    expect(draftCardHtml(card.draft)).toContain("I can't tell if it went up");
    expect(draftButtons(card.draft).flat().map((b) => b.text)).toEqual(["Not there, post again"]);
    expect(world.poster.posts).toHaveLength(0); // never sent again by itself

    expect(await world.drafts.recoverPosts()).toBe(0); // once
    expect(await world.drafts.act(c.id, offered.draft.id, "retry")).toBe("Sending it after your check…");
    await world.errands.stop();
    expect((await world.draftStore.get(offered.draft.id))?.status).toBe("posted");
  });

  it("include a find's reply, whose card offers Not there, post again", async () => {
    const world = makeWorld({}, { cards: true });
    const c = await customerIn(world);
    const find: NewFind = { customerId: c.id, taskId: null, source: "reddit:r/SaaS", url: "https://www.reddit.com/r/SaaS/comments/abc1/need_a_form_tool/", author: "sam", title: "Need a form tool", quote: "Looking for a cheaper Typeform alternative.", postedAt: new Date("2026-10-16T10:00:00Z"), why: "Wants a form tool.", reply: BODY, strength: "strong", replyTo: "t1_c1" };
    const saved = await world.finds.save(find);
    await world.finds.show(c.id);
    await world.findStore.beginPost(saved!.id);

    expect(await world.finds.recoverPosts()).toBe(1);
    const held = (await world.findStore.get(saved!.id))!;
    expect(held.postState).toBe("uncertain");
    expect(world.channel.sent.some((m) => /lost track|Have a look/.test(m.text))).toBe(false);
    expect(findButtons(world.channel.cards.at(-1)!.find).flat().map((b) => b.text)).toEqual(["Not there, post again"]);
    expect(world.poster.posts).toHaveLength(0);
  });
});
