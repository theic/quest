import { AIMessage, ToolMessage } from "@langchain/core/messages";
import { fakeModel } from "@langchain/core/testing";
import { describe, expect, it } from "vitest";
import { makeWorld, telegramSender } from "./world.ts";

async function customerIn(world: ReturnType<typeof makeWorld>) {
  return world.customers.create({ channel: telegramSender().channel, userRef: "42", displayName: "Dana", language: "en" });
}

describe("TaskRunner", () => {
  it("runs a task to its report and tells the manager", async () => {
    const researcher = fakeModel()
      .respondWithTools([{ name: "read_site", args: { url: "https://acme.test" } }])
      .respond(new AIMessage("What it is: invoicing for freelancers."));
    const world = makeWorld({ researcher });
    const c = await customerIn(world);
    const task = await world.tasks.start(c.id, "researcher", "Read the site", "Read https://acme.test and report.");

    expect(await world.runner.runNext()).toBe(true);

    const done = await world.taskStore.get(task.id);
    expect(done?.status).toBe("succeeded");
    expect(done?.result).toContain("invoicing for freelancers");
    expect(world.reader.reads).toEqual(["https://acme.test"]);
    expect(world.events.kinds(c.id)).toEqual(["task_finished"]);
  });

  it("parks on a question, frees the worker, and resumes with the answer", async () => {
    const researcher = fakeModel()
      .respondWithTools([{ name: "ask_human", args: { question: "Who is it for?", options: ["Freelancers", "Agencies"] } }])
      .respond(new AIMessage("Report: for freelancers."));
    const world = makeWorld({ researcher });
    const c = await customerIn(world);
    const task = await world.tasks.start(c.id, "researcher", "Read the site", "Read https://acme.test.");

    await world.runner.runNext();
    expect((await world.taskStore.get(task.id))?.status).toBe("waiting");
    const [question] = await world.questions.open(c.id);
    expect(question?.text).toBe("Who is it for?");
    expect(question?.options).toEqual(["Freelancers", "Agencies"]);
    expect(world.events.kinds(c.id)).toEqual(["question_raised"]);
    expect(await world.runner.runNext()).toBe(false); // nothing to run while it waits

    await world.questions.answer(question!.id, "Freelancers", "user");
    expect((await world.taskStore.get(task.id))?.status).toBe("queued");

    await world.runner.runNext();
    const done = await world.taskStore.get(task.id);
    expect(done?.status).toBe("succeeded");
    expect(done?.result).toBe("Report: for freelancers.");
    // The run picked up inside the same ask_human call, with the answer as its result.
    const lastCall = researcher.calls.at(-1)!.messages;
    const toolResult = lastCall.find((m) => m instanceof ToolMessage) as ToolMessage;
    expect(String(toolResult.content)).toBe("The person answered: Freelancers");
    expect(world.events.kinds(c.id)).toEqual(["question_raised", "question_answered", "task_finished"]);
  });

  it("resumes a dismissed question with the manager's note instead of an answer", async () => {
    const researcher = fakeModel()
      .respondWithTools([{ name: "ask_human", args: { question: "Pricing page?" } }])
      .respond(new AIMessage("Done without pricing."));
    const world = makeWorld({ researcher });
    const c = await customerIn(world);
    await world.tasks.start(c.id, "researcher", "Read", "Read it.");
    await world.runner.runNext();
    const [q] = await world.questions.open(c.id);

    await world.questions.dismiss(q!.id, "Skip pricing; it is not public.");
    await world.runner.runNext();

    const toolResult = researcher.calls.at(-1)!.messages.find((m) => m instanceof ToolMessage) as ToolMessage;
    expect(String(toolResult.content)).toBe("Nobody answered this. Skip pricing; it is not public.");
  });

  it("gives a waiting task new instructions as the answer to its question", async () => {
    const researcher = fakeModel()
      .respondWithTools([{ name: "ask_human", args: { question: "Which product?" } }])
      .respond(new AIMessage("Report on the API."));
    const world = makeWorld({ researcher });
    const c = await customerIn(world);
    const task = await world.tasks.start(c.id, "researcher", "Read", "Read it.");
    await world.runner.runNext();

    const out = await world.tasks.steer(c.id, task.id, "Focus on the API product only.");
    expect(out.kind).toBe("answered");
    await world.runner.runNext();
    expect((await world.taskStore.get(task.id))?.status).toBe("succeeded");
  });

  it("cancels a waiting task and closes its questions", async () => {
    const researcher = fakeModel().respondWithTools([{ name: "ask_human", args: { question: "Anything?" } }]);
    const world = makeWorld({ researcher });
    const c = await customerIn(world);
    const task = await world.tasks.start(c.id, "researcher", "Read", "Read it.");
    await world.runner.runNext();

    const cancelled = await world.tasks.cancel(c.id, task.id);
    expect(cancelled?.status).toBe("cancelled");
    expect(await world.questions.open(c.id)).toEqual([]);
  });

  it("retries a failing run, then reports the failure to the manager", async () => {
    const researcher = fakeModel().alwaysThrow(new Error("provider down"));
    const world = makeWorld({ researcher });
    const c = await customerIn(world);
    const task = await world.tasks.start(c.id, "researcher", "Read", "Read it.");

    await world.runner.runNext();
    expect((await world.taskStore.get(task.id))?.status).toBe("queued"); // first failure: retried later
    world.taskStore.recs.get(task.id)!.availableAt = 0;
    await world.runner.runNext();
    const failed = await world.taskStore.get(task.id);
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toContain("provider down");
    expect(world.events.kinds(c.id)).toEqual(["task_finished"]);
  });
});
