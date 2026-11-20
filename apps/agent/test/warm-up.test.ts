import { describe, expect, it } from "vitest";
import { productNames, promotes, WARM_UP } from "../src/drafts/warm-up.ts";
import { writingPrompt } from "../src/drafts/writer.ts";
import { makeWorld, telegramSender } from "./world.ts";

// Each card its own message (`cards`), as before Your move (asks/deck.ts): cards already in a chat still work so.

async function setUp() {
  const world = makeWorld({}, { cards: true });
  const c = await world.customers.create({ channel: telegramSender().channel, userRef: "42", displayName: "Serhii", language: "en" });
  await world.customers.update(c.id, { siteUrl: "https://messaging.quest/" });
  let n = 0;
  const reply = (text: string, author = "MakerTwo", quote = "thinking about investing in early stage startups") => {
    const url = `https://x.com/${author}/status/${++n}`;
    return world.drafts.offer(c.id, { platform: "browser", kind: "reply", url, target: url, author, quote, text });
  };
  /** Something plain going up on x.com from their account: a like on someone's post. */
  const warm = async (times: number) => {
    for (let i = 0; i < times; i++) {
      const url = `https://x.com/someone${i}/status/9${i}`;
      const like = await world.drafts.offer(c.id, { platform: "browser", kind: "like", url, target: `@someone${i}`, quote: "a post", text: "" });
      if (typeof like === "string") throw new Error(like);
      await world.drafts.act(c.id, like.draft.id, "post");
    }
    await world.errands.stop();
  };
  return { world, c, reply, warm };
}

describe("the product comes last", () => {
  it("knows the names a product goes by from its site, and words that promote it", () => {
    expect(productNames("https://messaging.quest/")).toEqual(["messaging.quest", "messaging quest", "messagingquest"]);
    expect(productNames("tally.so")).toEqual(["tally.so", "tally"]);
    expect(productNames("https://www.get-form.io/pricing")).toEqual(["get-form.io", "get form", "getform"]);
    const names = productNames("https://messaging.quest/");
    expect(promotes("I'm raising a small SAFE for Messaging Quest, so I'm biased", names)).toBe(true);
    expect(promotes("I built messaging.quest for this", names)).toBe(true);
    expect(promotes("see acme.io/pricing", names)).toBe(true);
    expect(promotes("Messaging people one by one beats a blast. Back one founder you can help.", names)).toBe(false);
  });

  it("keeps the first things on a platform plain: no product, no link", async () => {
    const { reply } = await setUp();
    // Live, 2026-10-19: the first replies on X named the product and the SAFE, to strangers.
    expect(await reply("Do it, but back one founder you can help. I'm raising a $10k SAFE for Messaging Quest, so I'm biased.")).toMatch(
      new RegExp(`^their account has put up only 0 of the first ${WARM_UP} things on this platform`),
    );
    const plain = await reply("Do it, but back one founder you can actually help instead of a spread.");
    expect(typeof plain === "string" ? plain : plain.draft.status).toBe("open");
  });

  it("names the product only to someone who asks for it, and then only now and then", async () => {
    const { world, c, reply, warm } = await setUp();
    await warm(WARM_UP);
    expect(await reply("I built Messaging Quest for exactly this.")).toMatch(/^@MakerTwo did not ask for it: the product's name and its link go only to someone who asks/);
    const pitch = await reply("I built Messaging Quest for this, happy to show you.", "MakerTwo", "nice, what do you use to find them?");
    if (typeof pitch === "string") throw new Error(pitch);
    await world.drafts.act(c.id, pitch.draft.id, "post");
    await world.errands.stop();
    // One in five at most: after a pitch, plain ones come first again.
    expect(await reply("And messaging.quest has a free plan.", "MakerTwo", "link?")).toMatch(/^1 of the last 6 things that went up here already named the product or carried a link/);
  });

  it("never posts a find's reply by itself while it still names the product too soon", async () => {
    // Live on the dev bot, 2026-10-21: every find card opened "I make Messaging Quest" to people who never heard of it.
    const { world, c } = await setUp();
    await world.trust.set(c.id, "reddit", 3);
    const find = (n: number, reply: string) =>
      world.findStore.add({ customerId: c.id, taskId: null, source: "reddit:r/buildinpublic", url: `https://www.reddit.com/r/buildinpublic/comments/x${n}/market_it/`, author: `maker${n}`, title: "How do you market it?", quote: "How do you market a startup on Reddit without spamming?", postedAt: null, why: "asks", reply, strength: "strong", replyTo: `t3_x${n}` });
    await find(1, "Answer people who already asked for something like yours. I make Messaging Quest, which does some of that.");
    await find(2, "Answer people who already asked for something like yours, and read the rules first.");
    await world.finds.show(c.id, 2);
    await world.errands.stop();
    expect(world.channel.cards.filter((card) => !card.redraw)).toHaveLength(2);
    // The plain one went up by itself; the one naming the product waits on its card for their tap.
    expect(world.poster.posts.map((p) => (p.post as { text: string }).text)).toEqual(["Answer people who already asked for something like yours, and read the rules first."]);
  });

  it("asks the writer for plain words when the product can't come up yet", () => {
    const prompt = writingPrompt({ kind: "reply", platform: "x.com", place: null, author: "@MakerTwo", quote: "investing?", draft: "Do it. I made Messaging Quest.", title: null, plain: true });
    expect(prompt).toContain("This one only warms things up: it names no product");
    expect(writingPrompt({ kind: "reply", platform: "x.com", place: null, author: null, quote: null, draft: "x", title: null })).not.toContain("warms things up");
  });
});
