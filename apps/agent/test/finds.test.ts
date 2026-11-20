import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { fakeModel } from "@langchain/core/testing";
import { findId, taskId, type Find, type FoundPost, type NewFind } from "@mq/core";
import { describe, expect, it } from "vitest";
import { managerTools } from "../src/manager/tools.ts";
import { age, findButtons, findCardHtml, parseFindData } from "../src/telegram/find-card.ts";
import { parseUpdate } from "../src/telegram/updates.ts";
import { readingTools } from "../src/tasks/researcher.ts";
import { JUDGE_NOW, SAVE_FIRST, saveFindTool, SEARCHES, scoutSpec } from "../src/tasks/scout.ts";
import { quoteAppears, SeenPages } from "../src/tasks/seen-pages.ts";
import type { SubagentContext } from "../src/tasks/subagents.ts";
import { makeWorld, telegramSender } from "./world.ts";

// Each card its own message (`cards`), as before Your move (asks/deck.ts): cards already in a chat still work so.

/** A reply that helps before it mentions the product: what save_find takes. */
const HELPFUL = "Cookie-free analytics needs no banner at all, since nothing personal is stored. We built one for exactly this, hosted in the EU.";

const post = (over: Partial<FoundPost> = {}): FoundPost => ({
  source: "hackernews",
  url: "https://news.ycombinator.com/item?id=41",
  author: "macro-b",
  title: "Ask HN: analytics without cookie banners?",
  text: "I would like to avoid bugging users with cookie banners and consent forms. Any privacy friendly analytics hosted in the EU?",
  postedAt: new Date("2026-09-20T10:00:00Z"),
  replies: 3,
  ...over,
});

async function customerIn(world: ReturnType<typeof makeWorld>) {
  return world.customers.create({ channel: telegramSender().channel, userRef: "42", displayName: "Dana", language: "en" });
}

const newFind = (customerId: NewFind["customerId"], n: number, over: Partial<NewFind> = {}): NewFind => ({
  customerId,
  taskId: null,
  source: "hackernews",
  url: `https://news.ycombinator.com/item?id=${n}`,
  author: `person${n}`,
  title: null,
  quote: `I need a simple analytics tool, number ${n}`,
  postedAt: new Date(Date.parse("2026-09-01T00:00:00Z") + n * 86_400_000),
  why: "Asks for exactly this.",
  reply: "Happy to help: we built one for this.",
  strength: "strong",
  ...over,
});

describe("quotes", () => {
  it("accepts the person's words however they are spaced, cased or cut, and nothing else", () => {
    const page = "I would like to avoid bugging users with cookie banners and consent forms. Any privacy friendly analytics hosted in the EU?";
    expect(quoteAppears("I would like to avoid bugging users with cookie banners", page)).toBe(true);
    expect(quoteAppears("“i would like to AVOID bugging users”… any privacy friendly analytics", page)).toBe(true);
    expect(quoteAppears("I would like to avoid cookie banners and trackers", page)).toBe(false); // a paraphrase
    expect(quoteAppears("analytics", page)).toBe(false); // too short to be anyone's words
  });
});

describe("save_find", () => {
  function scoutContext(world: ReturnType<typeof makeWorld>, customerId: SubagentContext["customerId"]): SubagentContext {
    return {
      customerId,
      taskId: taskId("00000000-0000-0000-0000-000000000001"),
      reader: world.reader,
      posts: world.posts,
      customer: () => world.customers.get(customerId),
      finds: world.finds,
      places: world.places,
    };
  }

  it("saves only posts seen in this run, with their own words, from the past year, once", async () => {
    const world = makeWorld({}, { cards: true });
    const c = await customerIn(world);
    const seen = new SeenPages();
    const save = saveFindTool(scoutContext(world, c.id), seen, () => new Date("2026-09-26T00:00:00Z"));
    const args = { url: post().url, quote: "avoid bugging users with cookie banners and consent forms", why: "Wants EU-hosted cookie-free analytics.", reply: HELPFUL, strength: "strong" as const };

    expect(await save.invoke(args)).toMatch(/^Not saved: you have not seen/);
    seen.record(post().url, post().text, post());
    expect(await save.invoke({ ...args, quote: "I hate Google Analytics with a passion" })).toMatch(/^Not saved: the quote must be/);
    expect(await save.invoke({ ...args, url: `${post().url}#top` })).toBe("Saved (1 in this task).");
    seen.record("https://news.ycombinator.com/item?id=42", "Same person again, asking about analytics once more", { source: "hackernews", author: "Macro-B" });
    expect(await save.invoke({ ...args, url: "https://news.ycombinator.com/item?id=42", quote: "asking about analytics once more" })).toMatch(/One card per person/);
    // A later task, same post: the customer already has it.
    const later = saveFindTool(scoutContext(world, c.id), seen, () => new Date("2026-09-26T00:00:00Z"));
    expect(await later.invoke(args)).toMatch(/already has that post/);

    const [saved] = [...world.findStore.finds.values()];
    expect(saved).toMatchObject({ source: "hackernews", author: "macro-b", url: post().url, strength: "strong" });
    expect(saved?.postedAt?.toISOString()).toBe("2026-09-20T10:00:00.000Z"); // from the search, not the scout's say-so

    seen.record("https://news.ycombinator.com/item?id=7", "old words from someone long ago asking", { postedAt: new Date("2024-01-01") });
    expect(await save.invoke({ ...args, url: "https://news.ycombinator.com/item?id=7", quote: "old words from someone long ago" })).toMatch(/older than 365 days/);
  });

  it("names the person who wrote the words, a commenter as much as the poster, and wants a reply that helps", async () => {
    const world = makeWorld({}, { cards: true });
    const c = await customerIn(world);
    const seen = new SeenPages();
    const save = saveFindTool(scoutContext(world, c.id), seen, () => new Date("2026-09-28T00:00:00Z"));
    const thread = "https://www.reddit.com/r/nocode/comments/1w5mqwf/looking_for_a_simpler_jotform_alternative/";
    // As read_page records a Reddit thread (live, 2026-09-28): the post by one person, a reply by another.
    seen.record(thread, "Looking for a simpler Jotform alternative\nJotform feels heavy for our small team.\n- u/jordanmiller81 (2026-09-03): I'm actually looking for an alternative too", {
      source: "reddit:r/nocode",
      author: "driftmoose88",
      title: "Looking for a simpler Jotform alternative",
      postedAt: new Date("2026-09-02T09:00:00Z"),
      comments: [{ author: "jordanmiller81", postedAt: new Date("2026-09-03T12:00:00Z"), text: "I'm actually looking for an alternative too" }],
    });
    const ask = { url: thread, quote: "I'm actually looking for an alternative too", why: "Also looking for a Jotform alternative.", strength: "maybe" as const, author: "driftmoose88" };

    expect(await save.invoke({ ...ask, reply: "I'm on the team at Tally." })).toMatch(/^Not saved: that message is too thin/);
    expect(await save.invoke({ ...ask, reply: HELPFUL })).toBe("Saved (1 in this task).");

    const [saved] = [...world.findStore.finds.values()];
    expect(saved).toMatchObject({ author: "jordanmiller81", title: "Looking for a simpler Jotform alternative", source: "reddit:r/nocode" });
    expect(saved?.postedAt?.toISOString()).toBe("2026-09-03T12:00:00.000Z"); // the reply's date, not the thread's
  });
});

describe("find cards", () => {
  it("shows a few at a time, redraws on each tap, and brings the next one in", async () => {
    const world = makeWorld({}, { cards: true }); // two cards at once
    const c = await customerIn(world);
    for (const n of [1, 2, 3]) await world.finds.save(newFind(c.id, n));

    expect(await world.finds.show(c.id)).toEqual({ shown: 2, sources: "2 from Hacker News", open: 2, waiting: 1 });
    expect(world.channel.cards.map((k) => k.find.author)).toEqual(["person3", "person2"]); // newest post first
    expect(await world.finds.show(c.id)).toEqual({ shown: 0, sources: "", open: 2, waiting: 1 });

    // What they ruled out goes: waiting finds that name it, and its open cards.
    const ruled = makeWorld({}, { cards: true });
    const e = await customerIn(ruled);
    for (const n of [1, 2, 3, 4]) await ruled.finds.save(newFind(e.id, n, n % 2 ? { reply: "I'm on the team at Tally." } : {}));
    await ruled.finds.show(e.id, 1); // the newest, n = 4, not Tally
    await ruled.finds.show(e.id, 1); // n = 3, Tally
    expect(await ruled.finds.dropAbout(e.id, "tally")).toEqual({ dropped: 1, closed: 1 });
    expect((await ruled.findStore.counts(e.id))).toMatchObject({ new: 1, shown: 1, skipped: 1 });

    // Cards left undecided for days stop holding their places.
    const fresh = makeWorld({}, { cards: true });
    const d = await customerIn(fresh);
    for (const n of [1, 2, 3]) await fresh.finds.save(newFind(d.id, n));
    await fresh.finds.show(d.id);
    fresh.clock.advance(4 * 86_400_000);
    expect(await fresh.finds.show(d.id)).toMatchObject({ shown: 1, open: 1, waiting: 0 });

    const first = world.channel.cards[0]!.find;
    expect(await world.finds.act(c.id, first.id, { kind: "decide", decision: "skipped" })).toMatch(/^Skipped/);
    const redrawn = world.channel.cards.find((k) => k.redraw)!;
    expect(redrawn.find.status).toBe("skipped");
    expect(findButtons(redrawn.find).flat().map((b) => b.text)).toEqual(["Not a fit", "Off topic", "Too old", "Other"]);
    expect(world.channel.cards.filter((k) => !k.redraw).map((k) => k.find.author)).toEqual(["person3", "person2", "person1"]);

    expect(await world.finds.act(c.id, first.id, { kind: "reason", reason: "not_my_buyer" })).toMatch(/helps the next search/);
    expect(findButtons((await world.findStore.get(first.id))!)).toEqual([]);
    expect(await world.finds.act(c.id, first.id, { kind: "decide", decision: "kept" })).toBe("Already decided");

    const [, second, third] = world.channel.cards.filter((k) => !k.redraw).map((k) => k.find);
    await world.finds.act(c.id, second!.id, { kind: "decide", decision: "replied" });
    expect(world.events.kinds(c.id)).toEqual([]);
    await world.finds.act(c.id, third!.id, { kind: "decide", decision: "kept" });
    expect(world.events.kinds(c.id)).toEqual(["system"]); // all decided, nothing waiting: the manager hears

    const feedback = await world.finds.feedback(c.id);
    expect(feedback).toContain("1 kept, 1 replied to, 1 skipped");
    expect(feedback).toContain("skipped (not a fit): Hacker News, person3");
  });

  it("never lets one customer decide another's card", async () => {
    const world = makeWorld({}, { cards: true });
    const c = await customerIn(world);
    const other = await world.customers.create({ channel: telegramSender("43").channel, userRef: "43", displayName: "Eve", language: "en" });
    const f = await world.finds.save(newFind(c.id, 1));
    await world.finds.show(c.id);
    expect(await world.finds.act(other.id, f!.id, { kind: "decide", decision: "kept" })).toBe("That one is no longer here");
  });
});

describe("find cards on Telegram", () => {
  const find: Find = {
    ...newFind("c" as never, 1),
    id: findId("5f1d8a2e-0c4b-4c7e-9a51-2d8b6c3e7f10"),
    author: "a<b>",
    quote: 'I need "simple" analytics & no <script>',
    status: "shown",
    skipReason: null,
    replyTo: null,
    cardRef: "700",
    createdAt: new Date(),
    shownAt: new Date(),
    decidedAt: null,
    sentUrl: null,
    sentAs: null,
    sentAt: null,
    sentAlone: false,
  };

  it("draws the post, why it fits and the reply, escaped, with buttons that fit in 64 bytes", () => {
    const html = findCardHtml(find, new Date("2026-09-05T00:00:00Z"));
    expect(html).toContain("<b>Hacker News</b> · a&lt;b&gt; · 3 days ago");
    expect(html).toContain("<blockquote>I need \"simple\" analytics &amp; no &lt;script&gt;</blockquote>");
    expect(html).toContain('<a href="https://news.ycombinator.com/item?id=1">Open the post</a>');
    const buttons = findButtons(find).flat();
    expect(buttons.map((b) => b.text)).toEqual(["Post it", "Edit", "Keep", "Skip", "I replied"]);
    expect(buttons.every((b) => Buffer.byteLength(b.callback_data) <= 64)).toBe(true);
    expect(findCardHtml({ ...find, status: "skipped", skipReason: "too_old" })).toContain("Skipped: too old");
  });

  it("reads a tap back into an action", () => {
    expect(parseFindData(`f:${find.id}:k`)).toEqual({ findId: find.id, action: { kind: "decide", decision: "kept" } });
    expect(parseFindData(`f:${find.id}:o`)).toEqual({ findId: find.id, action: { kind: "reason", reason: "too_old" } });
    expect(parseFindData(`f:${find.id}:z`)).toBeNull();
    const update = parseUpdate({
      update_id: 1,
      callback_query: { id: "cb1", from: { id: 42, is_bot: false, first_name: "Dana" }, data: `f:${find.id}:r`, message: { message_id: 700, chat: { id: 42, type: "private" }, date: 0 } },
    } as never);
    expect(update).toMatchObject({ type: "find", findId: find.id, action: { kind: "decide", decision: "replied" }, ackRef: "cb1" });
  });

  it("says how fresh a post is", () => {
    const now = new Date("2026-09-26T12:00:00Z");
    expect(age(new Date("2026-09-26T08:00:00Z"), now)).toBe("today");
    expect(age(new Date("2026-08-20T00:00:00Z"), now)).toBe("5 weeks ago");
    expect(age(null, now)).toBeNull();
  });
});

describe("the scout's pace", () => {
  function scoutTools(world: ReturnType<typeof makeWorld>, customerId: SubagentContext["customerId"]) {
    const ctx: SubagentContext = {
      customerId,
      taskId: taskId("00000000-0000-0000-0000-000000000002"),
      reader: world.reader,
      posts: world.posts,
      customer: () => world.customers.get(customerId),
      finds: world.finds,
      places: world.places,
    };
    const tools = scoutSpec().tools(ctx);
    const named = (name: string) => tools.find((t) => t.name === name)!;
    return { search: named("search_posts"), read: named("read_page"), save: named("save_find") };
  }

  it("tells it to stop searching and save once it has searched without saving, and ends its searches", async () => {
    const world = makeWorld({}, { cards: true });
    world.posts.results["hackernews"] = [post()];
    const c = await customerIn(world);
    const { search, save } = scoutTools(world, c.id);
    const searchOnce = () => search.invoke({ source: "hackernews", query: "cookie banner analytics" }) as Promise<string>;

    for (let i = 1; i < SEARCHES.nudgeAfter; i++) expect(await searchOnce()).not.toMatch(/saved nothing/);
    expect(await searchOnce()).toMatch(/searched 6 times and saved nothing yet \(8 searches left\)\. Stop searching now/);

    const saved = await save.invoke({ url: post().url, quote: "Any privacy friendly analytics hosted in the EU?", why: "Asks for EU-hosted analytics.", reply: HELPFUL, strength: "strong" });
    expect(saved).toBe("Saved (1 in this task).");
    expect(await searchOnce()).not.toMatch(/saved nothing/); // it saved: no more nagging

    for (let i = SEARCHES.nudgeAfter + 2; i < SEARCHES.max - 2; i++) await searchOnce();
    expect(await searchOnce()).toMatch(/2 searches left in this run\.$/);
    expect(await searchOnce()).toMatch(/1 search left in this run\.$/);
    expect(await searchOnce()).toMatch(/That was your last search in this run/);
    const asked = world.posts.queries.length;
    expect(await searchOnce()).toMatch(/^No more searches in this run: you have searched 14 times/);
    expect(world.posts.queries).toHaveLength(asked); // refused, never run
  });

  it("asks it to judge every page it reads, which the researcher is never asked", async () => {
    const world = makeWorld({}, { cards: true });
    const c = await customerIn(world);
    const { read } = scoutTools(world, c.id);
    expect(await read.invoke({ url: "https://example.com/thread" })).toMatch(new RegExp(`${JUDGE_NOW.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
    const researcherRead = readingTools(world.reader).find((t) => t.name === "read_page")!;
    expect(await researcherRead.invoke({ url: "https://example.com/thread" })).not.toContain("Judge this now");
  });

  it("is told near the end of its steps to save first, and does", async () => {
    // Tool calls as plain messages: respondWithTools echoes its whole input as text, which
    // doubles every step and, over two dozen steps, sets off summarization.
    const call = (n: number, name: string, args: Record<string, unknown>) => new AIMessage({ content: "", tool_calls: [{ id: `c${n}`, name, args }] });
    let researcher = fakeModel();
    for (let i = 0; i < 24; i++) researcher = researcher.respond(call(i, "search_posts", { source: "hackernews", query: `analytics ${i}` }));
    researcher = researcher
      .respond(
        call(24, "save_find", {
          url: post().url,
          quote: "Any privacy friendly analytics hosted in the EU?",
          why: "Asks for EU-hosted analytics.",
          reply: HELPFUL,
          strength: "strong",
        }),
      )
      .respond(new AIMessage("Saved 1 find from Hacker News."));
    const world = makeWorld({ researcher }, { cards: true });
    world.posts.results["hackernews"] = [post()];
    const c = await customerIn(world);
    const task = await world.tasks.start(c.id, "scout", "Find people", "Find people who want cookie-free analytics.");

    await world.runner.runNext();

    expect((await world.taskStore.get(task.id))?.status).toBe("succeeded");
    expect(world.posts.queries).toHaveLength(SEARCHES.max); // the other ten were refused
    const system = (n: number) =>
      researcher.calls[n]!.messages.filter((m): m is SystemMessage => m instanceof SystemMessage).map((m) => m.text).join("\n");
    expect(system(24)).toContain(SAVE_FIRST);
    expect(system(5)).not.toContain(SAVE_FIRST);
    expect([...world.findStore.finds.values()]).toHaveLength(1);
  });
});

describe("the scout at work", () => {
  it("starts from the brief and past decisions, saves what it found, and reports", async () => {
    const researcher = fakeModel()
      .respondWithTools([{ name: "search_posts", args: { source: "hackernews", query: "cookie banner analytics" } }])
      .respondWithTools([
        {
          name: "save_find",
          args: { url: post().url, quote: "Any privacy friendly analytics hosted in the EU?", why: "Asks for EU-hosted analytics.", reply: HELPFUL, strength: "strong" },
        },
      ])
      .respond(new AIMessage("Saved 1 find (1 strong) from Hacker News."));
    const world = makeWorld({ researcher }, { cards: true });
    world.posts.results["hackernews"] = [post()];
    const c = await customerIn(world);
    await world.customers.update(c.id, { brief: "Plausible: cookie-free, EU-hosted web analytics for small businesses." });
    const task = await world.tasks.start(c.id, "scout", "Find people", "Find people who want cookie-free analytics.");

    await world.runner.runNext();

    expect((await world.taskStore.get(task.id))?.status).toBe("succeeded");
    const opening = researcher.calls[0]!.messages.find((m) => m instanceof HumanMessage) as HumanMessage;
    expect(String(opening.content)).toContain("THE CUSTOMER'S BRIEF\nPlausible: cookie-free");
    expect(String(opening.content)).toContain("No finds yet");
    const [saved] = [...world.findStore.finds.values()];
    expect(saved).toMatchObject({ taskId: task.id, author: "macro-b", status: "new", title: "Ask HN: analytics without cookie banners?" });
    expect((await world.taskStore.get(task.id))?.result).toBe(
      "Saved 1 find (1 strong) from Hacker News.\n\nOn record: this task saved 1 find (1 strong, 0 maybe): 1 from Hacker News.",
    );
  });
});

describe("the manager and finds", () => {
  it("writes the brief and shows finds as cards", async () => {
    const world = makeWorld({}, { cards: true });
    const c = await customerIn(world);
    for (const n of [1, 2, 3]) await world.finds.save(newFind(c.id, n));
    let told = 0;
    const tools = Object.fromEntries(
      managerTools({
        ...world,
        customerId: c.id,
        userTurn: false,
        customers: world.customers,
        now: world.clock.now,
        onTold: () => void told++,
      }).map((t) => [t.name, t]),
    );

    expect(await tools["save_brief"]!.invoke({ brief: "Plausible: simple, cookie-free web analytics, EU-hosted, for small businesses." })).toMatch(/Brief saved/);
    expect((await world.customers.get(c.id)).brief).toMatch(/^Plausible/);
    expect(await tools["show_finds"]!.invoke({})).toBe("Showed 2 as cards: 2 from Hacker News. 2 cards are open now; 1 more wait their turn.");
    expect(told).toBe(1);
    expect(await tools["show_finds"]!.invoke({})).toMatch(/^Nothing new shown: 2 cards/);
  });
});

describe("the scout on each quest", () => {
  const contextFor = (world: ReturnType<typeof makeWorld>, customerId: SubagentContext["customerId"]): SubagentContext => ({
    customerId,
    taskId: taskId("00000000-0000-0000-0000-000000000002"),
    reader: world.reader,
    posts: world.posts,
    customer: () => world.customers.get(customerId),
    finds: world.finds,
    places: world.places,
  });

  it("reads what a find is for a founder before it searches", async () => {
    const world = makeWorld({}, { cards: true });
    const c = await customerIn(world);

    const opening = await scoutSpec().opening!(contextFor(world, c.id));

    expect(opening).toMatch(/^THE QUEST: people for what they built \(they are a founder or a builder\)\nWhat a find is: A find is a real person asking for help or for a tool/);
    expect(opening).toContain("The Reddit communities where these people ask");
    expect(opening).toContain("THE CUSTOMER'S BRIEF");
  });

  it("keeps an ask only while it is fresh enough to answer", async () => {
    const world = makeWorld({}, { cards: true });
    const c = await customerIn(world);
    const seen = new SeenPages();
    const save = saveFindTool(contextFor(world, c.id), seen, () => new Date("2026-09-28T00:00:00Z"));
    const url = "https://www.reddit.com/r/forhire/comments/1abc/hiring_product_designer/";
    seen.record(url, "[Hiring] Product designer for a two-month redesign of our booking app, remote, paid hourly.", {
      source: "reddit:r/forhire",
      author: "studio_lena",
      postedAt: new Date("2025-06-20"),
    });
    const args = { url, quote: "Product designer for a two-month redesign of our booking app", why: "A paid remote design project that fits their booking-app work.", reply: HELPFUL, strength: "strong" as const };

    expect(await save.invoke(args)).toMatch(/older than 365 days/);
  });
});
