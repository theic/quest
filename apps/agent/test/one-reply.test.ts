import { AlreadyAnswered, HostGuard, SiteLimit, type BrowserJob, type BrowserTransport, type BrowserView } from "@mq/core";
import { describe, expect, it } from "vitest";
import { CustomerBrowser } from "../src/chrome/browser.ts";
import { listPage, replySpot } from "../src/drafts/one-reply.ts";
import { handleFrom, whoseWords } from "../src/drafts/own-words.ts";
import { managerTools } from "../src/manager/tools.ts";
import { makeWorld, telegramSender } from "./world.ts";

const POST = "https://x.com/MakerOne/status/2110996449206907263";
const QUOTE = "you launched 2 product as in? 1 was B2B and other B2C and B2B performed better?";
const guard = new HostGuard({ resolve: async () => ["8.8.8.8"], unresolved: "refuse" });

async function setUp() {
  const world = makeWorld();
  const c = await world.customers.create({ channel: telegramSender().channel, userRef: "42", displayName: "Serhii Lahutin", language: "en" });
  const reply = (text: string) => world.drafts.offer(c.id, { platform: "browser", kind: "reply", url: POST, target: POST, author: "MakerOne", quote: QUOTE, text });
  return { world, c, reply };
}

describe("one reply under a post", () => {
  it("knows a post by its own id, whatever the address around it", () => {
    expect(replySpot(POST)).toBe("x.com/status/2110996449206907263");
    expect(replySpot("https://twitter.com/makerone/status/2110996449206907263?s=20")).toBe("x.com/status/2110996449206907263");
    expect(replySpot("https://mobile.x.com/i/web/status/2110996449206907263/photo/1")).toBe("x.com/status/2110996449206907263");
    expect(replySpot("https://www.reddit.com/r/SaaS/comments/abc123/x/", "t1_c1")).toBe("t1_c1");
    expect(replySpot("https://old.reddit.com/r/SaaS/comments/abc123/x/")).toBe("t3_abc123");
    expect(replySpot("https://www.linkedin.com/feed/update/urn:li:activity:1/?utm=x")).toBe("linkedin.com/feed/update/urn:li:activity:1");
    expect(replySpot("https://www.youtube.com/watch?v=3mAFTwYIzM0&t=12")).toBe("youtube.com/watch?v=3mAFTwYIzM0");
    expect(replySpot("https://youtu.be/3mAFTwYIzM0")).toBe("youtube.com/watch?v=3mAFTwYIzM0");
    expect(replySpot("https://www.youtube.com/watch?v=OtherVideo1")).not.toBe(replySpot("https://www.youtube.com/watch?v=3mAFTwYIzM0"));
    expect(replySpot("https://news.ycombinator.com/item?id=4512&utm=x")).toBe("news.ycombinator.com/item?id=4512");
  });

  it("takes a list for no post, and refuses a reply or a like there", async () => {
    for (const list of ["https://x.com/notifications/mentions", "https://www.threads.com/activity", "https://www.linkedin.com/notifications/", "https://www.linkedin.com/feed/", "https://x.com/search?q=a", "https://www.instagram.com/"]) expect(listPage(list)).toBe(true);
    for (const post of [POST, "https://www.linkedin.com/feed/update/urn:li:activity:1/", "https://www.linkedin.com/in/someone/recent-activity/all/", "https://www.threads.com/@a/post/Df1", "https://web.telegram.org/a/#-100123", "https://example.com/"]) expect(listPage(post)).toBe(false);
    const { world, c } = await setUp();
    const mentions = "https://x.com/notifications/mentions";
    expect(await world.drafts.offer(c.id, { platform: "browser", kind: "reply", url: mentions, target: mentions, author: "Md Sikandar", quote: QUOTE, text: "Jumping into fresh posts worked better" })).toMatch(/^That address is a list/);
    expect(await world.drafts.offer(c.id, { platform: "browser", kind: "like", url: mentions, target: mentions, quote: QUOTE, text: "" })).toMatch(/^That address is a list/);
  });

  it("offers no reply again where the page showed they answered by hand", async () => {
    const { world, c, reply } = await setUp();
    const first = await reply("Yeah, Voca Vela is B2C and the other one is B2B.");
    if (typeof first === "string") throw new Error(first);
    world.poster.throwNext = new AlreadyAnswered("my own answer");
    await world.drafts.act(c.id, first.draft.id, "post");
    await world.errands.stop();
    expect((await world.draftStore.get(first.draft.id))?.status).toBe("skipped");
    expect(await reply("Two of them, the B2B one got the replies.")).toMatch(/^They answered there themselves/);
  });

  it("holds a message the site turned away for the day, and sends it by itself after", async () => {
    const { world, c } = await setUp();
    const message = (to: string) => world.drafts.offer(c.id, { platform: "browser", kind: "message", url: `https://www.threads.com/@${to}`, target: to, text: "Did you write the viewer yourself?" });
    const first = await message("salocincasa");
    if (typeof first === "string") throw new Error(first);
    world.poster.throwNext = new SiteLimit("You can't send any more message requests today");
    await world.drafts.act(c.id, first.draft.id, "post");
    await world.errands.stop();
    expect((await world.draftStore.get(first.draft.id))?.status).toBe("open");
    expect(await message("someone")).toMatch(/takes no more of these today/);
    expect(await world.outbox.waiting(c.id)).toHaveLength(1);

    // A day on, it goes with no tap.
    world.clock.advance(86_400_000 + 1000);
    await world.outbox.kick();
    await world.errands.stop();
    expect((await world.draftStore.get(first.draft.id))?.status).toBe("posted");
  });

  it("never drafts a second reply where one went up, in other words or not, even when the site hides the first", async () => {
    const { world, c, reply } = await setUp();
    const first = await reply("Yeah, Voca Vela is B2C and the other one is B2B. B2B is the one that got replies.");
    if (typeof first === "string") throw new Error(first);
    await world.drafts.act(c.id, first.draft.id, "post");
    await world.errands.stop();
    expect((await world.draftStore.get(first.draft.id))?.status).toBe("posted");

    // Live, 2026-10-19: the next morning the manager opened the post, did not see the reply, and wrote another.
    const again = await reply("Yeah, two. Voca Vela is B2C, a voice tutor. The B2B one is mine too.");
    expect(again).toMatch(/^They already replied there on \d{4}-\d\d-\d\d: "Yeah, Voca Vela/);
    expect(again).toContain("One reply per post or comment, whatever the words");
    expect(world.poster.posts).toHaveLength(1);
    // Under the same post's address on twitter.com, too.
    expect(await world.drafts.offer(c.id, { platform: "browser", kind: "reply", url: "https://twitter.com/MakerOne/status/2110996449206907263?s=46", target: "@MakerOne", quote: QUOTE, text: "Third try" })).toMatch(/^They already replied there/);
  });

  it("keeps one card for a reply there, and closes the others when one goes up", async () => {
    const { world, c, reply } = await setUp();
    const card = await reply("B2B, by a mile.");
    if (typeof card === "string") throw new Error(card);
    expect(await reply("Two, and the B2B one worked.")).toBe(`their card for a reply there is still open (draft ${card.draft.id}): change its words with edit_card, never a second card.`);
    // Their own words in this turn are theirs to post: a second card they asked for.
    const theirs = await world.drafts.offer(c.id, { platform: "browser", kind: "reply", url: POST, target: POST, quote: QUOTE, text: "both, and b2b won", theirs: true });
    if (typeof theirs === "string") throw new Error(theirs);
    await world.drafts.act(c.id, theirs.draft.id, "post");
    await world.errands.stop();
    expect((await world.draftStore.get(card.draft.id))?.status).toBe("skipped");
    expect(await world.drafts.act(c.id, card.draft.id, "post")).toBe("That one is closed");
  });

  it("never sends an older card by itself where a reply already went up", async () => {
    const { world, c, reply } = await setUp();
    const card = await reply("B2B, by a mile.");
    if (typeof card === "string") throw new Error(card);
    // The reply went up from a find's card on the same post (or by their own hand, "I replied").
    const find = await world.findStore.add({ customerId: c.id, taskId: null, source: "x.com", url: POST, author: "MakerOne", title: null, quote: QUOTE, postedAt: null, why: "asks", reply: "B2B.", strength: "strong" });
    await world.findStore.markShown(find!.id, "card-1");
    await world.findStore.decide(find!.id, "replied");
    await world.trust.set(c.id, "x.com", 3);
    expect(await world.drafts.publish(c.id, card.draft.id)).toBe("You already replied there");
    expect(world.poster.posts).toHaveLength(0);
  });
});

describe("their own message is not an answer", () => {
  // A LinkedIn thread as its page reads: each message under its sender's name and time.
  const THREAD = [
    "Jordan Lee",
    "Jordan Lee sent the following message at 8:02 AM",
    "Jordan Lee 8:02 AM",
    "Привіт! Ми робимо розробку під ключ для стартапів.",
    "Serhii Lahutin sent the following message at 9:15 AM",
    "Serhii Lahutin 9:15 AM",
    "Вітаю!😊 Поки сейлзи шукають проєкти, я займався іншим інженерним челенджем, можливо, буде цікаво.",
    "Write a message…",
  ].join("\n");

  it("reads whose words a quote is from the header above it", () => {
    const mine = ["Serhii Lahutin"];
    const theirs = ["Jordan Lee"];
    expect(whoseWords("Поки сейлзи шукають проєкти, я займався іншим інженерним челенджем", THREAD, mine, theirs)).toBe("mine");
    expect(whoseWords("Ми робимо розробку під ключ для стартапів", THREAD, mine, theirs)).toBe("theirs");
    expect(whoseWords("Sounds good, send it over", "Jordan Lee\nYou: Sounds good, send it over\n2h", mine, theirs)).toBe("mine");
    // A greeting that names them is not a header: "Serhii, thanks …" is Jordan's message.
    expect(whoseWords("thanks for the note, let's talk", "Jordan Lee 10:01 AM\nSerhii, thanks for the note, let's talk on Monday about the details", mine, theirs)).toBe("theirs");
    expect(whoseWords("words nowhere on the page", THREAD, mine, theirs)).toBeNull();
    expect(handleFrom({ url: "https://x.com/home", controls: [{ ref: "p", role: "link", label: "Profile", value: null, href: "https://x.com/theIcreator" }] })).toBe("theIcreator");
  });

  it("refuses to draft an answer to a message they sent, read on the thread's page", async () => {
    const world = makeWorld();
    const c = await world.customers.create({ channel: telegramSender().channel, userRef: "42", displayName: "Serhii Lahutin", language: "en" });
    const url = "https://www.linkedin.com/messaging/thread/2-OGY3YmI4/";
    const page: BrowserTransport = { browser: async (_c: unknown, _j: BrowserJob): Promise<BrowserView> => ({ url, title: "Messaging | LinkedIn", text: THREAD, controls: [] }) };
    const tools = Object.fromEntries(managerTools({ ...world, browser: new CustomerBrowser(page, guard), customerId: c.id, userTurn: false, customers: world.customers, now: world.clock.now }).map((t) => [t.name, t]));
    await tools["browser_open"]!.invoke({ url });
    const draft = (quote: string) => tools["draft"]!.invoke({ kind: "message", url, target: "Jordan Lee", author: "Jordan Lee", quote, text: "Hey Jordan, thanks for the reply." }) as Promise<string>;
    expect(await draft("Поки сейлзи шукають проєкти, я займався іншим інженерним челенджем")).toMatch(/^Not drafted: those words are the customer's own: on https:\/\/www\.linkedin\.com\/messaging\/thread\/2-OGY3YmI4\/ they sit under their own name/);
    expect(await draft("Ми робимо розробку під ключ для стартапів")).toMatch(/^Waiting for their OK in the chat/);
  });

  it("refuses a quote from a message Quest sent for them", async () => {
    const world = makeWorld();
    const c = await world.customers.create({ channel: telegramSender().channel, userRef: "42", displayName: "Dana", language: "en" });
    const url = "https://www.linkedin.com/messaging/thread/abc/";
    const sent = await world.drafts.offer(c.id, { platform: "browser", kind: "message", url, target: "Ari Ko", text: "Hi Ari, saw your post about first customers and wanted to share what worked for us." });
    if (typeof sent === "string") throw new Error(sent);
    await world.drafts.act(c.id, sent.draft.id, "post");
    await world.errands.stop();
    expect(await world.drafts.offer(c.id, { platform: "browser", kind: "message", url, target: "Ari Ko", quote: "saw your post about first customers and wanted to share", text: "Thanks for the reply!" })).toMatch(
      /^that quote is from the customer's own message \(your message to Ari Ko on linkedin\.com, sent/,
    );
  });
});
