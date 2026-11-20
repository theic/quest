import { AIMessage } from "@langchain/core/messages";
import { slipped } from "../src/drafts/slips.ts";
import { fakeModel } from "@langchain/core/testing";
import type { CustomerId } from "@mq/core";
import { describe, expect, it } from "vitest";
import type { ModelProvider } from "../src/agents/models.ts";
import { lengthLimit, writingTells } from "../src/drafts/tells.ts";
import { parseWritten, Writer, writingPrompt, type Voice, type WritingJob } from "../src/drafts/writer.ts";
import { silentLogger } from "../src/infra/system.ts";

const VOICE: Voice = { name: "Serhii", language: "en", brief: "Messaging Quest finds people asking for what you sell.", rules: ["Name Messaging Quest, no link."], asked: ['short like "keep it up"'] };
const JOB: WritingJob = { kind: "reply", platform: "x.com", place: "@noa", author: "@noa", quote: "Day 47, still 0 customers.", draft: "Keep going! It's a game-changer — try Messaging Quest!", title: null };
const who = "c1" as CustomerId;

function writerWith(model: ReturnType<typeof fakeModel>) {
  const models: ModelProvider = { modelFor: () => model };
  return new Writer({ models, voice: async () => VOICE, log: silentLogger });
}

describe("the tells check", () => {
  it("names what gives a model away, and passes a plain reply", () => {
    const tells = writingTells("Great question! It's not luck — it's reps. Happy to help!", { kind: "reply", platform: "x.com" });
    expect(tells.join(" | ")).toMatch(/dash/);
    expect(tells.join(" | ")).toMatch(/opens with "Great question"/);
    expect(tells.join(" | ")).toMatch(/Happy to help/);
    expect(writingTells("Speaking practice is the core of it, not tapping through lessons.", { kind: "reply", platform: "reddit" })[0]).toMatch(/"X, not Y"/);
    expect(writingTells("Keep it up. I made Messaging Quest, it finds them and writes to them.", { kind: "reply", platform: "x.com" })).toEqual([]);
    // The takes, live 2026-10-18: "fair question." opened most answers to a skeptic.
    expect(writingTells("fair question. it runs in your own chrome, signed in as you.", { kind: "reply", platform: "x.com" })).toEqual(['it opens with "fair question": start with the point']);
  });

  it("keeps X short, and leaves English word lists out of another language", () => {
    expect(writingTells("a ".repeat(130), { kind: "reply", platform: "x.com" }).join()).toMatch(/under 220/);
    expect(writingTells("Isto é seamless e robust.", { kind: "reply", platform: "reddit", language: "pt" })).toEqual([]);
    expect(writingTells("Depende — leve os documentos.", { kind: "reply", platform: "reddit", language: "pt" }).join()).toMatch(/dash/);
  });

  it("holds a field to its own limit over the site's", () => {
    // Live, 2026-10-15: X takes 280 characters in a post, 160 in a bio; a 174-character bio passed as a post.
    const bio = "Messaging Quest\nAI that finds your first customers and writes to them from your own accounts\nFree, follows up, reports every evening\n0 MRR, building in public\nmessaging.quest";
    expect(lengthLimit({ kind: "post", platform: "x.com", chars: 160 })).toEqual({ chars: 160 });
    expect(lengthLimit({ kind: "post", platform: "linkedin.com", chars: 220 })).toEqual({ words: 170, chars: 220 });
    expect(writingTells(bio, { kind: "post", platform: "x.com" }).join()).not.toMatch(/characters/);
    expect(writingTells(bio, { kind: "post", platform: "x.com", chars: 160 }).join()).toMatch(/runs 174 characters: keep it under 160/);
    expect(writingPrompt({ kind: "post", platform: "x.com", place: "their X bio", author: null, quote: null, draft: bio, title: null, chars: 160 })).toContain(
      "Length: at most 160 characters in all, spaces and line breaks included: the field it goes in takes no more.",
    );
  });
});

describe("the writer", () => {
  it("reads what the model wrote as words to post, the title apart", () => {
    expect(parseWritten('"Keep it up."', JOB).text).toBe("Keep it up.");
    const post = { ...JOB, kind: "post" as const, title: "Old" };
    expect(parseWritten("Title: A plain title\nThe body.", post)).toEqual({ title: "A plain title", text: "The body." });
    // A whole paragraph on the first line is the body with no title.
    expect(parseWritten(`${"word ".repeat(40)}\nmore`, post).title).toBe("Old");
  });

  it("puts their voice in front of the model, and writes once when it reads like a person", async () => {
    const model = fakeModel().respond(new AIMessage("Keep it up. I made Messaging Quest, it finds people asking for what you sell."));
    const w = await writerWith(model).write(who, JOB);
    expect(w).toMatchObject({ rewritten: true, tells: [], text: "Keep it up. I made Messaging Quest, it finds people asking for what you sell." });
    expect(model.calls).toHaveLength(1);
    const system = JSON.stringify(model.calls[0]!.messages[0]);
    expect(system).toContain("Name Messaging Quest, no link.");
    expect(system).toContain("keep it up");
  });

  it("sends a draft that gives itself away back once, and the same draft again gets the same words", async () => {
    const model = fakeModel()
      .respond(new AIMessage("Great question! Try Messaging Quest, a game-changer."))
      .respond(new AIMessage("Keep it up. I made Messaging Quest, it finds them."));
    const writer = writerWith(model);
    const w = await writer.write(who, JOB);
    expect(w.text).toBe("Keep it up. I made Messaging Quest, it finds them.");
    expect(model.calls).toHaveLength(2);
    expect(JSON.stringify(model.calls[1]!.messages[1])).toMatch(/gives itself away/);
    expect((await writer.write(who, JOB)).text).toBe(w.text);
    expect(model.calls).toHaveLength(2);
  });

  it("lets the draft go on as it was, dashes made plain, when the model fails", async () => {
    const w = await writerWith(fakeModel().alwaysThrow(new Error("Request timed out."))).write(who, JOB);
    expect(w).toMatchObject({ rewritten: false, text: "Keep going! It's a game-changer, try Messaging Quest!" });
  });

  it("never says it is an AI, and never opens or hands over a link the way an earlier message did", async () => {
    // Live, 2026-11-01: five of seven Reddit replies opened this way, all with the same two threads, and five were taken down.
    const sent = "not a human here, i'm the ai agent a founder runs. found two people asking for what you're building: https://www.reddit.com/r/SavingMoney/comments/1xkky1y/ do your users scan receipts?";
    const again = "not a real human here, i'm the ai agent for a founder. found two people asking for exactly this: https://www.reddit.com/r/SavingMoney/comments/1xkky1y/ are people picking lifetime?";
    const tells = writingTells(again, { kind: "reply", platform: "reddit", lately: [{ platform: "reddit", text: sent }] }).join(" | ");
    expect(tells).toMatch(/comes from an AI or a bot \("not a real human"\)/);
    expect(tells).toMatch(/hands over https:\/\/www\.reddit\.com\/r\/SavingMoney\/comments\/1xkky1y\/, which already went to someone else/);
    expect(writingTells("found two people asking for this: https://a.test/2 does it scan?", { kind: "reply", platform: "reddit", lately: [{ platform: "x.com", text: "found two people asking for what you build: https://a.test/1" }] }).join()).toMatch(/opens like a message they already sent/);
    expect(writingTells("is this an ai tool, or do you check each one by hand?", { kind: "reply", platform: "reddit" })).toEqual([]);

    // Whatever the model does twice, what goes out drops the label, and a first line used before when more follows.
    const stubborn = "not a real human here, i'm the ai agent for a founder. found two people asking for exactly this. are people picking lifetime?";
    const writer = new Writer({ models: { modelFor: () => fakeModel().respond(new AIMessage(stubborn)).respond(new AIMessage(stubborn)) }, voice: async () => VOICE, lately: async () => [{ platform: "x.com", text: "found two people asking for exactly this, have a look" }], log: silentLogger });
    const w = await writer.write(who, { ...JOB, platform: "reddit", draft: "hand them the thread" });
    expect(w.text).toBe("Are people picking lifetime?");
    expect(writingPrompt({ ...JOB, platform: "reddit" }, [], undefined, [{ platform: "reddit", text: sent }])).toMatch(/How their last messages opened[^]*not a human here, i'm the ai agent a founder runs\./);
  });
});

describe("slips", () => {
  const always = () => 0;
  it("makes one everyday slip, only now and then, and never in a name, a link or twice in a row", () => {
    expect(slipped("I don't think people mind", always, [])).toBe("I dont think people mind");
    expect(slipped("People mind", always, [])).toBe("Poeple mind");
    expect(slipped("I don't think so", () => 0.5, [])).toBe("I don't think so");
    expect(slipped("See https://a.co/people and @really", always, [])).toBe("See https://a.co/people and @really");
    expect(slipped("I don't mind", always, [{ text: "dont worry" }])).toBe("I don't mind");
  });
});
