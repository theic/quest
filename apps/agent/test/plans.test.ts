import { AIMessage } from "@langchain/core/messages";
import { fakeModel } from "@langchain/core/testing";
import { type CustomerId } from "@mq/core";
import { catalogs, forLanguage } from "@mq/i18n";
import { describe, expect, it } from "vitest";
import { Checkout } from "../src/billing/checkout.ts";
import { SAID } from "../src/billing/credit-words.ts";
import { money, PACKS, PlanLinks } from "../src/billing/plans.ts";
import { FREE_START_USD } from "../src/conversation/way-in.ts";
import { planRoutes } from "../src/http/plan-routes.ts";
import { StripeApi, stripeSignature, stripeSigned } from "../src/infra/stripe.ts";
import { silentLogger } from "../src/infra/system.ts";
import { makeWorld, telegramSender } from "./world.ts";

type World = ReturnType<typeof makeWorld>;

const HOUR = 3_600_000;

/** Someone let in already (on an invite, unless the test says otherwise). */
async function customerIn(world: World, language = "en") {
  const c = await world.customers.create({ channel: telegramSender().channel, userRef: "42", displayName: "Dana", language });
  await world.customers.update(c.id, { activatedAt: world.clock.now() });
  return c;
}

/** A model call made for them that cost `usd`. */
function spent(world: World, id: CustomerId, usd: number): void {
  world.spend.record({ customerId: id, taskId: null, agent: "scout", model: "m", ms: 1, usage: { input: 1, cached: 0, cacheWrite: 0, output: 1, reasoning: 0, cost: usd } });
}

/** Stripe's page and webhook as the agent meets them: Checkout answers, and events signed as Stripe signs them. */
function stripeWorld(world: World) {
  const requests: URLSearchParams[] = [];
  const api = new StripeApi("sk_test_123", (async (_url: string | URL | Request, init?: RequestInit) => {
    requests.push(new URLSearchParams(String(init?.body ?? "")));
    return Response.json({ id: "cs_new", url: "https://checkout.stripe.com/c/pay/cs_new" });
  }) as typeof fetch);
  const checkout = new Checkout({ stripe: api, billing: world.billing, customers: world.customers, credited: (id, top) => world.energy.toppedUp(id, top), log: silentLogger });
  const app = planRoutes({ links: world.planLinks, energy: world.energy, customers: world.customers, checkout, webhookSecret: "whsec_test", log: silentLogger, now: () => world.clock.now() });
  const paid = (id: CustomerId, session: string, usd: number) => {
    const body = JSON.stringify({
      id: `evt_${session}`,
      type: "checkout.session.completed",
      data: { object: { id: session, mode: "payment", payment_status: "paid", amount_total: usd * 100, currency: "usd", client_reference_id: id, metadata: { product: "quest", customer_id: id, pack: String(usd) } } },
    });
    return app.request("/stripe/webhook", { method: "POST", body, headers: { "stripe-signature": stripeSignature(body, "whsec_test", Math.floor(world.clock.now().getTime() / 1000)) } });
  };
  return { app, paid, requests };
}

describe("pay as you go", () => {
  it("says all of it in their language, as money", () => {
    const english: Record<string, string> = catalogs.en;
    for (const words of [...Object.values(SAID), "{count} h", "{count} min"]) expect(english[words], words).toBeDefined();
    expect(money(840, "en")).toBe("$840.00");
    expect(money(20, "en", false)).toBe("$20");
    expect(forLanguage("uk")(SAID.toppedUp, { credit: money(25, "uk") })).toContain("25,00");
    expect(PACKS).toEqual([{ usd: 20, bonus: 5 }, { usd: 100, bonus: 40 }]);
    // Their page's address is theirs alone: signed, and read back.
    const links = new PlanLinks("123:t", "https://quest.test");
    const id = "00000000-0000-4000-8000-000000000001" as CustomerId;
    expect(links.read(links.token(id))).toEqual({ customerId: id });
  });

  it("rests everyone at the day's limit, until their midnight, and says so once", async () => {
    const world = makeWorld();
    const c = await customerIn(world);
    spent(world, c.id, 4.2);
    expect(await world.energy.check(c.id)).toMatchObject({ access: "invite", used: 4.2, limit: 5, tired: true, restUntil: null });
    spent(world, c.id, 0.9);
    const view = await world.energy.check(c.id);
    expect(view).toMatchObject({ resting: "day" });
    expect(world.channel.sent.at(-1)?.text).toBe("That's a full day's work for me, so I'm resting for 12 h. Anything you send meanwhile, I'll pick up when I'm back.");
    await world.energy.check(c.id);
    expect(world.channel.sent.filter((m) => m.text.startsWith("That's a full day's work"))).toHaveLength(1);
  });

  it("holds their work while it rests, but the evening report, and picks it up when the rest ends", async () => {
    const world = makeWorld();
    const c = await customerIn(world);
    const task = await world.tasks.start(c.id, "researcher", "Read the site", "Read https://acme.test.");
    spent(world, c.id, 5.2);
    await world.energy.check(c.id);

    // What they write waits; they hear once how long the rest has left, then get a 😴 on the next.
    await world.inbound.handle({ type: "text", from: telegramSender(), text: "any news?", messageRef: "m1", replyToRef: null });
    expect(world.channel.sent.at(-1)?.text).toBe("Resting for 12 h more. I'll pick this up when I'm back.");
    await world.inbound.handle({ type: "text", from: telegramSender(), text: "hello?", messageRef: "m2", replyToRef: null });
    expect(world.channel.reactions).toEqual([{ to: "42", ref: "m2", emoji: "😴" }]);
    expect(await world.events.claimCustomer("w", 60_000)).toBeNull();
    expect(await world.runner.runNext()).toBe(false);

    // The evening report does not wait for the morning.
    await world.events.push(c.id, { kind: "day_report", day: "2026-09-25" });
    expect(await world.events.claimCustomer("w", 60_000)).toBe(c.id);
    const report = await world.events.take(c.id, 20);
    expect(report.map((e) => e.event.kind)).toEqual(["day_report"]);
    await world.events.done(report.map((e) => e.id));
    await world.events.release(c.id, "w");

    // Their midnight: the rest is over, and everything waiting is taken up.
    world.clock.advance(12 * HOUR + 1);
    expect(await world.events.claimCustomer("w", 60_000)).toBe(c.id);
    expect((await world.events.take(c.id, 20)).map((e) => e.event.kind)).toEqual(["user_message", "user_message"]);
    const claimed = await world.taskStore.claim("w", 60_000, 2);
    expect(claimed?.task.id).toBe(task.id);
  });

  it("stops a run in flight at the day's limit, and goes on with it after the rest", async () => {
    const researcher = fakeModel()
      .respondWithTools([{ name: "read_site", args: { url: "https://acme.test" } }])
      .respond(new AIMessage("Report: invoicing for freelancers."));
    const world = makeWorld({ researcher });
    const c = await customerIn(world);
    const task = await world.tasks.start(c.id, "researcher", "Read the site", "Read https://acme.test.");
    const read = world.reader.readSite.bind(world.reader);
    let stopped = false;
    world.reader.readSite = async (url) => {
      if (!stopped) {
        stopped = true;
        spent(world, c.id, 5.5);
        await world.energy.check(c.id);
      }
      return read(url);
    };

    await world.runner.runNext();
    const resting = await world.taskStore.get(task.id);
    expect(resting?.status).toBe("queued");
    // Not the task's fault: its try is given back.
    expect(resting?.attempts).toBe(0);
    expect(await world.runner.runNext()).toBe(false);

    world.clock.advance(12 * HOUR + 1);
    await world.runner.runNext();
    const done = await world.taskStore.get(task.id);
    expect(done?.status).toBe("succeeded");
    expect(done?.result).toContain("invoicing for freelancers");
  });

  it("credits a pack once, with its bonus only the first time, stops them when the credits run out, and a top-up starts them again", async () => {
    const world = makeWorld({}, { dayLimitUsd: 100 });
    const c = await customerIn(world);
    world.billing.bought.add(c.id); // credits they bought let them in
    const stripe = stripeWorld(world);

    // Their page sends them to Stripe for the pack they tapped, showing the first top-up's bonus.
    const token = world.planLinks.token(c.id);
    const page = await (await stripe.app.request(`/plan/${token}`)).text();
    expect(page).toContain("<span>+ $5</span>");
    const go = await stripe.app.request(`/plan/${token}/checkout`, { method: "POST", body: new URLSearchParams({ pack: "100" }) });
    expect(go.status).toBe(303);
    expect(go.headers.get("location")).toBe("https://checkout.stripe.com/c/pay/cs_new");
    expect(Object.fromEntries(stripe.requests[0]!)).toMatchObject({ mode: "payment", "line_items[0][price_data][unit_amount]": "10000", "metadata[customer_id]": c.id });

    expect((await stripe.paid(c.id, "cs_1", 20)).status).toBe(200);
    await stripe.paid(c.id, "cs_1", 20); // Stripe sends it again
    expect(world.channel.sent.map((m) => m.text).filter((t) => t.includes("in credits added"))).toEqual([
      "$25.00 in credits added: $20.00, plus a $5.00 bonus for your first top-up. Back to work.",
    ]);
    expect((await world.energy.view(c.id)).balance).toBe(25);

    // Their calls are drawn from it; at zero Quest stops, says so with the way to top up, and waits.
    world.clock.advance(1);
    spent(world, c.id, 26);
    world.clock.advance(11_000);
    expect(await world.energy.check(c.id)).toMatchObject({ balance: 0, resting: "credits" });
    expect(world.channel.linkMessages.at(-1)).toMatchObject({ text: SAID.outOfCredits, links: [{ label: "Top up" }, { label: "Stuck? Write to Serhii" }] });
    expect(await world.runner.runNext()).toBe(false);

    // The next pack has no bonus, ends the stop at once, and wakes the manager.
    await stripe.paid(c.id, "cs_2", 100);
    expect(world.channel.sent.at(-1)?.text).toBe("$100.00 in credits added. Back to work.");
    expect(world.billing.rests.has(c.id)).toBe(false);
    expect(world.events.events.at(-1)?.event).toMatchObject({ kind: "system", topic: "credits" });
    expect(await world.energy.view(c.id)).toMatchObject({ balance: 100, firstTopUp: false, restUntil: null });
  });

  it("lets someone new in at once on a free start, and on an invite's code for free", async () => {
    const world = makeWorld({}, { wayIn: true });
    await world.inbound.handle({ type: "command", from: telegramSender(), command: "start", args: "", messageRef: "1" });
    const [c] = [...world.customers.customers.values()];
    expect((await world.customers.get(c!.id)).activatedAt).not.toBeNull();
    expect(world.channel.languageChoices).toHaveLength(1);
    expect(await world.energy.view(c!.id)).toMatchObject({ access: "credits", balance: FREE_START_USD });

    const invited = makeWorld({}, { wayIn: true });
    invited.invites.add("FRIEND1");
    await invited.inbound.handle({ type: "command", from: telegramSender(), command: "start", args: "friend1", messageRef: "1" });
    const [d] = [...invited.customers.customers.values()];
    expect(await invited.energy.view(d!.id)).toMatchObject({ access: "invite", balance: null });
  });

  it("shows someone on an invite that Quest is free for them, with no packs", async () => {
    const world = makeWorld();
    const c = await customerIn(world);
    const page = await (await stripeWorld(world).app.request(`/plan/${world.planLinks.token(c.id)}`)).text();
    expect(page).toContain("on an invite, so Quest is free for you.");
    expect(page).not.toContain('name="pack"');
  });

  it("refuses webhooks while Stripe is not set up, and checks signatures as Stripe makes them", async () => {
    const world = makeWorld();
    const app = planRoutes({ links: world.planLinks, energy: world.energy, customers: world.customers, checkout: null, webhookSecret: null, log: silentLogger });
    expect((await app.request("/stripe/webhook", { method: "POST", body: "{}" })).status).toBe(503);
    const now = 1_800_000_000;
    const header = stripeSignature('{"a":1}', "whsec_x", now);
    expect(stripeSigned('{"a":1}', header, "whsec_x", now)).toBe(true);
    expect(stripeSigned('{"a":2}', header, "whsec_x", now)).toBe(false);
    expect(stripeSigned('{"a":1}', header, "whsec_y", now)).toBe(false);
    expect(stripeSigned('{"a":1}', header, "whsec_x", now + 600)).toBe(false);
  });
});
