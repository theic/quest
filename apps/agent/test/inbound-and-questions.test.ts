import { taskId } from "@mq/core";
import { describe, expect, it } from "vitest";
import { HEARD } from "../src/conversation/inbound-service.ts";
import { pdfWith, spoken } from "./fakes.ts";
import { makeWorld, telegramSender } from "./world.ts";

// Each card its own message (`cards`), as before Your move (asks/deck.ts): cards already in a chat still work so.

async function withQuestions(n: number) {
  const world = makeWorld({}, { cards: true });
  const c = await world.customers.create({ channel: telegramSender().channel, userRef: "42", displayName: "Dana", language: "en" });
  const task = await world.tasks.start(c.id, "researcher", "Read", "Read it.");
  world.taskStore.recs.get(task.id)!.task = { ...task, status: "waiting" };
  const qs = await world.questions.raise(
    task,
    Array.from({ length: n }, (_, i) => ({ interruptId: `i${i}`, text: `Question ${i}?`, options: ["Yes", "No"], why: null })),
  );
  return { world, c, task, qs };
}

describe("inbound messages", () => {
  it("greets a newcomer with their language, then asks what they work on, and hands the answer to the manager as it is", async () => {
    const world = makeWorld({}, { cards: true });
    await world.inbound.handle({ type: "command", from: telegramSender(), command: "start", args: "ph", messageRef: "1" });

    expect(world.customers.customers.size).toBe(1);
    expect(world.events.events).toHaveLength(0); // nothing for the manager until they have said something
    const choice = world.channel.sent.at(-1)!;
    expect(choice.text).toBe("[language choice]");
    expect(world.channel.languageChoices).toEqual([{ ref: choice.ref, detected: "en" }]);

    // A tap on another language is theirs from then on, and the one question follows, in a message of its own.
    await world.inbound.handle({ type: "language", from: telegramSender(), locale: "pt", ackRef: "cb1", messageRef: choice.ref });
    const [c0] = [...world.customers.customers.values()];
    expect(c0?.language).toBe("manual:pt");
    expect(world.channel.languagesShown).toEqual([{ ref: choice.ref, locale: "pt" }]);
    expect(world.channel.acks).toEqual([{ ackRef: "cb1", text: "Português" }]);
    expect(world.channel.sent.at(-1)?.text).toContain("O que você está construindo?");
    expect(world.events.events).toHaveLength(0);

    // The same card tapped again changes the language and asks nothing twice.
    await world.inbound.handle({ type: "language", from: telegramSender(), locale: "auto", ackRef: "cb2", messageRef: choice.ref });
    expect(world.channel.sent.filter((m) => m.text.includes("O que você está construindo?")).length + world.channel.sent.filter((m) => m.text.includes("What are you building?")).length).toBe(1);

    // Founders and builders only (2026-10-29): nobody chooses a quest, and nothing reads one from their words.
    await world.inbound.handle({ type: "text", from: telegramSender(), text: "I'm building a form builder for waitlists", messageRef: "5", replyToRef: null });
    expect(world.events.events.map((e) => e.event.kind === "user_message" && e.event.text)).toEqual(["I'm building a form builder for waitlists"]);
  });

  it("starts with their language whatever link they came in by, and /start later goes to the manager", async () => {
    const world = makeWorld({}, { cards: true });
    await world.inbound.handle({ type: "command", from: telegramSender(), command: "start", args: "career", messageRef: "1" });
    expect(world.channel.sent.map((m) => m.text)).toEqual(["[language choice]"]);
    expect(world.events.events).toHaveLength(0);

    // Once Quest has said something, /start is them coming back.
    await world.inbound.handle({ type: "language", from: telegramSender(), locale: "auto", ackRef: "cb1", messageRef: world.channel.sent[0]!.ref });
    await world.inbound.handle({ type: "command", from: telegramSender(), command: "start", args: "", messageRef: "3" });
    expect(world.events.events.map((e) => e.event.kind === "user_message" && e.event.text)).toEqual(["(opened the chat with /start)"]);
  });

  it("reads a CV sent as a PDF, and says so when a file cannot be read", async () => {
    const world = makeWorld({}, { cards: true });
    world.channel.files.set("f1", pdfWith("Jane Doe, Senior Product Designer"));
    world.channel.files.set("f2", new Uint8Array([80, 75, 3, 4]));
    const file = (fileRef: string, fileName: string, mimeType: string, messageRef: string) =>
      world.inbound.handle({ type: "file", from: telegramSender(), fileRef, fileName, mimeType, size: 2_000, caption: "", messageRef });

    await file("f1", "cv.pdf", "application/pdf", "1");
    await file("f2", "cv.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "2");

    expect(world.events.events.map((e) => e.event.kind === "user_message" && e.event.text)).toEqual([
      "(They sent cv.pdf. Its text:)\nJane Doe, Senior Product Designer",
      "(They sent cv.docx, a kind of file Quest cannot read. Ask for a PDF, or the text pasted in.)",
    ]);
  });

  it("hears a voice message and takes it as what they typed", async () => {
    const world = makeWorld({}, { cards: true });
    world.channel.files.set("v1", spoken("Find me designers in Berlin"));
    const voice = { type: "voice" as const, from: telegramSender(), fileRef: "v1", mimeType: "audio/ogg", fileName: null, seconds: 3, size: 9_000, caption: "", messageRef: "1", replyToRef: null };

    await world.inbound.handle(voice);

    const [c] = [...world.customers.customers.values()];
    // Nobody is asked to choose a quest: what they said is read.
    expect(world.channel.sent.map((s) => s.text)).toEqual([]);
    // The manager is told it was heard, not typed: "Mark Lou. ..." was Marc Lou, not a message cut off (2026-10-14).
    expect(world.events.events.map((e) => e.event)).toEqual([{ kind: "user_message", text: `Find me designers in Berlin\n${HEARD}`, ref: "1" }]);
    expect(world.transcript.entries.filter((e) => e.direction === "in").map((e) => e.text)).toEqual(["Find me designers in Berlin"]);
    expect(world.transcriber.heard).toEqual([{ format: "ogg", customerId: c!.id }]);

    // Delivered twice, it goes to the manager once.
    await world.inbound.handle(voice);
    expect(world.events.events).toHaveLength(1);
  });

  it("takes a voice reply to a question as the answer", async () => {
    const { world, c, qs } = await withQuestions(1);
    await world.questions.ask(c.id, [qs[0]!.id]);
    const card = world.channel.sent.at(-1)!;
    world.channel.files.set("v2", spoken("Mostly agencies"));

    await world.inbound.handle({ type: "voice", from: telegramSender(), fileRef: "v2", mimeType: "audio/ogg", fileName: null, seconds: 2, size: 6_000, caption: "", messageRef: "9", replyToRef: card.ref });

    expect((await world.questionStore.get(qs[0]!.id))?.answer).toBe("Mostly agencies");
  });

  it("tells the manager why a recording could not be heard, so it asks for the words typed", async () => {
    const world = makeWorld({}, { cards: true });
    world.channel.files.set("silent", spoken(""));
    world.channel.files.set("broken", spoken("!"));
    world.channel.files.set("song", spoken("la la"));
    const voice = (fileRef: string, messageRef: string, more: { mimeType?: string | null; fileName?: string | null; seconds?: number; caption?: string } = {}) =>
      world.inbound.handle({ type: "voice", from: telegramSender(), fileRef, mimeType: "audio/ogg", fileName: null, seconds: 5, size: 20_000, caption: "", messageRef, replyToRef: null, ...more });

    await voice("silent", "1");
    await voice("broken", "2", { caption: "listen" });
    await voice("song", "3", { mimeType: "audio/x-ms-wma", fileName: "demo.wma" });
    await voice("song", "4", { seconds: 45 * 60 });
    await voice("gone", "5");

    expect(world.events.events.map((e) => e.event.kind === "user_message" && e.event.text)).toEqual([
      "(They sent a voice message, but nobody speaks in it. Ask what they meant to say.)",
      "listen\n\n(They sent a voice message, but it could not be heard. Ask them to send it again, or type it.)",
      "(They sent demo.wma, a kind of recording Quest cannot listen to. Ask for a voice message, or the words typed.)",
      "(They sent a voice message of 45 minutes, too long to listen to here. Ask for the main points typed, or in a shorter one.)",
      "(They sent a voice message, but it could not be heard. Ask them to send it again, or type it.)",
    ]);
    expect(world.transcript.entries.filter((e) => e.direction === "in").map((e) => e.text)).toEqual(["🎤", "🎤 listen", "🎤 demo.wma", "🎤", "🎤"]);
    expect(world.transcriber.heard).toHaveLength(1); // only the silent one reached the model and was heard
  });

  it("ignores a message the channel delivers twice", async () => {
    const world = makeWorld({}, { cards: true });
    const msg = { type: "text" as const, from: telegramSender(), text: "hi", messageRef: "7", replyToRef: null };
    await world.inbound.handle(msg);
    await world.inbound.handle(msg);
    expect(world.events.events).toHaveLength(1);
  });

  it("routes a reply to a question message to that question, not the manager", async () => {
    const { world, c, qs, task } = await withQuestions(1);
    await world.questions.ask(c.id, [qs[0]!.id]);
    const card = world.channel.sent.at(-1)!;

    await world.inbound.handle({ type: "text", from: telegramSender(), text: "Mostly agencies", messageRef: "9", replyToRef: card.ref });

    expect((await world.questionStore.get(qs[0]!.id))?.answer).toBe("Mostly agencies");
    expect((await world.taskStore.get(task.id))?.status).toBe("queued");
    expect(world.events.kinds(c.id)).toEqual(["question_raised", "question_answered"]);
  });

  it("takes a button press as the option's words and acknowledges it", async () => {
    const { world, c, qs } = await withQuestions(1);
    await world.questions.ask(c.id, [qs[0]!.id]);

    await world.inbound.handle({ type: "choice", from: telegramSender(), questionId: qs[0]!.id, option: 1, ackRef: "cb1", messageRef: null });

    expect((await world.questionStore.get(qs[0]!.id))?.answer).toBe("No");
    expect(world.channel.acks).toEqual([{ ackRef: "cb1", text: "Got it" }]);
    expect(world.channel.answersShown.at(-1)?.answer).toBe("No");
  });

  it("refuses a button press from someone else's chat", async () => {
    const { world, qs } = await withQuestions(1);
    await world.inbound.handle({ type: "choice", from: telegramSender("99"), questionId: qs[0]!.id, option: 0, ackRef: "cb2", messageRef: null });

    expect((await world.questionStore.get(qs[0]!.id))?.status).toBe("pending");
    expect(world.channel.acks.at(-1)?.text).toBe("That one is already settled");
  });
});

describe("the question queue", () => {
  it("keeps no more than the cap in front of the person at once", async () => {
    const { world, c, qs } = await withQuestions(3);
    const out = await world.questions.ask(c.id, qs.map((q) => q.id));
    expect(out.sent).toHaveLength(2); // askCap is 2 in the test world
    expect(out.held).toEqual([qs[2]!.id]);
    expect(world.channel.sent.filter((m) => m.question)).toHaveLength(2);
  });

  it("resumes a task only when every question it asked is settled", async () => {
    const { world, qs, task } = await withQuestions(2);
    await world.questions.answer(qs[0]!.id, "Yes", "manager");
    expect((await world.taskStore.get(task.id))?.status).toBe("waiting");

    await world.questions.answer(qs[1]!.id, "No", "user");
    const resumed = await world.taskStore.get(task.id);
    expect(resumed?.status).toBe("queued");
    expect(resumed?.nextInput).toEqual({ kind: "resume", answers: { i0: "The person answered: Yes", i1: "The person answered: No" } });
  });

  it("does not tell the manager twice about a question a replayed run raised again", async () => {
    const { world, c, task } = await withQuestions(1);
    const again = await world.taskStore.get(taskId(task.id));
    await world.questions.raise(again!, [{ interruptId: "i0", text: "Question 0?", options: [], why: null }]);
    expect(world.events.kinds(c.id)).toEqual(["question_raised"]);
  });
});
