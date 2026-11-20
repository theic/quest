import { AIMessage } from "@langchain/core/messages";
import { fakeModel } from "@langchain/core/testing";
import { ChromeError, HostGuard, TooLong, customerId, type BrowserJob, type BrowserTransport, type BrowserView, type ChromePost } from "@mq/core";
import { describe, expect, it } from "vitest";
import { CustomerBrowser, browserTools } from "../src/chrome/browser.ts";
import { BrowserPoster, recipientShown } from "../src/chrome/browser-poster.ts";
import { draftFor } from "../src/drafts/draft-service.ts";
import { managerTools } from "../src/manager/tools.ts";
import { managerPrompt } from "../src/manager/prompt.ts";
import { makeWorld, telegramSender } from "./world.ts";

const BODY = "I build a form tool that keeps your intake simple.";
const ID = customerId("customer-a");
class Workspace implements BrowserTransport {
  readonly jobs: BrowserJob[] = [];
  body = "";
  submitted = 0;
  loseAck = false;
  showReceipt = true;
  retainComposer = false;
  url = "https://workspace.example.com/messages/alex";
  async browser(_id: unknown, job: BrowserJob): Promise<BrowserView> {
    this.jobs.push(job);
    if (job.url) this.url = job.url;
    if (job.action.kind === "fill") this.body = job.action.text;
    if (job.action.kind === "click" && job.action.ref === "send") {
      this.submitted++;
      if (this.loseAck) throw new ChromeError("timeout", "Lost after sending");
    }
    return { url: this.url, title: "Alex", text: `alex@example.com ${this.submitted && this.showReceipt ? this.body : ""}`, controls: [{ ref: "to", role: "textbox", label: "To", value: "alex@example.com", href: null }, { ref: "body", role: "textbox", label: "Message", value: this.submitted && !this.retainComposer ? "" : this.body, href: null }, { ref: "send", role: "button", label: "Send", value: null, href: null }] };
  }
}
const call = (name: string, args: unknown, id: string) => new AIMessage({ content: "", tool_calls: [{ name, args: args as Record<string, unknown>, id }] });
const browser = (w: Workspace) => new CustomerBrowser(w, new HostGuard({ resolve: async () => ["8.8.8.8"], unresolved: "refuse" }));
const draft: ChromePost = { platform: "browser", kind: "message", url: "https://workspace.example.com/messages/alex", target: "alex@example.com", title: null, text: BODY };

describe("posting through a previously unknown workspace", () => {
  it("starts founder onboarding with a product-success mandate, asking before it posts until it is trusted", async () => {
    // 2026-10-14, the founder: "before switching to autopilot on a specific thing, platform or action, the agent must
    // first ask the user a few times for approvals or edits". A brief no longer grants posting alone.
    const world = makeWorld();
    const c = await world.customers.create({ channel: telegramSender().channel, userRef: "42", displayName: "Dana", language: "en" });
    await world.customers.update(c.id, { sweptAt: new Date(world.clock.t) });
    const tools = Object.fromEntries(managerTools({ ...world, customerId: c.id, userTurn: true, now: world.clock.now }).map((t) => [t.name, t]));
    await tools["save_brief"]!.invoke({ brief: "Acme makes intake forms for small teams. Success: ten teams actively using it. Be honest about making it." });
    expect(await world.autopilot.alone(c.id, "any-new-community.example.org")).toBe(false);
    expect(await tools["start_task"]!.invoke({ agent: "outreach", title: "Get the first conversations", instructions: "Find the relevant people and start useful conversations for the product." })).toContain("Started task");
    expect(managerPrompt(world.catalog.describe())).toContain("Your core goal is to make their product successful");
    for (let n = 0; n < 3; n++) await world.autopilot.approved(c.id, "any-new-community.example.org");
    // Their own behaviour decides (2026-11-18): the first few approved as written, and Quest stops asking, with no offer.
    expect(await world.trust.offered(c.id)).toEqual([]);
    expect(await world.autopilot.alone(c.id, "any-new-community.example.org")).toBe(true);
    expect(await world.autopilot.alone(c.id, "any-new-community.example.org posts")).toBe(false);
    // Their "ask me first" holds over approvals counted before or after it.
    await tools["posting"]!.invoke({ ask_first: true });
    for (let n = 0; n < 4; n++) await world.trust.approve(c.id, "other.example.org");
    await tools["save_brief"]!.invoke({ brief: "Acme makes intake forms for small teams. Now aim for twenty active teams, keeping its existing boundaries." });
    expect(await world.autopilot.alone(c.id, "other.example.org")).toBe(false);
  });
  it("publishes the exact body and records success only from page evidence", async () => {
    const w = new Workspace();
    const model = fakeModel().respond(call("prepare", { kind: "fill", ref: "body", text: BODY }, "fill"))
      .respond(call("publish", { ref: "send" }, "send"))
      .respond(call("confirm_post", { url: w.url, evidence: BODY }, "confirm"))
      .respond(new AIMessage("Sent and verified."));
    const poster = new BrowserPoster({ browser: browser(w), reddit: { post: async () => { throw new Error("Reddit must not be used"); } }, models: { modelFor: () => model } });
    expect(await poster.post(ID, draft)).toEqual({ url: w.url, account: "connected account" });
    expect(w.submitted).toBe(1);
    expect(w.jobs.at(-1)?.action.kind).toBe("close");
  });

  it("knows its post when the site shows the link its own way", async () => {
    // Live, 2026-10-14: X shows a long link shortened; the reply had gone up and was held as unknown.
    const body = "I made it, free to try: messaging.quest/start?from=reply-thread-42";
    class Shortening extends Workspace {
      override async browser(id: unknown, job: BrowserJob): Promise<BrowserView> {
        const view = await super.browser(id, job);
        return { ...view, text: view.text.replace("messaging.quest/start?from=reply-thread-42", "messaging.quest/start?fr…") };
      }
    }
    const w = new Shortening();
    const model = fakeModel().respond(call("prepare", { kind: "fill", ref: "body", text: body }, "fill"))
      .respond(call("publish", { ref: "send" }, "send"))
      .respond(new AIMessage("Posted."));
    const poster = new BrowserPoster({ browser: browser(w), reddit: { post: async () => { throw new Error("Reddit must not be used"); } }, models: { modelFor: () => model } });
    expect(await poster.post(ID, { ...draft, text: body })).toEqual({ url: w.url, account: "connected account" });
    expect(w.submitted).toBe(1);
  });

  it("names someone on X by their @handle, not Reddit's u/", () => {
    const on = (url: string, author: string) => draftFor(ID, { platform: "browser", kind: "reply", url, target: url, author, quote: "Ok. What is Messaging Quest?", text: "I made it." });
    // Live, 2026-10-14: an X card read "u/makerfour".
    expect(on("https://x.com/makerfour/status/2110320982636523790", "u/makerfour")).toMatchObject({ author: "@makerfour" });
    expect(on("https://x.com/makerfour/status/2110320982636523790", "Rob @makerfour")).toMatchObject({ author: "Rob @makerfour" });
    expect(on("https://www.linkedin.com/feed/update/urn:li:activity:1/", "u/Dana Whitfield")).toMatchObject({ author: "Dana Whitfield" });
  });

  describe("words longer than their field takes", () => {
    // Live, 2026-10-15: X's bio takes 160 characters. Quest's was 174: the poster went round prepare 26 times, and
    // twice the card said only "try again".
    const BIO = "Messaging Quest\nAI that finds your first customers and writes to them from your own accounts\nFree, follows up, reports every evening\n0 MRR, building in public\nmessaging.quest";
    const SHORT = "Messaging Quest\nFinds your first customers and writes to them from your own accounts\n0 MRR, building in public\nmessaging.quest";
    const onCard = async (world: ReturnType<typeof makeWorld>) => {
      const c = await world.customers.create({ channel: telegramSender().channel, userRef: "42", displayName: "Serhii", language: "en" });
      const d = await world.draftStore.add({ customerId: c.id, kind: "post", platform: "x.com", url: "https://x.com/settings/profile", target: "their X bio", title: null, author: null, quote: null, text: BIO });
      const ref = (await world.messenger.showDraft(c.id, d))!;
      await world.draftStore.markShown(d.id, ref);
      return { c, d, ref };
    };

    it("stop the poster at once, before anything is typed", async () => {
      class Bio extends Workspace {
        override async browser(id: unknown, job: BrowserJob): Promise<BrowserView> {
          const view = await super.browser(id, job);
          return { ...view, controls: view.controls.map((c) => (c.ref === "body" ? { ...c, limit: 160 } : c)) };
        }
      }
      const w = new Bio();
      const model = fakeModel().respond(call("prepare", { kind: "fill", ref: "body", text: BIO }, "fill"))
        .respond(call("prepare", { kind: "fill", ref: "body", text: BIO }, "again"))
        .respond(new AIMessage("It does not fit."));
      const poster = new BrowserPoster({ browser: browser(w), reddit: { post: async () => { throw new Error("Reddit must not be used"); } }, models: { modelFor: () => model } });
      const failed = poster.post(ID, { ...draft, kind: "post", target: "their X bio", text: BIO });
      await expect(failed).rejects.toBeInstanceOf(TooLong);
      await expect(failed).rejects.toMatchObject({ reason: "too_long", limit: 160, length: 174 });
      expect(w.jobs.filter((j) => j.action.kind === "fill")).toEqual([]);
      // One look at the page, not a run of retries.
      expect(model.calls).toHaveLength(1);
      expect(w.submitted).toBe(0);
      expect(w.jobs.at(-1)?.action.kind).toBe("close");
    });

    it("are cut to fit, and the card comes back for a tap", async () => {
      const writer = fakeModel().respond(new AIMessage(SHORT));
      const world = makeWorld({ writer });
      const { c, d, ref } = await onCard(world);
      world.poster.throwNext = new TooLong(160, BIO.length);

      await world.drafts.act(c.id, d.id, "post");
      await world.errands.stop();

      expect(await world.draftStore.get(d.id)).toMatchObject({ status: "open", text: SHORT });
      expect(JSON.stringify(writer.calls[0]!.messages[1])).toContain("at most 160 characters");
      expect(world.channel.sent.map((m) => m.text)).toContain("Too long: your post in their X bio on x.com had 174 characters, and the field takes 160. I cut it to fit: tap Post it on the new version if it reads right.");
      expect(world.channel.drafts.at(-1)).toMatchObject({ redraw: false, draft: { id: d.id, text: SHORT } });
      expect(world.channel.closed).toEqual([ref]);
      // Their next tap posts the shorter words.
      await world.drafts.act(c.id, d.id, "post");
      await world.errands.stop();
      expect(world.poster.posts.at(-1)?.post).toMatchObject({ text: SHORT });
      expect((await world.draftStore.get(d.id))?.status).toBe("posted");
    });

    it("say so plainly when they can't be cut to fit", async () => {
      const writer = fakeModel().respond(new AIMessage(`${BIO} Free.`)).respond(new AIMessage(`${BIO} Free!`));
      const world = makeWorld({ writer });
      const { c, d } = await onCard(world);
      world.poster.throwNext = new TooLong(160, BIO.length);

      await world.drafts.act(c.id, d.id, "post");
      await world.errands.stop();

      expect(await world.draftStore.get(d.id)).toMatchObject({ status: "open", text: BIO });
      // Out of line, the draft is back on Your move, under what was said about it.
      expect(world.channel.sent.slice(-2).map((m) => m.text)).toEqual(["Too long: your post in their X bio on x.com has 174 characters, and the field takes 160. Tap Edit to make it shorter, or post it yourself.", `[deck] draft:${d.id}`]);
    });

    it("are kept within a limit the manager read on the page", async () => {
      const world = makeWorld({ writer: fakeModel().respond(new AIMessage(`${BIO} Free.`)).respond(new AIMessage(`${BIO} Free!`)) });
      const c = await world.customers.create({ channel: telegramSender().channel, userRef: "42", displayName: "Serhii", language: "en" });
      const bio = { platform: "browser", kind: "profile", url: "https://x.com/settings/profile", target: "bio", text: BIO, rulesRead: true } as const;
      expect(await world.drafts.offer(c.id, { ...bio, limit: 160 })).toBe("The field takes at most 160 characters, and this has 174. Write it shorter.");
      // Where the writer runs over, the manager's own words go on when they fit.
      const fits = await world.drafts.offer(c.id, { ...bio, text: SHORT, limit: 160 });
      expect(typeof fits === "string" ? fits : fits.draft.text).toBe(SHORT);
    });
  });

  it("does not treat a disappearing composer or the model's claim as a receipt", async () => {
    const w = new Workspace();
    w.showReceipt = false;
    const model = fakeModel().respond(call("prepare", { kind: "fill", ref: "body", text: BODY }, "fill"))
      .respond(call("publish", { ref: "send" }, "send"))
      .respond(call("confirm_post", { url: w.url, evidence: BODY }, "confirm"))
      .respond(new AIMessage("Sent successfully."));
    const poster = new BrowserPoster({ browser: browser(w), reddit: { post: async () => ({ url: "", account: "" }) }, models: { modelFor: () => model } });
    await expect(poster.post(ID, draft)).rejects.toMatchObject({ reason: "uncertain" });
    expect(w.submitted).toBe(1);
    // Its tab closes all the same: what may have gone up is looked at later in a tab of its own (HeldCheck).
    expect(w.jobs.at(-1)?.action.kind).toBe("close");
  });

  it("guards the destination and refuses a recipient that was not selected", async () => {
    const w = new Workspace();
    await expect(browser(w).open(ID, "test", "http://127.0.0.1/admin")).rejects.toMatchObject({ reason: "blocked" });
    expect(w.jobs).toHaveLength(0);
    const model = fakeModel().respond(call("prepare", { kind: "fill", ref: "body", text: BODY }, "fill"))
      .respond(call("publish", { ref: "send" }, "send"))
      .respond(new AIMessage("Cannot verify recipient."));
    const poster = new BrowserPoster({ browser: browser(w), reddit: { post: async () => ({ url: "", account: "" }) }, models: { modelFor: () => model } });
    await expect(poster.post(ID, { ...draft, target: "other@example.com" })).rejects.toMatchObject({ reason: "unavailable" });
    expect(w.submitted).toBe(0);
  });

  it("does not count a sidebar Draft preview as a sent message while its editor retains the body", async () => {
    const w = new Workspace();
    w.retainComposer = true;
    const model = fakeModel().respond(call("prepare", { kind: "fill", ref: "body", text: BODY }, "fill"))
      .respond(call("publish", { ref: "send" }, "send"))
      .respond(call("confirm_post", { url: w.url, evidence: BODY }, "confirm"))
      .respond(new AIMessage("It appeared in the sidebar."));
    const poster = new BrowserPoster({ browser: browser(w), reddit: { post: async () => ({ url: "", account: "" }) }, models: { modelFor: () => model } });
    await expect(poster.post(ID, draft)).rejects.toMatchObject({ reason: "uncertain" });
  });

  describe("who a message goes to", () => {
    /** A web messenger: the chat list holds every contact, and only one chat is open. */
    class Messenger implements BrowserTransport {
      body = "";
      submitted = 0;
      readonly open: string;
      readonly composer: string;
      readonly search: string;
      constructor(open: string, composer = "Message", search = "") { this.open = open; this.composer = composer; this.search = search; }
      async browser(_id: unknown, job: BrowserJob): Promise<BrowserView> {
        if (job.action.kind === "fill" && job.action.ref === "body") this.body = job.action.text;
        if (job.action.kind === "click" && job.action.ref === "send") this.submitted++;
        const list = ["Alex Chen", "Bob Li", "Carla Ruiz"];
        return {
          url: "https://chat.example.org/t/open",
          title: `${this.open} | Chat`,
          text: `${list.join(" ")} ${this.open} ${this.submitted ? this.body : ""}`,
          controls: [
            ...list.map((name, i) => ({ ref: `chat${i}`, role: "a", label: name, value: null, href: `https://chat.example.org/t/${i}` })),
            { ref: "search", role: "textbox", label: "Search", value: this.search, href: null },
            { ref: "body", role: "textbox", label: this.composer, value: this.submitted ? "" : this.body, href: null },
            { ref: "send", role: "button", label: "Send", value: null, href: null },
          ],
        };
      }
    }
    const dm = (target: string, text = BODY): Extract<ChromePost, { platform: "browser" }> => ({ platform: "browser", kind: "message", url: "https://chat.example.org/t/open", target, title: null, text });
    async function send(w: Messenger, post: Extract<ChromePost, { platform: "browser" }>) {
      const model = fakeModel().respond(call("prepare", { kind: "fill", ref: "body", text: post.text }, "fill"))
        .respond(call("publish", { ref: "send" }, "send"))
        .respond(new AIMessage("done"));
      const poster = new BrowserPoster({ browser: new CustomerBrowser(w, new HostGuard({ resolve: async () => ["8.8.8.8"], unresolved: "refuse" })), reddit: { post: async () => { throw new Error("no"); } }, models: { modelFor: () => model } });
      return poster.post(ID, post).then(() => "sent", (e: unknown) => (e instanceof ChromeError ? e.reason : "error"));
    }

    it("does not send to the open chat because the contact is only in the chat list", async () => {
      const w = new Messenger("Bob Li");
      expect(await send(w, dm("Alex Chen"))).toBe("unavailable");
      expect(w.submitted).toBe(0);
    });
    it("does not count the draft's own words or a search box as the recipient", async () => {
      const w = new Messenger("Bob Li", "Message", "Alex Chen");
      expect(await send(w, dm("Alex Chen", "Hi Alex Chen, I build a form tool for small teams."))).toBe("unavailable");
      expect(w.submitted).toBe(0);
    });
    it("sends when the open conversation is the recipient, by its title or the composer's label", async () => {
      const byTitle = new Messenger("Alex Chen");
      expect(await send(byTitle, dm("Alex Chen"))).toBe("sent");
      expect(byTitle.submitted).toBe(1);
      const byLabel = new Messenger("Someone", "Message Alex Chen");
      expect(await send(byLabel, dm("Alex Chen"))).toBe("sent");
      expect(byLabel.submitted).toBe(1);
    });
    it("reads the recipient from the address and the To field, and never from page text or links", () => {
      const post = { target: "alex@example.org", text: BODY, title: null };
      const view = (over: Partial<BrowserView>): BrowserView => ({ url: "https://mail.example.org/c", title: "Mail", text: "alex@example.org", controls: [], ...over });
      expect(recipientShown(view({}), post)).toBe(false);
      expect(recipientShown(view({ controls: [{ ref: "l", role: "a", label: "alex@example.org", value: null, href: "https://mail.example.org/x" }] }), post)).toBe(false);
      expect(recipientShown(view({ controls: [{ ref: "t", role: "textbox", label: "To", value: "alex@example.org", href: null }] }), post)).toBe(true);
      expect(recipientShown(view({ url: "https://chat.example.org/dm/Alex%20Chen" }), { ...post, target: "alex chen" })).toBe(true);
    });
  });

  it("keeps general browsing from typing or submitting unrecorded outgoing messages", async () => {
    const w = new Workspace();
    const tools = Object.fromEntries(browserTools(browser(w), ID).map((t) => [t.name, t]));
    await tools["browser_open"]!.invoke({ url: w.url });
    expect(await tools["browser_act"]!.invoke({ kind: "fill", ref: "body", text: BODY })).toContain("Use draft");
    expect(await tools["browser_act"]!.invoke({ kind: "click", ref: "send" })).toContain("Use draft");
    expect(w.submitted).toBe(0);
    expect(w.body).toBe("");
  });

  it("persists an ambiguous send and holds further taps and edits", async () => {
    const world = makeWorld();
    const c = await world.customers.create({ channel: telegramSender().channel, userRef: "42", displayName: "Dana", language: "en" });
    world.poster.failWith = { reason: "uncertain", message: "Unknown send result" };
    const offered = await world.drafts.offer(c.id, { platform: "browser", kind: "message", url: "https://mail.example.org/inbox", target: "alex@example.com", title: "Forms", text: BODY });
    if (typeof offered === "string") throw new Error(offered);
    await world.drafts.act(c.id, offered.draft.id, "post");
    await world.errands.stop();
    expect((await world.draftStore.get(offered.draft.id))?.status).toBe("uncertain");
    expect(await world.drafts.act(c.id, offered.draft.id, "post")).toContain("It may have gone up: look first");
    expect(world.poster.posts).toHaveLength(1);
    expect(await world.drafts.verifySent(c.id, offered.draft.id, { url: "https://mail.example.org/inbox", title: "Inbox", text: BODY, controls: [], visualText: true })).toContain("not a receipt");
    expect(await world.drafts.verifySent(c.id, offered.draft.id, { url: "https://mail.example.org/inbox", title: "Inbox", text: BODY, controls: [{ ref: "body", role: "textbox", label: "Body", value: BODY, href: null }] })).toContain("empty composer");
    expect(await world.drafts.verifySent(c.id, offered.draft.id, { url: "https://mail.example.org/sent/42", title: "Sent", text: BODY, controls: [] })).toMatchObject({ status: "posted" });
    expect(world.poster.posts).toHaveLength(1);
  });

  it("inherits founder autonomy on new hosts while preserving ask-first overrides", async () => {
    const world = makeWorld();
    const c = await world.customers.create({ channel: telegramSender().channel, userRef: "42", displayName: "Dana", language: "en" });
    await world.trust.initialize(c.id);
    expect(await world.autopilot.alone(c.id, "forum.example.org")).toBe(true);
    await world.trust.set(c.id, "forum.example.org", 0);
    await world.trust.initialize(c.id);
    expect(await world.autopilot.alone(c.id, "forum.example.org")).toBe(false);
    expect(await world.autopilot.alone(c.id, "mail.example.org")).toBe(true);
    await world.trust.set(c.id, "*", 0);
    expect(await world.autopilot.alone(c.id, "mail.example.org")).toBe(false);
    const result = draftFor(c.id, { platform: "browser", kind: "message", url: "https://chat.example.org/room", target: "Alex", text: BODY });
    expect(result).toMatchObject({ platform: "chat.example.org", title: null });
    expect(draftFor(c.id, { platform: "browser", kind: "message", url: "https://chat.example.org/room", target: "chat.example.org", text: BODY })).toContain("not the workspace's host");
  });

  it("reuses the same open outgoing draft, then prevents an identical send after verification", async () => {
    const world = makeWorld();
    const c = await world.customers.create({ channel: telegramSender().channel, userRef: "42", displayName: "Dana", language: "en" });
    const request = { platform: "browser", kind: "message", url: "https://chat.example.org/room", target: "Alex", text: BODY } as const;
    const first = await world.drafts.offer(c.id, request);
    const second = await world.drafts.offer(c.id, request);
    if (typeof first === "string" || typeof second === "string") throw new Error("Draft refused");
    expect(first.draft.id).toBe(second.draft.id);
    expect(world.draftStore.drafts.size).toBe(1);
    await world.trust.initialize(c.id);
    // A private message never goes on trust alone: it goes on their word.
    expect(await world.drafts.publish(c.id, first.draft.id)).toContain("They want to review");
    await world.drafts.publish(c.id, first.draft.id, { asked: true });
    await world.errands.stop();
    expect((await world.draftStore.get(first.draft.id))?.status).toBe("posted");
    expect(await world.drafts.offer(c.id, request)).toContain("already went to that destination");
    expect(world.poster.posts).toHaveLength(1);
  });

  it("posts a strong forum find autonomously and holds unknown results against duplicate taps", async () => {
    const world = makeWorld();
    const c = await world.customers.create({ channel: telegramSender().channel, userRef: "42", displayName: "Dana", language: "en" });
    await world.trust.initialize(c.id);
    world.poster.failWith = { reason: "uncertain", message: "No acknowledgement" };
    const f = await world.finds.save({ customerId: c.id, taskId: null, source: "web", url: "https://community.example.org/topic/42", author: "Alex", title: "Forms", quote: "Looking for a simpler form builder.", why: "Matches the product", reply: BODY, postedAt: new Date(), strength: "strong" });
    await world.finds.show(c.id);
    await world.errands.stop();
    expect(world.poster.posts[0]?.post).toMatchObject({ platform: "browser", quote: f!.quote, author: "Alex" });
    expect((await world.findStore.get(f!.id))?.postState).toBe("uncertain");
    expect(await world.finds.act(c.id, f!.id, { kind: "post" })).toContain("It may have gone up: look first");
    expect(world.poster.posts).toHaveLength(1);
    expect(await world.finds.verifySent(c.id, f!.id, { url: f!.url, title: "Forms", text: BODY, controls: [] })).toMatchObject({ status: "replied", postState: "posted" });
    expect(world.poster.posts).toHaveLength(1);
  });
});

describe("a Mastodon post on another server", () => {
  it("is opened from the server their own account is on", async () => {
    const { fediverseHome, fromHome } = await import("../src/chrome/fediverse.ts");
    const home = fediverseHome(["They like short replies.", "Their Mastodon account is https://mastodon.social/@serhiilahutin."]);
    expect(home).toBe("mastodon.social");
    expect(fromHome("https://mastodon.example.net/@someone/117581658943754342", home)).toBe("https://mastodon.social/authorize_interaction?uri=https%3A%2F%2Fmastodon.example.net%2F%40someone%2F117581658943754342");
    expect(fromHome("https://mastodon.social/@someone/1", home)).toBeNull();
    expect(fromHome("https://x.com/someone/status/1", home)).toBeNull();
    expect(fromHome("https://mastodon.example.net/@someone/1", null)).toBeNull();
  });
});
