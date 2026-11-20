import { readFile } from "node:fs/promises";
import { AIMessage } from "@langchain/core/messages";
import { fakeModel } from "@langchain/core/testing";
import { PGlite } from "@electric-sql/pglite";
import { customerId, WORK_BUTTON } from "@mq/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Queryable } from "../src/infra/db.ts";
import { PgBoards } from "../src/infra/pg-boards.ts";
import { estimate, workLabel } from "../src/tasks/task-board.ts";
import { TelegramBotApi } from "../src/telegram/bot-api.ts";
import { TelegramChannel } from "../src/telegram/telegram-channel.ts";
import { ownPinNotice } from "../src/telegram/updates.ts";
import { forLanguage } from "@mq/i18n";
import { makeWorld, telegramSender } from "./world.ts";

async function customerIn(world: ReturnType<typeof makeWorld>, language = "en") {
  return world.customers.create({ channel: telegramSender().channel, userRef: "42", displayName: "Dana", language });
}

const SCOUT_PACE = { agent: "scout", runs: 12, medianMs: 300_000, p80Ms: 600_000 };

describe("the work going on, on the Quest button and the customer's page", () => {
  it("says on the chat's Quest button that a run is at work, and puts it back once the work is over", async () => {
    const researcher = fakeModel()
      .respondWithTools([{ name: "read_site", args: { url: "https://acme.test" } }])
      .respond(new AIMessage("What it is: invoicing for freelancers."));
    const world = makeWorld({ researcher });
    const c = await customerIn(world);
    await world.tasks.start(c.id, "researcher", "Read the site", "Read https://acme.test and report.");

    await world.runner.runNext();
    await world.board.settled();
    expect(world.channel.buttons).toEqual([{ to: "42", label: "1 working" }]);
    expect(await world.boards.get(c.id)).toEqual({ to: telegramSender().channel, ref: WORK_BUTTON });
    // No message, no pin: nothing in the chat to scroll past, nothing in its record.
    expect(world.channel.sent).toEqual([]);
    // Finished with its report: the page shows it done for a moment.
    const live = await world.board.live(c.id, "en");
    expect(live.runs).toMatchObject([{ agent: "researcher", title: "Read the site", done: true, share: 1, doing: null }]);

    // A moment's grace, for the next run of the same work; then the button is "Quest" again.
    world.clock.advance(10_000);
    await world.board.tick();
    expect(world.channel.buttons).toHaveLength(1);
    world.clock.advance(5_000);
    await world.board.tick();
    expect(world.channel.buttons.at(-1)).toEqual({ to: "42", label: null });
    expect(await world.boards.get(c.id)).toBeNull();
    expect((await world.board.live(c.id, "en")).runs).toEqual([]);
    expect(world.board.busy).toBe(false);
  });

  it("counts the runs at work, and changes the button only when the count does", async () => {
    const world = makeWorld();
    const c = await customerIn(world);
    const scout = await world.tasks.start(c.id, "scout", "People asking for first customers", "Find them.");
    const researcher = await world.tasks.start(c.id, "researcher", "What messaging.quest is", "Read it.");

    world.board.started(scout, 30);
    world.board.tool(scout.id, "search_posts", { source: "reddit", query: "first customers" });
    world.board.step(scout.id);
    await world.board.settled();
    world.board.started(researcher, 20);
    await world.board.settled();
    world.board.stopped(researcher.id, true);
    await world.board.settled();

    expect(world.channel.buttons.map((b) => b.label)).toEqual(["1 working", "2 working", "1 working"]);
    // A run stopped short (a question, a cancel) leaves the page at once; one finished shows done for the grace.
    world.board.stopped(scout.id, false);
    expect((await world.board.live(c.id, "en")).runs.map((r) => [r.agent, r.done])).toEqual([["researcher", true]]);
    world.clock.advance(15_000);
    await world.board.tick();
    expect(world.channel.buttons.at(-1)?.label).toBeNull();
  });

  it("shows each run live: how far it is, the minutes left, what it does now and the site it is on", async () => {
    const world = makeWorld();
    world.taskStore.pace = [SCOUT_PACE];
    const c = await customerIn(world);
    const task = await world.tasks.start(c.id, "scout", "People asking for first customers", "Find them.");

    world.board.started(task, 30);
    world.clock.advance(180_000);
    world.board.tool(task.id, "search_posts", { source: "reddit", query: "how did you get your first customers", within: "month" });
    world.board.step(task.id);
    expect((await world.board.live(c.id, "en")).runs[0]).toMatchObject({
      agent: "scout",
      share: 0.3,
      leftMs: 420_000,
      late: false,
      doing: "Searching Reddit for “how did you get your first customers”",
      site: null,
    });

    world.board.tool(task.id, "read_page", { url: "https://www.reddit.com/r/SaaS/comments/abc/first_customers/" });
    expect((await world.board.live(c.id, "en")).runs[0]).toMatchObject({ doing: "Reading reddit.com/r/SaaS", site: "reddit.com" });

    // Past eight in ten of its runs, it says so, and stays short of done.
    world.clock.advance(600_000);
    world.board.tool(task.id, "browser_act", { kind: "click", ref: "e12" });
    expect((await world.board.live(c.id, "en")).runs[0]).toMatchObject({ share: 0.95, late: true, doing: "Looking through reddit.com/r/SaaS" });
  });

  it("shows a run waiting its turn on a site, and Quest's own turn as it works", async () => {
    const world = makeWorld();
    const c = await customerIn(world);

    world.board.turnStarted(c.id);
    expect((await world.board.live(c.id, "en")).manager).toMatchObject({ busy: true, doing: "Thinking", site: null });
    world.board.turnTool(c.id, "browser_open", { url: "https://x.com/home" });
    expect((await world.board.live(c.id, "en")).manager).toMatchObject({ busy: true, doing: "Reading x.com", site: "x.com" });

    world.board.started({ id: "post:1", customerId: c.id, agent: "poster", title: { text: "Your profile on {place}", values: { place: "x.com" } } }, 30);
    world.board.waiting("post:1", "x.com");
    expect((await world.board.live(c.id, "en")).runs[0]).toMatchObject({ agent: "poster", title: "Your profile on x.com", waitingFor: "x.com", doing: "Waiting for its turn on x.com" });
    world.board.waiting("post:1", null);
    world.board.tool("post:1", "publish", { url: "https://x.com/settings/profile" });
    expect((await world.board.live(c.id, "en")).runs[0]).toMatchObject({ waitingFor: null, doing: "Sending it on x.com", site: "x.com" });

    world.board.turnEnded(c.id);
    expect((await world.board.live(c.id, "en")).manager.busy).toBe(false);
    // Quest's own turn never counts on the button: only runs of the team do.
    await world.board.settled();
    expect(world.channel.buttons.map((b) => b.label)).toEqual(["1 working"]);
  });

  it("is written in their language", async () => {
    const world = makeWorld();
    world.taskStore.pace = [SCOUT_PACE];
    const c = await customerIn(world, "ru");
    const task = await world.tasks.start(c.id, "scout", "Люди, которые ищут первых клиентов", "Find them.");

    world.board.started(task, 30);
    world.clock.advance(180_000);
    world.board.tool(task.id, "search_posts", { source: "web", query: "первые клиенты" });
    await world.board.settled();

    expect(world.channel.buttons.at(-1)?.label).toBe(workLabel(1, forLanguage("ru")));
    expect(world.channel.buttons.at(-1)?.label).not.toContain("working");
    expect((await world.board.live(c.id, "ru")).runs[0]?.doing).toBe("Ищу «первые клиенты» в интернете");
  });

  it("after a restart, takes down a board an older version pinned, and puts a button back unless its work starts again", async () => {
    const world = makeWorld();
    const c = await customerIn(world);
    const other = await world.customers.create({ channel: { kind: "telegram", address: "77" }, userRef: "77", displayName: "Sam", language: "en" });
    const third = await world.customers.create({ channel: { kind: "telegram", address: "78" }, userRef: "78", displayName: "Lee", language: "en" });
    await world.boards.save(c.id, { to: telegramSender().channel, ref: WORK_BUTTON });
    await world.boards.save(other.id, { to: { kind: "telegram", address: "77" }, ref: "501" });
    await world.boards.save(third.id, { to: { kind: "telegram", address: "78" }, ref: WORK_BUTTON });
    const task = await world.tasks.start(c.id, "scout", "People asking for first customers", "Find them.");

    world.board.start();
    try {
      await world.board.settled();
      expect(world.channel.removedBoards).toEqual(["501"]);
      world.board.started(task, 30);
      await world.board.settled();
      expect(world.channel.buttons).toEqual([{ to: "42", label: "1 working" }]);

      world.clock.advance(90_000);
      await world.board.tick();
      expect(world.channel.buttons.at(-1)).toEqual({ to: "78", label: null });
      expect(await world.boards.list()).toEqual([{ customerId: c.id, board: { to: telegramSender().channel, ref: WORK_BUTTON } }]);
    } finally {
      await world.board.stop();
    }
  });

  it("still shows the work on the page in a chat without a Quest button", async () => {
    const world = makeWorld();
    world.channel.hasButton = false;
    const c = await customerIn(world);
    const task = await world.tasks.start(c.id, "scout", "People asking for first customers", "Find them.");

    world.board.started(task, 30);
    await world.board.settled();

    expect(world.channel.buttons).toEqual([]);
    expect(await world.boards.get(c.id)).toBeNull();
    expect((await world.board.live(c.id, "en")).runs).toHaveLength(1);
    expect(world.board.busy).toBe(true);
    world.board.stopped(task.id, false);
    world.clock.advance(15_000);
    await world.board.tick();
    expect(world.board.busy).toBe(false);
  });

  it("estimates from its own steps until the teammate's runs are timed", () => {
    // Six steps in a minute, of thirty: four minutes more if it uses them all.
    const e = estimate({ steps: 6, budget: 30, startedAt: 0 }, undefined, 60_000);
    expect(e).toEqual({ share: 0.2, leftMs: 240_000, late: false });
    // Two timed runs are not a pace yet.
    expect(estimate({ steps: 1, budget: 30, startedAt: 0 }, { agent: "scout", runs: 2, medianMs: 1, p80Ms: 1 }, 60_000).leftMs).toBeNull();
  });
});

describe("the Quest button on Telegram", () => {
  const api = (appUrl: string | null = "https://quest.example/glass") => {
    const calls: { method: string; body: Record<string, unknown> }[] = [];
    const fetchStub = (async (url: string, init: { body: string }) => {
      const method = url.split("/").at(-1)!;
      calls.push({ method, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ ok: true, result: true }));
    }) as unknown as typeof fetch;
    return { calls, channel: new TelegramChannel(new TelegramBotApi("TOKEN", fetchStub), async () => null, { appUrl }) };
  };

  it("names the work on the chat's own button, and hands it back to every chat's after", async () => {
    const { calls, channel } = api();
    const to = { kind: "telegram" as const, address: "42" };

    expect(await channel.showWork(to, "2 working")).toBe(true);
    expect(await channel.showWork(to, null)).toBe(true);

    expect(calls).toEqual([
      { method: "setChatMenuButton", body: { chat_id: "42", menu_button: { type: "web_app", text: "2 working", web_app: { url: "https://quest.example/glass" } } } },
      { method: "setChatMenuButton", body: { chat_id: "42", menu_button: { type: "default" } } },
    ]);
  });

  it("has no button to show work on without an https page for it", async () => {
    const { calls, channel } = api("http://localhost:8080/glass");
    expect(await channel.showWork({ kind: "telegram", address: "42" }, "1 working")).toBe(false);
    expect(calls).toEqual([]);
  });

  it("takes down a board an older version pinned", async () => {
    const { calls, channel } = api();
    await channel.removeBoard({ kind: "telegram", address: "42" }, "31");
    expect(calls).toEqual([
      { method: "unpinChatMessage", body: { chat_id: "42", message_id: 31 } },
      { method: "deleteMessage", body: { chat_id: "42", message_id: 31 } },
    ]);
  });

  it("deletes Telegram's note of its own pin, and leaves theirs alone", async () => {
    const { calls, channel } = api();
    const bot = { id: 7, is_bot: true, first_name: "Quest" };
    const user = { id: 42, is_bot: false, first_name: "Dana" };
    const chat = { id: 42, type: "private" as const };
    const notice = (from: typeof bot) => ({ update_id: 1, message: { message_id: 32, from, chat, date: 0, pinned_message: { message_id: 31, chat, date: 0 } } });

    expect(ownPinNotice(notice(user))).toBeNull();
    expect(await channel.dropPinNotice(notice(user))).toBe(false);
    expect(await channel.dropPinNotice({ update_id: 2, message: { message_id: 33, from: user, chat, date: 0, text: "hi" } })).toBe(false);
    expect(await channel.dropPinNotice(notice(bot))).toBe(true);
    expect(calls).toEqual([{ method: "deleteMessage", body: { chat_id: "42", message_id: 32 } }]);
  });
});

describe("mq.task_boards against PostgreSQL", () => {
  let db: PGlite;
  let boards: PgBoards;
  const live = customerId("00000000-0000-0000-0000-000000000001");
  const test = customerId("00000000-0000-0000-0000-000000000002");
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(
      "create role mq_app; create schema mq; create table mq.customers(id uuid primary key, lane text not null); " +
        "insert into mq.customers values ('00000000-0000-0000-0000-000000000001', 'live'), ('00000000-0000-0000-0000-000000000002', 'test');",
    );
    await db.exec(await readFile(new URL("../../../supabase/migrations/20261013200000_task_boards.sql", import.meta.url), "utf8"));
    const queryable = { query: async (sql: string, values?: unknown[]) => {
      const result = await db.query(sql, values);
      return { rows: result.rows, rowCount: result.affectedRows ?? 0 };
    } } as Queryable;
    boards = new PgBoards(queryable, "live");
  }, 120_000);
  afterAll(async () => { await db?.close(); });

  it("keeps one board a customer, forgets it only by its own ref, and lists its own lane's", async () => {
    const chat = { kind: "telegram" as const, address: "42" };
    await boards.save(live, { to: chat, ref: "10" });
    await boards.save(live, { to: chat, ref: WORK_BUTTON });
    await boards.save(test, { to: { kind: "telegram", address: "43" }, ref: "12" });
    expect(await boards.get(live)).toEqual({ to: chat, ref: WORK_BUTTON });

    await boards.clear(live, "10");
    expect(await boards.list()).toEqual([{ customerId: live, board: { to: chat, ref: WORK_BUTTON } }]);
    await boards.clear(live, WORK_BUTTON);
    expect(await boards.get(live)).toBeNull();
    expect(await boards.get(test)).toEqual({ to: { kind: "telegram", address: "43" }, ref: "12" });

    await db.query("delete from mq.customers where id = $1", [test]);
    expect(await boards.get(test)).toBeNull();
  });
});
