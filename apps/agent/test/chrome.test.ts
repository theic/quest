import { AIMessage } from "@langchain/core/messages";
import { fakeModel } from "@langchain/core/testing";
import { ChromeError, customerId, HostGuard, ReadError, SearchError, type ChromeJob, type ChromePost, type ChromeRead } from "@mq/core";
import { describe, expect, it } from "vitest";
import { ChromeBroker } from "../src/chrome/broker.ts";
import { ChromeReader } from "../src/chrome/chrome-reader.ts";
import { RedditSource, WebSource } from "../src/chrome/chrome-sources.ts";
import { threadFrom } from "../src/chrome/reddit.ts";
import { ChromeLinkService, showCode } from "../src/chrome/link-service.ts";
import { chromeRoutes } from "../src/http/chrome-routes.ts";
import { silentLogger } from "../src/infra/system.ts";
import { managerTools } from "../src/manager/tools.ts";
import { SourceRegistry } from "../src/sources/registry.ts";
import { searchTools } from "../src/tasks/search-tools.ts";
import { SeenPages } from "../src/tasks/seen-pages.ts";
import { MemoryChromeLinks } from "./fakes.ts";
import { makeWorld, telegramSender } from "./world.ts";

const C = customerId("11111111-1111-4111-8111-111111111111");
const job: ChromeJob = { url: "https://example.com/", take: { text: true } };

const page = (over: Partial<ChromeRead> = {}): ChromeRead => ({
  url: "https://example.com/",
  status: 200,
  title: "Example",
  description: null,
  text: "Example builds invoicing for freelancers, with reminders that get paid.",
  links: [],
  rows: {},
  visible: false,
  ...over,
});

const publicGuard = () => new HostGuard({ resolve: async (host) => (host.endsWith("intranet.test") ? ["10.0.0.5"] : ["93.184.216.34"]), unresolved: "refuse" });

/** A Chrome that answers each job with the next scripted read, and remembers what it was asked. */
function scripted(...reads: (ChromeRead | Error)[]) {
  const jobs: ChromeJob[] = [];
  const read = async (j: ChromeJob): Promise<ChromeRead> => {
    jobs.push(j);
    const next = reads.shift();
    if (!next) throw new Error(`no scripted read for ${j.url}`);
    if (next instanceof Error) throw next;
    return next;
  };
  return { jobs, read };
}

describe("the Chrome broker", () => {
  it("fails at once when the customer's Chrome is not connected", async () => {
    await expect(new ChromeBroker().read(C, job)).rejects.toMatchObject({ reason: "offline" });
  });

  it("hands a page to the waiting Chrome and gives back what it read", async () => {
    const broker = new ChromeBroker();
    const poll = broker.next(C, 5_000);
    const reading = broker.read(C, job);
    const issued = await poll;
    expect(issued).toMatchObject({ url: "https://example.com/" });

    expect(broker.complete(C, issued!.id, { ok: true, read: page() })).toBe(true);
    await expect(reading).resolves.toMatchObject({ title: "Example" });
    expect(broker.complete(C, issued!.id, { ok: true, read: page() })).toBe(false); // answered once only
  });

  it("queues pages until the Chrome asks again, and returns a failed read as its reason", async () => {
    const broker = new ChromeBroker();
    expect(await broker.next(C, 0)).toBeNull();
    expect(broker.online(C)).toBe(true);
    const first = broker.read(C, { ...job, url: "https://a.test/" });
    const second = broker.read(C, { ...job, url: "https://b.test/" });

    const one = await broker.next(C, 1_000);
    broker.complete(C, one!.id, { ok: false, reason: "blocked", message: "a.test refused" });
    const two = await broker.next(C, 1_000);
    expect(two).toMatchObject({ url: "https://b.test/" });
    broker.complete(C, two!.id, { ok: true, read: page({ url: "https://b.test/" }) });

    await expect(first).rejects.toMatchObject({ reason: "blocked", message: "a.test refused" });
    await expect(second).resolves.toMatchObject({ url: "https://b.test/" });
  });

  it("gives up on a page the Chrome takes but never finishes", async () => {
    const broker = new ChromeBroker({ onlineWindowMs: 45_000, jobTimeoutMs: 30, queueTimeoutMs: 1_000 });
    const poll = broker.next(C, 1_000);
    const reading = broker.read(C, job);
    await poll;
    await expect(reading).rejects.toMatchObject({ reason: "timeout" });
  });

  it("hands nothing to an ask whose request went away", async () => {
    const broker = new ChromeBroker();
    const gone = new AbortController();
    const poll = broker.next(C, 5_000, gone.signal);
    gone.abort();
    expect(await poll).toBeNull();
    const reading = broker.read(C, job); // still online: it asked a moment ago
    const next = await broker.next(C, 1_000);
    expect(next).toMatchObject({ url: job.url });
    broker.complete(C, next!.id, { ok: true, read: page() });
    await reading;
  });

  const POST: ChromePost = { platform: "reddit", url: "https://www.reddit.com/r/SaaS/comments/abc123/need_a_form_tool/", parent: "t1_c1", text: "Tally does this." };

  it("posts ahead of the pages waiting to be read, and hears where the reply went", async () => {
    const broker = new ChromeBroker();
    await broker.next(C, 0);
    const reading = broker.read(C, job);
    const posting = broker.post(C, POST);

    const first = await broker.next(C, 1_000);
    expect(first).toMatchObject({ kind: "post", post: POST });
    const posted = { url: "https://www.reddit.com/r/SaaS/comments/abc123/comment/n1/", account: "dana_builds" };
    broker.complete(C, first!.id, { ok: true, posted });
    await expect(posting).resolves.toEqual(posted);

    const second = await broker.next(C, 1_000);
    expect(second).toMatchObject({ url: job.url });
    broker.complete(C, second!.id, { ok: true, read: page() });
    await reading;
  });

  it("says why a post did not go up, and knows an extension from before posting", async () => {
    const broker = new ChromeBroker();
    await broker.next(C, 0);
    const notSignedIn = broker.post(C, POST);
    const one = await broker.next(C, 1_000);
    broker.complete(C, one!.id, { ok: false, reason: "login", message: "this Chrome is not logged in to Reddit" });
    await expect(notSignedIn).rejects.toMatchObject({ reason: "login" });

    // An older extension reads the job as a page with no address.
    const old = broker.post(C, POST);
    const two = await broker.next(C, 1_000);
    broker.complete(C, two!.id, { ok: false, reason: "invalid_url", message: "undefined is not a web address" });
    await expect(old).rejects.toMatchObject({ reason: "outdated" });

    await expect(new ChromeBroker().post(C, POST)).rejects.toMatchObject({ reason: "offline" });
  });

  it("says when a Chrome comes online, once", async () => {
    const broker = new ChromeBroker();
    const online: string[] = [];
    broker.whenOnline((id) => online.push(id));
    await broker.next(C, 0);
    await broker.next(C, 0);
    expect(online).toEqual([C]);
  });
});

describe("several tabs at once, each site at a person's pace", () => {
  /** A broker on a clock the test moves, with each site's pause fixed at its shortest. */
  function paced(pace: ConstructorParameters<typeof ChromeBroker>[2] = {}) {
    const clock = { t: 1_000_000 };
    const broker = new ChromeBroker(undefined, () => clock.t, { random: () => 0, ...pace });
    return { clock, broker };
  }
  const at = (url: string): ChromeJob => ({ url, take: { text: true } });
  const done = (broker: ChromeBroker, id: string, url: string) => broker.complete(C, id, { ok: true, read: page({ url }) });

  it("hands each poller its own job, on different sites at once, and one site one page at a time", async () => {
    const { broker } = paced();
    await broker.next(C, 0);
    const x1 = broker.read(C, at("https://x.com/a"));
    const x2 = broker.read(C, at("https://x.com/b")).catch((e: unknown) => e);
    const hn = broker.read(C, at("https://news.ycombinator.com/item?id=1"));

    const one = await broker.next(C, 50, undefined, "0");
    const two = await broker.next(C, 50, undefined, "1");
    // The second x.com page waits while the first is open; Hacker News goes beside it.
    expect([one, two].map((j) => j && "url" in j ? j.url : null)).toEqual(["https://x.com/a", "https://news.ycombinator.com/item?id=1"]);
    expect(await broker.next(C, 20, undefined, "2")).toBeNull();
    expect(broker.view(C)).toMatchObject({ tabs: 2, waiting: 1 });

    done(broker, one!.id, "https://x.com/a");
    done(broker, two!.id, "https://news.ycombinator.com/item?id=1");
    await Promise.all([x1, hn]);
    broker.drop(C);
    expect(await x2).toMatchObject({ reason: "offline" });
  });

  it("runs nothing else on the post's site or in front while it posts as them: the post's steps go once that work is done", async () => {
    const { broker } = paced({ pace: () => null });
    await broker.next(C, 0);
    const drawnRead = broker.read(C, { ...at("https://www.reddit.com/r/SaaS/"), drawn: true });
    const inFlight = await broker.next(C, 50, undefined, "0");
    const end = broker.posting(C, "post-1", "https://x.com/a/status/1");
    const search = broker.read(C, at("https://x.com/search?q=x"));
    const step = broker.browser(C, { session: "post-1", url: "https://x.com/a/status/1", action: { kind: "wait", seconds: 1 } });
    // The drawn read already at work finishes first; the search on the post's site waits.
    expect(await broker.next(C, 20, undefined, "1")).toBeNull();
    done(broker, inFlight!.id, "https://www.reddit.com/r/SaaS/");
    await drawnRead;
    const mine = await broker.next(C, 50, undefined, "1");
    expect(mine).toMatchObject({ kind: "browser", browser: { session: "post-1" } });
    // A read of another site in the background goes beside it (live, 2026-11-04: a LinkedIn reply held every read for 8 minutes).
    const hn = broker.read(C, at("https://news.ycombinator.com/item?id=1"));
    const beside = await broker.next(C, 50, undefined, "2");
    expect(beside).toMatchObject({ url: "https://news.ycombinator.com/item?id=1" });
    done(broker, beside!.id, "https://news.ycombinator.com/item?id=1");
    await hn;
    expect(await broker.next(C, 20, undefined, "2")).toBeNull();
    broker.complete(C, mine!.id, { ok: true, view: { url: "https://x.com/a/status/1", title: "", text: "", controls: [] } as never });
    await step;
    end();
    expect(await broker.next(C, 50, undefined, "2")).toMatchObject({ url: "https://x.com/search?q=x" });
    broker.drop(C);
    await search.catch(() => undefined);
  });

  it("waits a site's pause between its pages while other sites go, then hands the page out by itself", async () => {
    const { clock, broker } = paced({ pace: (host) => (host === "x.com" ? { gapMs: [40, 40], per10Min: 30 } : null) });
    await broker.next(C, 0);
    const first = broker.read(C, at("https://x.com/a"));
    const one = await broker.next(C, 50);
    done(broker, one!.id, "https://x.com/a");
    await first;

    const second = broker.read(C, at("https://x.com/b"));
    const other = broker.read(C, at("https://example.com/"));
    // x.com's pause is not over: example.com goes first.
    const two = await broker.next(C, 50);
    expect(two).toMatchObject({ url: "https://example.com/" });
    done(broker, two!.id, "https://example.com/");
    await other;

    // The poller waits; once the pause is over the line hands the page out without another ask.
    const waiting = broker.next(C, 1_000);
    clock.t += 40;
    const three = await waiting;
    expect(three).toMatchObject({ url: "https://x.com/b" });
    done(broker, three!.id, "https://x.com/b");
    await second;
  });

  it("opens at most a site's share of pages in ten minutes", async () => {
    const { clock, broker } = paced({ pace: () => ({ gapMs: [0, 0], per10Min: 2 }) });
    await broker.next(C, 0);
    for (const path of ["a", "b"]) {
      const reading = broker.read(C, at(`https://linkedin.com/${path}`));
      const j = await broker.next(C, 50);
      done(broker, j!.id, `https://linkedin.com/${path}`);
      await reading;
    }
    const third = broker.read(C, at("https://linkedin.com/c"));
    expect(await broker.next(C, 20)).toBeNull();
    clock.t += 600_001;
    const j = await broker.next(C, 50);
    expect(j).toMatchObject({ url: "https://linkedin.com/c" });
    done(broker, j!.id, "https://linkedin.com/c");
    await third;
  });

  it("lets a post go without waiting for its site's pause", async () => {
    const { broker } = paced({ pace: () => ({ gapMs: [60_000, 60_000], per10Min: 30 }) });
    await broker.next(C, 0);
    const reading = broker.read(C, at("https://www.reddit.com/r/SaaS/"));
    const j = await broker.next(C, 50);
    done(broker, j!.id, "https://www.reddit.com/r/SaaS/");
    await reading;
    const posting = broker.post(C, { platform: "reddit", url: "https://www.reddit.com/r/SaaS/comments/abc/x/", parent: "t3_abc", text: "hi" });
    const p = await broker.next(C, 50);
    expect(p).toMatchObject({ kind: "post" });
    broker.complete(C, p!.id, { ok: true, posted: { url: "https://www.reddit.com/r/SaaS/comments/abc/comment/n1/", account: "dana" } });
    await posting;
  });

  it("hands out nothing while they answer a first-day card, and everything once they did", async () => {
    let until: number | null = Number.MAX_SAFE_INTEGER;
    const { broker } = paced({ hold: { until: () => until } });
    await broker.next(C, 0);
    const reading = broker.read(C, at("https://example.com/"));
    const asking = broker.next(C, 1_000);
    await new Promise((r) => setTimeout(r, 20));
    until = null;
    broker.recheck(C);
    const j = await asking;
    expect(j).toMatchObject({ url: "https://example.com/" });
    done(broker, j!.id, "https://example.com/");
    await reading;
  });

  it("fails a page whose turn never came while their Chrome worked on, as paced, not as a closed Chrome", async () => {
    const broker = new ChromeBroker({ queueTimeoutMs: 20, turnTimeoutMs: 60 }, Date.now, { hold: { until: () => Number.MAX_SAFE_INTEGER } });
    void broker.next(C, 1_000);
    await expect(broker.read(C, at("https://example.com/"))).rejects.toMatchObject({ reason: "rate_limited", message: expect.stringContaining("answer") });
  });

  it("keeps an older extension, polling with no slot, to one job at a time", async () => {
    const { broker } = paced();
    const first = broker.next(C, 1_000);
    const second = broker.next(C, 1_000); // the same Chrome asking again: the older ask gives way
    expect(await first).toBeNull();
    const reading = broker.read(C, at("https://example.com/"));
    const j = await second;
    expect(j).toMatchObject({ url: "https://example.com/" });
    done(broker, j!.id, "https://example.com/");
    await reading;
  });
});

function linkWorld() {
  const world = makeWorld();
  const links = new MemoryChromeLinks(() => world.clock.t);
  const broker = new ChromeBroker(undefined, () => world.clock.t);
  let woke = 0;
  const service = new ChromeLinkService({
    links,
    broker,
    messenger: world.messenger,
    events: world.events,
    wakeManager: () => void woke++,
    publicUrl: "https://quest.test",
    clock: world.clock,
    log: silentLogger,
  });
  return { world, links, broker, service, woke: () => woke };
}

describe("connecting a Chrome", () => {
  it("sends the setup with a Connect link and a code, and not again for half a day unless they ask", async () => {
    const { world, service } = linkWorld();
    const c = await world.customers.create({ channel: telegramSender().channel, userRef: "42", displayName: "Dana", language: "en" });

    const out = await service.offer(c.id);
    expect(out.sent).toBe(true);
    const code = out.sent ? showCode(out.code) : "";
    const [msg] = world.channel.linkMessages;
    expect(msg?.text).toContain(code);
    expect(msg?.links.map((l) => l.url)).toEqual([`https://quest.test/connect#${code}`, "https://t.me/theicreator"]);

    const sentAt = world.clock.now();
    // Live, 2026-10-17: it went out three or four times while a newcomer answered the first-day cards.
    world.clock.advance(3 * 3_600_000);
    expect(await service.offer(c.id)).toEqual({ sent: false, why: "recent", at: sentAt });
    expect(await service.status(c.id)).toMatchObject({ linked: false, offeredAt: sentAt });
    expect((await service.offer(c.id, { force: true })).sent).toBe(true); // they asked with /connect
    world.clock.advance(13 * 3_600_000);
    expect((await service.status(c.id)).offeredAt).toBeUndefined();
    expect((await service.offer(c.id)).sent).toBe(true);
  });

  it("trades the code for a token once, tells the customer and wakes the manager", async () => {
    const { world, service, woke } = linkWorld();
    const c = await world.customers.create({ channel: telegramSender().channel, userRef: "42", displayName: "Dana", language: "en" });
    const out = await service.offer(c.id);
    const code = out.sent ? out.code : "";

    const paired = await service.pair(showCode(code).toLowerCase(), "Chrome 141 on Windows");
    expect(paired).not.toBeNull();
    expect(await service.pair(code, "Chrome 141 on Windows")).toBeNull(); // one use
    expect(world.channel.sent.at(-1)?.text).toMatch(/^Chrome connected \(Chrome 141 on Windows\)/);
    expect(world.events.events.map((e) => e.event)).toContainEqual(expect.objectContaining({ kind: "system", topic: "chrome" }));
    expect(woke()).toBe(1);

    expect((await service.authenticate(paired!.token))?.customerId).toBe(c.id);
    expect(await service.status(c.id)).toMatchObject({ linked: true, online: false, device: "Chrome 141 on Windows" });
  });

  it("sends a silent Chrome's reconnect link once in half a day, unless they ask", async () => {
    const { world, service } = linkWorld();
    const c = await world.customers.create({ channel: telegramSender().channel, userRef: "42", displayName: "Dana", language: "en" });
    const first = await service.offer(c.id);
    await service.pair(first.sent ? first.code : "", null);

    expect((await service.offer(c.id)).sent).toBe(true);
    expect(world.channel.linkMessages.at(-1)?.links.map((l) => l.label)).toEqual(["Reconnect Chrome", "Set up another Chrome", "Stuck? Write to Serhii"]);
    world.clock.advance(3 * 3_600_000);
    expect(await service.offer(c.id)).toMatchObject({ sent: false, why: "recent" });
    expect((await service.offer(c.id, { force: true })).sent).toBe(true); // they asked with /connect
    world.clock.advance(13 * 3_600_000);
    expect((await service.offer(c.id)).sent).toBe(true);
  });

  it("refuses an expired code", async () => {
    const { world, service } = linkWorld();
    const c = await world.customers.create({ channel: telegramSender().channel, userRef: "42", displayName: "Dana", language: "en" });
    const out = await service.offer(c.id);
    world.clock.advance(16 * 60_000);
    expect(await service.pair(out.sent ? out.code : "", null)).toBeNull();
  });

  it("lets one Chrome work for a customer: connecting another disconnects the first", async () => {
    const { world, service } = linkWorld();
    const c = await world.customers.create({ channel: telegramSender().channel, userRef: "42", displayName: "Dana", language: "en" });
    const pairWith = async () => {
      const out = await service.offer(c.id, { force: true });
      return (await service.pair(out.sent ? out.code : "", null))!.token;
    };
    const first = await pairWith();
    expect(await service.authenticate(first)).not.toBeNull(); // now cached
    const second = await pairWith();

    expect(await service.authenticate(first)).toBeNull();
    expect(await service.authenticate(second)).not.toBeNull();
  });

  it("disconnects when the extension says so, and tells the customer how to come back", async () => {
    const { world, service } = linkWorld();
    const c = await world.customers.create({ channel: telegramSender().channel, userRef: "42", displayName: "Dana", language: "en" });
    const out = await service.offer(c.id);
    const { token, link } = (await service.pair(out.sent ? out.code : "", null))!;

    await service.disconnect(link);

    expect(await service.authenticate(token)).toBeNull();
    expect(world.channel.sent.at(-1)?.text).toContain("send /connect");
    expect((await service.status(c.id)).linked).toBe(false);
  });

  it("tells the manager when a Chrome it held work for is open again", async () => {
    const { world, service, broker } = linkWorld();
    const c = await world.customers.create({ channel: telegramSender().channel, userRef: "42", displayName: "Dana", language: "en" });
    service.awaitOnline(c.id);

    await broker.next(c.id, 0);
    await new Promise((r) => setImmediate(r));

    expect(world.events.events.map((e) => e.event)).toContainEqual(
      expect.objectContaining({ kind: "system", topic: "chrome", text: expect.stringContaining("open again") }),
    );
  });
});

describe("a Reddit post read as a stranger", () => {
  const thread = (text: string, body: string | null) =>
    threadFrom(
      page({
        url: "https://www.reddit.com/r/SideProject/comments/1wxi0nx/voca_vela/",
        title: "Voca Vela : r/SideProject",
        text,
        rows: { post: [{ title: "Voca Vela", author: "dana", "created-timestamp": "2026-10-04T15:11:26Z", body, thing: "t3_1wxi0nx" }] },
      }),
      "https://www.reddit.com/r/SideProject/comments/1wxi0nx/voca_vela/",
    )!;

  it("tells a post taken down from a link post, and from a community's rules", () => {
    expect(thread("r/SideProject\nVoca Vela\nSorry, this post was removed by Reddit's filters.\n", null).post?.notice).toBe("Sorry, this post was removed by Reddit's filters.");
    expect(thread("Rules\n1. Posts without a description will be removed.\nVoca Vela\nvocavela.live\n", null).post?.notice).toBeNull();
    expect(thread("Voca Vela\nI built a translator.\n", "I built a translator.").post?.notice).toBeUndefined();
  });
});

describe("reading in the customer's Chrome", () => {
  it("reads a page, and says why when it cannot", async () => {
    const chrome = scripted(
      page(),
      page({ status: 403 }),
      page({ title: "Just a moment...", text: "Checking your browser" }),
      new ChromeError("offline", "the customer's Chrome is not connected"),
    );
    const reader = new ChromeReader(chrome.read, publicGuard());

    expect((await reader.readPage("https://example.com/")).text).toContain("invoicing for freelancers");
    await expect(reader.readPage("https://example.com/a")).rejects.toMatchObject({ reason: "blocked", message: expect.stringContaining("HTTP 403") });
    await expect(reader.readPage("https://example.com/b")).rejects.toMatchObject({ reason: "blocked", message: expect.stringContaining("bot check") });
    await expect(reader.readPage("https://example.com/c")).rejects.toMatchObject({ reason: "offline" });
  });

  it("never opens an address on the customer's own network", async () => {
    const chrome = scripted();
    const reader = new ChromeReader(chrome.read, publicGuard());
    await expect(reader.readPage("http://router.intranet.test/admin")).rejects.toBeInstanceOf(ReadError);
    await expect(reader.readPage("http://192.168.1.1/")).rejects.toMatchObject({ reason: "blocked" });
    expect(chrome.jobs).toHaveLength(0);
  });

  it("reads a site's first page and the pages that say what it sells", async () => {
    const chrome = scripted(
      page({ links: [{ href: "https://example.com/pricing", text: "Pricing" }, { href: "https://example.com/terms", text: "Terms" }] }),
      page({ url: "https://example.com/pricing", title: "Pricing", text: "Free for one client, $9 a month after." }),
    );
    const site = await new ChromeReader(chrome.read, publicGuard()).readSite("https://example.com/");
    expect(site.pages.map((p) => p.url)).toEqual(["https://example.com/", "https://example.com/pricing"]);
    expect(chrome.jobs[0]?.take).toEqual({ text: true, links: true });
  });

  it("reads a Reddit thread as a post with its author and date, and its comments, each with the id a reply goes under", async () => {
    const chrome = scripted(
      page({
        url: "https://www.reddit.com/r/SaaS/comments/abc123/need_a_form_tool/?solution=x&js_challenge=1",
        rows: {
          post: [
            {
              author: "dana_builds",
              at: "2026-09-20T10:00:00.735000+0000",
              title: "Need a form tool that isn't Typeform",
              body: "Looking for a cheaper Typeform alternative for my waitlist.",
              community: "r/SaaS",
              thing: "t3_abc123",
            },
          ],
          comments: [
            { author: "sam", at: "2026-09-21T08:00:00.000Z", body: "Tally works for me.", thing: "t1_c1" },
            // No id attribute: the comment's own address has it.
            { author: "lee", at: "2026-09-22T08:00:00.000Z", body: "Same question here.", permalink: "/r/SaaS/comments/abc123/comment/c2/", parent: "t1_c1" },
            { author: "kim", at: "2026-09-22T09:00:00.000Z", body: "No idea." },
            // Removed by a moderator: kept in place as "[deleted]" with no words.
            { author: "[deleted]", thing: "t1_c9" },
          ],
        },
      }),
    );
    const got = await new ChromeReader(chrome.read, publicGuard()).readPage("https://www.reddit.com/r/SaaS/comments/abc123/need_a_form_tool/");

    expect(chrome.jobs[0]).toMatchObject({ url: "https://www.reddit.com/r/SaaS/comments/abc123/need_a_form_tool/", waitFor: "shreddit-post" });
    expect(chrome.jobs[0]?.drawn).toBeUndefined(); // tried off screen first
    expect(got.url).toBe("https://www.reddit.com/r/SaaS/comments/abc123/need_a_form_tool/");
    expect(got.post).toEqual({
      source: "reddit:r/SaaS",
      author: "dana_builds",
      title: "Need a form tool that isn't Typeform",
      postedAt: new Date("2026-09-20T10:00:00.735Z"),
      ref: "t3_abc123",
    });
    expect(got.comments?.map((c) => c.ref)).toEqual(["t1_c1", "t1_c2", null]);
    expect(got.comments?.map((c) => c.parentRef)).toEqual([null, "t1_c1", null]); // lee answered sam
    expect(got.gone).toEqual(["t1_c9"]);
    expect(got.text).toContain("Looking for a cheaper Typeform alternative for my waitlist.");
    expect(got.text).toContain("u/sam (2026-09-21): Tally works for me.");
  });

  it("reads a thread again on screen when nothing rendered off screen", async () => {
    const chrome = scripted(
      page({ url: "https://www.reddit.com/r/SaaS/comments/abc123/x/", rows: { post: [], comments: [] }, visible: false }),
      page({ url: "https://www.reddit.com/r/SaaS/comments/abc123/x/", rows: { post: [{ author: "dana", title: "Help", body: "Need a form tool", at: "2026-09-20T10:00:00.000Z" }] }, visible: true }),
    );
    const got = await new ChromeReader(chrome.read, publicGuard()).readPage("https://www.reddit.com/r/SaaS/comments/abc123/x/");
    expect(chrome.jobs[1]).toMatchObject({ drawn: true, url: "https://www.reddit.com/r/SaaS/comments/abc123/x/" });
    expect(got.post?.author).toBe("dana");
  });

  it("takes Reddit's CAPTCHA as a refusal, and never reads again on screen for it", async () => {
    const chrome = scripted(page({ url: "https://www.reddit.com/r/SaaS/comments/abc123/x/", title: "Reddit - Prove your humanity", text: "Complete the challenge below", visible: false }));
    await expect(new ChromeReader(chrome.read, publicGuard()).readPage("https://www.reddit.com/r/SaaS/comments/abc123/x/")).rejects.toMatchObject({ reason: "blocked" });
    expect(chrome.jobs).toHaveLength(1);
  });
});

describe("searching in the customer's Chrome", () => {
  it("searches inside one subreddit by relevance in the window, and returns results still to read", async () => {
    const chrome = scripted(
      page({
        url: "https://www.reddit.com/r/SaaS/search/?solution=x&js_challenge=1&q=typeform",
        rows: {
          search: [
            {
              href: "https://www.reddit.com/r/SaaS/comments/abc123/need_a_form_tool/",
              title: "Need a form tool",
              at: "2026-09-20T10:00:00.000Z",
              counts: "20 votes·12 comments",
            },
          ],
          posts: [],
        },
      }),
    );
    const posts = await new RedditSource(chrome.read).search({ source: "reddit", query: "typeform alternative", site: "r/SaaS", within: "month" }, 10);

    expect(chrome.jobs[0]?.url).toBe("https://www.reddit.com/r/SaaS/search/?q=typeform%20alternative&type=posts&restrict_sr=1&sort=relevance&t=month");
    expect(posts).toEqual([
      {
        source: "reddit:r/SaaS",
        url: "https://www.reddit.com/r/SaaS/comments/abc123/need_a_form_tool/",
        author: null,
        title: "Need a form tool",
        text: "",
        postedAt: new Date("2026-09-20T10:00:00Z"),
        replies: 12,
        preview: true,
      },
    ]);
  });

  it("takes a subreddit's name only, Reddit's 'no results' as none, and its refusal as final", async () => {
    await expect(new RedditSource(scripted().read).search({ source: "reddit", query: "x", site: "https://evil.test" }, 5)).rejects.toMatchObject({
      reason: "bad_query",
    });
    const none = scripted(page({ text: "Hm... we couldn’t find any results for “x”", rows: { search: [], posts: [] } }));
    expect(await new RedditSource(none.read).search({ source: "reddit", query: "x" }, 5)).toEqual([]);
    expect(none.jobs).toHaveLength(1); // no second read on screen for an honest "nothing"
    const refused = scripted(page({ title: "Reddit - Prove your humanity", text: "Complete the challenge below and let us know you're a real person." }));
    await expect(new RedditSource(refused.read).search({ source: "reddit", query: "x" }, 5)).rejects.toMatchObject({ reason: "refused" });
  });

  it("searches the web on DuckDuckGo and returns results as pages still to read", async () => {
    const chrome = scripted(
      page({
        url: "https://html.duckduckgo.com/html/?q=x",
        rows: {
          results: [
            { title: "Ad", href: "https://duckduckgo.com/y.js?ad=1", snippet: "Buy", kind: "result results_links result--ad" },
            {
              title: "Typeform alternative? - Indie Hackers",
              href: "//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.indiehackers.com%2Fpost%2Fform-tool&rut=abc",
              snippet: "I need a form tool that...",
              kind: "result results_links",
            },
          ],
        },
      }),
    );
    const posts = await new WebSource(chrome.read).search({ source: "web", query: "typeform alternative", within: "month" }, 10);

    expect(chrome.jobs[0]?.url).toBe("https://html.duckduckgo.com/html/?q=typeform%20alternative&df=m");
    expect(posts).toEqual([
      { source: "web", url: "https://www.indiehackers.com/post/form-tool", author: null, title: "Typeform alternative? - Indie Hackers", text: "I need a form tool that...", postedAt: null, replies: null, preview: true },
    ]);
    const check = scripted(page({ title: "DuckDuckGo", text: "Unfortunately, bots use DuckDuckGo too." }));
    await expect(new WebSource(check.read).search({ source: "web", query: "x" }, 5)).rejects.toBeInstanceOf(SearchError);
  });

  it("keeps a web result out of what can be saved until it has been read", async () => {
    const chrome = scripted(
      page({ rows: { results: [{ title: "A thread", href: "https://forum.test/t/1", snippet: "Anyone know a Typeform alternative for waitlists?", kind: "result" }] } }),
    );
    const seen = new SeenPages();
    const [search] = searchTools(new SourceRegistry([new WebSource(chrome.read)]), { seen });

    const out = String(await search!.invoke({ source: "web", query: "typeform alternative" }));

    expect(out).toContain("read_page it before you judge or save it");
    expect(seen.get("https://forum.test/t/1")).toBeUndefined();
  });
});

describe("the extension's side of the agent", () => {
  async function api() {
    const { world, broker, service } = linkWorld();
    const c = await world.customers.create({ channel: telegramSender().channel, userRef: "42", displayName: "Dana", language: "en" });
    const out = await service.offer(c.id);
    const app = chromeRoutes({ links: service, broker, log: silentLogger });
    return { c, app, broker, code: out.sent ? showCode(out.code) : "" };
  }

  /** The API with a Chrome already connected: the headers it sends. */
  async function connected() {
    const a = await api();
    const paired = await a.app.request("/chrome/pair", { method: "POST", body: JSON.stringify({ code: a.code, device: "Chrome 141 on Windows" }) });
    const { token } = (await paired.json()) as { token: string };
    const auth = { authorization: `Bearer ${token}` };
    await a.app.request("/chrome/next?wait=0", { headers: auth }); // asking for work once is what makes a Chrome count as online
    return { ...a, auth };
  }

  it("tells the extension how many tabs to work in and whether its tab may come to the front, and hands each slot its own job", async () => {
    const { world, broker, service } = linkWorld();
    const c = await world.customers.create({ channel: telegramSender().channel, userRef: "42", displayName: "Dana", language: "en" });
    const out = await service.offer(c.id);
    let front = true;
    const app = chromeRoutes({ links: service, broker, log: silentLogger, tabs: 3, front: async () => front, now: () => world.clock.t });
    const paired = await app.request("/chrome/pair", { method: "POST", body: JSON.stringify({ code: out.sent ? showCode(out.code) : "", device: "Chrome 141 on Windows" }) });
    const auth = { authorization: `Bearer ${((await paired.json()) as { token: string }).token}` };

    const idle = await app.request("/chrome/next?wait=0&slot=0", { headers: auth });
    expect(idle.status).toBe(204);
    expect(idle.headers.get("x-mq-tabs")).toBe("3");
    expect(idle.headers.get("x-mq-front")).toBeNull();

    const a = broker.read(c.id, { url: "https://example.com/", take: { text: true } });
    const b = broker.read(c.id, { url: "https://news.ycombinator.com/", take: { text: true } });
    const [one, two] = await Promise.all([app.request("/chrome/next?wait=1&slot=0", { headers: auth }), app.request("/chrome/next?wait=1&slot=1", { headers: auth })]);
    const urls = [((await one.json()) as { url: string }).url, ((await two.json()) as { url: string }).url].sort();
    expect(urls).toEqual(["https://example.com/", "https://news.ycombinator.com/"]);
    broker.drop(c.id);
    await Promise.allSettled([a, b]);

    // Their switch, off on their page: the next ask past the 15 s it is kept says so.
    front = false;
    world.clock.advance(16_000);
    const off = await app.request("/chrome/next?wait=0&slot=0", { headers: auth });
    expect(off.headers.get("x-mq-front")).toBe("off");
  });

  it("serves the connect page, pairs with a code, and hands out pages to read", async () => {
    const { c, app, broker, code } = await api();
    expect(await (await app.request("/connect")).text()).toContain("Connect your Chrome <em>to Quest.</em>");

    const paired = await app.request("/chrome/pair", { method: "POST", body: JSON.stringify({ code, device: "Chrome 141 on Windows" }) });
    expect(paired.status).toBe(200);
    const { token } = (await paired.json()) as { token: string };
    const auth = { authorization: `Bearer ${token}` };

    expect((await app.request("/chrome/next?wait=0", { headers: auth })).status).toBe(204);
    const reading = broker.read(c.id, job);
    const next = await app.request("/chrome/next?wait=5", { headers: auth });
    const issued = (await next.json()) as { id: string; url: string };
    expect(issued.url).toBe(job.url);

    const done = await app.request(`/chrome/jobs/${issued.id}`, { method: "POST", headers: auth, body: JSON.stringify({ ok: true, read: page() }) });
    expect(done.status).toBe(204);
    await expect(reading).resolves.toMatchObject({ title: "Example" });
  });

  it("keeps a browser page whose link is longer than the limit, with the link cut", async () => {
    const a = await connected();
    const viewing = a.broker.browser(a.c.id, { session: "s1", url: "https://mail.example.org/inbox", action: { kind: "snapshot" } });
    const issued = (await (await a.app.request("/chrome/next?wait=5", { headers: a.auth })).json()) as { id: string };
    const control = (ref: string, href: string) => ({ ref, role: "a", label: "Offer", value: null, href });
    const view = { url: "https://mail.example.org/inbox", title: "Inbox", text: "Two links", controls: [control("0:r:1", "https://t.example.org/?x=" + "a".repeat(6000)), control("0:r:2", "https://example.org/ok")] };
    const done = await a.app.request(`/chrome/jobs/${issued.id}`, { method: "POST", headers: a.auth, body: JSON.stringify({ ok: true, view }) });
    expect(done.status).toBe(204);
    const seen = await viewing;
    expect(seen.controls.map((c) => c.href?.length)).toEqual([4000, "https://example.org/ok".length]);
    expect(seen.controls[0]?.href?.startsWith("https://t.example.org/?x=")).toBe(true);
  });

  it("turns away a code it does not know and a token it never gave", async () => {
    const { app } = await api();
    expect((await app.request("/chrome/pair", { method: "POST", body: JSON.stringify({ code: "AAAA-BBBB" }) })).status).toBe(400);
    expect((await app.request("/chrome/next?wait=0", { headers: { authorization: "Bearer nope" } })).status).toBe(401);
  });
});

describe("the manager and the customer's Chrome", () => {
  it("does not start reading work without a connected Chrome, and sends the setup instead", async () => {
    const world = makeWorld();
    const c = await world.customers.create({ channel: telegramSender().channel, userRef: "42", displayName: "Dana", language: "en" });
    world.chrome.state = { linked: false, online: false, device: null, lastSeenAt: null };
    let told = 0;
    const tools = Object.fromEntries(
      managerTools({ ...world, customerId: c.id, userTurn: true, now: world.clock.now, onTold: () => void told++ }).map((t) => [t.name, t]),
    );

    const refused = String(await tools["start_task"]!.invoke({ agent: "researcher", title: "Read the site", instructions: "Read https://acme.test and report." }));
    expect(refused).toMatch(/^Not started: your team reads and searches the web in the customer's own Chrome/);
    expect(await world.tasks.list(c.id)).toHaveLength(0);

    expect(String(await tools["connect_chrome"]!.invoke({}))).toMatch(/^Sent|^Queued/);
    expect(world.chrome.offers).toEqual([{ customerId: c.id, force: false }]);
    expect(told).toBe(1);
  });

  it("knows when the setup went out, and does not send it again", async () => {
    const world = makeWorld();
    const c = await world.customers.create({ channel: telegramSender().channel, userRef: "42", displayName: "Dana", language: "en" });
    await world.customers.update(c.id, { sweptAt: new Date(world.clock.t) });
    world.chrome.state = { linked: false, online: false, device: null, lastSeenAt: null, offeredAt: new Date(world.clock.t - 20 * 60_000) };
    const tools = Object.fromEntries(managerTools({ ...world, customerId: c.id, userTurn: true, now: world.clock.now }).map((t) => [t.name, t]));

    const refused = String(await tools["start_task"]!.invoke({ agent: "scout", title: "Find people", instructions: "Find people asking for this." }));
    expect(refused).toContain("You sent them the setup 20 min ago: do not send it again.");
    expect(refused).not.toContain("Send them the setup");
    expect(String(await tools["connect_chrome"]!.invoke({}))).toMatch(/^Not sent: it went out 20 min ago and is still in their chat/);
  });

  it("holds work for a connected Chrome that is closed, and asks to hear when it is back", async () => {
    const world = makeWorld();
    const c = await world.customers.create({ channel: telegramSender().channel, userRef: "42", displayName: "Dana", language: "en" });
    await world.customers.update(c.id, { sweptAt: new Date(world.clock.t) });
    world.chrome.state = { linked: true, online: false, device: "Chrome 141 on Windows", lastSeenAt: new Date(world.clock.t - 3 * 3_600_000) };
    const [start] = managerTools({ ...world, customerId: c.id, userTurn: true, now: world.clock.now }).filter((t) => t.name === "start_task");

    const out = String(await start!.invoke({ agent: "scout", title: "Find people", instructions: "Find people asking for this." }));

    expect(out).toContain("is connected, but silent (last heard from 3 h ago)");
    expect(world.chrome.awaited).toEqual([c.id]);
  });

  it("sees how the Chrome stands at the start of every turn", async () => {
    const manager = fakeModel().respond(new AIMessage("What's your website?"));
    const world = makeWorld({ manager });
    world.chrome.state = { linked: false, online: false, device: null, lastSeenAt: null };
    await world.inbound.handle({ type: "text", from: telegramSender(), text: "hi", messageRef: "1", replyToRef: null });

    await world.manager.serveNext();

    expect(String(manager.calls[0]!.messages.at(-1)!.content)).toContain("Their Chrome: not connected.");
  });

  it("is told the setup already went out, so it neither sends it again nor brings it up", async () => {
    const manager = fakeModel().respond(new AIMessage("On it."));
    const world = makeWorld({ manager });
    world.chrome.state = { linked: false, online: false, device: null, lastSeenAt: null, offeredAt: new Date(world.clock.t - 7 * 60_000) };
    await world.inbound.handle({ type: "text", from: telegramSender(), text: "my site is acme.test", messageRef: "1", replyToRef: null });

    await world.manager.serveNext();

    const briefing = String(manager.calls[0]!.messages.at(-1)!.content);
    expect(briefing).toContain("Their Chrome: not connected. You sent the setup 7 min ago and it is still in their chat");
    expect(briefing).toContain("Do not send it again or remind them of it");
  });

  it("sends a fresh setup on /connect without bothering the manager", async () => {
    const world = makeWorld();
    await world.inbound.handle({ type: "command", from: telegramSender(), command: "connect", args: "", messageRef: "1" });
    expect(world.chrome.offers).toEqual([expect.objectContaining({ force: true })]);
    expect(world.events.events).toHaveLength(0);
  });
});
