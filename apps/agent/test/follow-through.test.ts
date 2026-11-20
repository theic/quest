import { AIMessage } from "@langchain/core/messages";
import { fakeModel } from "@langchain/core/testing";
import { checkTimeFor, customerId, placeKey, placeKeys, trustKey, type CustomerId, type TranscriptEntry } from "@mq/core";
import { describe, expect, it } from "vitest";
import { onlyANod, reactionEmoji, reactionRefusal } from "../src/conversation/reactions.ts";
import { overlap, SAME_MEMORY } from "../src/lib/overlap.ts";
import { atTheirTime, promisedTimes, span, whenFrom } from "../src/lib/their-time.ts";
import { voiceNotes } from "../src/lib/voice.ts";
import { linkPeople, namedIn, shortlistPeople } from "../src/manager/ownership-tools.ts";
import { managerTools } from "../src/manager/tools.ts";
import { makeWorld, telegramSender } from "./world.ts";

type World = ReturnType<typeof makeWorld>;

const MIN = 60_000;
const say = (text: string, ref: string) => ({ type: "text" as const, from: telegramSender(), text, messageRef: ref, replyToRef: null });

/** A founder who has picked their quest, so their first message is not answered with the choice. */
async function founder(world: World): Promise<CustomerId> {
  const c = await world.customers.create({ channel: telegramSender().channel, userRef: "42", displayName: "Dana", language: "en" });
  await world.customers.update(c.id, { brief: "Voca Vela: a live two-way translator app for families.", status: "active" });
  return c.id;
}

const briefingOf = (model: ReturnType<typeof fakeModel>, call: number): string => String(model.calls[call]!.messages.at(-1)!.content);

function toolsOf(world: World, id: CustomerId, opts: { userTurn?: boolean; theySpoke?: boolean } = {}) {
  const tools = managerTools({ ...world, customerId: id, userTurn: opts.userTurn ?? false, customers: world.customers, now: world.clock.now, ...(opts.theySpoke === undefined ? {} : { theySpoke: opts.theySpoke }) });
  return Object.fromEntries(tools.map((t) => [t.name, t]));
}

describe("Quest's sense of time", () => {
  const now = new Date("2026-10-07T09:00:00Z"); // 12:00 in Kyiv

  it("reads the times it gives in its own words, and only promises", () => {
    expect(promisedTimes("Give me 5 min to check the best people we already found 👀", now, null)).toEqual([
      { sentence: "Give me 5 min to check the best people we already found 👀", words: "give me 5 min", due: new Date(now.getTime() + 5 * MIN) },
    ]);
    const [hour] = promisedTimes("These two look promising. The third needs a language-support check. I'll check that and get back to you within an hour.", now, null);
    expect(hour).toMatchObject({ sentence: "I'll check that and get back to you within an hour.", words: "within an hour", due: new Date(now.getTime() + 60 * MIN) });
    expect(promisedTimes("Need another 10 min, the second site is slow.", now, null)[0]?.due).toEqual(new Date(now.getTime() + 10 * MIN));
    // What the live chat of 2026-10-07 said, none of it a promise.
    expect(promisedTimes("No. I can't schedule a message for a future time, so I'll get back to you in 2 min is not something I can do.", now, null)).toEqual([]);
    expect(promisedTimes("Tomorrow I keep the family-interpreter thread and the letter asks in r/expats.", now, null)).toEqual([]);
    expect(promisedTimes("I posted it 5 min ago.", now, null)).toEqual([]);
    expect(promisedTimes("I'll check the threads from the last 24 hours.", now, null)).toEqual([]);
    expect(promisedTimes("I'll be back at 10 am.", now, null)).toEqual([]);
    // Work under way with a time on it, as the real model put it (2026-10-07), is a promise too; work done is not.
    expect(promisedTimes("I'm also running today's search in r/chinalife and r/taiwan, about 10 min.", now, null)[0]?.due).toEqual(new Date(now.getTime() + 10 * MIN));
    expect(promisedTimes("Going after visa and bank asks in r/chinalife now, about 10 min.", now, null)[0]?.due).toEqual(new Date(now.getTime() + 10 * MIN));
    expect(promisedTimes("Reading your site took 10 min.", now, null)).toEqual([]);
    expect(promisedTimes("Today's search is still running, ~7 min.", now, null)[0]?.due).toEqual(new Date(now.getTime() + 7 * MIN));
    expect(promisedTimes("Back in ~10 min.", now, null)[0]?.due).toEqual(new Date(now.getTime() + 10 * MIN));
    expect(promisedTimes("The thread is getting 10 replies an hour.", now, null)).toEqual([]);
    expect(promisedTimes("Fresh search running, more in ~10 min.", now, null)[0]?.due).toEqual(new Date(now.getTime() + 10 * MIN));
  });

  it("puts a part of their day on their clock", () => {
    const [p] = promisedTimes("I'll get back to you this afternoon.", now, "Europe/Kyiv");
    expect(p?.due).toEqual(atTheirTime(now, "Europe/Kyiv", 16));
    expect(p?.due.toISOString()).toBe("2026-10-07T13:00:00.000Z");
    expect(promisedTimes("You'll have it tomorrow morning.", now, "Europe/Kyiv")[0]?.due.toISOString()).toBe("2026-10-08T07:00:00.000Z");
  });

  it("reads a time a tool is given, on their clock", () => {
    expect(whenFrom({ minutes: 5 }, now, null)).toEqual(new Date(now.getTime() + 5 * MIN));
    expect(whenFrom({ at: "15:30" }, now, "Europe/Kyiv")?.toISOString()).toBe("2026-10-07T12:30:00.000Z");
    expect(whenFrom({ at: "3pm" }, now, "Europe/Kyiv")?.toISOString()).toBe("2026-10-07T12:00:00.000Z");
    expect(whenFrom({ at: "09:00" }, now, "Europe/Kyiv")?.toISOString()).toBe("2026-10-08T06:00:00.000Z"); // past today: tomorrow
    expect(whenFrom({ at: "tomorrow 10:00" }, now, "Europe/Kyiv")?.toISOString()).toBe("2026-10-08T07:00:00.000Z");
    expect(whenFrom({ at: "soonish" }, now, null)).toBeNull();
    expect(whenFrom({ minutes: 0 }, now, null)).toBeNull();
  });

  it("looks at a promise early enough to say it needs longer, and at the time itself when they asked for one", () => {
    const due = (min: number) => new Date(now.getTime() + min * MIN);
    expect(checkTimeFor("promise", now, due(5), false)).toEqual(due(4));
    expect(checkTimeFor("promise", now, due(60), false)).toEqual(due(48));
    expect(checkTimeFor("promise", now, due(24 * 60), false)).toEqual(due(24 * 60 - 20));
    expect(checkTimeFor("promise", now, due(2), false)).toEqual(due(2));
    expect(checkTimeFor("promise", now, due(30), true)).toEqual(due(30));
    expect(checkTimeFor("next_step", now, due(60), false)).toEqual(due(60));
  });

  it("says a length of time the way a person does", () => {
    expect([span(40_000), span(5 * MIN), span(80 * MIN), span(7 * 60 * MIN), span(50 * 60 * MIN)]).toEqual(["40 s", "5 min", "1 h 20 min", "7 h", "2 days"]);
  });
});

describe("keeping its word", () => {
  it("holds an answer written at once for the time they asked for, and sends it then with no model call", async () => {
    // Live on Telegram, 2026-10-08: promised for 3 min, then answered and settled ten seconds later.
    const line = '"Hey, saw your post about your mom\'s mail. Want to try Voca Vela on that pile?"';
    const manager = fakeModel()
      .respondWithTools([{ name: "promise", args: { what: "First DM line for u/grace_lin", in_minutes: 3, words: "3 min" } }])
      .respondWithTools([{ name: "settle", args: { id: "1", outcome: "kept", note: "Delivered the first DM line." } }])
      .respond(new AIMessage(line));
    const world = makeWorld({ manager });
    const id = await founder(world);

    await world.inbound.handle(say("Nice. Ping me in 3 min with the first line I should send them.", "21"));
    await world.manager.serveNext();

    expect(world.channel.sent).toEqual([]);
    expect(world.channel.reactions).toEqual([{ to: "42", ref: "21", emoji: "👍" }]);
    const [held] = await world.commitments.open(id);
    expect(held).toMatchObject({ kind: "promise", source: "asked", onTime: true, words: "in 3 min", held: line });
    expect(held!.dueAt.getTime()).toBe(world.clock.t + 3 * MIN);
    expect(await world.commitments.get(id, "1")).toMatchObject({ status: "kept", note: "Delivered the first DM line." });
    expect(world.events.commitmentWake(id, held!.id)?.getTime()).toBe(world.clock.t + 3 * MIN);

    world.clock.advance(2 * MIN);
    expect(await world.manager.serveNext()).toBe(false); // not before the time they asked for
    world.clock.advance(MIN);
    await world.manager.serveNext();

    expect(world.channel.sent.map((m) => m.text)).toEqual([line]);
    expect(await world.commitments.get(id, held!.id)).toMatchObject({ status: "kept", note: "sent at the time they asked for" });
    expect(manager.calls).toHaveLength(3); // the turn that wrote it, and nothing after
  });

  it("sends a question back, an \"on it\" and a reply with its own time at once, even when they asked for a time", async () => {
    const manager = fakeModel()
      .respond(new AIMessage("Which of the three, the mail one or the landlord one?"))
      .respond(new AIMessage("On it 👀"))
      .respond(new AIMessage("Checking their profiles now, back in 4 min."));
    const world = makeWorld({ manager });
    const id = await founder(world);

    await world.inbound.handle(say("Ping me in 3 min with the first line I should send them.", "22"));
    await world.manager.serveNext();
    await world.inbound.handle(say("Get back to me in 10 min with it.", "23"));
    await world.manager.serveNext();
    await world.inbound.handle(say("Tell me in 5 min if they are still active.", "24"));
    await world.manager.serveNext();

    // "On it" is a 👍 instead (a reply that only nods), and nothing is held for it.
    expect(world.channel.sent.map((m) => m.text)).toEqual(["Which of the three, the mail one or the landlord one?", "Checking their profiles now, back in 4 min."]);
    expect(world.channel.reactions.map((r) => r.ref)).toEqual(["23"]);
    expect((await world.commitments.open(id)).map((c) => c.source)).toEqual(["said"]); // the time it gave, heard
  });

  it("comes back at the time they asked for, with the shortlist and its links, and not before", async () => {
    const shortlist = "These two look promising: u/grace_lin in r/taiwan wants a live translator for her grandma https://www.reddit.com/r/taiwan/comments/t1/";
    const manager = fakeModel()
      .respondWithTools([{ name: "promise", args: { what: "the three best people found so far, with links and why", in_minutes: 2, on_time: true, words: "2 min" } }])
      .respond(new AIMessage("On it, back in 2 min 👀"))
      .respondWithTools([{ name: "best_people", args: { count: 3 } }])
      .respondWithTools([
        { name: "message_user", args: { text: shortlist } },
        { name: "settle", args: { id: "1", outcome: "kept", note: "sent the shortlist" } },
      ])
      .respond(new AIMessage("Delivered."));
    const world = makeWorld({ manager });
    const id = await founder(world);
    await world.finds.save({
      customerId: id,
      taskId: null,
      source: "reddit:r/taiwan",
      url: "https://www.reddit.com/r/taiwan/comments/t1/",
      author: "grace_lin",
      title: "Translator for grandma",
      quote: "My grandma only speaks Taiwanese, is there a live translator that works?",
      postedAt: new Date(world.clock.t - 2 * 86_400_000),
      why: "Asks for exactly a live two-way translator.",
      reply: "We built Voca Vela for this.",
      strength: "strong",
    });

    await world.inbound.handle(say("In two minutes, come back with your three best saved people.", "7"));
    await world.manager.serveNext();

    expect(world.channel.sent.map((m) => m.text)).toEqual(["On it, back in 2 min 👀"]);
    expect(await world.commitments.open(id)).toMatchObject([{ id: "1", kind: "promise", onTime: true, source: "manager", words: "2 min" }]);
    expect(world.events.commitmentWake(id, "1")?.getTime()).toBe(world.clock.t + 2 * MIN);

    world.clock.advance(MIN);
    expect(await world.manager.serveNext()).toBe(false); // not before the time they asked for
    world.clock.advance(MIN);
    expect(await world.manager.serveNext()).toBe(true);

    expect(briefingOf(manager, 2)).toContain("Your promise #1 is due now (they asked for it at this time): the three best people found so far, with links and why.");
    expect(String(manager.calls[3]!.messages.at(-1)!.content)).toContain("u/grace_lin in Reddit (r/taiwan) (posted 2 days ago, strong, not shown yet)");
    expect(world.channel.sent.at(-1)?.text).toBe(shortlist);
    expect(await world.commitments.get(id, "1")).toMatchObject({ status: "kept", note: "sent the shortlist" });
    expect(world.events.commitmentWake(id, "1")).toBeNull();
  });

  it("keeps a time it gave in passing, and says it needs longer before that time passes rather than going quiet", async () => {
    const manager = fakeModel()
      .respond(new AIMessage("Give me 5 min to check the best people we already found 👀"))
      .respond(new AIMessage("Still reading the second site."))
      .respond(new AIMessage("Need another 10 min, the second site is slow."));
    const world = makeWorld({ manager });
    const id = await founder(world);

    await world.inbound.handle(say("Who should we try next?", "8"));
    await world.manager.serveNext();

    const [p] = await world.commitments.open(id);
    expect(p).toMatchObject({ source: "said", words: "give me 5 min", dueAt: new Date(world.clock.t + 5 * MIN) });
    expect(world.events.commitmentWake(id, p!.id)?.getTime()).toBe(world.clock.t + 4 * MIN);

    world.clock.advance(4 * MIN);
    await world.manager.serveNext();

    expect(String(manager.calls[2]!.messages.at(-1)!.content)).toMatch(/^Your promise #1 is due now and still open/);
    expect(world.channel.sent.map((m) => m.text)).toEqual(["Give me 5 min to check the best people we already found 👀", "Need another 10 min, the second site is slow."]);
    const moved = await world.commitments.get(id, "1");
    expect(moved).toMatchObject({ status: "open", moves: 1, dueAt: new Date(world.clock.t + 10 * MIN) });
    expect(world.events.commitmentWake(id, "1")?.getTime()).toBe(world.clock.t + 8 * MIN);
    expect(await world.commitments.open(id)).toHaveLength(1); // the new time moved it, not a second promise
  });

  it("stays quiet at an early look when the work is on track, and looks again at the time it gave", async () => {
    const manager = fakeModel()
      .respondWithTools([{ name: "promise", args: { what: "whether Voca Vela supports Taiwanese", in_minutes: 60, words: "within an hour" } }])
      .respond(new AIMessage("I'll check that and get back to you within an hour."))
      .respond(new AIMessage("The researcher is still on it; on track."));
    const world = makeWorld({ manager });
    const id = await founder(world);
    await world.inbound.handle(say("Does it do Taiwanese?", "9"));
    await world.manager.serveNext();
    const start = world.clock.t;

    world.clock.advance(48 * MIN);
    await world.manager.serveNext();

    expect(briefingOf(manager, 2)).toContain("Your promise #1 is due in 12 min");
    expect(world.channel.sent).toHaveLength(1);
    expect(world.events.commitmentWake(id, "1")?.getTime()).toBe(start + 60 * MIN);
  });

  it("ties a time given in passing to the work started with it, and points the work's report back to it", async () => {
    const manager = fakeModel()
      .respondWithTools([{ name: "start_task", args: { agent: "researcher", title: "Taiwanese support", instructions: "Check whether vocavela.live supports Taiwanese." } }])
      .respond(new AIMessage("I'm checking the language list on the site now, about 10 min."))
      .respond(new AIMessage("Done."))
      .respond(new AIMessage("Nothing more to say."));
    const world = makeWorld({ manager });
    const id = await founder(world);
    await world.inbound.handle(say("Does it do Taiwanese?", "30"));
    await world.manager.serveNext();

    const [task] = await world.tasks.list(id);
    expect(await world.commitments.open(id)).toMatchObject([{ source: "said", words: "about 10 min", taskId: task!.id }]);

    world.clock.advance(3 * MIN);
    await world.events.push(id, { kind: "task_finished", taskId: task!.id, agent: "researcher", outcome: "succeeded", summary: "No Taiwanese; Mandarin only." });
    await world.manager.serveNext();
    expect(briefingOf(manager, 2)).toContain("This was the work for your promise #1 (I'm checking the language list on the site now, about 10 min.): deliver it and settle it.");
  });

  it("does not wake the model for a promise already kept", async () => {
    const manager = fakeModel();
    const world = makeWorld({ manager });
    const id = await founder(world);
    const p = await world.commitments.add(id, { kind: "promise", what: "the shortlist", words: "5 min", person: null, url: null, taskId: null, dueAt: new Date(world.clock.t + 5 * MIN), onTime: false, source: "manager" });
    await world.commitments.settle(id, p.id, "kept", "sent it early");
    await world.events.push(id, { kind: "commitment_due", commitmentId: p.id });

    await world.manager.serveNext();

    expect(manager.calls).toHaveLength(0);
    expect(world.events.events.every((e) => e.status === "done")).toBe(true);
  });

  it("holds a promise on a teammate's work to how long that teammate takes", async () => {
    const world = makeWorld();
    const id = await founder(world);
    world.taskStore.pace = [{ agent: "scout", runs: 30, medianMs: 7 * MIN, p80Ms: 10 * MIN }];
    const task = await world.tasks.start(id, "scout", "Find people", "Look.");
    const tools = toolsOf(world, id, { userTurn: true });
    const paces = await world.tasks.paces(new Date(0));
    const withPace = Object.fromEntries(managerTools({ ...world, customerId: id, userTurn: true, customers: world.customers, now: world.clock.now, paces }).map((t) => [t.name, t]));

    expect(await withPace["promise"]!.invoke({ what: "the people this run finds", in_minutes: 2, task_id: task.id })).toMatch(
      /^Not kept: the scout's runs take about 7 min \(8 in 10 within 10 min\)/,
    );
    expect(await withPace["promise"]!.invoke({ what: "the people this run finds", in_minutes: 15, task_id: task.id })).toMatch(/^Kept as promise #1: due 12:15 their time, in 15 min/);
    expect(await withPace["promise"]!.invoke({ what: "the new people this run finds, with links", in_minutes: 25 })).toBe(
      'Not kept: you already owe this as promise #1 ("the people this run finds", due 12:15). To give it a new time, settle it as moved.',
    );
    expect(await tools["settle"]!.invoke({ id: "#1", outcome: "moved", note: "the run is slow", in_minutes: 30 })).toMatch(/^Moved #1 to 12:30 their time\. Tell them now/);
  });

  it("follows a conversation through its next step, and lets go of one nobody took", async () => {
    const manager = fakeModel().respond(new AIMessage("Checked, nothing to add."));
    const world = makeWorld({ manager });
    const id = await founder(world);
    const tools = toolsOf(world, id);

    expect(await tools["next_step"]!.invoke({ person: "u/grace_lin", what: "check whether she tried it, and send the setup link if not", in_minutes: 24 * 60 })).toBe(
      "Next step #1 with u/grace_lin: Sat 12:00 their time. You are woken then to do it.",
    );
    world.clock.advance(24 * 60 * MIN);
    await world.manager.serveNext();

    expect(briefingOf(manager, 0)).toContain("A next step is due (#1), with u/grace_lin: check whether she tried it, and send the setup link if not.");
    expect(await world.commitments.get(id, "1")).toMatchObject({ status: "open", moves: 1, note: "not done when it fell due" });
  });
});

describe("reactions", () => {
  it("answers a clear instruction with a 👍 instead of a \"got it\"", async () => {
    const manager = fakeModel()
      .respondWithTools([
        { name: "react", args: { emoji: "👍️" } },
        { name: "remember", args: { kind: "decision", text: "No Reddit today: they asked on 25 Sep." } },
      ])
      .respond(new AIMessage("Got it, no Reddit today."));
    const world = makeWorld({ manager });
    const id = await founder(world);

    await world.inbound.handle(say("No Reddit today please.", "11"));
    await world.manager.serveNext();

    expect(world.channel.reactions).toEqual([{ to: "42", ref: "11", emoji: "👍" }]);
    expect(world.channel.sent).toEqual([]);
    expect((await world.transcript.recent(id, 5)).at(-1)).toMatchObject({ direction: "in", ref: "11", reaction: "👍" });
  });

  it("asks once for only what is new when a reply beside the reaction opens with a nod, and sends nothing when nothing is", async () => {
    const manager = fakeModel()
      .respondWithTools([{ name: "react", args: { emoji: "👍" } }])
      .respond(new AIMessage("Done: Reddit's off the table for today and the queued search is cancelled."))
      .respond(new AIMessage("NOTHING"));
    const world = makeWorld({ manager });
    await founder(world);

    await world.inbound.handle(say("No Reddit today please.", "13"));
    await world.manager.serveNext();

    expect(String(manager.calls[2]!.messages.at(-1)!.content)).toMatch(/^You reacted 👍 to their message: that already says you understood/);
    expect(world.channel.reactions.map((r) => r.emoji)).toEqual(["👍"]);
    expect(world.channel.sent).toEqual([]);
  });

  it("holds all of Reddit until the time they gave, and lets the 👍 speak for it", async () => {
    // Live on Telegram, 2026-10-08: set_place "reddit.com" was refused (no such place), the hold became a memory
    // nothing enforced or lifted, and "Reddit's off the list for today. I'll keep the finds warm…" went out beside the 👍.
    const manager = fakeModel()
      .respondWithTools([
        { name: "set_place", args: { place: "reddit.com", verdict: "avoid", reason: "No Reddit today please", until: "tomorrow 09:00" } },
        { name: "react", args: { emoji: "👍" } },
      ])
      .respond(new AIMessage("Reddit's off the list for today. I'll keep the finds warm and pick this up tomorrow morning."))
      .respond(new AIMessage("NOTHING"));
    const world = makeWorld({ manager });
    const id = await founder(world);
    const waiting = await world.finds.save({
      customerId: id,
      taskId: null,
      source: "reddit:r/taiwan",
      url: "https://www.reddit.com/r/taiwan/comments/t9/",
      author: "lin_99",
      title: "Landlord",
      quote: "My landlord only speaks Mandarin.",
      postedAt: null,
      why: "A language wall with a landlord.",
      reply: "Try Voca Vela.",
      strength: "strong",
    });

    await world.inbound.handle(say("No Reddit today please.", "16"));
    await world.manager.serveNext();

    expect(String(manager.calls[2]!.messages.at(-1)!.content)).toMatch(/^You reacted 👍 to their message: that already says you understood and are on it, and a reply that says it back in words/);
    expect(world.channel.reactions.map((r) => r.emoji)).toEqual(["👍"]);
    expect(world.channel.sent).toEqual([]);
    expect((await world.places.listFor(id)).find((p) => p.key === "reddit.com")).toMatchObject({ verdict: "avoid", rules: "The customer's call: No Reddit today please" });
    const lift = (await world.commitments.open(id)).find((c) => c.kind === "next_step");
    expect(lift).toMatchObject({ onTime: true, url: "https://www.reddit.com/" });
    expect(lift!.what).toMatch(/^Lift the hold on reddit\.com/);
    expect((await world.findStore.get(waiting!.id))?.status).not.toBe("new"); // the waiting Reddit find is dropped
  });

  it("turns a reply that only nods to a clear instruction into a 👍, but never nods at a question", async () => {
    const manager = fakeModel()
      .respondWithTools([{ name: "remember", args: { kind: "decision", text: "No Reddit today: they asked on 25 Sep." } }])
      .respond(new AIMessage("Got it, no Reddit today."))
      .respond(new AIMessage("Sure, which one?"));
    const world = makeWorld({ manager });
    await founder(world);

    await world.inbound.handle(say("No Reddit today please.", "14"));
    await world.manager.serveNext();
    expect(world.channel.reactions).toEqual([{ to: "42", ref: "14", emoji: "👍" }]);
    expect(world.channel.sent).toEqual([]);

    await world.inbound.handle(say("Can you check one more?", "15"));
    await world.manager.serveNext();
    expect(world.channel.reactions).toHaveLength(1);
    expect(world.channel.sent.map((m) => m.text)).toEqual(["Sure, which one?"]);
  });

  it("still replies when the reply says something the reaction does not", async () => {
    const manager = fakeModel()
      .respondWithTools([{ name: "react", args: { emoji: "🎉" } }])
      .respond(new AIMessage("Huge. That's our first paying customer from the r/taiwan thread."));
    const world = makeWorld({ manager });
    await founder(world);

    await world.inbound.handle(say("Grace just paid for the yearly plan!", "12"));
    await world.manager.serveNext();

    expect(world.channel.reactions.map((r) => r.emoji)).toEqual(["🎉"]);
    expect(world.channel.sent.map((m) => m.text)).toEqual(["Huge. That's our first paying customer from the r/taiwan thread."]);
  });

  it("does not nod at a question, react to every message, or use an emoji Telegram would refuse", () => {
    const at = new Date();
    const theirs = (reaction: string | null): TranscriptEntry => ({ direction: "in", text: "ok", at, reaction });
    expect(reactionRefusal("👍", { text: "Who should we try next?" }, [])).toMatch(/^it is a question/);
    expect(reactionRefusal("😁", { text: "Who knew grandmas were our market?" }, [])).toBeNull();
    expect(reactionRefusal("👍", { text: "Go ahead." }, [theirs("👍"), { direction: "out", text: "Done.", at }, theirs("❤")])).toMatch(/^you reacted to their last two messages/);
    expect(reactionRefusal("👍", { text: "Go ahead." }, [theirs("👍"), theirs(null)])).toBeNull();
    expect(reactionRefusal("👍", { text: "Go ahead.", reaction: "👌" }, [])).toMatch(/already has your 👌/);
    expect([reactionEmoji("❤️"), reactionEmoji("🫡"), reactionEmoji("💩"), reactionEmoji("🚀")]).toEqual(["❤", "🫡", null, null]);
  });

  it("knows a nod from a reply with news in it", () => {
    expect(["Got it.", "Done 👍", "Noted, no Reddit today.", "On it."].map(onlyANod)).toEqual([true, true, true, true]);
    expect(["Got it, back in 5 min 👀", "Done. Moved the search to Bluesky instead.", "Sure, which one?", "ok https://x.test"].map(onlyANod)).toEqual([false, false, false, false]);
  });

  it("offers react only in a turn where they wrote", () => {
    const world = makeWorld();
    const id = customerId("c1");
    const names = (userTurn: boolean) =>
      managerTools({ ...world, customerId: id, userTurn, customers: world.customers, now: world.clock.now, theirs: [{ ref: "1", text: "hi" }] }).map((t) => t.name);
    expect(names(true)).toContain("react");
    expect(names(false)).not.toContain("react");
  });
});

describe("owning the work", () => {
  it("calls a route spent after two tries in a row that did not work, and starts no more work on it without new evidence", async () => {
    const world = makeWorld();
    const id = await founder(world);
    const tools = toolsOf(world, id);
    const start = (extra: Record<string, string> = {}) =>
      tools["start_task"]!.invoke({ agent: "researcher", title: "Caregivers again", instructions: "Search caregiver communities for family interpreters.", route: "Family interpreters on Reddit", ...extra });

    expect(await tools["log_try"]!.invoke({ route: "Family interpreters on Reddit", result: "thin", note: "2 finds, both old" })).toBe('"Family interpreters on Reddit": 1 try, 0 worked, the last 1 did not.');
    expect(await tools["log_try"]!.invoke({ route: "family  interpreters on reddit", result: "failed", note: "0 finds" })).toMatch(/has not worked 2 times in a row: it is spent\. Change course now/);
    expect(await start()).toMatch(/^Not started: "Family interpreters on Reddit" is spent \(2 tries in a row did not work; the last: 0 finds\)/);
    expect(await start({ retry_because: "They just launched Taiwanese support, which these threads asked for." })).toMatch(/^Started task/);
    expect(await world.routes.get(id, "Family interpreters on Reddit")).toMatchObject({ status: "trying", misses: 1 });
    expect(await tools["log_try"]!.invoke({ route: "Family interpreters on Reddit", result: "thin", note: "still thin" })).toMatch(/it is spent/);
  });

  it("replaces what newer evidence makes untrue, and points out what still says the same", async () => {
    const world = makeWorld();
    const id = await founder(world);
    const tools = toolsOf(world, id);
    await tools["remember"]!.invoke({ kind: "lesson", text: "Family-interpreter wording in r/AgingParents and r/CaregiverSupport is exhausted; next try r/ABCDesis." });
    const second = await tools["remember"]!.invoke({ kind: "lesson", text: "Family-interpreter wording in r/AgingParents, r/CaregiverSupport and r/ABCDesis is exhausted; next try r/taiwan." });
    expect(second).toMatch(/^Kept for good as #2\. Still kept and saying much the same: #1 "Family-interpreter wording/);
    const merged = "Family-interpreter wording in r/AgingParents, r/CaregiverSupport and r/ABCDesis is spent; live-translator asks in r/taiwan are the lead.";
    expect(await tools["remember"]!.invoke({ kind: "lesson", text: merged, replaces: ["#1", "2"] })).toBe(
      "Kept for good as #3. It replaces #1, #2, now retired.",
    );
    expect((await world.memory.list(id, 10)).map((m) => m.id)).toEqual(["3"]);
  });

  it("does not retire an unrelated memory named by mistake, and keeps a turn's forgetting to a few", async () => {
    const world = makeWorld();
    const id = await founder(world);
    const tools = toolsOf(world, id, { userTurn: true });
    await tools["remember"]!.invoke({ kind: "decision", text: "Saved Messages test is done and verified; never send those test notes again." });
    // The real model's slip of 2026-10-07: "No Reddit today" kept as replacing the Saved Messages decision.
    expect(await tools["remember"]!.invoke({ kind: "decision", text: "No Reddit today (7 Oct evening).", replaces: ["1"] })).toBe(
      'Kept for good as #2. Not retired, as it says something else: #1 ("Saved Messages test is done and verified; never send those test notes again."). If it is no longer true, forget it on its own.',
    );
    for (let i = 0; i < 5; i++) await world.memory.add(id, { kind: "lesson", text: `Lesson number ${i} about something`, source: "manager" });
    const forget = (n: string) => tools["forget"]!.invoke({ memory_id: n });
    for (const n of ["3", "4", "5", "6"]) expect(await forget(n)).toMatch(/^Retired #/);
    expect(await forget("7")).toMatch(/^Not retired: you have forgotten 4 this turn/);
    expect((await world.memory.list(id, 10)).map((m) => m.id)).toEqual(["7", "2", "1"]);
  });

  it("tells memories that say much the same from ones that do not, as the live ones of 2026-10-07 were", () => {
    // Lessons #158 and #159, word for word: one route, each calling the last one's plan exhausted.
    const a = 'Family-interpreter wording in r/AgingParents and r/CaregiverSupport is exhausted. Next: web search site:reddit.com for "translate for my mom" unquoted, and r/AsianParentStories / r/ABCDesis with the same phrasing.';
    const b = 'Web site:reddit.com "translate for my mom/dad" family-interpreter phrasing is exhausted (false matches only); next is r/ABCDesis "doesn\'t speak English" and reading the r/taiwan and r/chinalife threads.';
    // Lesson #142, about something else.
    const other = "Trustpilot/G2/Capterra form-builder review mining is done (Tally era): do not spend runs on review-site filters again; keep to Voca Vela language-wall searches on Reddit and the web.";
    expect(overlap(a, b)).toBeGreaterThanOrEqual(SAME_MEMORY);
    expect(overlap(a, other)).toBeLessThan(SAME_MEMORY);
  });

  it("lifts a hold they put a time on when the time is up, and says so when the time was left out", async () => {
    const world = makeWorld();
    const id = await founder(world);
    const tools = toolsOf(world, id, { userTurn: true });
    expect(await tools["set_place"]!.invoke({ place: "r/taiwan", verdict: "avoid", reason: "No Reddit today please", until: "tomorrow 09:00" })).toBe(
      'r/taiwan is now "avoid" on their list. The scout will not save finds from it. The hold lifts at Sat 09:00 their time (next step #1).',
    );
    expect(await world.commitments.open(id)).toMatchObject([{ kind: "next_step", onTime: true, dueAt: new Date("2026-09-26T09:00:00Z") }]);
    expect(world.events.commitmentWake(id, "1")).toEqual(new Date("2026-09-26T09:00:00Z"));
    expect(await tools["set_place"]!.invoke({ place: "r/chinalife", verdict: "avoid", reason: "No Reddit today please" })).toMatch(/They put a time on it: set it again with until/);
  });

  it("hears the same work promised twice in other words as one promise", async () => {
    const manager = fakeModel()
      .respond(new AIMessage("I'm now hunting expats stuck on landlords in Germany and Portugal, give me 10 min."))
      .respond(new AIMessage("Try the r/taiwan student first. Germany and Portugal search is running, about 10 min."));
    const world = makeWorld({ manager });
    const id = await founder(world);
    await world.inbound.handle(say("How's it going?", "50"));
    await world.manager.serveNext();
    await world.inbound.handle(say("Who should we try next?", "51"));
    await world.manager.serveNext();

    expect(await world.commitments.open(id)).toHaveLength(1);
  });

  it("changes how it posts only on their word", async () => {
    const world = makeWorld();
    const id = await founder(world);
    expect(await toolsOf(world, id, { theySpoke: false })["posting"]!.invoke({ ask_first: true, platform: "reddit" })).toMatch(/^Not changed: how you post changes only on their word/);
    expect(await world.trust.approved(id, "reddit")).toBe(0);
    expect(await toolsOf(world, id, { userTurn: true, theySpoke: true })["posting"]!.invoke({ ask_first: true, platform: "reddit" })).toMatch(/^Done/);
  });

  it("puts likes and follows on by themselves everywhere, and keeps asking for the rest", async () => {
    // Live, 2026-11-05: "You can do all likes and follows automatically, on all platforms. But ask me for replies, dms and posts."
    const world = makeWorld();
    const id = await founder(world);
    const posting = toolsOf(world, id, { userTurn: true, theySpoke: true })["posting"]!;
    await posting.invoke({ ask_first: true });
    expect(await posting.invoke({ ask_first: false, platform: "*", kinds: ["like", "follow"] })).toMatch(/^Done: likes, follows on every platform go up by themselves/);
    expect(await world.trust.alone(id, trustKey("linkedin.com", "like"))).toBe(true);
    expect(await world.trust.alone(id, trustKey("youtube.com", "follow"))).toBe(true);
    expect(await world.trust.alone(id, trustKey("x.com", "reply"))).toBe(false);
    expect(await world.trust.alone(id, trustKey("x.com", "post"))).toBe(false);
  });

  it("keeps results with their evidence, and tells unknown from zero", async () => {
    const world = makeWorld();
    const id = await founder(world);
    const tools = toolsOf(world, id, { userTurn: true });
    expect(await tools["record_result"]!.invoke({ stage: "paying", count: 0, evidence: "They said nobody pays yet.", source: "told" })).toBe(
      "On record: 0 paying customers. Results now: conversations unknown; trials unknown; active users unknown; paying customers 0 (they told you 0 on 25 Sept).",
    );
    await tools["record_result"]!.invoke({ stage: "conversation", person: "u/grace_lin", url: "https://www.reddit.com/r/taiwan/comments/t1/", evidence: "Answered: 'does it do Taiwanese?'", source: "seen" });
    expect(await tools["record_result"]!.invoke({ stage: "conversation", person: "U/Grace_Lin", evidence: "again", source: "seen" })).toMatch(/^Already on record: U\/Grace_Lin\. Results now: conversations at least 1 \(u\/grace_lin\)/);
    expect(await tools["record_result"]!.invoke({ stage: "trial", evidence: "no one", source: "told" })).toBe("Not recorded: give a person, or a count, one of them.");
  });

  it("briefs the manager on results, what it owes, its team's pace, a run running late, and the reactions it gave", async () => {
    const manager = fakeModel().respond(new AIMessage("Reddit filtered both replies, so they didn't get us anywhere. I'm changing course."));
    const world = makeWorld({ manager });
    const id = await founder(world);
    world.taskStore.pace = [{ agent: "scout", runs: 103, medianMs: 7 * MIN, p80Ms: 10 * MIN }];
    await world.results.record(id, { stage: "paying", person: null, count: 0, url: null, evidence: "They said nobody pays yet.", source: "told" });
    await world.commitments.add(id, { kind: "promise", what: "whether it does Taiwanese", words: "within an hour", person: null, url: null, taskId: null, dueAt: new Date(world.clock.t + 60 * MIN), onTime: false, source: "said" });
    await world.tasks.start(id, "scout", "Live translator asks", "Search r/taiwan.");
    await world.taskStore.claim("w", 60_000, 5);
    // An earlier turn's message, with the reaction that turn put on it.
    await world.transcript.recordIncoming(id, "telegram", "20", "No Reddit today please.");
    await world.transcript.recordReaction(id, "telegram", "20", "👍");
    world.clock.advance(12 * MIN);

    await world.inbound.handle(say("How's it going?", "21"));
    await world.manager.serveNext();

    const briefing = briefingOf(manager, 0);
    expect(briefing).toContain("Results, what counts (record_result with evidence): conversations unknown; trials unknown; active users unknown; paying customers 0 (they told you 0 on 25 Sept).");
    expect(briefing).toContain("Unknown is not zero");
    expect(briefing).toContain('  - #1 promise, due 13:00 their time (in 48 min): whether it does Taiwanese (you said "within an hour" 12 min ago)');
    expect(briefing).toContain("How long your team takes (last 14 days): scout about 7 min, 8 in 10 within 10 min.");
    expect(briefing).toContain('Open work: scout "Live translator asks" running for 12 min, longer than 8 in 10 of its runs: running late.');
    expect(briefing).toContain('They: No Reddit today please. [you reacted 👍]');
    expect(briefing).toContain("Routes: none logged yet.");
    expect(briefing).toContain("They are asking how it's going. Answer like a friend who owns the work: lead with results, the ones on record above; then what you are changing.");
  });

  it("frames how-it's-going around the results on record and the routes that stopped working", async () => {
    const manager = fakeModel().respond(new AIMessage("Reddit filtered both replies, so they didn't get us anywhere. I kept pushing that too long, so I'm switching to DMs."));
    const world = makeWorld({ manager });
    const id = await founder(world);
    await world.routes.log(id, "Reddit posts and replies", "failed", "taken down in r/test");
    await world.routes.log(id, "Reddit posts and replies", "failed", "taken down in r/Thailand");

    await world.inbound.handle(say("How's it going?", "40"));
    await world.manager.serveNext();

    const briefing = briefingOf(manager, 0);
    expect(briefing).toContain(
      'They are asking how it\'s going. Answer like a friend who owns the work: lead with results, and there are none on record, so say so plainly; then what did not work ("Reddit posts and replies": spent) and what you are doing instead.',
    );
    expect(briefing).toContain(' Spent (did not work twice in a row: change course, and go back only with new evidence):\n  - "Reddit posts and replies": 2 tries, 0 worked, last 2 did not (taken down in r/Thailand)');
  });
});

describe("the voice of a friend who runs the work with them", () => {
  it("asks once for a rewrite of canned reassurance and forced slang, and leaves everyday shorteners alone", () => {
    expect(voiceNotes("No worries, I've got this.")).toEqual(['it reassures with a stock line ("No worries"): leave it out, what you do next says it']);
    expect(voiceNotes("Thanks for your patience, the list is coming.")[0]).toMatch(/^it reassures with a stock line \("Thanks for your patience"\)/);
    expect(voiceNotes("Bestie, these two slay.")).toEqual(['"Bestie" reads as forced slang: say it the way you\'d text a friend you work with']);
    // Slang that lands is the voice (2026-10-29): only the costume is asked again.
    expect(voiceNotes("No cap, these two are great.")).toEqual([]);
    expect(voiceNotes("Give me 5 min, btw the DM to Grace went out 👀")).toEqual([]);
  });

  it("asks for results first when they asked how it's going, and for less card talk", () => {
    const busy = "Fresh search is running in r/chinalife, r/taiwan and r/expats, about 10 min.";
    expect(voiceNotes(busy, { progress: true })).toEqual([
      "they asked how it's going and it says what you did, not what came of it: lead with the results (or plainly that there are none yet) and what didn't work",
    ]);
    expect(voiceNotes("No results yet: nobody's talked, tried or paid. Reddit kept filtering the posts, so I dropped it.", { progress: true })).toEqual([]);
    expect(voiceNotes("Two cards are up now, the rest follow on their own.")[0]).toMatch(/^it talks about their cards \("Two cards are up"\)/);
    // Its own bookkeeping, and a greeting where the point should be (a rehearsal with the real model, 2026-10-07).
    expect(voiceNotes("Hi Dana, I'm Quest. What's your website?", { reply: true })).toEqual([]); // a first hello
    expect(voiceNotes("Hey. Honest answer: no results yet. Reddit posts and replies are spent.", { reply: true, earlier: ["Two finds just landed."] })).toEqual([
      'it says how you did the work ("are spent"): say what came of it, and leave out the search words, filters, pages and numbers behind it',
      'it opens with "Hey.": in a reply, start with the point',
    ]);
  });

  it("asks for the links when a shortlist names people without them", () => {
    const bare = "Best bets: u/Little_Guarantee_371 (r/taiwan, live lecture translation), u/Adept_Key7376 (r/taiwan, landlord).";
    expect(voiceNotes(bare, { shortlist: true })).toEqual(["it names people without their links: put each one's link by their name, so they can open it"]);
    expect(voiceNotes(`${bare} https://www.reddit.com/r/taiwan/comments/1wzvwf4/`, { shortlist: true })).toEqual([]);
    expect(voiceNotes(bare)).toEqual([]);
  });

  it("hears card talk with no number in it", () => {
    // Live on Telegram, 2026-10-08, closing a shortlist.
    expect(voiceNotes("3. u/teal_kite (r/Bangkok): landlord fight, no shared language.\n\nCards are up.")[0]).toMatch(/^it talks about their cards \("Cards are up"\)/);
    expect(voiceNotes("The three fresh ones from this morning are on the cards in front of you.")[0]).toMatch(/^it talks about their cards \("on the cards"\)/);
  });

  it("puts each shortlisted person's link on their name, once, and leaves other names alone", () => {
    const list = [
      "The best people found so far (3), best first:",
      '- u/Quiet-Lake-1234 in Reddit (r/AgingParents) (posted 3 days ago, strong, on a card): "translating for both parents" Why: fits https://www.reddit.com/r/AgingParents/comments/a1/x/ [find f1]',
      '- u/teal_kite in Reddit (r/Bangkok) (posted 1 day ago, strong, not shown yet): "landlord" Why: fits https://www.reddit.com/r/Bangkok/comments/b2/y/ [find f2]',
      '- someone in Hacker News (found 2 hours ago, maybe, not shown yet): "x" Why: y https://news.ycombinator.com/item?id=1 [find f3]',
    ].join("\n");
    const people = shortlistPeople([list]);
    expect(people.map((p) => p.who)).toEqual(["u/Quiet-Lake-1234", "u/teal_kite"]);
    // The live reply, 2026-10-08: three names, no links.
    expect(linkPeople("1. u/Quiet-Lake-1234 (r/AgingParents): two parents. Ask u/Quiet-Lake-1234 first.\n2. teal_kite (r/Bangkok): landlord fight.", people)).toBe(
      "1. [u/Quiet-Lake-1234](https://www.reddit.com/r/AgingParents/comments/a1/x/) (r/AgingParents): two parents. Ask u/Quiet-Lake-1234 first.\n" +
        "2. [teal_kite](https://www.reddit.com/r/Bangkok/comments/b2/y/) (r/Bangkok): landlord fight.",
    );
    const linked = "Try u/teal_kite https://www.reddit.com/r/Bangkok/comments/b2/y/ and u/teal_kite0.";
    expect(linkPeople(linked, people)).toBe(linked);
    // The model's own short form of the link counts (live, 2026-10-08: "Links: reddit.com/r/Bangkok/comments/1wpo6l0").
    expect(linkPeople("u/teal_kite: reddit.com/r/Bangkok/comments/b2", people)).toBe("u/teal_kite: reddit.com/r/Bangkok/comments/b2");
    expect(linkPeople("Nobody to name.", people)).toBe("Nobody to name.");
    expect(namedIn("**u/Quiet-Lake-1234** and u/teal_kite, not r/u/x or au/thing")).toEqual(["Quiet-Lake-1234", "teal_kite"]);
    // Live, 2026-10-08: names without their "u/". Ordinary words are never taken for one.
    expect(namedIn("Quiet-Lake-1234 replied 6 days ago; Grace and mom too, see reddit.com/user/x_1")).toEqual(["Quiet-Lake-1234"]);
    expect(linkPeople("Quiet-Lake-1234 replied 6 days ago.", people)).toBe("[Quiet-Lake-1234](https://www.reddit.com/r/AgingParents/comments/a1/x/) replied 6 days ago.");
    expect(linkPeople("grace said hi", [{ who: "u/grace", url: "https://www.reddit.com/r/taiwan/comments/g1/" }])).toBe("grace said hi");
  });

  it("files all of Reddit as one place, and holds every community under it", () => {
    expect(placeKey("https://www.reddit.com/")).toBe("reddit.com");
    expect(placeKey("https://www.reddit.com/r/taiwan/comments/t1/")).toBe("reddit:r/taiwan");
    expect(placeKey("https://www.reddit.com/user/teal_kite/")).toBeNull();
    expect(placeKeys("https://www.reddit.com/r/taiwan/comments/t1/")).toEqual(["reddit:r/taiwan", "reddit.com"]);
    expect(placeKeys("https://www.reddit.com/user/teal_kite/")).toEqual(["reddit.com"]);
    expect(placeKeys("https://news.ycombinator.com/item?id=1")).toEqual(["news.ycombinator.com"]);
  });

  it("links a person it found when it names them from the chat before, with no shortlist this turn", async () => {
    // Live, 2026-10-08: "Can you send me their links?" named u/Quiet-Lake-1234 from the earlier reply; this turn's shortlist no longer had them.
    const manager = fakeModel().respond(new AIMessage("u/grace_lin is the one: her grandma only speaks Taiwanese."));
    const world = makeWorld({ manager });
    const id = await founder(world);
    await world.finds.save({
      customerId: id,
      taskId: null,
      source: "reddit:r/taiwan",
      url: "https://www.reddit.com/r/taiwan/comments/t1/",
      author: "grace_lin",
      title: "Translator for grandma",
      quote: "My grandma only speaks Taiwanese, is there a live translator that works?",
      postedAt: new Date(world.clock.t - 2 * 86_400_000),
      why: "Asks for exactly a live two-way translator.",
      reply: "We built Voca Vela for this.",
      strength: "strong",
    });

    await world.inbound.handle(say("Can you send me their links?", "9"));
    await world.manager.serveNext();

    expect(world.channel.sent.map((m) => m.text)).toEqual(["[u/grace_lin](https://www.reddit.com/r/taiwan/comments/t1) is the one: her grandma only speaks Taiwanese."]);
  });

  it("sends the reply to \"who next?\" with the links, though the model left them out", async () => {
    const manager = fakeModel()
      .respondWithTools([{ name: "best_people", args: { count: 3 } }])
      .respond(new AIMessage("Try u/grace_lin first: her grandma only speaks Taiwanese. Reply with the trial link."));
    const world = makeWorld({ manager });
    const id = await founder(world);
    await world.finds.save({
      customerId: id,
      taskId: null,
      source: "reddit:r/taiwan",
      url: "https://www.reddit.com/r/taiwan/comments/t1/",
      author: "grace_lin",
      title: "Translator for grandma",
      quote: "My grandma only speaks Taiwanese, is there a live translator that works?",
      postedAt: new Date(world.clock.t - 2 * 86_400_000),
      why: "Asks for exactly a live two-way translator.",
      reply: "We built Voca Vela for this.",
      strength: "strong",
    });

    await world.inbound.handle(say("Who should we try next?", "8"));
    await world.manager.serveNext();

    expect(world.channel.sent.map((m) => m.text)).toEqual([
      "Try [u/grace_lin](https://www.reddit.com/r/taiwan/comments/t1) first: her grandma only speaks Taiwanese. Reply with the trial link.",
    ]);
    expect(manager.calls).toHaveLength(2); // linked in code: no rewrite asked for
  });
});
