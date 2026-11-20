import { draftId, draftLabel, placeKey, type Draft, type PageComment } from "@mq/core";
import { systemMessage } from "@mq/i18n";
import { describe, expect, it } from "vitest";
import { PLATFORMS } from "../src/platforms.ts";
import { ReplyWatch } from "../src/finds/reply-watch.ts";
import { silentLogger } from "../src/infra/system.ts";
import { managerTools } from "../src/manager/tools.ts";
import { draftButtons, draftCardHtml, parseDraftData } from "../src/telegram/draft-card.ts";
import { FakeReach } from "./fakes.ts";
import { makeWorld, telegramSender } from "./world.ts";

// Each card its own message (`cards`), as before Your move (asks/deck.ts): cards already in a chat still work so.

type World = ReturnType<typeof makeWorld>;

const COMMENT = "https://www.reddit.com/r/SaaS/comments/abc123/comment/c1/";
/** What the turn showed the manager: an answer under a reply they posted. */
const BRIEFING = `- answers: Someone answered the reply the customer posted.\n- u/sam (${COMMENT}): "Tally works for me, but the free plan caps responses at 100?"`;

async function setUp() {
  const world = makeWorld({}, { cards: true });
  const c = await world.customers.create({ channel: telegramSender().channel, userRef: "42", displayName: "Dana", language: "en" });
  // A post goes only to a community the explorer filed: these, with no rules on file.
  for (const name of ["nocode", "startups", "webdev", "SideProject", "indiehackers"]) {
    const url = `https://www.reddit.com/r/${name}/`;
    await world.places.save({ customerId: c.id, key: placeKey(url)!, name: `r/${name}`, url, verdict: "search", rules: null, why: "they ask there" });
  }
  const tools = Object.fromEntries(
    managerTools({ ...world, customerId: c.id, userTurn: false, customers: world.customers, now: world.clock.now, briefing: BRIEFING }).map((t) => [t.name, t]),
  );
  const draft = (args: Record<string, unknown>) => tools["draft"]!.invoke(args) as Promise<string>;
  const tap = (world: World, id: string, action: "post" | "skip" | "edit", ackRef: string) =>
    world.inbound.handle({ type: "draft", from: telegramSender(), draftId: draftId(id), action, ackRef });
  return { world, c, draft, tap, tools };
}

describe("drafts Quest writes for them to post", () => {
  it("drafts a reply quoting what it read, and posts it from their account only on their tap", async () => {
    const { world, draft, tap } = await setUp();

    expect(
      await draft({ kind: "reply", url: COMMENT, author: "u/sam", quote: "the free plan caps responses at 100", text: "It doesn't — Tally's free plan has no response cap." }),
    ).toMatch(/^Waiting for their OK in the chat, with Post it, Edit and Skip/);
    const [card] = world.channel.drafts;
    expect(card?.draft).toMatchObject({ kind: "reply", target: "t1_c1", author: "sam", quote: "the free plan caps responses at 100", text: "It doesn't, Tally's free plan has no response cap." });
    expect(world.poster.posts).toHaveLength(0);
    expect(draftCardHtml(card!.draft)).toContain("<blockquote>the free plan caps responses at 100</blockquote>");

    await tap(world, card!.draft.id, "post", "cb1");
    await world.errands.stop();
    expect(world.channel.acks.at(-1)).toEqual({ ackRef: "cb1", text: "Posting it from your Chrome…" });
    expect(world.poster.posts[0]?.post).toEqual({ platform: "reddit", url: COMMENT, parent: "t1_c1", text: "It doesn't, Tally's free plan has no response cap." });
    const redrawn = world.channel.drafts.at(-1)!;
    expect(redrawn).toMatchObject({ redraw: true, draft: { status: "posted", sentAs: "dana_builds" } });
    expect(draftButtons(redrawn.draft)).toEqual([]);

    await tap(world, card!.draft.id, "post", "cb2");
    expect(world.channel.acks.at(-1)?.text).toBe("Already posted");
  });

  it("quotes only words it read, and keeps posts out of communities on the avoid list", async () => {
    const { world, c, draft } = await setUp();

    expect(await draft({ kind: "reply", url: COMMENT, quote: "Typeform is too expensive", text: "Try Tally." })).toMatch(/^Not drafted: that quote is not in anything you read/);
    // A quote it read, under a thread it did not: a made-up address.
    expect(await draft({ kind: "reply", url: "https://www.reddit.com/r/SaaS/comments/zzz999/caps/", quote: "the free plan caps responses at 100", text: "No cap." })).toMatch(
      /^Not drafted: that thread is not in anything you read this turn/,
    );
    await world.places.save({ customerId: c.id, key: placeKey("https://www.reddit.com/r/SaaS/")!, name: "r/SaaS", url: "https://www.reddit.com/r/SaaS/", verdict: "avoid", rules: "no self-promotion", why: "rules" });
    expect(await draft({ kind: "post", community: "r/SaaS", title: "Forms", text: "What do you use?" })).toBe("Not drafted: r/SaaS is on their avoid list (no self-promotion): no post goes there. Nothing was written and no card exists: never tell them it is written or waiting.");
    // Three refused in a turn, and it stops drafting until the next one (live: the same four asked for six times).
    expect(await draft({ kind: "message", to: "sam", text: "Hi" })).toBe("Not drafted: 3 drafts were refused this turn, so no more until your next one. Tell them only what is on a card.");
    expect(await (await setUp()).draft({ kind: "message", to: "sam", text: "Hi" })).toMatch(/^Not drafted: a message needs who it is for \(u\/name\) and a subject/);
    expect(world.channel.drafts).toHaveLength(0);
  });

  it("drafts a post and a message, each with its own button, and lets them skip", async () => {
    const { world, draft, tap } = await setUp();

    await draft({ kind: "post", community: "r/nocode", title: "What do you use for waitlist forms?", text: "Building a waitlist and comparing form tools." });
    await draft({ kind: "message", to: "u/sam", title: "Your question about response caps", quote: "the free plan caps responses at 100", url: COMMENT, text: "Hi Sam, saw your comment." });
    const [post, message] = world.channel.drafts.map((d) => d.draft);
    expect(post).toMatchObject({ kind: "post", target: "nocode", url: "https://www.reddit.com/r/nocode/", title: "What do you use for waitlist forms?" });
    expect(message).toMatchObject({ kind: "message", target: "sam", title: "Your question about response caps" });
    expect(draftButtons(message!)[0]?.map((b) => b.text)).toEqual(["Send it", "Edit", "Skip"]);
    expect(draftCardHtml(message!)).toContain("<b>Subject:</b> Your question about response caps");
    expect(parseDraftData(draftButtons(post!)[0]![0]!.callback_data)).toEqual({ draftId: post!.id, action: "post" });

    await tap(world, post!.id, "post", "p1");
    await tap(world, message!.id, "skip", "m1");
    await world.errands.stop();
    expect(world.poster.posts.map((p) => p.post)).toEqual([
      { platform: "reddit", kind: "post", url: "https://www.reddit.com/r/nocode/", community: "nocode", title: "What do you use for waitlist forms?", text: "Building a waitlist and comparing form tools." },
    ]);
    expect(world.channel.drafts.at(-1)?.draft.status).toBe("skipped");
  });

  it("looks again at a draft reply and a draft post once they are up, and tells the manager who answered, once", async () => {
    const { world, draft, tap } = await setUp();
    await draft({ kind: "reply", url: COMMENT, author: "u/sam", quote: "the free plan caps responses at 100", text: "It has no response cap." });
    await draft({ kind: "post", community: "r/nocode", title: "Waitlist forms?", text: "What do you use?" });
    await draft({ kind: "message", to: "u/sam", title: "Hi", text: "Hi Sam" });
    for (const { draft: d } of [...world.channel.drafts]) await tap(world, d.id, "post", `t-${d.id}`);
    await world.errands.stop();
    expect(world.draftStore.watches.size).toBe(2); // the reply and the post; a message's answers go to their inbox

    const at = world.clock.now();
    const page = (url: string, comments: PageComment[]) => (world.reader.pages[url] = { url, title: "t", description: null, text: "…", comments });
    page("https://www.reddit.com/r/SaaS/comments/abc123/comment/new1/", [
      { author: "dana_builds", postedAt: at, text: "It has no response cap.", ref: "t1_new1", parentRef: "t1_c1" },
      { author: "sam", postedAt: at, text: "Oh nice, does it take file uploads?", ref: "t1_a1", parentRef: "t1_new1" },
    ]);
    page("https://www.reddit.com/r/nocode/comments/p1/waitlist_forms_/", [
      { author: "lee", postedAt: at, text: "Tally, free and no caps.", ref: "t1_b1", parentRef: null },
      { author: "AutoModerator", postedAt: at, text: "Remember the rules.", ref: "t1_bot", parentRef: null },
      { author: "dana_builds", postedAt: at, text: "Thanks!", ref: "t1_m1", parentRef: "t1_b1" },
      { author: "kim", postedAt: at, text: "How about Jotform?", ref: "t1_k1", parentRef: "t1_m1" },
    ]);
    const watch = new ReplyWatch(
      { finds: world.findStore, drafts: world.draftStore, reach: new FakeReach(world.reader, world.posts), online: () => true, events: world.events, memory: world.memory, wakeManager: () => undefined, clock: world.clock, log: silentLogger },
      { everyMs: 60_000 },
    );

    world.clock.advance(20 * 60_000);
    expect(await watch.tick()).toBe(3); // sam under the reply; lee and kim on the post
    const told = world.events.events.flatMap((e) => (e.event.kind === "system" && e.event.topic === "answers" ? [e.event.text] : []));
    expect(told[0]).toContain("Someone answered the reply the customer posted with Post it on Reddit (r/SaaS)");
    expect(told[0]).toContain('- u/sam (the person they answered) on');
    expect(told[1]).toContain("2 people answered the post the customer put up with Post it on Reddit (r/nocode)");
    expect(told[1]).toContain('Their post was: "Waitlist forms?: What do you use?"');
    expect(told[1]).toContain('(https://www.reddit.com/r/nocode/comments/p1/comment/k1/): "How about Jotform?"');

    // Read as a visitor: logged in, Reddit shows the customer their own removed comment as if it were up.
    expect(world.reader.visitorReads).toEqual(["https://www.reddit.com/r/SaaS/comments/abc123/comment/new1/", "https://www.reddit.com/r/nocode/comments/p1/waitlist_forms_/"]);

    world.clock.advance(6 * 3_600_000);
    expect(await watch.tick()).toBe(0);
  });

  it("asks before its first posts on Reddit, takes their edits, then posts by itself until a reply is taken down", async () => {
    const { world, c, draft, tap, tools } = await setUp();
    const words = ["What do you use?", "Which form builder survived your launch?", "Any tips for intake forms in Next.js?"];
    for (const n of [1, 2, 3]) await draft({ kind: "post", community: ["r/nocode", "r/startups", "r/webdev"][n - 1], title: `Forms ${n}?`, text: words[n - 1] });
    // One post a week in a community, even from two drafts in one step.
    const [twice] = await Promise.all([
      draft({ kind: "post", community: "r/nocode", title: "Forms again?", text: "Hm?" }),
      draft({ kind: "post", community: "r/nocode", title: "And again?", text: "Hm?" }),
    ]);
    expect(twice).toMatch(/^Not drafted: r\/nocode already has a post of theirs this week \(on its card, draft /);
    expect(world.channel.drafts).toHaveLength(3);
    const [first, second, third] = world.channel.drafts.map((d) => d.draft);

    // Edit asks under the card what should change, their reply box open on the question. With no writer, the answer
    // reaches the manager with the card's id and words, and the card changes in place.
    expect(await tap(world, first!.id, "edit", "e1")).toBeUndefined();
    expect(world.channel.acks.at(-1)?.text).toBeUndefined();
    const asked1 = world.channel.editAsks.at(-1)!;
    expect(asked1).toMatchObject({ cardRef: world.channel.drafts[0]!.ref, text: expect.stringContaining("What should change?") });
    await world.inbound.handle({ type: "text", from: telegramSender(), text: "Ask about waitlists", messageRef: "m1", replyToRef: asked1.ref });
    const asked = world.events.events.flatMap((e) => (e.event.kind === "user_message" ? [e.event.text] : [])).at(-1);
    expect(asked).toContain(`Ask about waitlists\n(Their reply to the card of your post in r/nocode: draft ${first!.id}, open.`);
    expect(await tools["edit_card"]!.invoke({ id: first!.id, text: "What do you use for waitlists?" })).toMatch(/^Changed/);
    expect(world.channel.drafts.at(-1)).toMatchObject({ ref: world.channel.drafts[0]!.ref, redraw: true, draft: { text: "What do you use for waitlists?" } });

    // A day apart: Reddit takes two new posts of theirs a day.
    for (const d of [first!, second!, third!]) {
      await tap(world, d.id, "post", `p-${d.id}`);
      await world.errands.stop();
      world.clock.advance(25 * 3_600_000);
    }
    expect(world.poster.posts.map((p) => p.post.text)).toEqual(["What do you use for waitlists?", words[1], words[2]]);
    // Three approved: Quest posts there by itself from now on, with no offer to answer (2026-11-18: their behaviour decides).
    expect(await world.trust.offered(c.id)).toEqual([]);
    expect(await world.autopilot.alone(c.id, "reddit posts")).toBe(true);

    // Trusted for posts there. A private message earns it apart (2026-10-14: ask a few times per platform and action), so it waits.
    expect(await draft({ kind: "post", community: "r/SideProject", title: "Forms 4?", text: "Anyone?" })).toMatch(/^Publishing/);
    await draft({ kind: "message", to: "u/sam", title: "Hi", text: "Hi Sam" });
    await world.errands.stop();
    expect(world.poster.posts).toHaveLength(4);
    const fourth = [...world.draftStore.drafts.values()].find((d) => d.title === "Forms 4?")!;
    expect(fourth).toMatchObject({ status: "posted", alone: true });
    expect(draftCardHtml(fourth)).toContain("Quest posted it as u/dana_builds");
    expect([...world.draftStore.drafts.values()].find((d) => d.kind === "message")?.status).toBe("open");

    // A reply taken down: back to asking, posts included.
    await world.autopilot.removed(c.id, "reddit");
    await draft({ kind: "post", community: "r/indiehackers", title: "Forms 5?", text: "Anyone?" });
    await world.errands.stop();
    expect(world.poster.posts).toHaveLength(4);
  });

  it("posts only where the rules were read, and never the same post in two communities", async () => {
    const { world, c, draft } = await setUp();
    expect(await draft({ kind: "post", community: "r/Thailand", title: "Hi", text: "My app." })).toBe(
      "Not drafted: r/Thailand is not on their list: the explorer reads a community's rules before anything is posted there. Nothing was written and no card exists: never tell them it is written or waiting.",
    );
    const url = "https://www.reddit.com/r/Bangkok/";
    await world.places.save({ customerId: c.id, key: placeKey(url)!, name: "r/Bangkok", url, verdict: "search", rules: "Posting links to advertising is not allowed", why: "expats ask" });
    expect(await draft({ kind: "post", community: "r/Bangkok", title: "Hi", text: "My app." })).toMatch(/^Not drafted: r\/Bangkok's rules, as filed: "Posting links to advertising is not allowed"/);
    expect(await draft({ kind: "post", community: "r/Bangkok", title: "Hi", text: "I built a translator for the errands nobody speaks English at.", rules_read: true })).toMatch(/^Waiting for their OK/);
    expect(await draft({ kind: "post", community: "r/nocode", title: "Hi", text: "I built a translator for the errands nobody speaks English at!" })).toMatch(
      /^Not drafted: those are nearly the words of their post in r\/Bangkok/,
    );
    expect(world.channel.drafts).toHaveLength(1);
  });

  it("takes a Reddit community or person given as the destination, and wants the words", async () => {
    const { draft } = await setUp();
    // Live, 2026-10-16: DeepSeek put the community in target, and left the words out of text.
    expect(await draft({ kind: "post", target: "r/nocode", title: "Forms?", text: "what do you use for intake forms these days?" })).toMatch(/^Waiting for their OK/);
    expect(await draft({ kind: "post", community: "r/webdev", title: "Forms?", text: "" })).toMatch(/^Not drafted: a post needs its words in text \(the body; the title goes in title\)/);
  });

  it("schedules a post past Reddit's day limit instead of refusing it", async () => {
    const { world, c, draft, tap } = await setUp();
    const max = PLATFORMS.find((p) => p.key === "reddit")!.limits.posts;
    for (let i = 0; i < max; i++) {
      const d = await world.draftStore.add({ customerId: c.id, kind: "post", platform: "reddit", url: "https://www.reddit.com/r/nocode/", target: "nocode", title: `Post ${i}`, author: null, quote: null, text: "Hi" });
      await world.draftStore.markSent(d.id, "https://www.reddit.com/r/nocode/comments/x/", "dana_builds");
    }
    await draft({ kind: "post", community: "r/startups", title: "One more", text: "Hi" });
    await tap(world, world.channel.drafts[0]!.draft.id, "post", "late");
    expect(world.channel.acks.at(-1)?.text).toMatch(/^Scheduled: it goes up by itself in about \d+ h, when Reddit's day has room$/);
    expect(world.poster.posts).toHaveLength(0);
  });
});

describe("a draft on a page with no name to show", () => {
  const habr = {
    id: draftId("cd70444a-759e-4a65-a376-b63c6d0a582d"),
    customerId: "638dd1c3-1065-4785-8c4a-3bae2373c2eb",
    kind: "reply",
    platform: "habr.com",
    url: "https://habr.com/ru/news/1093690/comments/",
    target: "https://habr.com/ru/news/1093690/comments/",
    title: null,
    author: null,
    quote: "Peak download speed in Ufa reached 1.5 Gbit/s.",
    text: "Hard to call it a breakthrough without rush-hour numbers.",
    status: "open",
    cardRef: null,
    createdAt: new Date("2026-10-13T08:36:59Z"),
    decidedAt: null,
    sentUrl: null,
    sentAs: null,
    sentAt: null,
    alone: false,
  } as unknown as Draft;

  it("says the address once, as the card's link, not in its first line too", () => {
    const card = draftCardHtml(habr);
    expect(card.split("\n")[0]).toBe("<b>Reply on habr.com</b>");
    expect(card.match(/habr\.com\/ru\/news\/1093690/g)).toHaveLength(1);
    expect(draftLabel(habr)).toBe("your reply on habr.com");
    expect(systemMessage("ru", "your reply on habr.com")).toBe("ваш ответ на habr.com");
  });

  it("still names whom it goes to when there is a name", () => {
    expect(draftCardHtml({ ...habr, author: "CitizenOfDreams" }).split("\n")[0]).toBe("<b>Reply on habr.com</b> · CitizenOfDreams");
    expect(draftLabel({ ...habr, author: "CitizenOfDreams" })).toBe("your reply to CitizenOfDreams on habr.com");
    const message = { ...habr, kind: "message", target: "Alex Chen", url: "https://mail.example.com/" } as Draft;
    expect(draftCardHtml(message).split("\n")[0]).toBe("<b>Message on habr.com</b> · Alex Chen");
    expect(draftLabel(message)).toBe("your message to Alex Chen on habr.com");
  });
});
