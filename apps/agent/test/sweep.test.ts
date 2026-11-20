import { fakeModel } from "@langchain/core/testing";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { forLanguage } from "@mq/i18n";
import { SearchError, type CustomerId, type Find, type FoundPost, type PostQuery } from "@mq/core";
import type { WritingJob, WriterPort } from "../src/drafts/writer.ts";
import { type IntakeGuesser } from "../src/conversation/intake.ts";
import { sweepLine, sweptNote } from "../src/finds/sweep.ts";
import { parseGuesses } from "../src/conversation/intake-guess.ts";
import { managerTools } from "../src/manager/tools.ts";
import { silentLogger } from "../src/infra/system.ts";
import { makeWorld, telegramSender } from "./world.ts";

const NOW = new Date("2026-10-23T12:00:00Z");
const SITES = "Reddit, X, LinkedIn, YouTube, Hacker News, Bluesky";
const BRIEF = "Acme makes intake forms for small teams. They switch from Typeform when it gets too expensive.";

const post = (p: Partial<FoundPost> & Pick<FoundPost, "source" | "url">): FoundPost => ({ author: null, title: null, text: "", postedAt: NOW, replies: 0, ...p });
/** A Reddit result is its title only: the sweep reads its thread before quoting anyone. */
const REDDIT = post({ source: "reddit:r/SaaS", url: "https://www.reddit.com/r/SaaS/comments/abc/form_tool", author: "u/maya", title: "Which form tool for a waitlist?", text: "Which form tool for a waitlist?", preview: true, postedAt: new Date("2026-10-21T09:00:00Z") });
const TWEET = post({ source: "x", url: "https://x.com/leo/status/1", author: "@leo", text: "typeform got way too expensive for our waitlist, what do you all use instead?", postedAt: new Date("2026-10-22T09:00:00Z") });
const NEWS = post({ source: "hackernews", url: "https://news.ycombinator.com/item?id=9", author: "pg", text: "Show HN: my own form builder" });

/** The volume seat's answers in order: the search words, then the judge on each call, by what the call asks. */
function volumeSeat() {
  const prompts: string[] = [];
  const answer = (messages: BaseMessage[]) => {
    const system = String(messages[0]!.content);
    const asked = String(messages.at(-1)!.content);
    prompts.push(asked);
    if (system.startsWith("You plan searches")) return new AIMessage(JSON.stringify({ queries: ["typeform alternative", "form tool for waitlist"], communities: ["SaaS"] }));
    // The thread read in full: judged again on its words.
    if (asked.includes("I tried three, none do conditional logic")) {
      return new AIMessage(JSON.stringify({ picks: [{ n: 1, fit: "strong", quote: "I tried three, none do conditional logic", why: "Asks for a form tool.", reply: "Conditional logic is the hard part; most cheap ones skip it." }] }));
    }
    const at = (needle: string) => asked.split("\n").findIndex((l) => l.includes(needle));
    const lines = asked.split("\n");
    const n = (needle: string) => Number(/^#(\d+)/.exec(lines.slice(0, at(needle) + 1).reverse().find((l) => /^#\d+/.test(l)) ?? "")?.[1]);
    return new AIMessage(
      JSON.stringify({
        picks: [
          { n: n("Which form tool for a waitlist?"), fit: "strong", quote: "Which form tool for a waitlist?", why: "Asks for one.", reply: "Depends on the waitlist size." },
          { n: n("typeform got way too expensive"), fit: "strong", quote: "typeform got way too expensive for our waitlist", why: "Leaving Typeform.", reply: "We moved off it for the same reason." },
        ],
      }),
    );
  };
  let model = fakeModel();
  for (let i = 0; i < 20; i++) model = model.respond(answer);
  return { model, prompts };
}

/** The writer seat: every message written as them, and the looks back at a take. */
function writerSeat() {
  let model = fakeModel();
  for (let i = 0; i < 20; i++) {
    model = model.respond((messages) =>
      String(messages[0]!.content).includes("look back at what you wrote")
        ? new AIMessage(JSON.stringify({ noted: "Shorter from now on.", rules: ["Two short sentences at most"] }))
        : new AIMessage(String(messages.at(-1)!.content).includes("@leo") ? "we left typeform over the price too, the cheap ones drop logic" : "conditional logic is where the cheap ones fall down"),
    );
  }
  return model;
}

/** A founder with a brief and their Chrome, not swept yet, in a world whose takes answer real posts. */
async function newcomer(opts: { guesser?: IntakeGuesser } = {}) {
  const volume = volumeSeat();
  const writer = writerSeat();
  const world = makeWorld({ volume: volume.model, writer }, { ...(opts.guesser ? { intake: { guesser: opts.guesser } } : {}) });
  world.clock.t = NOW.getTime();
  world.posts.results["reddit"] = [REDDIT];
  world.posts.results["x"] = [TWEET];
  world.posts.results["hackernews"] = [NEWS];
  world.reader.pages[REDDIT.url] = {
    url: REDDIT.url,
    title: REDDIT.title!,
    description: null,
    text: "Which form tool for a waitlist?\nI tried three, none do conditional logic. Budget is small.",
    post: { source: "reddit:r/SaaS", author: "u/maya", title: REDDIT.title, postedAt: REDDIT.postedAt, ref: "t3_abc" },
  };
  const c = await world.customers.create(telegramSender());
  await world.customers.update(c.id, { brief: BRIEF, status: "active" });
  return { world, id: c.id, volume };
}

async function swept(world: ReturnType<typeof makeWorld>, id: CustomerId): Promise<void> {
  expect(await world.sweep.maybeStart(id)).toBe(true);
  await world.errands.stop();
}

describe("the first sweep", () => {
  it("reads every site at once, reads the titles in full, saves the best", async () => {
    const { world, id } = await newcomer();
    // Each search takes a moment, as a page in their Chrome does, so the line is redrawn while it reads.
    const search = world.posts.search.bind(world.posts);
    let calls = 0;
    world.posts.search = async (q) => {
      await new Promise((r) => setTimeout(r, 3 * ++calls));
      return search(q);
    };
    await swept(world, id);

    // Every site's search, in their Chrome and the public APIs, and the communities the words named.
    const asked = (q: PostQuery) => `${q.source}${q.site ? `:${q.site}` : ""}`;
    expect(new Set(world.posts.queries.map(asked))).toEqual(new Set(["reddit", "x", "linkedin", "youtube", "hackernews", "bluesky", "reddit:SaaS"]));
    expect(world.posts.queries.every((q) => q.within === "month")).toBe(true);
    // The Reddit pick was a title: its thread was read, and it is quoted from what the person wrote there.
    expect(world.reader.reads).toEqual([REDDIT.url]);
    const finds = [...world.findStore.finds.values()];
    expect(finds.map((f) => [f.url, f.quote, f.replyTo, f.taskId])).toEqual(
      expect.arrayContaining([
        [TWEET.url, "typeform got way too expensive for our waitlist", null, null],
        [REDDIT.url, "I tried three, none do conditional logic", "t3_abc", null],
      ]),
    );
    expect(finds).toHaveLength(2);

    // One line, redrawn in place, and what it came to; 
    const line = world.channel.sent.find((m) => m.text === sweepLine.found(SITES, 1, 11, 3, 2));
    expect(line).toBeDefined();
    expect(world.channel.edits.every((e) => e.ref === line!.ref)).toBe(true);
    expect(world.channel.edits[0]!.text).toMatch(/^Reading Reddit, X, LinkedIn, YouTube, Hacker News, Bluesky… pages: \d+, posts: \d+, worth answering: \d+$/);

    // Past it: once, with what it saw kept for the manager and the cards after.
    const c = await world.customers.get(id);
    expect(c.sweptAt).not.toBeNull();
    expect(await world.sweep.maybeStart(id)).toBe(false);
    expect(world.events.events.at(-1)?.event).toMatchObject({ kind: "system", topic: "first_sweep" });
    expect((await world.memory.list(id, 10)).map((m) => m.text)).toEqual(["Their Chrome is signed in to X, LinkedIn (the first sweep, 2026-10-23)."]);
    // The transcript has the line as it ended, once.
    expect((await world.transcript.recent(id, 10)).map((e) => e.text)).toEqual([sweepLine.found(SITES, 1, 11, 3, 2)]);
  });

  it("waits for their Chrome when it went away, and starts over once it is back", async () => {
    const { world, id } = await newcomer();
    const search = world.posts.search.bind(world.posts);
    world.posts.search = async (q) => {
      if (["reddit", "x", "linkedin", "youtube"].includes(q.source)) throw new SearchError("offline", "the customer's Chrome is not connected");
      return search(q);
    };
    await swept(world, id);
    expect(world.channel.sent.at(-1)?.text).toBe(sweepLine.paused);
    expect((await world.customers.get(id)).sweptAt).toBeNull();
    expect(world.findStore.finds.size).toBe(0);

    world.posts.search = search;
    await swept(world, id);
    expect((await world.customers.get(id)).sweptAt).not.toBeNull();
    expect(world.findStore.finds.size).toBe(2);
  });

  it("starts only with a brief and their Chrome", async () => {
    const { world, id } = await newcomer();
    world.chromeOffline.add(id);
    expect(await world.sweep.maybeStart(id)).toBe(false);
    world.chromeOffline.delete(id);
    await world.customers.update(id, { brief: null });
    expect(await world.sweep.maybeStart(id)).toBe(false);
    expect((await world.customers.get(id)).sweptAt).toBeNull();
  });

  it("is started by the brief, and the teammates who read for people wait for it", async () => {
    const { world, id } = await newcomer();
    world.chromeOffline.add(id);
    const tools = Object.fromEntries(managerTools({ ...world, customerId: id, userTurn: true, now: world.clock.now }).map((t) => [t.name, t]));
    expect(await tools["save_brief"]!.invoke({ brief: BRIEF })).toContain("Their first sweep starts by itself once their Chrome is connected");
    expect(await tools["start_task"]!.invoke({ agent: "scout", title: "People leaving Typeform", instructions: "Find people leaving Typeform." })).toMatch(/^Not started: their first sweep comes first/);
    expect(await tools["start_task"]!.invoke({ agent: "outreach", title: "Their profiles", instructions: "Look at their X profile." })).toMatch(/^Not started: their first sweep comes first/);
    expect(await tools["start_task"]!.invoke({ agent: "researcher", title: "Read acme.test", instructions: "Read https://acme.test and report." })).toMatch(/^Started task/);

    world.chromeOffline.delete(id);
    expect(await tools["save_brief"]!.invoke({ brief: BRIEF })).toContain("Their first sweep is reading the sites where their people ask now");
    expect(world.sweep.running(id)).toBe(true);
    expect(await tools["start_task"]!.invoke({ agent: "explorer", title: "Places", instructions: "Find where they ask." })).toMatch(/^Not started: their first sweep is reading/);
    await world.errands.stop();
    expect(await tools["start_task"]!.invoke({ agent: "explorer", title: "Places", instructions: "Find where they ask." })).toMatch(/^Started task/);
  });

  it("tells the manager what it read, who it is signed in as, and to start the team", () => {
    const note = sweptNote({ pages: 40, posts: 212, saved: 12, strong: 5, ms: 9 * 60_000, sites: ["Reddit", "X"], signedIn: ["Reddit", "X"], signedOut: ["LinkedIn"], cost: 0.002 });
    expect(note).toContain("read 40 pages on Reddit, X in 9 min, 212 posts, and saved 12 finds (5 strong)");
    expect(note).toContain("Their Chrome is signed in to Reddit, X, not to LinkedIn.");
    expect(note).toContain("show none of them, and write nothing about the sweep");
    expect(note).toContain("Start your team now");
  });
});

describe("where they show up, after the sweep", () => {
  it("is read from what they said, once, instead of asked", async () => {
    const guesses: string[] = [];
    const guesser: IntakeGuesser = {
      async guess(_c, questions) {
        guesses.push(questions.map((q) => q.key).join(","));
        return { where: ["reddit", "x"] };
      },
    };
    const { world, id } = await newcomer({ guesser });
    await swept(world, id);
    expect((await world.customers.get(id)).profile["where"]).toMatchObject({ choice: "reddit,x", answer: "Reddit, X" });
    // One guess, about nothing but that.
    expect(guesses).toEqual(["where"]);
  });

  it("guesses only with the options there are", () => {
    const qs = [{ key: "where", text: "Where do they want to show up?", about: "where they show up", options: [{ id: "x", label: "X" }, { id: "reddit", label: "Reddit" }] }];
    expect(parseGuesses('{"where":["x","myspace"],"push":["ludicrous"],"stage":"paying"}', qs)).toEqual({ where: ["x"] });
    expect(parseGuesses("not json", qs)).toEqual({});
  });
});
