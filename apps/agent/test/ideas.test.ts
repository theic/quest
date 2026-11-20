import { AIMessage } from "@langchain/core/messages";
import { fakeModel } from "@langchain/core/testing";
import { HostGuard, customerId, type BrowserJob, type BrowserTransport, type BrowserView, type ChromePost } from "@mq/core";
import { describe, expect, it } from "vitest";
import { CustomerBrowser } from "../src/chrome/browser.ts";
import { BrowserPoster } from "../src/chrome/browser-poster.ts";
import { ideaLines } from "../src/ideas/idea-service.ts";
import { managerTools } from "../src/manager/tools.ts";
import { draftCardHtml } from "../src/telegram/draft-card.ts";
import { parseUpdate } from "../src/telegram/updates.ts";
import { makeWorld, telegramSender } from "./world.ts";

// Each card its own message (`cards`), as before Your move (asks/deck.ts): cards already in a chat still work so.

async function setUp() {
  const world = makeWorld({}, { cards: true });
  const c = await world.customers.create({ channel: telegramSender().channel, userRef: "42", displayName: "Serhii", language: "en" });
  const tools = Object.fromEntries(managerTools({ ...world, customerId: c.id, userTurn: true, customers: world.customers, now: world.clock.now }).map((t) => [t.name, t]));
  const call = (name: string, args: Record<string, unknown>) => tools[name]!.invoke(args) as Promise<string>;
  return { world, c, call };
}

describe("they steer: ideas and assets", () => {
  it("keeps a picture they send for their posts, and tells the manager its id", async () => {
    const { world, c } = await setUp();
    await world.inbound.handle({ type: "file", from: telegramSender(), fileRef: "tg-file-1", fileName: "picture.jpg", mimeType: "image/jpeg", size: 120_000, caption: "our dashboard, for the launch post", messageRef: "m1" });
    const [asset] = await world.ideas.assets(c.id);
    expect(asset).toMatchObject({ kind: "image", fileRef: "tg-file-1", channel: "telegram", mime: "image/jpeg" });
    expect(asset!.about).toContain("our dashboard, for the launch post");
    const told = world.events.events.at(-1)!.event;
    expect(told.kind === "user_message" && told.text).toContain(`Kept for their posts as asset ${asset!.id}`);
    // A video too; a PDF is read, not kept.
    await world.inbound.handle({ type: "file", from: telegramSender(), fileRef: "tg-file-2", fileName: "demo.mp4", mimeType: "video/mp4", size: 2_000_000, caption: "", messageRef: "m2" });
    await world.inbound.handle({ type: "file", from: telegramSender(), fileRef: "tg-file-3", fileName: "deck.pdf", mimeType: "application/pdf", size: 2_000, caption: "", messageRef: "m3" });
    expect((await world.ideas.assets(c.id)).map((a) => a.kind)).toEqual(["video", "image"]);
  });

  it("keeps their ideas to do", async () => {
    const { world, c, call } = await setUp();
    expect(await call("idea", { text: "Post about the first paying user and what they said", platform: "x.com" })).toMatch(/^Kept as their idea/);
    const lines = ideaLines(await world.ideas.ideas(c.id), await world.ideas.assets(c.id));
    expect(lines[0]).toMatch(/^Ideas for posts to do \(theirs first/);
  });

  it("reads which button of an idea card was tapped", () => {
    const id = "6f1c2b9e-0d4e-4a51-9a0e-6f3a2d9c1b11";
    const update = { update_id: 1, callback_query: { id: "cb", from: { id: 7, is_bot: false, first_name: "Dana" }, message: { message_id: 3, date: 0, chat: { id: 7, type: "private" as const } }, data: `idea:${id}:no` } };
    expect(parseUpdate(update as never)).toMatchObject({ type: "idea", ideaId: id, action: "no" });
  });

  it("puts their picture up with a post: the card says so, and the post carries the file", async () => {
    const { world, c, call } = await setUp();
    await world.inbound.handle({ type: "file", from: telegramSender(), fileRef: "tg-file-1", fileName: "picture.jpg", mimeType: "image/jpeg", size: 120_000, caption: "launch shot", messageRef: "m1" });
    const [asset] = await world.ideas.assets(c.id);
    world.channel.files.set("tg-file-1", new Uint8Array([0xff, 0xd8, 0xff]));
    expect(await call("draft", { kind: "post", url: "https://x.com/compose/post", target: "@serhii", text: "Shipped: onboarding in two taps.", rules_read: true, assets: ["00000000-0000-0000-0000-000000000000"] })).toMatch(/^Not drafted: 00000000-0000-0000-0000-000000000000 is not one of their assets/);
    const offered = await world.drafts.offer(c.id, { platform: "browser", kind: "post", url: "https://x.com/compose/post", target: "@serhii", text: "Shipped: onboarding in two taps.", rulesRead: true, assets: [asset!.id] });
    if (typeof offered === "string") throw new Error(offered);
    expect(draftCardHtml(offered.draft)).toContain("With your picture");
    await world.drafts.act(c.id, offered.draft.id, "post");
    await world.errands.stop();
    const sent = world.poster.posts.at(-1)!.post as Extract<ChromePost, { platform: "browser" }>;
    expect(sent.files).toEqual([{ name: `image-${asset!.id.slice(0, 8)}.jpg`, type: "image/jpeg", data: Buffer.from([0xff, 0xd8, 0xff]).toString("base64") }]);
  });
});

describe("attaching their picture in the composer", () => {
  const ID = customerId("customer-a");
  const BODY = "Shipped: onboarding in two taps.";
  class Composer implements BrowserTransport {
    readonly jobs: BrowserJob[] = [];
    body = "";
    picture = false;
    posted = false;
    async browser(_id: unknown, job: BrowserJob): Promise<BrowserView> {
      this.jobs.push(job);
      if (job.action.kind === "attach") this.picture = true;
      if (job.action.kind === "fill") this.body = job.action.text;
      if (job.action.kind === "click" && job.action.ref === "post") this.posted = true;
      return {
        url: "https://x.com/compose/post",
        title: "X",
        text: this.posted ? `Serhii ${this.body}` : this.picture ? "Remove media" : "",
        controls: [
          { ref: "media", role: "button", label: "Add photos or video", value: null, href: null },
          { ref: "body", role: "textbox", label: "Post text", value: this.posted ? "" : this.body, href: null },
          { ref: "post", role: "button", label: "Post", value: null, href: null },
        ],
      };
    }
  }
  const call = (name: string, args: unknown, id: string) => new AIMessage({ content: "", tool_calls: [{ name, args: args as Record<string, unknown>, id }] });
  const post: ChromePost = { platform: "browser", kind: "post", url: "https://x.com/compose/post", target: "@serhii", title: null, text: BODY, files: [{ name: "launch.jpg", type: "image/jpeg", data: "/9j/" }] };

  it("sends nothing until every picture is attached, and attaches it from the bytes it was given", async () => {
    const w = new Composer();
    const model = fakeModel()
      .respond(call("prepare", { kind: "fill", ref: "body", text: BODY }, "fill"))
      .respond(call("publish", { ref: "post" }, "early"))
      .respond(call("attach", { file: 0, ref: "media" }, "attach"))
      .respond(call("publish", { ref: "post" }, "send"))
      .respond(new AIMessage("Posted."));
    const poster = new BrowserPoster({ browser: new CustomerBrowser(w, new HostGuard({ resolve: async () => ["8.8.8.8"], unresolved: "refuse" })), reddit: { post: async () => { throw new Error("no Reddit"); } }, models: { modelFor: () => model } });
    expect(await poster.post(ID, post)).toEqual({ url: "https://x.com/compose/post", account: "connected account" });
    const kinds = w.jobs.map((j) => j.action.kind);
    // The early publish clicked nothing: the attach came first, then the one send.
    expect(kinds.indexOf("attach")).toBeLessThan(kinds.indexOf("click"));
    expect(kinds.filter((k) => k === "click")).toHaveLength(1);
    expect(w.jobs.find((j) => j.action.kind === "attach")?.action).toMatchObject({ kind: "attach", ref: "media", name: "launch.jpg", type: "image/jpeg", data: "/9j/" });
  });
});
