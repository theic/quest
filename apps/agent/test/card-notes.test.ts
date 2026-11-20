import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { AIMessage } from "@langchain/core/messages";
import { fakeModel } from "@langchain/core/testing";
import { draftId, type CustomerId } from "@mq/core";
import { nextLanguage } from "@mq/i18n";
import { describe, expect, it } from "vitest";
import { HEARD } from "../src/conversation/inbound-service.ts";
import { PgDraftRepository } from "../src/infra/pg-drafts.ts";
import { managerTools } from "../src/manager/tools.ts";
import { spoken } from "./fakes.ts";
import { makeWorld, telegramSender } from "./world.ts";

const ARI = "Keep it up. Messaging Quest helped me find people asking for exactly this.";

/** A customer with one open draft on a card, and the writer answering as scripted. */
async function withCard(writer: ReturnType<typeof fakeModel>) {
  const world = makeWorld({ writer });
  const c = await world.customers.create({ channel: telegramSender().channel, userRef: "42", displayName: "Serhii", language: "en" });
  await world.customers.update(c.id, { status: "active" });
  const d = await world.draftStore.add({
    customerId: c.id as CustomerId, kind: "reply", platform: "x.com", url: "https://x.com/Panlytics_ai/status/1", target: "Ari @Panlytics_ai",
    title: null, author: "Ari @Panlytics_ai", quote: "3 months in, finally got my first 5 users. How do I find the next 50?", text: ARI,
  });
  const ref = (await world.messenger.showDraft(c.id, d))!;
  await world.draftStore.markShown(d.id, ref);
  const told = () => world.events.events.flatMap((e) => (e.event.kind === "user_message" ? [e.event.text] : [])).at(-1) ?? "";
  return { world, c, d, ref, told };
}

describe("a note on a card", () => {
  it("said in a voice message, goes into the card's words, and the card comes back under it", async () => {
    // Live, 2026-10-14: this note got a 👍 from the manager and no change to the card.
    const writer = fakeModel().respond(new AIMessage("Keep it up."));
    const { world, d, ref, told } = await withCard(writer);
    world.channel.files.set("v1", spoken("Say nothing about messaging question."));

    await world.inbound.handle({ type: "voice", from: telegramSender(), fileRef: "v1", mimeType: "audio/ogg", fileName: null, seconds: 2, size: 5_000, caption: "", messageRef: "m1", replyToRef: ref });

    expect((await world.draftStore.get(d.id))?.text).toBe("Keep it up.");
    const prompt = JSON.stringify(writer.calls[0]!.messages[1]);
    expect(prompt).toContain("Say nothing about messaging question.");
    expect(prompt).toContain("misheard");
    // The new card is under their note, with its buttons; the old copy keeps its words and loses its buttons.
    const again = world.channel.drafts.at(-1)!;
    expect(again).toMatchObject({ redraw: false, draft: { id: d.id, text: "Keep it up." } });
    expect(again.ref).not.toBe(ref);
    expect(world.channel.closed).toEqual([ref]);
    // The manager hears it was done, and has nothing to redo.
    expect(told()).toContain("The writer already put it into the words");
    expect(told()).toContain(HEARD);
    // A reply to the old copy still finds the card.
    expect((await world.draftStore.byCard(d.customerId, ref))?.id).toBe(d.id);
  });

  it("after Edit, answers the question asked under the card", async () => {
    const writer = fakeModel().respond(new AIMessage("Keep it up, the next 50 come faster."));
    const { world, d } = await withCard(writer);

    await world.inbound.handle({ type: "draft", from: telegramSender(), draftId: d.id, action: "edit", ackRef: "a1" });
    const asked = world.channel.editAsks.at(-1)!;
    expect(asked.cardRef).toBe(d.cardRef ?? (await world.draftStore.get(d.id))!.cardRef);
    expect(world.channel.acks.at(-1)).toEqual({ ackRef: "a1" });

    await world.inbound.handle({ type: "text", from: telegramSender(), text: "drop the product, say the next 50 come faster", messageRef: "m2", replyToRef: asked.ref });
    expect((await world.draftStore.get(d.id))?.text).toBe("Keep it up, the next 50 come faster.");
    expect(world.channel.drafts.at(-1)?.draft.text).toBe("Keep it up, the next 50 come faster.");
  });

  it("that asks something instead leaves the card alone, and goes to the manager with it", async () => {
    const writer = fakeModel().respond(new AIMessage("NO CHANGE"));
    const { world, d, ref, told } = await withCard(writer);
    const cards = world.channel.drafts.length;

    await world.inbound.handle({ type: "text", from: telegramSender(), text: "why Ari?", messageRef: "m3", replyToRef: ref });

    expect((await world.draftStore.get(d.id))?.text).toBe(ARI);
    expect(world.channel.drafts).toHaveLength(cards);
    expect(told()).toContain(`why Ari?\n(Their reply to the card of`);
  });
});

describe("a picture they send", () => {
  it("reaches the manager as what it shows, with the words sent along", async () => {
    // Live, 2026-10-14: "This is him" with a screenshot of Marc Lou's profile reached the manager as the caption alone.
    const world = makeWorld();
    world.pictures.says = "A screenshot of the X profile of Marc Lou (@marclou): ⭐ TrustMRR.com $53K/m, 📈 DataFa.st $31K/m.";
    world.channel.files.set("p1", new Uint8Array([1, 2, 3]));
    await world.inbound.handle({ type: "file", from: telegramSender(), fileRef: "p1", fileName: "picture.jpg", mimeType: "image/jpeg", size: 3, caption: "This is him", messageRef: "m4", replyToRef: null });
    const said = world.events.events.map((e) => (e.event.kind === "user_message" ? e.event.text : "")).at(-1)!;
    expect(said).toMatch(/^This is him\n\n\(They sent a picture\. It shows: A screenshot of the X profile of Marc Lou/);
    expect(world.pictures.seen).toEqual(["image/jpeg"]);
    expect(world.transcript.entries.at(-1)?.text).toBe("🖼 This is him");
  });
});

describe("the language they write to", () => {
  it("holds once they ask for it, whatever device writes next", async () => {
    const world = makeWorld();
    const c = await world.customers.create({ channel: telegramSender().channel, userRef: "42", displayName: "Serhii", language: "pt" });
    const tools = Object.fromEntries(managerTools({ ...world, customerId: c.id, userTurn: true, customers: world.customers, now: world.clock.now }).map((t) => [t.name, t]));
    expect(await tools["set_language"]!.invoke({ language: "en" })).toMatch(/^Saved: English/);
    expect((await world.customers.get(c.id)).language).toBe("manual:en");
    expect(nextLanguage("manual:en", "pt-BR")).toBe("manual:en");
    expect(await tools["set_language"]!.invoke({ language: "klingon" })).toMatch(/^Quest speaks/);
  });
});

describe("a card's older messages, in Postgres", () => {
  it("still find the card after it moved, and so does the question asked under it", async () => {
    const db = new PGlite();
    await db.exec("create role mq_app; create schema mq; create schema extensions;");
    await db.exec(`create table mq.customers (id uuid primary key);
      create table mq.drafts (id uuid primary key, customer_id uuid, kind text, platform text, url text, target text, title text, author text, quote text, body text,
        status text default 'open', card_ref text, created_at timestamptz default now(), decided_at timestamptz, sent_url text, sent_as text, sent_at timestamptz,
        watch_next_at timestamptz, watch_checks int default 0, watch_seen text[] default '{}', alone boolean default false, assets uuid[] not null default '{}');
      create table mq.finds (id uuid primary key);`);
    await db.exec(await readFile(new URL("../../../supabase/migrations/20261014180000_card_refs.sql", import.meta.url), "utf8"));
    await db.exec(await readFile(new URL("../../../supabase/migrations/20261106090000_drafts_answered_at.sql", import.meta.url), "utf8"));
    const customer = "00000000-0000-0000-0000-000000000001";
    const id = "00000000-0000-0000-0000-0000000000d1";
    await db.query(`insert into mq.drafts (id, customer_id, kind, platform, url, target, body, card_ref) values ($1, $2, 'reply', 'x.com', 'https://x.com/a/status/1', 'a', 'hi', '10')`, [id, customer]);
    const drafts = new PgDraftRepository({ query: (sql: string, params?: unknown[]) => db.query(sql, params) as never } as never);
    await drafts.addRef(draftId(id), "11");
    await drafts.moveCard(draftId(id), "12");
    for (const ref of ["10", "11", "12"]) expect((await drafts.byCard(customer as CustomerId, ref))?.id, ref).toBe(id);
    expect((await drafts.byCard(customer as CustomerId, "13"))).toBeNull();
    expect((await db.query<{ card_ref: string; other_refs: string[] }>("select card_ref, other_refs from mq.drafts")).rows[0]).toEqual({ card_ref: "12", other_refs: ["11", "10"] });
  }, 60_000);
});
