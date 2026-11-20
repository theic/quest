import { ReadError, type Draft, type ResultEntry, type Task, type WebReach } from "@mq/core";
import { describe, expect, it } from "vitest";
import { HIDDEN_RETRY_MS, ReplyWatch } from "../src/finds/reply-watch.ts";
import { silentLogger } from "../src/infra/system.ts";
import { PLATFORMS } from "../src/platforms.ts";
import { howItWent, nextPlatform, wentLine } from "../src/tasks/rotation.ts";
import { FakeReach } from "./fakes.ts";
import { makeWorld, telegramSender } from "./world.ts";

const now = new Date("2026-11-04T08:00:00Z");
const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000);
const platform = (key: string) => PLATFORMS.find((p) => p.key === key)!;
const task = (site: string, minutes: number, status = "succeeded", result: string | null = null) =>
  ({ site, status, createdAt: ago(minutes), finishedAt: status === "running" ? null : ago(minutes - 10), result }) as unknown as Task;
const like = (url: string) => ({ kind: "like", platform: "x.com", url, status: "posted", sentAt: ago(30) }) as unknown as Draft;

describe("always exploring", () => {
  it("works their platforms in turn: never worked first, then the oldest, passing over what it should", () => {
    const picked = ["threads", "x", "instagram", "linkedin"].map(platform);
    const tasks = [task("threads.net", 120), task("x.com", 300), task("instagram.com", 5, "running")];
    const x = { tasks, drafts: [] as Draft[], avoided: new Set<string>(), now };
    expect(nextPlatform(picked, x)?.key).toBe("linkedin");
    expect(nextPlatform(picked, { ...x, avoided: new Set(["linkedin.com"]) })?.key).toBe("x");
    // X's 100 likes and follows of the day are spent: Threads, worked two hours ago, is next.
    const spent = Array.from({ length: 100 }, (_, i) => like(`https://x.com/a/status/${i}`));
    expect(nextPlatform(picked, { ...x, avoided: new Set(["linkedin.com"]), drafts: spent })?.key).toBe("threads");
    // A run that met a sign-in wall rests the site; one started there lately does too.
    const walled = [task("threads.net", 120, "succeeded", "Not signed in on threads.com: nothing to do."), task("x.com", 20)];
    expect(nextPlatform(picked, { ...x, tasks: [...walled, task("instagram.com", 5, "running")], avoided: new Set(["linkedin.com"]) })).toBeNull();
    // As runs said it live: Discord signed out, and Telegram twice with nobody to reach.
    const discord = [platform("discord")];
    expect(nextPlatform(discord, { ...x, tasks: [task("discord.com", 120, "succeeded", "The Chrome I work in isn't signed in to discord.com. It redirects to the login page.")] })).toBeNull();
    const telegram = [platform("telegram")];
    const empty = [task("web.telegram.org", 150, "succeeded", "I reached nobody this run, and nothing went up."), task("web.telegram.org", 100, "succeeded", "I reached nobody this run, and nothing went up.")];
    expect(nextPlatform(telegram, { ...x, tasks: empty })).toBeNull();
  });

  it("comes back sooner where people answered, and later where its words went up to nobody", () => {
    const picked = ["threads", "x"].map(platform);
    const tasks = [task("threads.net", 300), task("x.com", 120)];
    const reply = (host: string, i: number) => ({ kind: "reply", platform: host, url: `https://${host}/p/${i}`, status: "posted", sentAt: ago(600) }) as unknown as Draft;
    const answer = (i: number) => ({ stage: "conversation", person: `@p${i}`, url: "https://x.com/notifications/mentions", evidence: `answered them on x.com: "${i}"`, at: ago(500) }) as unknown as ResultEntry;
    const x = { tasks, drafts: [] as Draft[], avoided: new Set<string>(), now };
    expect(nextPlatform(picked, x)?.key).toBe("threads");
    // 13 answered on X: two hours there count as six.
    expect(nextPlatform(picked, { ...x, results: Array.from({ length: 13 }, (_, i) => answer(i)) })?.key).toBe("x");
    const quiet = Array.from({ length: 6 }, (_, i) => reply("www.threads.com", i));
    const went = howItWent(platform("threads"), { drafts: quiet, results: [], now });
    expect(went).toEqual({ sent: 6, answered: 0 });
    expect(wentLine(platform("threads"), went)).toMatch(/nobody answered\. Change something/);
  });
});

describe("the reply watch beyond Reddit", () => {
  it("never tells their own words as an answer, from a send of theirs not due in that look", async () => {
    const world = makeWorld();
    const c = await world.customers.create({ channel: telegramSender().channel, userRef: "42", displayName: "Dana", language: "en" });
    const reply = async (who: string, text: string) => {
      const url = `https://www.threads.com/@${who}/post/Df${who}`;
      const d = await world.draftStore.add({ customerId: c.id, kind: "reply", platform: "threads.com", url, target: url, title: null, author: who, quote: "Launch day", text });
      await world.draftStore.markSent(d.id, url, "connected account");
      return d;
    };
    const due = await reply("jon", "A phone lying on its side as a desk clock is a good second life for an old iPhone.");
    await reply("alex", "Tickets for budgets is such a fun idea, my expenses finally get to feel like a night out.");
    await world.draftStore.watch(due.id, world.clock.now(), 0, []);
    world.reader.pages["https://www.threads.com/activity"] = { url: "https://www.threads.com/activity", title: "Activity", description: null, text: "Tickets for budgets is such a fun idea, my expenses finally get to feel like a night out." };
    const watch = new ReplyWatch(
      {
        finds: world.findStore,
        drafts: world.draftStore,
        reach: new FakeReach(world.reader, world.posts),
        online: () => true,
        events: world.events,
        memory: world.memory,
        // As the model read it live, 2026-11-05: their reply to @alex, no name over it, taken for an answer to the one due.
        answers: { read: async () => [{ to: 0, author: "", text: "Tickets for budgets is such a fun idea, my expenses finally get to feel like a n" }] },
        wakeManager: () => undefined,
        clock: world.clock,
        log: silentLogger,
      },
      { everyMs: 60_000 },
    );

    world.clock.advance(20 * 60_000);
    expect(await watch.tick()).toBe(0);
    expect(world.events.events.filter((e) => e.event.kind === "system" && e.event.topic === "answers")).toHaveLength(0);
  });

  it("tells an answer once across all their sends, gives its own address, and leaves one a reply of theirs answers", async () => {
    const world = makeWorld();
    const c = await world.customers.create({ channel: telegramSender().channel, userRef: "42", displayName: "Dana", language: "en" });
    const mentions = "https://x.com/notifications/mentions";
    const asked = "Do you have any tips for what kind of posts get replies there?";
    const answerUrl = "https://x.com/sikandar/status/2118287431258763400";
    const send = async (who: string, quote = "Launch day") => {
      const url = `https://x.com/${who}/status/1`;
      const d = await world.draftStore.add({ customerId: c.id, kind: "reply", platform: "x.com", url, target: url, title: null, author: who, quote, text: `Words for ${who} that are nobody's answer` });
      await world.draftStore.markSent(d.id, url, "connected account");
      await world.draftStore.watch(d.id, world.clock.now(), 0, []);
    };
    await send("one");
    world.reader.pages[mentions] = { url: mentions, title: "Mentions", description: null, text: asked, posts: [{ source: "x", url: answerUrl, title: asked, text: asked, author: "sikandar", postedAt: null }] } as never;
    const answers = [{ to: null, author: "Md Sikandar", text: asked }];
    const watch = new ReplyWatch(
      { finds: world.findStore, drafts: world.draftStore, reach: new FakeReach(world.reader, world.posts), online: () => true, events: world.events, memory: world.memory, answers: { read: async () => answers }, wakeManager: () => undefined, clock: world.clock, log: silentLogger },
      { everyMs: 60_000 },
    );
    const told = () => world.events.events.flatMap((e) => (e.event.kind === "system" && e.event.topic === "answers" ? [e.event.text] : []));

    world.clock.advance(20 * 60_000);
    expect(await watch.tick()).toBe(1);
    expect(told()[0]).toContain(answerUrl);

    // Live, 2026-11-05: every send with nothing told yet told Md Sikandar's question again, ten times in a day.
    await send("two");
    world.clock.advance(20 * 60_000);
    expect(await watch.tick()).toBe(0);

    // A question nobody told yet, but their reply to it is on its card already: no news.
    answers[0] = { to: null, author: "Kunal", text: "Which of the two got you more replies so far?" };
    await send("kunal", "Which of the two got you more replies so far?");
    world.clock.advance(20 * 60_000);
    expect(await watch.tick()).toBe(0);
    expect(told()).toHaveLength(1);
  });

  it("reads a Threads reply's answers off their activity, and tells each answer once", async () => {
    const world = makeWorld();
    const c = await world.customers.create({ channel: telegramSender().channel, userRef: "42", displayName: "Dana", language: "en" });
    const d = await world.draftStore.add({
      customerId: c.id,
      kind: "reply",
      platform: "threads.com",
      url: "https://www.threads.com/@sohizs/post/DfSNegyjYg2",
      target: "https://www.threads.com/@sohizs/post/DfSNegyjYg2",
      title: null,
      author: "sohizs",
      quote: "Made $2 today",
      text: "The $2 a day is a good sign.",
    });
    await world.draftStore.markSent(d.id, "https://www.threads.com/@dana/replies", "connected account");
    await world.draftStore.watch(d.id, world.clock.now(), 0, []);
    world.reader.pages["https://www.threads.com/activity"] = { url: "https://www.threads.com/activity", title: "Activity", description: null, text: "sohizs replied: Thanks! It's a slow climb but it's climbing" };
    const reads: string[] = [];
    const watch = new ReplyWatch(
      {
        finds: world.findStore,
        drafts: world.draftStore,
        reach: new FakeReach(world.reader, world.posts),
        online: () => true,
        events: world.events,
        memory: world.memory,
        answers: { read: async (_c, page) => (reads.push(page.url), [{ to: 0, author: "sohizs", text: "Thanks! It's a slow climb but it's climbing" }]) },
        wakeManager: () => undefined,
        clock: world.clock,
        log: silentLogger,
      },
      { everyMs: 60_000 },
    );

    world.clock.advance(20 * 60_000);
    expect(await watch.tick()).toBe(1);
    expect(reads).toEqual(["https://www.threads.com/activity"]);
    const told = world.events.events.flatMap((e) => (e.event.kind === "system" && e.event.topic === "answers" ? [e.event.text] : []));
    expect(told).toHaveLength(1);
    expect(told[0]).toContain('Their reply on Threads to @sohizs (https://www.threads.com/@sohizs/post/DfSNegyjYg2) was: "The $2 a day is a good sign."');
    expect(told[0]).toContain('- @sohizs (the person they answered): "Thanks! It\'s a slow climb but it\'s climbing"');

    // The next look sees the same answer: nothing new to tell.
    world.clock.advance(6 * 3_600_000);
    expect(await watch.tick()).toBe(0);
  });

  it("keeps a look their minimised window could not draw, and tries it again soon", async () => {
    // Live, 2026-11-04: X's mentions show their posts only on screen, and the read spent a reply's 15-minute look.
    const world = makeWorld();
    const c = await world.customers.create({ channel: telegramSender().channel, userRef: "42", displayName: "Dana", language: "en" });
    const d = await world.draftStore.add({ customerId: c.id, kind: "reply", platform: "x.com", url: "https://x.com/him/status/1", target: "https://x.com/him/status/1", title: null, author: "him", quote: "first users", text: "Ten chats first." });
    await world.draftStore.markSent(d.id, "https://x.com/dana/status/2", "connected account");
    await world.draftStore.watch(d.id, world.clock.now(), 0, []);
    let hidden = true;
    const reader = { readPage: async (url: string) => {
      if (hidden) throw new ReadError("hidden", "Your Chrome window is minimised or covered");
      return { url, title: "Mentions", description: null, text: "him replied: thanks" };
    } };
    const reads: string[] = [];
    const watch = new ReplyWatch(
      {
        finds: world.findStore,
        drafts: world.draftStore,
        reach: { forCustomer: () => ({ reader }) } as unknown as WebReach,
        online: () => true,
        events: world.events,
        memory: world.memory,
        answers: { read: async (_c, page) => (reads.push(page.url), []) },
        wakeManager: () => undefined,
        clock: world.clock,
        log: silentLogger,
      },
      { everyMs: 60_000 },
    );

    world.clock.advance(20 * 60_000);
    await watch.tick();
    expect(world.draftStore.watches.get(d.id)).toMatchObject({ checks: 0, next: new Date(world.clock.now().getTime() + HIDDEN_RETRY_MS) });
    hidden = false;
    world.clock.advance(HIDDEN_RETRY_MS);
    await watch.tick();
    expect(reads).toEqual(["https://x.com/notifications/mentions"]);
    expect(world.draftStore.watches.get(d.id)?.checks).toBe(1);
  });
});
