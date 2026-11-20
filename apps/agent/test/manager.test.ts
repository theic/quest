import { AIMessage } from "@langchain/core/messages";
import { fakeModel } from "@langchain/core/testing";
import { describe, expect, it } from "vitest";
import { CARD_MARK, QUESTION_MARK } from "../src/conversation/messenger.ts";
import { capitalized, unstyled, stockPhrases, voiceNotes } from "../src/lib/voice.ts";
import { waitingOn } from "../src/manager/follow-up.ts";
import { holdBack, managerTools, UNATTENDED_STARTS_A_DAY } from "../src/manager/tools.ts";
import { chatPulse, type ChatPulse } from "../src/manager/turn-input.ts";
import { makeWorld, telegramSender } from "./world.ts";

/** A system prompt's words, whether sent as a string or as content blocks. */
const systemText = (m: { content: unknown }): string =>
  typeof m.content === "string" ? m.content : (m.content as { text?: string }[]).map((b) => b.text ?? "").join("");

const say = (text: string, ref: string) => ({ type: "text" as const, from: telegramSender(), text, messageRef: ref, replyToRef: null });

describe("the manager", () => {
  it("answers a first-time customer in the chat, after their language and the one question", async () => {
    const manager = fakeModel().respond(new AIMessage("nice. what's the site?"));
    const world = makeWorld({ manager });
    await world.inbound.handle({ type: "command", from: telegramSender(), command: "start", args: "", messageRef: "1" });
    await world.inbound.handle({ type: "language", from: telegramSender(), locale: "auto", ackRef: "cb1", messageRef: world.channel.sent[0]!.ref });
    await world.inbound.handle(say("I'm building a form builder for waitlists", "2"));

    expect(await world.manager.serveNext()).toBe(true);

    expect(world.channel.sent.at(-1)?.text).toBe("Nice. What's the site?");
    const briefing = String(manager.calls[0]!.messages.at(-1)!.content);
    expect(briefing).toContain("I'm building a form builder for waitlists");
    expect(briefing).not.toContain("Their quest");
    expect(briefing).toContain("your final message will be sent to them".replace("your", "Your"));
    expect(systemText(manager.calls[0]!.messages[0]!)).toContain("You have already asked them what they work on, what they want from it and where");
    // All handled; what's left is the wake to follow up "What's your website?" if it goes unanswered.
    expect(world.events.events.filter((e) => e.status !== "done").map((e) => e.event.kind)).toEqual(["follow_up"]);
  });

  it("hands work to the team and replies without waiting for it", async () => {
    const manager = fakeModel()
      .respondWithTools([
        { name: "save_site", args: { url: "acme.test" } },
        { name: "start_task", args: { agent: "researcher", title: "Read acme.test", instructions: "Read https://acme.test and report." } },
      ])
      .respond(new AIMessage("Reading your site now. I'll be back here in a few minutes."));
    const world = makeWorld({ manager });
    await world.inbound.handle(say("my site is acme.test", "1"));

    await world.manager.serveNext();

    const [c] = [...world.customers.customers.values()];
    expect(c?.siteUrl).toBe("https://acme.test/");
    expect(c?.status).toBe("active");
    const [task] = await world.tasks.list(c!.id);
    expect(task?.status).toBe("queued"); // the manager started it and moved on
    expect(world.channel.sent.at(-1)?.text).toBe("Reading your site now. I'll be back here in a few minutes.");
  });

  it("keeps a background turn private unless it chooses to speak", async () => {
    const manager = fakeModel()
      .respondWithTools([{ name: "message_user", args: { text: "Your site is read. It's invoicing for freelancers, right?" } }])
      .respond(new AIMessage("Told them; waiting for their confirmation."));
    const world = makeWorld({ manager });
    const c = await world.customers.create({ channel: telegramSender().channel, userRef: "42", displayName: "Dana", language: "en" });
    const task = await world.tasks.start(c.id, "researcher", "Read", "Read it.");
    await world.events.push(c.id, { kind: "task_finished", taskId: task.id, agent: "researcher", outcome: "succeeded", summary: "Invoicing for freelancers." });

    await world.manager.serveNext();

    expect(world.channel.sent.map((m) => m.text)).toEqual(["Your site is read. It's invoicing for freelancers, right?"]);
  });

  it("checks itself when work they asked for came back and they heard nothing, and lets the work go on quietly otherwise", async () => {
    const manager = fakeModel()
      .respond(new AIMessage("Tally is a form builder for makers; brief written.")) // a summary, left private
      .respondWithTools([{ name: "message_user", args: { text: "Read your site: Tally is a free form builder that works like a doc." } }])
      .respond(new AIMessage("Sent the summary."))
      .respond(new AIMessage("Two more saved in r/nocode; they come up as cards.")); // hours later: stays private
    const world = makeWorld({ manager });
    const c = await world.customers.create({ channel: telegramSender().channel, userRef: "42", displayName: "Dana", language: "en" });
    await world.transcript.recordIncoming(c.id, "telegram", "1", "tally.so");
    const task = await world.tasks.start(c.id, "scout", "Read", "Read it.");
    await world.events.push(c.id, { kind: "task_finished", taskId: task.id, agent: "scout", outcome: "succeeded", summary: "Tally: forms." });

    await world.manager.serveNext();

    expect(world.channel.sent.map((m) => m.text)).toEqual(["Read your site: Tally is a free form builder that works like a doc."]);
    expect(String(manager.calls[1]!.messages.at(-1)!.content)).toMatch(/^Before you finish: the customer wrote to you within the hour/);

    world.clock.advance(3 * 3_600_000);
    await world.events.push(c.id, { kind: "task_finished", taskId: task.id, agent: "scout", outcome: "succeeded", summary: "Saved 2." });
    await world.manager.serveNext();
    expect(manager.calls).toHaveLength(4);
    expect(world.channel.sent).toHaveLength(1);
  });

  it("sends the evening report itself when the turn kept it private, and skips only a day it calls empty", async () => {
    const report = "Two people in r/nocode asked for a Typeform alternative today. Tomorrow I read r/nonprofit.";
    const manager = fakeModel()
      .respond(new AIMessage("Report: two finds in r/nocode, nonprofit tomorrow.")) // written as its private last word (live, 2026-09-30)
      .respond(new AIMessage(report))
      .respond(new AIMessage("Nothing happened; said so yesterday."))
      .respond(new AIMessage("NOTHING."));
    const world = makeWorld({ manager });
    const c = await world.customers.create({ channel: telegramSender().channel, userRef: "42", displayName: "Dana", language: "en" });

    await world.events.push(c.id, { kind: "day_report", day: "2026-09-30" });
    await world.manager.serveNext();
    expect(world.channel.sent.map((m) => m.text)).toEqual([report]);
    expect(String(manager.calls[1]!.messages.at(-1)!.content)).toMatch(/^Their evening report is due/);

    await world.events.push(c.id, { kind: "day_report", day: "2026-10-01" });
    await world.manager.serveNext();
    expect(world.channel.sent).toHaveLength(1);
  });

  it("does not second-guess a background turn that already spoke", async () => {
    const manager = fakeModel()
      .respondWithTools([{ name: "message_user", args: { text: "Your site is read." } }])
      .respond(new AIMessage("Told them."));
    const world = makeWorld({ manager });
    const c = await world.customers.create({ channel: telegramSender().channel, userRef: "42", displayName: "Dana", language: "en" });
    const task = await world.tasks.start(c.id, "researcher", "Read", "Read it.");
    await world.events.push(c.id, { kind: "task_finished", taskId: task.id, agent: "researcher", outcome: "succeeded", summary: "x" });

    await world.manager.serveNext();

    expect(manager.calls).toHaveLength(2);
  });

  it("offers message_user only in turns where nobody wrote", async () => {
    const world = makeWorld();
    const c = await world.customers.create({ channel: telegramSender().channel, userRef: "42", displayName: "Dana", language: "en" });
    const names = (userTurn: boolean) =>
      managerTools({ ...world, customerId: c.id, userTurn, customers: world.customers, now: () => new Date() }).map((t) => t.name);

    expect(names(true)).toContain("start_task");
    expect(names(true)).not.toContain("message_user");
    expect(names(false)).toContain("message_user");
  });

  it("works on its own at a day's pace, without reporting in, and never turns down what the customer asks for", async () => {
    const world = makeWorld();
    const c = await world.customers.create({ channel: telegramSender().channel, userRef: "42", displayName: "Dana", language: "en" });
    await world.transcript.recordIncoming(c.id, "telegram", "1", "tally.so");
    const pulse = chatPulse(await world.transcript.recent(c.id, 100), world.clock.now(), null);
    const tools = (userTurn: boolean) =>
      Object.fromEntries(managerTools({ ...world, customerId: c.id, userTurn, customers: world.customers, now: world.clock.now, pulse }).map((t) => [t.name, t]));
    const start = (userTurn: boolean, title: string) =>
      tools(userTurn)["start_task"]!.invoke({ agent: "researcher", title, instructions: "Look for posts about it." });

    world.clock.advance(60_000);
    for (let i = 1; i <= UNATTENDED_STARTS_A_DAY; i++) expect(await start(false, `Run ${i}`)).toMatch(/^Started task/);
    expect(await start(false, "One more")).toMatch(/^Not started: you have started 8 tasks on your own in the last day/);
    // The customer is in the chat: their turn is never refused.
    expect(await start(true, "They asked for it")).toMatch(/^Started task/);

    world.clock.advance(24 * 3_600_000);
    expect(await start(false, "Next day")).toMatch(/^Started task/);
  });

  it("apologises when a turn keeps failing, instead of going silent", async () => {
    const manager = fakeModel().alwaysThrow(new Error("provider down"));
    const world = makeWorld({ manager });
    await world.inbound.handle(say("hello", "1"));

    await world.manager.serveNext();
    for (const e of world.events.events) e.availableAt = 0;
    await world.manager.serveNext();

    expect(world.channel.sent.at(-1)?.text).toMatch(/something went wrong on my side/);
    expect(world.events.events[0]?.status).toBe("failed");
  });
});

describe("the manager's voice", () => {
  it("turns dashes into commas, and keeps ranges as ranges", () => {
    expect(unstyled("I'm on the team at Tally — since you asked")).toBe("I'm on the team at Tally, since you asked");
    expect(unstyled("Tally — the free one — fits.")).toBe("Tally, the free one, fits.");
    expect(unstyled("3–5 posts a week, word—word")).toBe("3-5 posts a week, word, word");
    expect(unstyled("A dash at the end —\n— and one at the start")).toBe("A dash at the end\nand one at the start");
    expect(unstyled("It is **so** good, *really* and _truly_, see snake_case_name, 2*3*4 and https://a.co/_x_")).toBe("It is so good, really and truly, see snake_case_name, 2*3*4 and https://a.co/_x_");
  });

  it("starts every sentence with a capital, and leaves handles, links and abbreviations be", () => {
    expect(capitalized("i'm on it. if i can, i'll send it")).toBe("I'm on it. If I can, I'll send it");
    expect(capitalized("@maya ha, fair 😅")).toBe("@maya Ha, fair 😅");
    expect(capitalized("x.com folds it. so... yeah, e.g. this. u/maya said hi")).toBe("x.com folds it. So... yeah, e.g. this. u/maya said hi");
    expect(capitalized("привет. як справи", "uk")).toBe("Привет. Як справи");
  });

  it("never sends a dash as punctuation", async () => {
    const manager = fakeModel().respond(new AIMessage("Read it — invoicing for freelancers, 3–5 people a week ask for it."));
    const world = makeWorld({ manager });
    await world.inbound.handle(say("did you read it?", "1"));

    await world.manager.serveNext();

    expect(world.channel.sent.at(-1)?.text).toBe("Read it, invoicing for freelancers, 3-5 people a week ask for it.");
  });

  it("reads the chat's pulse from the transcript: cards and questions are not messages", () => {
    const at = (h: number, m = 0) => new Date(Date.UTC(2026, 8, 28, h, m));
    const pulse = (now: Date, timezone: string | null = null) => chatPulse([
      { direction: "in", text: "hi", at: at(7) },
      { direction: "in", text: "tally.so", at: at(8, 30) },
      { direction: "out", text: "Reading it now.", at: at(8, 31) },
      { direction: "in", text: "thanks", at: at(19) },
      { direction: "out", text: "Found two people in r/nocode.", at: at(20) },
      { direction: "out", text: `${CARD_MARK}Reddit r/nocode: https://reddit.test/1`, at: at(20, 1) },
      { direction: "out", text: `${QUESTION_MARK}Nonprofits too?`, at: at(20, 2) },
      { direction: "out", text: "The r/nocode one posted yesterday.", at: at(22) },
      { direction: "out", text: "Someone in r/nonprofit asked an hour ago.", at: at(31) }, // the next morning
    ], now, timezone);
    expect(pulse(at(32))).toEqual({ lastFromThem: at(19), lastToThem: at(31), unanswered: 3, unansweredToday: 1, theirHours: "07-08, 19", waitingOn: null });
    // "Today" is their day: in Kyiv, 22:00 UTC was already past midnight.
    expect(pulse(at(32), "Europe/Kyiv").unansweredToday).toBe(2);
    expect(chatPulse([{ direction: "in", text: "hi", at: at(7) }], at(8), null).theirHours).toBeNull();
  });

  it("writes first the way a hire writes to a busy manager: twice a day at most, hours apart", () => {
    const now = new Date(Date.UTC(2026, 9, 1, 12));
    const ago = (h: number) => new Date(now.getTime() - h * 3_600_000);
    const chat = (p: Partial<ChatPulse>): ChatPulse => ({ lastFromThem: ago(20), lastToThem: null, unanswered: 0, unansweredToday: 0, theirHours: null, waitingOn: null, ...p });

    expect(holdBack(chat({}), 0, now)).toBeNull();
    expect(holdBack(chat({}), 1, now)).toBe("you already wrote to them in this turn");
    expect(holdBack(chat({ lastToThem: ago(4), unanswered: 1, unansweredToday: 1 }), 0, now)).toBeNull();
    expect(holdBack(chat({ lastToThem: ago(1), unanswered: 1, unansweredToday: 1 }), 0, now)).toBe("you wrote to them 1 h ago");
    expect(holdBack(chat({ lastToThem: ago(5), unanswered: 2, unansweredToday: 2 }), 0, now)).toBe("you already wrote to them 2 times today without a word back");
    // Yesterday's messages don't use up today's.
    expect(holdBack(chat({ lastToThem: ago(10), unanswered: 4, unansweredToday: 0 }), 0, now)).toBeNull();
    // In the conversation (they wrote 15 minutes ago): a follow-up, but not a second one unanswered.
    expect(holdBack(chat({ lastFromThem: ago(0.25), lastToThem: ago(0.2), unanswered: 1 }), 0, now)).toBeNull();
    expect(holdBack(chat({ lastFromThem: ago(0.25), lastToThem: ago(0.2), unanswered: 1 }), 1, now)).toBe("they have not answered your last 2 messages");
  });

  it("holds back what it would say first, but never the evening report", async () => {
    const message = (id: string, text: string) => new AIMessage({ content: "", tool_calls: [{ id, name: "message_user", args: { text } }] });
    const manager = fakeModel()
      .respond(message("a", "Someone in r/nocode wants off Jotform today, and it's a clean fit."))
      .respond(message("b", "Next I'm trying r/nonprofit."))
      .respond(new AIMessage("Told them."))
      .respond(message("c", "Another one in r/nocode."))
      .respond(new AIMessage("Held it."))
      .respond(message("d", "Three new people today, all in r/nocode and all leaving Jotform over price. Tomorrow I try the same in r/nonprofit."))
      .respond(new AIMessage("Reported."));
    const world = makeWorld({ manager });
    const c = await world.customers.create({ channel: telegramSender().channel, userRef: "42", displayName: "Dana", language: "en" });
    await world.transcript.recordIncoming(c.id, "telegram", "1", "tally.so");
    world.clock.advance(5 * 3_600_000);

    await world.events.push(c.id, { kind: "heartbeat" });
    await world.manager.serveNext();
    expect(String(manager.calls[2]!.messages.at(-1)!.content)).toMatch(/^Not sent: you already wrote to them in this turn\. They hired you/);

    world.clock.advance(10 * 60_000);
    await world.events.push(c.id, { kind: "heartbeat" });
    await world.manager.serveNext();
    expect(String(manager.calls[4]!.messages.at(-1)!.content)).toMatch(/^Not sent: you wrote to them 10 min ago/);

    world.clock.advance(10 * 60_000);
    await world.events.push(c.id, { kind: "day_report", day: "2026-10-01" });
    await world.manager.serveNext();
    expect(world.channel.sent.map((m) => m.text)).toEqual([
      "Someone in r/nocode wants off Jotform today, and it's a clean fit.",
      "Three new people today, all in r/nocode and all leaving Jotform over price. Tomorrow I try the same in r/nonprofit.",
    ]);
  });

  it("asks once for a shorter message, and one that says what came of the work rather than how", () => {
    // Live, 2026-10-01.
    expect(
      voiceNotes(
        "Experiment #20 is in: 3 finds from Typeform and Jotform Cancellation pages 2-3, 2 strong (Alexander M. on Typeform's \"insane\" pricing for a glorified form builder, Emaline Taylor double-charged over $1,000 on Jotform and leaving). Pages 2-3 were mostly people we already have, so that filter is nearly mined out. Cards are queued behind yours. Next I'll try the Price or Subscription filter on those same brands' page 2.",
      ),
    ).toEqual([
      'it says how you did the work ("Experiment #20"): say what came of it, and leave out the search words, filters, pages and numbers behind it',
      'it talks about their cards ("queued behind yours"): the cards speak for themselves, so leave them out',
      "it runs 69 words: say it in under 25, the way you'd text a busy manager, unless they asked for the detail",
    ]);
    expect(voiceNotes("Reddit is quiet today. 84 finds still wait on your cards. Evening report goes out at 20:00.")).toEqual([
      'it talks about their cards ("84 finds still wait"): the cards speak for themselves, so leave them out',
      'it says when the report comes ("report goes out"): they know, so leave it out',
    ]);
    expect(voiceNotes("Someone in r/smallbusiness is leaving Jotform after a double charge, and needs unlimited forms. Clean fit, the reply is ready.")).toEqual([]);
    // "Card" is Quest's word, not theirs (the founder, 2026-11-01: "a card doesn't bring more clarity, use simpler language").
    expect(voiceNotes("Clean fit, the reply is on the card.")).toEqual([
      'it says "card", which means nothing to them: say what waits in plain words ("the reply to Dana is waiting for your OK"), or leave it out',
    ]);
    expect(voiceNotes("Stripe takes any credit card there.")).toEqual([]);
  });

  it("chases a question they owe an answer to: in an hour, a few hours later, then each morning, never at night", () => {
    const at = (day: number, h: number, m = 0) => new Date(Date.UTC(2026, 9, day, h, m));
    const out = (text: string, when: Date) => ({ direction: "out" as const, text, at: when });
    const hi = { direction: "in" as const, text: "hi", at: at(1, 8) };
    const q = out("Are nonprofits in too, or just small businesses?", at(1, 9)); // 12:00 in Kyiv
    const f1 = out("Hey, did you see my question? 🙏", at(1, 10));
    const f2 = out("Nonprofits: yes or no?", at(1, 14));
    const w = (...entries: { direction: "in" | "out"; text: string; at: Date }[]) => waitingOn(entries, "Europe/Kyiv");

    expect(w(hi, q)).toMatchObject({ text: q.text, followUps: 0, nextAt: at(1, 10) });
    expect(w(hi, q, f1)?.nextAt).toEqual(at(1, 14));
    expect(w(hi, q, f1, f2)?.nextAt).toEqual(at(2, 7)); // 10:00 their time, the next morning
    // Asked at 20:30 their time: the follow-up waits for their morning.
    expect(w(out("Where are you based?", at(1, 17, 30)))?.nextAt).toEqual(at(2, 6));
    // Anything they write answers it; a link or a quote of someone else's words asks nothing.
    expect(w(q, { direction: "in", text: "small ones", at: at(1, 9, 30) })).toBeNull();
    expect(w(out('Someone asked "anything cheaper than Typeform?" in r/nocode: https://reddit.test/x?ref=1', at(1, 9)))).toBeNull();
    // A question asked again as a statement still waits on them (live).
    expect(w(out("Done, the cards are gone. Still need the conference name or link.", at(1, 9)))?.nextAt).toEqual(at(1, 10));
    // A question card counts while its question is open.
    const card = out(`${QUESTION_MARK}Which plan should replies mention?`, at(1, 9));
    expect(waitingOn([card], null, () => true)?.text).toBe("Which plan should replies mention?");
    expect(waitingOn([card], null, () => false)).toBeNull();
    // A week of mornings, then it waits for them to write.
    const mornings = Array.from({ length: 7 }, (_, i) => out(`Morning ${i}`, at(2 + i, 7)));
    expect(w(q, ...mornings)?.nextAt).toBeNull();
  });

  it("follows up an unanswered question when it falls due, and stops when they answer", async () => {
    const message = (id: string, text: string) => new AIMessage({ content: "", tool_calls: [{ id, name: "message_user", args: { text } }] });
    const ask = "Got it. Are nonprofits in too, or just small businesses?";
    const first = "Hey, did you see my question? Nonprofits too, or just small businesses? 🙏";
    const second = "Nonprofits in the search too: yes or no?";
    const manager = fakeModel()
      .respond(new AIMessage(ask))
      .respond(new AIMessage("Nothing to start yet.")) // woken to follow up, and wrote nothing
      .respond(new AIMessage(first))
      .respond(message("a", second))
      .respond(new AIMessage("Followed up."))
      .respond(new AIMessage("Small businesses it is."));
    const world = makeWorld({ manager });
    await world.inbound.handle(say("I want people leaving Typeform", "1"));
    await world.manager.serveNext();
    const c = [...world.customers.customers.values()][0]!;
    const hour = 3_600_000;
    expect(world.events.followUpDue(c.id)).toEqual(new Date(world.clock.t + hour));

    world.clock.advance(hour / 2);
    expect(await world.manager.serveNext()).toBe(false);
    world.clock.advance(hour / 2);
    await world.manager.serveNext();
    expect(String(manager.calls[1]!.messages.at(-1)!.content)).toContain("A follow-up is due now");
    expect(String(manager.calls[2]!.messages.at(-1)!.content)).toMatch(/^They still owe you an answer, a follow-up is due/);
    expect(world.events.followUpDue(c.id)).toEqual(new Date(world.clock.t + 4 * hour));

    // Past the twice-a-day limit on writing first: a follow-up still goes out.
    world.clock.advance(4 * hour);
    await world.manager.serveNext();
    expect(world.events.followUpDue(c.id)).toEqual(new Date(Date.parse("2026-09-26T10:00:00Z")));

    world.clock.advance(hour);
    await world.inbound.handle(say("small ones only", "2"));
    await world.manager.serveNext();
    expect(world.events.followUpDue(c.id)).toBeNull();
    expect(world.channel.sent.map((m) => m.text)).toEqual([ask, first, second, "Small businesses it is."]);

    // A wake that comes after they answered costs no turn.
    await world.events.push(c.id, { kind: "follow_up" });
    await world.manager.serveNext();
    expect(manager.calls).toHaveLength(6);
  });

  it("keeps a question their new message left unanswered in front of it while it replies", async () => {
    // Live, 2026-10-01: "Also find people for my second product" came in, and the conference was never asked about again.
    const manager = fakeModel().respond(new AIMessage("What's the second product? And I still need the conference name."));
    const world = makeWorld({ manager });
    const c = await world.customers.create({ channel: telegramSender().channel, userRef: "42", displayName: "Dana", language: "en" });
    await world.transcript.recordIncoming(c.id, "telegram", "1", "I'll be at a conference next week, find people going there");
    await world.messenger.say(c.id, "Which conference is it?");
    world.clock.advance(15 * 60_000);
    await world.inbound.handle(say("Also find people for my second product", "2"));

    await world.manager.serveNext();

    expect(String(manager.calls[0]!.messages.at(-1)!.content)).toContain(
      'Before they wrote, you were waiting on their answer to "Which conference is it?" (asked 15 min ago). If what they wrote answers it, use the answer.',
    );
  });

  it("uses an emoji now and then, one at most, and never a launch post's", () => {
    expect(voiceNotes("Three people leaving Jotform today 🚀")).toEqual([
      "it uses 🚀, which reads like a launch post: use none, or one a person would text (🙏 👀 🙂 🎉)",
    ]);
    expect(voiceNotes("Three people leaving Jotform today 🎉🙏")).toEqual(["it has 2 emoji (🎉 🙏): one at most, or none"]);
    const ask = "Free plan in the replies: yes or no? 🙏";
    expect(voiceNotes(ask, { earlier: ["Did you see my question? 🙏", "Someone in r/nocode wants off Jotform 👀"] })).toEqual([
      "it has an emoji, like your last two messages: leave it out of this one",
    ]);
    expect(voiceNotes(ask, { earlier: ["Reading your site now.", "Did you see my question? 🙏"] })).toEqual([]);
    expect(stockPhrases("Friendly reminder: which plan should replies mention?")).toEqual(["friendly reminder"]);
    // Live, 2026-10-01: a re-ask that leaned on a cliché and on the machinery.
    const live = "Quick note: my page budget for today is spent, so I can't read or search anything else until tomorrow.";
    expect(stockPhrases(live)).toEqual(["quick note"]);
    expect(voiceNotes(live)[0]).toMatch(/^it says how you did the work \("page budget"\)/);
  });

  it("speaks first on a heartbeat, but not a third time without an answer", async () => {
    const nudge = (id: string) => new AIMessage({ content: "", tool_calls: [{ id, name: "message_user", args: { text: "Two people in r/nocode are still waiting on a reply." } }] });
    const manager = fakeModel().respond(nudge("a")).respond(new AIMessage("Nudged.")).respond(nudge("b")).respond(new AIMessage("Held it."));
    const world = makeWorld({ manager });
    const c = await world.customers.create({ channel: telegramSender().channel, userRef: "42", displayName: "Dana", language: "en" });
    await world.transcript.recordIncoming(c.id, "telegram", "1", "tally.so");
    world.clock.advance(60_000);
    await world.messenger.say(c.id, "Reading your site now.");

    await world.events.push(c.id, { kind: "heartbeat" });
    await world.manager.serveNext();
    expect(world.channel.sent.map((m) => m.text)).toEqual(["Reading your site now.", "Two people in r/nocode are still waiting on a reply."]);
    expect(String(manager.calls[0]!.messages.at(-1)!.content)).toContain("1 message from you since they last wrote.");

    await world.events.push(c.id, { kind: "heartbeat" });
    await world.manager.serveNext();
    expect(world.channel.sent).toHaveLength(2);
    expect(String(manager.calls[3]!.messages.at(-1)!.content)).toMatch(/^Not sent: they have not answered your last 2 messages/);
  });
});
