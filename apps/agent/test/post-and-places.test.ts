import { AIMessage } from "@langchain/core/messages";
import { fakeModel } from "@langchain/core/testing";
import { ReadError, placeKey, taskId, type NewFind, type NewPlace, type PageComment } from "@mq/core";
import { describe, expect, it } from "vitest";
import { ReplyWatch, WATCH_AFTER_HOURS } from "../src/finds/reply-watch.ts";
import { silentLogger } from "../src/infra/system.ts";
import { explorerSpec } from "../src/tasks/explorer.ts";
import { saveFindTool, scoutSpec } from "../src/tasks/scout.ts";
import { SeenPages } from "../src/tasks/seen-pages.ts";
import type { SubagentContext } from "../src/tasks/subagents.ts";
import { findButtons, findCardHtml, parseFindData } from "../src/telegram/find-card.ts";
import { FakeReach } from "./fakes.ts";
import { makeWorld, telegramSender } from "./world.ts";

// Each card its own message (`cards`), as before Your move (asks/deck.ts): cards already in a chat still work so.

type World = ReturnType<typeof makeWorld>;

const THREAD = "https://www.reddit.com/r/SaaS/comments/abc123/need_a_form_tool/";
/** Where the fake Chrome says the first find's reply went up. */
const POSTED = "https://www.reddit.com/r/SaaS/comments/abc1/comment/new1/";
const REPLY = "Tally's free plan covers waitlists with no response cap, which is what most people here switch for. I work on Tally, so weigh that.";

const customerIn = (world: World) => world.customers.create({ channel: telegramSender().channel, userRef: "42", displayName: "Dana", language: "en" });

const redditFind = (customerId: NewFind["customerId"], n: number, over: Partial<NewFind> = {}): NewFind => ({
  customerId,
  taskId: null,
  source: "reddit:r/SaaS",
  url: `https://www.reddit.com/r/SaaS/comments/abc${n}/need_a_form_tool/`,
  author: "sam",
  title: "Need a form tool that isn't Typeform",
  quote: "Looking for a cheaper Typeform alternative for my waitlist.",
  postedAt: new Date("2026-09-20T10:00:00Z"),
  why: "Wants a cheaper form tool for a waitlist.",
  reply: REPLY,
  strength: "strong",
  replyTo: `t1_c${n}`,
  ...over,
});

/** A Reddit find on a card in front of the customer. */
async function shownFind(world: World, over: Partial<NewFind> = {}) {
  const c = await customerIn(world);
  const saved = await world.finds.save(redditFind(c.id, 1, over));
  await world.finds.show(c.id);
  return { c, f: (await world.findStore.get(saved!.id))! };
}

const contextFor = (world: World, customerId: SubagentContext["customerId"]): SubagentContext => ({
  customerId,
  taskId: taskId("00000000-0000-0000-0000-000000000003"),
  reader: world.reader,
  posts: world.posts,
  customer: () => world.customers.get(customerId),
  finds: world.finds,
  places: world.places,
});

describe("Post it", () => {
  it("posts the reply from the customer's Chrome on their tap, once, and the card shows where it went", async () => {
    const world = makeWorld({}, { cards: true });
    const { c, f } = await shownFind(world);
    expect(findButtons(f).map((row) => row.map((b) => b.text))).toEqual([["Post it", "Edit"], ["Keep", "Skip", "I replied"]]);
    expect(parseFindData(findButtons(f)[0]![0]!.callback_data)).toEqual({ findId: f.id, action: { kind: "post" } });

    let release!: () => void;
    world.poster.hold = new Promise((r) => (release = r));
    expect(await world.finds.act(c.id, f.id, { kind: "post" })).toBe("Posting it from your Chrome…");
    expect(await world.finds.act(c.id, f.id, { kind: "post" })).toBe("Already posting it"); // a double tap
    expect(world.errands.busy).toBe(true); // the agent does not sleep mid-post
    release();
    await world.errands.stop();

    expect(world.poster.posts).toEqual([{ customerId: c.id, post: { platform: "reddit", url: f.url, parent: "t1_c1", text: REPLY } }]);
    const posted = await world.findStore.get(f.id);
    expect(posted).toMatchObject({ status: "replied", sentAs: "dana_builds", sentUrl: POSTED });
    const card = world.channel.cards.at(-1)!;
    expect(card).toMatchObject({ ref: f.cardRef, redraw: true });
    expect(findCardHtml(card.find)).toContain(`Posted as u/dana_builds: <a href="${POSTED}">see it</a>`);
    expect(findButtons(card.find)).toEqual([]);

    expect(await world.finds.act(c.id, f.id, { kind: "post" })).toBe("Already posted");
    expect(world.poster.posts).toHaveLength(1);
  });

  it("keeps Post it on a kept card", async () => {
    const world = makeWorld({}, { cards: true });
    const { c, f } = await shownFind(world);
    await world.finds.act(c.id, f.id, { kind: "decide", decision: "kept" });
    const kept = (await world.findStore.get(f.id))!;
    expect(findButtons(kept).map((row) => row.map((b) => b.text))).toEqual([["Post it", "Edit"]]);

    await world.finds.act(c.id, f.id, { kind: "post" });
    await world.errands.stop();
    expect((await world.findStore.get(f.id))?.status).toBe("replied");
  });

  it("says in the chat what stopped a post, in words they can act on, and leaves the card as it was", async () => {
    const world = makeWorld({}, { cards: true });
    const { c, f } = await shownFind(world);
    world.poster.failWith = { reason: "login", message: "this Chrome is not logged in to Reddit" };

    await world.finds.act(c.id, f.id, { kind: "post" });
    await world.errands.stop();

    expect(world.channel.sent.at(-1)?.text).toBe(
      "I couldn't post your reply to sam on Reddit (r/SaaS): this Chrome isn't logged in to Reddit. Log in at reddit.com in Chrome, then tap Post it again.",
    );
    expect((await world.findStore.get(f.id))?.status).toBe("shown");

    world.poster.failWith = { reason: "refused", message: "that thread is locked (THREAD_LOCKED)" };
    await world.finds.act(c.id, f.id, { kind: "post" });
    await world.errands.stop();
    expect(world.channel.sent.at(-1)?.text).toBe(
      'Reddit didn\'t take your reply to sam on Reddit (r/SaaS): "that thread is locked (THREAD_LOCKED)". The text is still waiting in Your move if you\'d rather post it yourself.',
    );
  });

  it("posts a Hacker News find through the generic browser, and replies have no day limit", async () => {
    const world = makeWorld({}, { cards: true });
    const { c, f } = await shownFind(world, { source: "hackernews", url: "https://news.ycombinator.com/item?id=9", replyTo: null });
    expect(findButtons(f).map((row) => row.map((b) => b.text))).toEqual([["Post it", "Edit"], ["Keep", "Skip", "I replied"]]);
    expect(await world.finds.act(c.id, f.id, { kind: "post" })).toBe("Posting it from your Chrome…");
    await world.errands.stop();
    expect(world.poster.posts[0]?.post).toMatchObject({ platform: "browser", kind: "reply", url: f.url, target: f.url, text: f.reply, quote: f.quote });
    const sent = await world.findStore.get(f.id);
    expect(sent).toMatchObject({ status: "replied", postState: "posted", sentAs: "connected account" });
    // The browser knows no account name; the card says only that it went up.
    expect(findCardHtml(sent!)).toContain(`Posted: <a href="`);
    // Watched for answers like a Reddit reply, off the post itself (reply-watch.ts, answersPage).
    expect(world.findStore.watches.has(f.id)).toBe(true);

    for (let n = 2; n < 30; n++) {
      const posted = await world.findStore.add(redditFind(c.id, n));
      await world.findStore.markSent(posted!.id, `${posted!.url}comment/x/`, "dana_builds");
    }
    const next = await world.findStore.add(redditFind(c.id, 50));
    await world.findStore.markShown(next!.id, "900");
    expect(await world.finds.act(c.id, next!.id, { kind: "post" })).toBe("Posting it from your Chrome…");
    await world.errands.stop();
    expect(world.poster.posts).toHaveLength(2);
  });

  it("answers the comment whose words it quotes, or else the post", async () => {
    const world = makeWorld({}, { cards: true });
    const c = await customerIn(world);
    const seen = new SeenPages();
    const save = saveFindTool(contextFor(world, c.id), seen, () => new Date("2026-09-26T00:00:00Z"));
    seen.record(THREAD, "Need a form tool. Looking for a cheaper Typeform alternative for my waitlist.\n- u/lee: Same here, our survey tool doubled its price this year.", {
      source: "reddit:r/SaaS",
      author: "dana_builds",
      postedAt: new Date("2026-09-20"),
      ref: "t3_abc123",
      comments: [{ author: "lee", postedAt: new Date("2026-09-21"), text: "Same here, our survey tool doubled its price this year.", ref: "t1_lee1" }],
    });
    const args = { url: THREAD, why: "Wants a cheaper form tool.", reply: REPLY, strength: "strong" as const };

    await save.invoke({ ...args, quote: "our survey tool doubled its price this year" });
    await save.invoke({ ...args, url: `${THREAD}?x=1`, quote: "Looking for a cheaper Typeform alternative" });
    const finds = [...world.findStore.finds.values()];
    expect(finds.map((f) => [f.author, f.replyTo])).toEqual([["lee", "t1_lee1"]]); // one post, one card

    const other = "https://www.reddit.com/r/SaaS/comments/zzz9/forms/";
    seen.record(other, "Looking for a cheaper Typeform alternative for my waitlist, anyone?", { source: "reddit:r/SaaS", author: "kim", ref: "t3_zzz9" });
    await save.invoke({ ...args, url: other, quote: "Looking for a cheaper Typeform alternative for my waitlist" });
    expect([...world.findStore.finds.values()].at(-1)?.replyTo).toBe("t3_zzz9");
  });
});

describe("places", () => {
  const place = (customerId: NewPlace["customerId"], over: Partial<NewPlace> = {}): NewPlace => ({
    customerId,
    key: "reddit:r/nocode",
    name: "r/nocode",
    url: "https://www.reddit.com/r/nocode/",
    verdict: "search",
    rules: "Rule 3: no self-promotion posts; helpful replies are fine.",
    why: "Builders ask which form tool to use every week.",
    ...over,
  });

  it("files a place under one key, however its address is spelled", () => {
    expect(placeKey("https://old.reddit.com/r/NoCode/about/rules/")).toBe("reddit:r/nocode");
    expect(placeKey("https://www.reddit.com/r/nocode/comments/abc/x/")).toBe("reddit:r/nocode");
    expect(placeKey("https://www.indiehackers.com/group/no-code")).toBe("indiehackers.com");
    expect(placeKey("https://www.reddit.com/search/?q=x")).toBeNull();
    expect(placeKey("not a url")).toBeNull();
  });

  it("files only places the explorer opened a page in during its task", async () => {
    const world = makeWorld({}, { cards: true });
    const c = await customerIn(world);
    const tools = explorerSpec().tools(contextFor(world, c.id));
    const tool = (name: string) => tools.find((t) => t.name === name)!;
    const args = { url: "https://www.reddit.com/r/nocode/", name: "r/nocode", verdict: "search" as const, rules: "No self-promotion posts — helpful replies are fine.", why: "Builders ask which form tool to use every week." };

    expect(await tool("save_place").invoke(args)).toBe("Not filed: you have not opened a page in r/nocode in this task. Open its rules (or its front page) with read_page first, then file it.");
    await tool("read_page").invoke({ url: "https://www.reddit.com/r/NoCode/about/rules/" });
    expect(await tool("save_place").invoke(args)).toBe("Filed r/nocode as search.");
    expect(await tool("save_place").invoke({ ...args, verdict: "avoid" })).toBe("Updated r/nocode: now avoid.");

    expect(world.places.places).toEqual([expect.objectContaining({ key: "reddit:r/nocode", verdict: "avoid", rules: "No self-promotion posts, helpful replies are fine." })]);
  });

  it("drops waiting finds from a place it files as avoid, and leaves the cards already shown", async () => {
    const world = makeWorld({}, { cards: true });
    const c = await customerIn(world);
    const inSmallBiz = (n: number) => redditFind(c.id, n, { source: "reddit:r/smallbusiness", url: `https://www.reddit.com/r/smallbusiness/comments/sb${n}/forms/` });
    const shown = await world.findStore.add(inSmallBiz(1));
    await world.findStore.markShown(shown!.id, "800");
    const waiting = await world.findStore.add(inSmallBiz(2));
    const elsewhere = await world.findStore.add(redditFind(c.id, 3));
    const tools = explorerSpec().tools(contextFor(world, c.id));
    await tools.find((t) => t.name === "read_page")!.invoke({ url: "https://www.reddit.com/r/smallbusiness/about/rules/" });

    const said = await tools.find((t) => t.name === "save_place")!.invoke({
      url: "https://www.reddit.com/r/smallbusiness/",
      name: "r/smallbusiness",
      verdict: "avoid",
      rules: '"No links, product recommendations, unsolicited advice."',
      why: "Owners ask for form builders, but product recommendations are banned.",
    });

    expect(said).toBe("Filed r/smallbusiness as avoid. 1 waiting find from there will not be shown.");
    expect([...world.findStore.finds.keys()].sort()).toEqual([shown!.id, elsewhere!.id].sort());
    expect(waiting).not.toBeNull();
  });

  it("starts the explorer from the brief and the list so far", async () => {
    const world = makeWorld({}, { cards: true });
    const c = await customerIn(world);
    await world.customers.update(c.id, { brief: "Tally: free form builder for makers." });
    await world.places.save(place(c.id));

    const opening = await explorerSpec().opening!(contextFor(world, c.id));

    expect(opening).toContain("THE QUEST: people for what they built");
    expect(opening).toContain("Tally: free form builder for makers.");
    expect(opening).toContain("PLACES ALREADY ON THEIR LIST\n- r/nocode (search): Rule 3: no self-promotion posts; helpful replies are fine.");
  });

  it("points the scout at the places to search, and saves nothing from a place to avoid", async () => {
    const world = makeWorld({}, { cards: true });
    const c = await customerIn(world);
    await world.places.save(place(c.id));
    await world.places.save(place(c.id, { key: "reddit:r/saas", name: "r/SaaS", url: "https://www.reddit.com/r/SaaS/", verdict: "avoid", rules: "No self-promotion of any kind." }));

    const opening = await scoutSpec().opening!(contextFor(world, c.id));
    expect(opening).toContain("PLACES TO SEARCH FIRST (their rules were checked; follow what they say)\n- r/nocode (https://www.reddit.com/r/nocode/): Rule 3");
    expect(opening).toContain("AVOID (their rules forbid messages like the customer's: nothing found there can be saved)\n- r/SaaS (https://www.reddit.com/r/SaaS/): No self-promotion of any kind.");

    const seen = new SeenPages();
    seen.record(THREAD, "Looking for a cheaper Typeform alternative for my waitlist.", { source: "reddit:r/SaaS", author: "sam", postedAt: new Date("2026-09-20") });
    const save = saveFindTool(contextFor(world, c.id), seen, () => new Date("2026-09-26T00:00:00Z"));
    expect(await save.invoke({ url: THREAD, quote: "Looking for a cheaper Typeform alternative", why: "Wants a cheaper form tool.", reply: REPLY, strength: "strong" })).toBe(
      "Not saved: r/SaaS is on the customer's avoid list (No self-promotion of any kind.). Skip it and look elsewhere.",
    );
    expect(world.findStore.finds.size).toBe(0);
  });

  it("shows the manager the list, and when it was last explored", async () => {
    const manager = fakeModel().respond(new AIMessage("Noted."));
    const world = makeWorld({ manager }, { cards: true });
    const c = await customerIn(world);
    await world.places.save(place(c.id));
    await world.places.save(place(c.id, { key: "reddit:r/saas", name: "r/SaaS", verdict: "avoid" }));
    await world.places.save(place(c.id, { key: "community.shopify.com", name: "Shopify Community", verdict: "login" }));
    world.clock.advance(3 * 86_400_000);
    await world.events.push(c.id, { kind: "heartbeat" });

    await world.manager.serveNext();

    const briefing = String(manager.calls[0]!.messages.at(-1)!.content);
    expect(briefing).toContain("Places: 1 to search (r/nocode); 1 to avoid (r/SaaS); 1 members only (Shopify Community). Last explored 3 days ago.");
  });
});

describe("answers to a posted reply", () => {
  const HOUR = 3_600_000;

  function watchIn(world: World, online: () => boolean = () => true) {
    const woke: number[] = [];
    const watch = new ReplyWatch(
      { finds: world.findStore, reach: new FakeReach(world.reader, world.posts), online, events: world.events, memory: world.memory, results: world.results, routes: world.routes, wakeManager: () => void woke.push(1), clock: world.clock, log: silentLogger },
      { everyMs: 60_000 },
    );
    return { watch, woke };
  }

  /** The thread as Quest's Chrome reads it at the posted reply's address. */
  function threadWith(world: World, comments: PageComment[]): void {
    world.reader.pages[POSTED] = { url: POSTED, title: "Need a form tool", description: null, text: "…", comments };
  }

  async function posted(world: World) {
    const { c, f } = await shownFind(world);
    await world.finds.act(c.id, f.id, { kind: "post" });
    await world.errands.stop();
    return { c, f };
  }

  const at = new Date("2026-09-25T13:00:00Z");
  const MINE: PageComment = { author: "dana_builds", postedAt: at, text: REPLY, ref: "t1_new1", parentRef: "t1_c1" };

  it("looks again an hour after posting, tells the manager who answered, and never tells the same answer twice", async () => {
    const world = makeWorld({}, { cards: true });
    const { c, f } = await posted(world);
    threadWith(world, [
      MINE,
      { author: "sam", postedAt: at, text: "Oh nice, does the free plan take file uploads?", ref: "t1_a1", parentRef: "t1_new1" },
      { author: "AutoModerator", postedAt: at, text: "Your comment is under review.", ref: "t1_bot", parentRef: "t1_new1" },
      { author: "lee", postedAt: at, text: "Not an answer to Dana at all.", ref: "t1_x", parentRef: "t1_c1" },
    ]);
    const { watch, woke } = watchIn(world);

    expect(await watch.tick()).toBe(0); // not an hour yet
    expect(world.reader.reads).not.toContain(POSTED);

    world.clock.advance(HOUR);
    expect(await watch.tick()).toBe(1);
    const note = world.events.events.at(-1)!.event;
    expect(note).toMatchObject({ kind: "system", topic: "answers" });
    const text = note.kind === "system" ? note.text : "";
    expect(text).toContain(`Someone answered the reply the customer posted with Post it on Reddit (r/SaaS) (${POSTED}).`);
    expect(text).toContain('- u/sam (the person they answered) on 2026-09-25 (https://www.reddit.com/r/SaaS/comments/abc1/comment/a1/): "Oh nice, does the free plan take file uploads?"');
    expect(text).not.toMatch(/AutoModerator|Not an answer/);
    expect(woke).toHaveLength(1);
    expect(world.findStore.watches.get(f.id)).toEqual({ next: new Date(world.clock.t - HOUR + 6 * HOUR), checks: 1, seen: ["t1_a1"] });

    world.clock.advance(5 * HOUR);
    expect(await watch.tick()).toBe(0); // the same answer, already told
    expect(world.events.events.filter((e) => e.customerId === c.id && e.event.kind === "system" && e.event.topic === "answers")).toHaveLength(1);
    // Someone talking back is a result on record, and the posting route working.
    expect(world.results.rows).toMatchObject([{ stage: "conversation", person: "u/sam", source: "system", url: "https://www.reddit.com/r/SaaS/comments/abc1/comment/a1/" }]);
    expect(await world.routes.get(c.id, "Reddit posts and replies")).toMatchObject({ status: "working", wins: 1, misses: 0 });
  });

  it("calls the posting route spent after the second reply taken down in a row, and says to change course", async () => {
    const world = makeWorld({}, { cards: true });
    const { c } = await posted(world);
    await world.routes.log(c.id, "Reddit posts and replies", "failed", "a reply taken down in r/test");
    world.reader.pages[POSTED] = { url: POSTED, title: "Need a form tool", description: null, text: "…", comments: [], gone: ["t1_new1"] };
    const { watch } = watchIn(world);

    world.clock.advance(WATCH_AFTER_HOURS[0] * HOUR);
    await watch.tick();

    const note = world.events.events.at(-1)!.event;
    expect(note.kind === "system" && note.text).toContain('That is 2 in a row taken down on Reddit: the route "Reddit posts and replies" is spent.');
    expect(await world.routes.get(c.id, "reddit posts and replies")).toMatchObject({ status: "spent", tries: 2, misses: 2 });
  });

  it("tells the manager once when the reply was taken down, and stops looking", async () => {
    const world = makeWorld({}, { cards: true });
    const { f } = await posted(world);
    // As r/test's filter left it (live, 2026-09-28): the comment in place, gone to everyone else.
    world.reader.pages[POSTED] = { url: POSTED, title: "Need a form tool", description: null, text: "…", comments: [], gone: ["t1_new1"] };
    const { watch, woke } = watchIn(world);

    world.clock.advance(WATCH_AFTER_HOURS[0] * HOUR);
    await watch.tick();

    const note = world.events.events.at(-1)!.event;
    expect(note).toMatchObject({ kind: "system", topic: "removed" });
    expect(note.kind === "system" && note.text).toContain(`on Reddit (r/SaaS) (${POSTED}) no longer shows to anyone else`);
    expect(woke).toHaveLength(1);
    expect(world.findStore.watches.get(f.id)).toMatchObject({ next: null, checks: 1 });
  });

  it("knows a reply is down when, to a visitor, its own address shows the thread without it", async () => {
    const world = makeWorld({}, { cards: true });
    await posted(world);
    // As r/test's filter left one (live, 2026-10-03): strangers see the thread with zero comments.
    const post = { source: "reddit:r/SaaS", author: "sam", title: "Need a form tool", postedAt: null, ref: "t3_abc1" };
    world.reader.pages[POSTED] = { url: POSTED, title: "Need a form tool", description: null, text: "…", post, comments: [] };
    const { watch } = watchIn(world);

    world.clock.advance(WATCH_AFTER_HOURS[0] * HOUR);
    await watch.tick();

    expect(world.events.events.at(-1)!.event).toMatchObject({ kind: "system", topic: "removed" });
    expect(world.reader.visitorReads).toEqual([POSTED]);
  });

  it("stops after a week of looks", async () => {
    const world = makeWorld({}, { cards: true });
    const { f } = await posted(world);
    threadWith(world, [MINE]);
    const { watch } = watchIn(world);

    for (const hours of WATCH_AFTER_HOURS) {
      world.clock.t = world.findStore.finds.get(f.id)!.sentAt!.getTime() + hours * HOUR;
      await watch.tick();
    }
    expect(world.findStore.watches.get(f.id)).toMatchObject({ next: null, checks: WATCH_AFTER_HOURS.length });
    expect(world.reader.reads.filter((u) => u === POSTED)).toHaveLength(WATCH_AFTER_HOURS.length);
  });

  it("waits for the customer's Chrome to be open, and does not count a look it could not take", async () => {
    const world = makeWorld({}, { cards: true });
    const { f } = await posted(world);
    let open = false;
    const { watch } = watchIn(world, () => open);
    world.clock.advance(HOUR);

    await watch.tick();
    expect(world.reader.reads).not.toContain(POSTED); // closed: not even tried
    open = true;
    world.reader.readPage = async () => {
      throw new ReadError("limit", "this Chrome has read 400 pages today");
    };
    await watch.tick();
    expect(world.findStore.watches.get(f.id)).toMatchObject({ checks: 0 }); // the same look waits for tomorrow's allowance
  });
});
