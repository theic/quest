import { ChromeError, customerId } from "@mq/core";
import { describe, expect, it } from "vitest";
import { ChromeBroker, SWITCHED_OFF } from "../src/chrome/broker.ts";
import { OFF_ACK } from "../src/drafts/draft-service.ts";
import { OFF_SAID, ON_SAID, Power } from "../src/lifecycle/power.ts";
import { silentLogger } from "../src/infra/system.ts";
import { ManagerLoop } from "../src/manager/manager-loop.ts";
import { TurnStopped } from "../src/manager/manager-turn.ts";
import { parseUpdate } from "../src/telegram/updates.ts";
import { makeWorld, telegramSender } from "./world.ts";

async function setUp() {
  const world = makeWorld();
  const c = await world.customers.create({ channel: telegramSender().channel, userRef: "42", displayName: "Dana", language: "en" });
  const command = (command: string, ref: string) => world.inbound.handle({ type: "command", from: telegramSender(), command, args: "", messageRef: ref });
  const say = (text: string, ref: string) => world.inbound.handle({ type: "text", from: telegramSender(), text, messageRef: ref, replyToRef: null });
  return { world, c, command, say };
}

describe("the off switch", () => {
  it("switches Quest off with /off: none of their work is claimed, and the manager still answers what they write", async () => {
    const { world, c, command, say } = await setUp();
    await world.tasks.start(c.id, "scout", "People on Reddit", "Find people.");
    await command("off", "m1");
    expect((await world.customers.get(c.id)).offAt).toBeInstanceOf(Date);
    expect(world.channel.switches.at(-1)).toEqual({ to: telegramSender().channel.address, text: OFF_SAID, on: true });
    world.clock.advance(1);
    expect(await world.taskStore.claim("w", 60_000, 5)).toBeNull();

    // What is not theirs waits for on; what they write gets a turn, and nothing says it waits.
    await world.events.push(c.id, { kind: "heartbeat" });
    expect(await world.events.claimCustomer("w", 60_000)).toBeNull();
    const said = world.channel.switches.length;
    await say("are you there?", "m2");
    expect(world.channel.switches).toHaveLength(said);
    expect(await world.events.claimCustomer("w", 60_000)).toBe(c.id);
    expect((await world.events.take(c.id, 10)).map((e) => e.event.kind)).toEqual(["user_message"]);

    // /off again changes nothing.
    await command("off", "m4");
    expect(world.channel.sent.at(-1)?.text).toBe("I'm already off. /on switches me back on.");
  });

  it("switches back on with the button: the manager picks up what waited", async () => {
    const { world, c, command, say } = await setUp();
    await command("off", "m1");
    await say("one thing for later", "m2");
    await world.inbound.handle({ type: "power", from: telegramSender(), on: true, ackRef: "cb1" });
    expect(world.channel.acks.at(-1)).toEqual({ ackRef: "cb1", text: "Quest is on" });
    expect((await world.customers.get(c.id)).offAt).toBeNull();
    expect(world.channel.switches.at(-1)).toMatchObject({ text: ON_SAID, on: false });
    expect(world.events.kinds(c.id)).toEqual(["user_message", "system"]);
    expect(await world.events.claimCustomer("w", 60_000)).toBe(c.id);
    expect((await world.events.take(c.id, 10)).map((e) => e.event.kind)).toEqual(["user_message", "system"]);
    // A second tap on an old button.
    await world.inbound.handle({ type: "power", from: telegramSender(), on: true, ackRef: "cb2" });
    expect(world.channel.acks.at(-1)).toEqual({ ackRef: "cb2", text: "Already on" });
  });

  it("posts nothing while off, by itself or on a tap", async () => {
    const { world, c, command } = await setUp();
    const url = "https://x.com/ari/status/1";
    const offered = await world.drafts.offer(c.id, { platform: "browser", kind: "reply", url, target: url, quote: "who has a form tool?", text: "Tally does this." });
    if (typeof offered === "string") throw new Error(offered);
    await world.trust.set(c.id, "x.com", 3);
    await command("off", "m1");
    expect(await world.autopilot.alone(c.id, "x.com")).toBe(false);
    expect(await world.drafts.act(c.id, offered.draft.id, "post")).toBe(OFF_ACK);
    expect(await world.drafts.publish(c.id, offered.draft.id)).toMatch(/^They want to review sends/);
    await world.errands.stop();
    expect(world.poster.posts).toHaveLength(0);
    await command("on", "m2");
    expect(await world.autopilot.alone(c.id, "x.com")).toBe(true);
  });

  it("gives their Chrome nothing while off, and fails what waits for it with nothing sent", async () => {
    const broker = new ChromeBroker();
    const id = customerId("c-1");
    const polling = broker.next(id, 50);
    await polling;
    const waiting = broker.read(id, { url: "https://example.com/", take: { text: true } });
    broker.switchOff(id, true);
    await expect(waiting).rejects.toMatchObject({ reason: "unavailable" });
    await expect(broker.browser(id, { session: "s", url: "https://example.com/", action: { kind: "snapshot" } })).rejects.toEqual(new ChromeError("offline", SWITCHED_OFF));
    broker.switchOff(id, false);
    const after = broker.read(id, { url: "https://example.com/", take: { text: true } });
    const job = await broker.next(id, 50);
    expect(job).toMatchObject({ url: "https://example.com/" });
    broker.complete(id, job!.id, { ok: false, reason: "not_found", message: "gone" });
    await expect(after).rejects.toMatchObject({ reason: "not_found" });
  });

  it("reads the switch's button from Telegram", () => {
    const update = { update_id: 1, callback_query: { id: "cb", from: { id: 7, is_bot: false, first_name: "Dana" }, message: { message_id: 3, date: 0, chat: { id: 7, type: "private" as const } }, data: "power:off" } };
    expect(parseUpdate(update as never)).toMatchObject({ type: "power", on: false, ackRef: "cb" });
  });
});
