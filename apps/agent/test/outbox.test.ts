import type { NewFind } from "@mq/core";
import { describe, expect, it } from "vitest";
import { QUEUED } from "../src/drafts/outbox.ts";
import { draftButtons, draftCardHtml } from "../src/telegram/draft-card.ts";
import { findButtons, findCardHtml } from "../src/telegram/find-card.ts";
import { makeWorld, telegramSender } from "./world.ts";

// Each card its own message (`cards`), as before Your move (asks/deck.ts): cards already in a chat still work so.

type World = ReturnType<typeof makeWorld>;

const WAITING = "Waiting for your Chrome. It goes up once Chrome is open.";
const customerIn = (world: World) => world.customers.create({ channel: telegramSender().channel, userRef: "42", displayName: "Dana", language: "en" });
const reply = { platform: "browser", kind: "reply", url: "https://x.com/rdominguezibar/status/2095574318272954478", target: "https://x.com/rdominguezibar/status/2095574318272954478", title: null, quote: "Which form tool do you use for your waitlist?", text: "I build a form tool that keeps intake simple." } as const;

/** A draft on its card, and their Chrome closed. */
async function closedChrome() {
  const world = makeWorld({}, { cards: true });
  const c = await customerIn(world);
  const offered = await world.drafts.offer(c.id, reply);
  if (typeof offered === "string") throw new Error(offered);
  world.chromeOffline.add(c.id);
  return { world, c, draft: offered.draft };
}

describe("the outbox", () => {
  it("keeps a tapped post while their Chrome is closed, says so on the card, and sends it when the Chrome is back", async () => {
    const { world, c, draft } = await closedChrome();
    const said = world.channel.sent.length;

    expect(await world.drafts.act(c.id, draft.id, "post")).toBe(QUEUED);
    expect(world.poster.posts).toHaveLength(0);
    const card = world.channel.drafts.at(-1)!.draft;
    expect(draftCardHtml(card)).toContain(WAITING);
    expect(draftButtons(card).flat().map((b) => b.text)).toEqual(["Edit", "Skip"]);
    expect(world.channel.sent.length).toBe(said); // no message: the toast and the card say it
    expect(await world.outboxStore.of({ draftId: draft.id })).toMatchObject({ status: "queued", approved: "tap" });

    // A tap again while it waits changes nothing.
    expect(await world.drafts.act(c.id, draft.id, "post")).toBe(QUEUED);
    expect(world.outboxStore.items).toHaveLength(1);

    world.chromeOffline.delete(c.id);
    await world.outbox.kick();
    await world.errands.stop();
    expect(world.poster.posts).toHaveLength(1);
    expect(await world.draftStore.get(draft.id)).toMatchObject({ status: "posted", alone: false });
    expect(world.outboxStore.items[0]).toMatchObject({ status: "done", reason: "sent" });
    expect(draftCardHtml(world.channel.drafts.at(-1)!.draft)).not.toContain(WAITING);
  });

  it("takes a Chrome that went away while posting as a wait, not a failure: nothing said, back in line", async () => {
    const world = makeWorld({}, { cards: true });
    const c = await customerIn(world);
    const offered = await world.drafts.offer(c.id, reply);
    if (typeof offered === "string") throw new Error(offered);
    world.poster.failWith = { reason: "offline", message: "the customer's Chrome is not connected" };
    const said = world.channel.sent.length;

    await world.drafts.act(c.id, offered.draft.id, "post");
    await world.errands.stop();
    expect(world.channel.sent.length).toBe(said);
    expect(await world.draftStore.get(offered.draft.id)).toMatchObject({ status: "open" });
    expect(await world.outboxStore.of({ draftId: offered.draft.id })).toMatchObject({ status: "queued", reason: "their Chrome went away", tries: 0 });
    expect(draftCardHtml(world.channel.drafts.at(-1)!.draft)).toContain(WAITING);

    world.poster.failWith = null;
    world.clock.advance(30_001);
    await world.outbox.kick();
    await world.errands.stop();
    expect(await world.draftStore.get(offered.draft.id)).toMatchObject({ status: "posted" });
  });

  it("drops what waits when they skip it or change its words, and sends nothing when the Chrome is back", async () => {
    const { world, c, draft } = await closedChrome();
    await world.drafts.act(c.id, draft.id, "post");
    expect(await world.drafts.act(c.id, draft.id, "skip")).toBe("Skipped");
    expect(world.outboxStore.items[0]).toMatchObject({ status: "dropped", reason: "skipped" });

    const second = await world.drafts.offer(c.id, { ...reply, url: "https://x.com/danabuilds/status/2095574318272954999", target: "https://x.com/danabuilds/status/2095574318272954999", quote: "any other form tools worth a look?" });
    if (typeof second === "string") throw new Error(second);
    await world.drafts.act(c.id, second.draft.id, "post");
    await world.drafts.revise(c.id, second.draft.id, "A shorter reply.", null, true);
    expect(world.outboxStore.items[1]).toMatchObject({ status: "dropped", reason: "its words changed" });
    expect(draftButtons(world.channel.drafts.at(-1)!.draft).flat().map((b) => b.text)).toEqual(["Post it", "Edit", "Skip"]);

    world.chromeOffline.delete(c.id);
    await world.outbox.kick();
    await world.errands.stop();
    expect(world.poster.posts).toHaveLength(0);
  });

  it("gives a card back after three days waiting for their Chrome", async () => {
    const { world, c, draft } = await closedChrome();
    await world.drafts.act(c.id, draft.id, "post");
    world.clock.advance(3 * 86_400_000 + 1);
    await world.outbox.kick();
    expect(world.outboxStore.items[0]).toMatchObject({ status: "dropped", reason: "waited too long for their Chrome" });
    expect(draftButtons(world.channel.drafts.at(-1)!.draft).flat().map((b) => b.text)).toEqual(["Post it", "Edit", "Skip"]);
  });

  it("sends what Quest may send by itself once their Chrome is back, and a tap on one waiting its turn still keeps the site's pace", async () => {
    const world = makeWorld({}, { cards: true, outbox: { siteGapMs: 240_000, acrossGapMs: 60_000 } });
    const c = await customerIn(world);
    world.autopilot.alone = async () => true;
    world.chromeOffline.add(c.id);
    const first = await world.drafts.offer(c.id, reply);
    if (typeof first === "string") throw new Error(first);
    expect(first.alone).toBe(true); // on its way: it waits in line for the Chrome
    expect(world.poster.posts).toHaveLength(0);

    world.chromeOffline.delete(c.id);
    await world.outbox.kick();
    await world.errands.stop();
    expect(await world.draftStore.get(first.draft.id)).toMatchObject({ status: "posted", alone: true });

    const second = await world.drafts.offer(c.id, { ...reply, url: "https://x.com/danabuilds/status/2095574318272954999", target: "https://x.com/danabuilds/status/2095574318272954999", quote: "any other form tools worth a look?" });
    if (typeof second === "string") throw new Error(second);
    expect(await world.outboxStore.of({ draftId: second.draft.id })).toMatchObject({ status: "queued", approved: "trust" });
    // Their tap makes it theirs, but two on one site seconds apart is how a bot looks: it waits for the site's turn.
    await world.drafts.act(c.id, second.draft.id, "post");
    expect(await world.outboxStore.of({ draftId: second.draft.id })).toMatchObject({ status: "queued", approved: "tap", reason: "its turn: a person's pace" });
    world.clock.advance(240_000);
    await world.outbox.kick();
    await world.errands.stop();
    expect(await world.draftStore.get(second.draft.id)).toMatchObject({ status: "posted", alone: false });
  });

  it("keeps a find's tapped reply for their Chrome too", async () => {
    const world = makeWorld({}, { cards: true });
    const c = await customerIn(world);
    const find: NewFind = { customerId: c.id, taskId: null, source: "hackernews", url: "https://news.ycombinator.com/item?id=1", author: "person1", title: null, quote: "I need a simple analytics tool", postedAt: new Date("2026-09-01T00:00:00Z"), why: "Asks for exactly this.", reply: "Happy to help: we built one for this.", strength: "strong" };
    const f = await world.finds.save(find);
    await world.finds.show(c.id);
    world.chromeOffline.add(c.id);

    expect(await world.finds.act(c.id, f!.id, { kind: "post" })).toBe(QUEUED);
    const card = world.channel.cards.at(-1)!.find;
    expect(findCardHtml(card)).toContain(WAITING);
    expect(findButtons(card).flat().map((b) => b.text)).toEqual(["Edit", "Skip", "I replied"]);

    world.chromeOffline.delete(c.id);
    await world.outbox.kick();
    await world.errands.stop();
    expect(world.poster.posts[0]?.post).toMatchObject({ platform: "browser", kind: "reply", url: find.url });
    expect((await world.findStore.get(f!.id))?.sentAt).not.toBeNull();
  });

  it("at start, takes what a stopped machine left sending as done, never to be sent again by itself", async () => {
    const { world, c, draft } = await closedChrome();
    await world.drafts.act(c.id, draft.id, "post");
    await world.outboxStore.claim(world.outboxStore.items[0]!.id);
    expect(await world.outbox.recover()).toBe(1);
    expect(world.outboxStore.items[0]).toMatchObject({ status: "done", reason: expect.stringContaining("uncertain") });
  });
});
