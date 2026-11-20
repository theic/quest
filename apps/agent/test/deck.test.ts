import { AIMessage } from "@langchain/core/messages";
import { fakeModel } from "@langchain/core/testing";
import { askKeys, draftId, findId, type Ask, type Draft, type Find, type NewFind } from "@mq/core";
import { describe, expect, it } from "vitest";
import { DECK_NOTICES_A_DAY } from "../src/asks/deck.ts";
import { rankAsks } from "../src/asks/rank.ts";
import { CARD_MARK, QUESTION_MARK } from "../src/conversation/messenger.ts";
import { deckButtons, deckHtml } from "../src/telegram/deck-card.ts";
import { parseUpdate } from "../src/telegram/updates.ts";
import { makeWorld, telegramSender } from "./world.ts";

type World = ReturnType<typeof makeWorld>;

async function setUp(models: Parameters<typeof makeWorld>[0] = {}, opts: Parameters<typeof makeWorld>[1] = {}) {
  const world = makeWorld(models, opts);
  const c = await world.customers.create({ channel: telegramSender().channel, userRef: "42", displayName: "Dana", language: "en" });
  await world.customers.update(c.id, { status: "active", sweptAt: world.clock.now() });
  return { world, c };
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
  reply: "Cookie-free analytics needs no banner.",
  strength: "maybe",
  ...over,
});

const shownFind = (world: World): Find => {
  const ask = world.channel.deck?.view.ask;
  if (ask?.kind !== "find") throw new Error(`the deck shows ${ask?.kind ?? "nothing"}`);
  return ask.find;
};

const tapFind = (world: World, id: string, action: Parameters<World["finds"]["act"]>[2], ackRef = "cb") =>
  world.inbound.handle({ type: "find", from: telegramSender(), findId: findId(id), action, ackRef });

/** A like Quest drafted on X, as the manager's draft tool makes it. */
const like = (world: World, customerId: Draft["customerId"], n: number) =>
  world.drafts.offer(customerId, { platform: "browser", kind: "like", url: `https://x.com/p${n}/status/${n}`, target: `https://x.com/p${n}/status/${n}`, author: `@p${n}`, quote: `post number ${n} about forms`, text: "" });

describe("Your move: one message for what waits on them", () => {
  it("shows the asks one at a time in one message, which turns to the next on a tap", async () => {
    const { world, c } = await setUp();
    for (const n of [1, 2]) await world.finds.save(newFind(c.id, n));
    await world.finds.show(c.id);

    expect(world.channel.decks).toHaveLength(1);
    const deck = world.channel.decks[0]!;
    // The freshest post first: it goes stale soonest.
    expect(deck).toMatchObject({ sent: true, silent: false, view: { position: 1, total: 2, prev: null, ask: { kind: "find", find: { author: "person2" } } } });
    expect(world.channel.cards).toHaveLength(0); // no card of its own
    // Each ask that joins is noted as its card was, for the manager and the follow-ups.
    expect(world.transcript.entries.filter((e) => e.text.startsWith(CARD_MARK)).map((e) => [e.text, e.ref])).toEqual([
      [`${CARD_MARK}Hacker News: https://news.ycombinator.com/item?id=2`, deck.ref],
      [`${CARD_MARK}Hacker News: https://news.ycombinator.com/item?id=1`, deck.ref],
    ]);

    await tapFind(world, shownFind(world).id, { kind: "decide", decision: "skipped" });
    // The same message, now the next one, with what became of the last.
    expect(world.channel.deck).toMatchObject({ ref: deck.ref, view: { position: 1, total: 1, last: "Skipped: person2", ask: { find: { author: "person1" } } } });
    expect(world.channel.decks.filter((d) => d.sent)).toHaveLength(1);

    await tapFind(world, shownFind(world).id, { kind: "decide", decision: "kept" });
    expect(world.channel.deck).toMatchObject({ ref: deck.ref, view: { ask: null, total: 0, last: "Kept: person1" } });
    expect(deckHtml(world.channel.deck!.view, new Date(), "en")).toContain("Nothing waits on you");
    expect(deckButtons(world.channel.deck!.view, "en")).toEqual([]);

    // The next one that comes is a deck of its own at the bottom, which notifies; the one that said nothing waits goes.
    await world.finds.save(newFind(c.id, 3));
    await world.finds.show(c.id);
    expect(world.channel.decks.at(-1)).toMatchObject({ sent: true, silent: false, view: { total: 1, ask: { find: { author: "person3" } } } });
    expect(world.channel.removed).toEqual([deck.ref]);
  });

  it("turns past a reply as soon as it is on its way, and says when it is up", async () => {
    const { world, c } = await setUp();
    for (const n of [1, 2]) await world.finds.save(newFind(c.id, n));
    await world.finds.show(c.id);
    const first = shownFind(world);

    await tapFind(world, first.id, { kind: "post" }, "cb1");
    expect(world.channel.acks.at(-1)).toEqual({ ackRef: "cb1", text: "Posting it from your Chrome…" });
    await world.errands.stop();
    expect(world.poster.posts).toHaveLength(1);
    expect(world.channel.deck?.view).toMatchObject({ total: 1, last: "Posted: your reply to person2", ask: { find: { author: "person1" } } });
  });

  it("goes back to the bottom when asks come after other messages, and is redrawn in place while it is the last", async () => {
    const { world, c } = await setUp();
    await world.finds.save(newFind(c.id, 1));
    await world.finds.show(c.id);
    const first = world.channel.deck!.ref;

    // Still the last message: a new ask redraws it in place, which notifies nobody.
    await world.finds.save(newFind(c.id, 2));
    await world.finds.show(c.id);
    expect(world.channel.decks.at(-1)).toMatchObject({ ref: first, sent: false, view: { total: 2 } });

    // They talked since: the next ask brings it down to them, once.
    await world.inbound.handle({ type: "text", from: telegramSender(), text: "hey", messageRef: String(Number(first) + 5), replyToRef: null });
    await like(world, c.id, 1);
    const now = world.channel.deck!;
    expect(now.ref).not.toBe(first);
    expect(world.channel.decks.at(-1)).toMatchObject({ sent: true, view: { total: 3 } });
    expect(world.channel.removed).toEqual([first]);
  });

  it("notifies a few times a day, then comes silently; someone waiting on them always notifies", async () => {
    const { world, c } = await setUp();
    let n = 0;
    const comeBack = async () => {
      // A message of theirs after the deck, then a new draft: the deck comes down to them.
      await world.inbound.handle({ type: "text", from: telegramSender(), text: "ok", messageRef: String(1000 + n), replyToRef: null });
      n++;
      await world.drafts.offer(c.id, { kind: "reply", url: `https://www.reddit.com/r/SaaS/comments/abc${n}/comment/c${n}/`, quote: `question number ${n}`, author: `u/asker${n}`, text: "Happy to help with that." });
    };
    for (let i = 0; i <= DECK_NOTICES_A_DAY; i++) await comeBack();
    const sent = world.channel.decks.filter((d) => d.sent);
    expect(sent.map((d) => d.silent)).toEqual([...Array(DECK_NOTICES_A_DAY).fill(false), true]);

    // A private message waits on a person: it notifies whatever the count.
    await world.inbound.handle({ type: "text", from: telegramSender(), text: "ok", messageRef: "2000", replyToRef: null });
    await world.drafts.offer(c.id, { kind: "message", to: "u/sam", subject: "Your form question", text: "Happy to show you how I did it.", url: null, quote: null });
    expect(world.channel.decks.at(-1)).toMatchObject({ sent: true, silent: false, view: { position: 1, ask: { kind: "draft", draft: { kind: "message" } } } });
  });

  it("moves with ‹ and › without deciding anything", async () => {
    const { world, c } = await setUp();
    for (const n of [1, 2, 3]) await world.finds.save(newFind(c.id, n));
    await world.finds.show(c.id, 3);
    const view = world.channel.deck!.view;
    expect(view).toMatchObject({ position: 1, total: 2 }); // two at once in the test world
    const buttons = deckButtons(view, "en");
    expect(buttons.at(-1)).toEqual([{ text: "›", callback_data: `mv:${view.next}` }]);
    const update = parseUpdate({ update_id: 1, callback_query: { id: "cb9", from: { id: 42, is_bot: false, first_name: "Dana" }, message: { message_id: Number(world.channel.deck!.ref), chat: { id: 42, type: "private" }, date: 0 }, data: `mv:${view.next}` } } as never);
    expect(update).toMatchObject({ type: "deck", action: "move", key: view.next });

    await world.inbound.handle(update!);
    expect(world.channel.deck?.view).toMatchObject({ position: 2, total: 2, prev: view.ask!.key, next: null });
    expect([...world.findStore.finds.values()].filter((f) => f.status === "shown")).toHaveLength(2);
  });

  it("takes a reply to the deck as a note on the ask it shows, and comes back under it", async () => {
    // The first answer puts the reply in their voice as it is shown; the second is the note.
    const writer = fakeModel().respond(new AIMessage("Cookie-free analytics needs no banner.")).respond(new AIMessage("Shorter: no banner needed."));
    const { world, c } = await setUp({ writer });
    await world.finds.save(newFind(c.id, 1));
    await world.finds.show(c.id);
    const deck = world.channel.deck!;

    expect(shownFind(world).reply).toBe("Cookie-free analytics needs no banner.");
    await world.inbound.handle({ type: "text", from: telegramSender(), text: "shorter", messageRef: String(Number(deck.ref) + 1), replyToRef: deck.ref });
    expect(shownFind(world).reply).toBe("Shorter: no banner needed.");
    const again = world.channel.decks.at(-1)!;
    expect(again).toMatchObject({ sent: true, silent: true });
    expect(again.ref).not.toBe(deck.ref);
    expect(world.channel.removed).toEqual([deck.ref]);
    const told = world.events.events.at(-1)!.event;
    expect(told.kind === "user_message" && told.text).toContain("The writer already put it into the words");
  });

  it("asks under the deck what should change on Edit, and takes the answer as the note", async () => {
    const writer = fakeModel().respond(new AIMessage("Cookie-free analytics needs no banner.")).respond(new AIMessage("No banner, nothing stored."));
    const { world, c } = await setUp({ writer });
    await world.finds.save(newFind(c.id, 1));
    await world.finds.show(c.id);
    const deck = world.channel.deck!;

    await tapFind(world, shownFind(world).id, { kind: "edit" });
    const asked = world.channel.editAsks.at(-1)!;
    expect(asked.cardRef).toBe(deck.ref);
    expect(shownFind(world).reply).toBe("Cookie-free analytics needs no banner.");
    await world.inbound.handle({ type: "text", from: telegramSender(), text: "say nothing is stored", messageRef: String(Number(asked.ref) + 1), replyToRef: asked.ref });
    expect(shownFind(world).reply).toBe("No banner, nothing stored.");
    // Under their answer, silently: they are right there.
    expect(world.channel.decks.at(-1)).toMatchObject({ sent: true, silent: true });
    expect(world.channel.removed).toEqual([deck.ref]);
  });

  it("puts the team's questions on it, answered by a tap or by a reply to it", async () => {
    const { world, c } = await setUp();
    const task = await world.tasks.start(c.id, "researcher", "Read", "Read it.");
    world.taskStore.recs.get(task.id)!.task = { ...task, status: "waiting" };
    const [q1, q2] = await world.questions.raise(task, [
      { interruptId: "i1", text: "Do you integrate with Notion?", options: ["Yes", "No"], why: null },
      { interruptId: "i2", text: "Which plan do they ask about most?", options: [], why: null },
    ]);
    await world.questions.ask(c.id, [q1!.id, q2!.id]);
    // A question the team stopped on comes before a reply; a find that joins goes under, and the deck stays on what it shows.
    await world.finds.save(newFind(c.id, 1));
    await world.finds.show(c.id);
    const deck = world.channel.deck!;
    expect(deck.view).toMatchObject({ position: 1, total: 3, ask: { kind: "question", question: { id: q1!.id } } });
    expect(world.channel.decks.filter((d) => d.sent)).toHaveLength(1);
    expect(world.channel.sent.filter((m) => m.question)).toHaveLength(0);
    expect(world.transcript.entries.map((e) => e.text)).toContain(`${QUESTION_MARK}Do you integrate with Notion?`);

    await world.inbound.handle({ type: "choice", from: telegramSender(), questionId: q1!.id, option: 1, ackRef: "cb1", messageRef: deck.ref });
    expect((await world.questionStore.get(q1!.id))?.answer).toBe("No");
    expect(world.channel.deck?.view).toMatchObject({ last: "No", ask: { kind: "question", question: { id: q2!.id } } });

    await world.inbound.handle({ type: "text", from: telegramSender(), text: "The yearly one", messageRef: String(Number(deck.ref) + 1), replyToRef: world.channel.deck!.ref });
    expect((await world.questionStore.get(q2!.id))?.answer).toBe("The yearly one");
    expect(world.channel.deck?.view.ask).toMatchObject({ kind: "find" });
  });

  it("does all the likes on a platform at once, or goes through them one by one", async () => {
    const { world, c } = await setUp();
    for (const n of [1, 2, 3]) await like(world, c.id, n);
    const group = world.channel.deck!.view.ask!;
    expect(group).toMatchObject({ kind: "group", key: askKeys.group("like", "x.com"), what: "like" });
    expect(group.kind === "group" && group.drafts).toHaveLength(3);
    expect(deckButtons(world.channel.deck!.view, "en")[0]).toEqual([{ text: "Do all 3", callback_data: "all:group:like:x.com" }]);

    // One by one: each like is its own ask, with Like it and Skip.
    await world.inbound.handle({ type: "deck", from: telegramSender(), action: "one", key: group.key, ackRef: "cb1" });
    expect(world.channel.deck?.view).toMatchObject({ total: 3, ask: { kind: "draft", draft: { kind: "like" } } });
    const one = (world.channel.deck!.view.ask as Extract<Ask, { kind: "draft" }>).draft;
    await world.inbound.handle({ type: "draft", from: telegramSender(), draftId: draftId(one.id), action: "skip", ackRef: "cb2" });
    expect(world.channel.deck?.view).toMatchObject({ total: 2, ask: { kind: "draft" } });

    // Two left, gone through to the end or not: "Do all" does each as its own tap would, through the outbox.
    await world.deck!.changed(c.id);
    await world.deckStore.save(c.id, { ...(await world.deckStore.get(c.id))!, oneByOne: null });
    await world.deck!.changed(c.id);
    expect(world.channel.deck?.view.ask).toMatchObject({ kind: "group" });
    await world.inbound.handle({ type: "deck", from: telegramSender(), action: "all", key: group.key, ackRef: "cb3" });
    expect(world.channel.acks.at(-1)).toEqual({ ackRef: "cb3", text: "2 likes going" });
    await world.errands.stop();
    expect(world.poster.posts.map((p) => p.post.kind)).toEqual(["like", "like"]);
    expect(world.channel.deck?.view).toMatchObject({ ask: null, total: 0 });
  });

  it("the sweep's end sends no take: its finds go to Your move, and the manager hears the setup is over", async () => {
    const { world, c } = await setUp();
    await world.customers.update(c.id, { brief: "Acme finds the threads where buyers ask." });
    await world.finds.save(newFind(c.id, 1));
    await world.intake.begin(c.id);
    expect(world.events.events.some((e) => e.event.kind === "system" && e.event.topic === "about_them")).toBe(true);
    expect((await world.finds.show(c.id)).shown).toBe(1);
    expect(world.channel.deck?.view).toMatchObject({ total: 1, ask: { kind: "find" } });
  });

});

describe("the line's order", () => {
  const at = (iso: string) => new Date(iso);
  const draft = (over: Partial<Omit<Draft, "id">> & { readonly id?: string }): Ask => {
    const d = { id: "d", customerId: "c", kind: "reply", platform: "x.com", url: "https://x.com/a/status/1", target: "t", title: null, author: null, quote: null, text: "hi", status: "open", cardRef: null, createdAt: at("2026-10-01"), decidedAt: null, sentUrl: null, sentAs: null, sentAt: null, alone: false, ...over } as unknown as Draft;
    return { kind: "draft", key: askKeys.draft(d.id), draft: d };
  };
  const find = (id: string, postedAt: string, over: Partial<Find> = {}): Ask => {
    const f = { id, customerId: "c", source: "reddit:r/SaaS", url: `https://www.reddit.com/r/SaaS/comments/${id}/`, author: id, quote: "q", postedAt: at(postedAt), status: "shown", createdAt: at("2026-10-01"), shownAt: at("2026-10-02"), ...over } as unknown as Find;
    return { kind: "find", key: askKeys.find(id), find: f };
  };

  it("says whom a private message goes to, and opens their profile", () => {
    // Live, 2026-11-05: a message to @georgesh0 on Threads, with no quote, showed only its words.
    const ask = draft({ kind: "message", platform: "threads.com", url: "https://www.threads.com/@georgesh0", target: "georgesh0", text: "Weighing up Product Hunt?" });
    const view = { ask, position: 1, total: 1, prev: null, next: null } as unknown as Parameters<typeof deckHtml>[0];
    expect(deckHtml(view, at("2026-10-02"), "en")).toBe("<i>Private message to @georgesh0</i>\n\nWeighing up Product Hunt?");
    expect(deckButtons(view, "en").flat()).toContainEqual({ text: "@georgesh0 on Threads", url: "https://www.threads.com/@georgesh0" });
  });

  it("puts someone waiting first, then the team's questions, fresh replies, posts, held sends, profiles, likes, ideas", () => {
    const question: Ask = { kind: "question", key: "question:q", question: { id: "q", createdAt: at("2026-10-01"), askedAt: at("2026-10-01") } as never };
    const idea: Ask = { kind: "idea", key: "idea:i", idea: { id: "i", createdAt: at("2026-10-01") } as never };
    const asks: Ask[] = [
      idea,
      draft({ id: "like1", kind: "like" }),
      draft({ id: "profile", kind: "profile" }),
      find("old", "2026-09-01"),
      draft({ id: "held", status: "uncertain" }),
      draft({ id: "post", kind: "post" }),
      find("fresh", "2026-10-20"),
      question,
      draft({ id: "sam", kind: "reply", author: "u/sam" }),
      draft({ id: "msg", kind: "message", target: "bob" }),
    ];
    const talking = (p: string | null) => p === "u/sam";
    expect(rankAsks(asks, talking).map((a) => a.key)).toEqual([
      "draft:sam", // a reply to someone talking with them (the newer of the two)
      "draft:msg",
      "question:q",
      "find:fresh",
      "find:old",
      "draft:post",
      "draft:held",
      "draft:profile",
      "draft:like1",
      "idea:i",
    ]);
  });

  it("puts two likes on one platform together, unless they go through them one by one", () => {
    const asks = [draft({ id: "l1", kind: "like" }), draft({ id: "l2", kind: "like" }), draft({ id: "l3", kind: "like", platform: "linkedin.com" })];
    expect(rankAsks(asks, () => false).map((a) => a.key)).toEqual(["group:like:x.com", "draft:l3"]);
    expect(rankAsks(asks, () => false, "group:like:x.com").map((a) => a.key)).toEqual(["draft:l1", "draft:l2", "draft:l3"]);
  });
});

describe("a new deck", () => {
  it("opens on what just came, which is what Quest says is there", async () => {
    const { world, c } = await setUp();
    for (const n of [1, 2]) await world.finds.save(newFind(c.id, n));
    await world.finds.show(c.id);
    // They talked since; the post they asked for comes ninth-best by rank, and the new deck opens on it.
    await world.inbound.handle({ type: "text", from: telegramSender(), text: "post this on r/SaaS", messageRef: "5000", replyToRef: null });
    world.clock.t += 120_000;
    await world.places.save({ customerId: c.id, key: "reddit:r/saas", name: "r/SaaS", url: "https://www.reddit.com/r/SaaS/", verdict: "search", rules: null, why: "they ask there" });
    await world.drafts.offer(c.id, { kind: "post", community: "r/SaaS", title: "Forms that keep people", text: "What we learned.", rulesRead: true });
    expect(world.channel.decks.at(-1)).toMatchObject({ sent: true, view: { position: 3, total: 3, ask: { kind: "draft", draft: { kind: "post" } } } });
  });
});

describe("cards from before the deck", () => {
  it("join it, and are not noted in the transcript again", async () => {
    // Live, 2026-10-24: the first deck held 25 old cards, and noting each again filled the chat the manager reads.
    const { world, c } = await setUp();
    const d = await world.draftStore.add({ customerId: c.id, kind: "reply", platform: "x.com", url: "https://x.com/ari/status/1", target: "Ari", title: null, author: "Ari", quote: "How do I find the next 50?", text: "Keep going." });
    await world.draftStore.markShown(d.id, "77");
    const before = world.transcript.entries.length;
    await world.deck!.changed(c.id);
    expect(world.channel.deck?.view.ask).toMatchObject({ kind: "draft", draft: { id: d.id } });
    expect(world.transcript.entries.length).toBe(before);
  });
});
