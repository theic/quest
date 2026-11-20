// @vitest-environment happy-dom
// @vitest-environment-options {"url": "https://www.reddit.com/r/SaaS/search/?q=typeform"}
import { afterEach, describe, expect, it, vi } from "vitest";
import { postsFrom, searchJob, threadFrom, threadJob } from "../../agent/src/chrome/reddit.ts";
import { Outcome } from "../../agent/src/http/chrome-outcome.ts";
import { keepsAwake, syncAwake } from "../src/awake.js";
import { isPrivateIp, privateFrame, refuseUrl } from "../src/guard.js";
import { commentUrl, redditForm, redditPost } from "../src/post-reply.js";
import { DEFAULT_SERVER, DEV_SERVER, LOCAL_SERVER, pairingServer, refusal, unpacked } from "../src/quest-server.js";
import { probePage, readPage } from "../src/read-page.js";

/** A result on Reddit's search page, with the test ids measured on 2026-09-27 (markup trimmed). */
const REDDIT_SEARCH = `
<search-telemetry-tracker>
  <div data-testid="search-post-unit">
    <div data-testid="sdui-post-unit">
      <a data-testid="post-title" href="/r/SaaS/comments/abc123/need_a_form_tool/"><span data-testid="post-title-text">Need a form tool that isn't Typeform</span></a>
      <span>r/SaaS · <faceplate-timeago ts="2026-09-20T10:00:00.000Z"><time datetime="2026-09-20T10:00:00.000Z">7d ago</time></faceplate-timeago></span>
      <div data-testid="search-counter-row">20 votes·12 comments</div>
    </div>
  </div>
</search-telemetry-tracker>`;

/** A thread: the post and a comment as custom elements with their attributes (measured 2026-09-27). */
const REDDIT_THREAD = `
<shreddit-post author="dana_builds" created-timestamp="2026-09-20T10:00:00.735000+0000" post-title="Need a form tool that isn't Typeform"
  permalink="/r/SaaS/comments/abc123/need_a_form_tool/" comment-count="1" subreddit-prefixed-name="r/SaaS">
  <div slot="text-body"><p>Looking for a cheaper Typeform alternative for my waitlist.</p></div>
</shreddit-post>
<shreddit-comment author="sam" permalink="/r/SaaS/comments/abc123/comment/c1/">
  <time datetime="2026-09-21T08:00:00.000Z">6d ago</time>
  <div slot="comment"><p>Tally works for me.</p></div>
</shreddit-comment>`;

describe("reading a page in Quest's tab", () => {
  it("takes rows by the agent's own specs, and the agent reads them into posts", () => {
    document.title = "typeform - Reddit Search!";
    document.body.innerHTML = REDDIT_SEARCH;
    const job = searchJob("https://www.reddit.com/r/SaaS/search/?q=typeform");

    const read = readPage(job.take);

    expect(read.rows.search).toEqual([
      {
        href: "https://www.reddit.com/r/SaaS/comments/abc123/need_a_form_tool/",
        title: "Need a form tool that isn't Typeform",
        at: "2026-09-20T10:00:00.000Z",
        counts: "20 votes·12 comments",
      },
    ]);
    const [post] = postsFrom({ ...read, status: 200, visible: true }, 10);
    expect(post).toMatchObject({ source: "reddit:r/SaaS", url: "https://www.reddit.com/r/SaaS/comments/abc123/need_a_form_tool/", replies: 12, preview: true });
  });

  it("reads a thread's post and comments by the agent's specs", () => {
    document.body.innerHTML = REDDIT_THREAD;
    const url = new URL("https://www.reddit.com/r/SaaS/comments/abc123/need_a_form_tool/");

    const read = readPage(threadJob(url).take);
    const page = threadFrom({ ...read, status: 200, visible: true }, url.href);

    expect(page?.post).toEqual({
      source: "reddit:r/SaaS",
      author: "dana_builds",
      title: "Need a form tool that isn't Typeform",
      postedAt: new Date("2026-09-20T10:00:00.735Z"),
      ref: "t3_abc123", // from the address, when the element has no id
    });
    expect(page?.comments?.[0]?.ref).toBe("t1_c1");
    expect(page?.text).toContain("Looking for a cheaper Typeform alternative for my waitlist.");
    expect(page?.text).toContain("u/sam (2026-09-21): Tally works for me.");
  });

  it("looks inside shadow roots, where new Reddit keeps its posts", () => {
    document.body.innerHTML = "";
    const host = document.createElement("div");
    document.body.append(host);
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<article class="post" data-author="sam"><h3>Any form builder with logic jumps?</h3></article>`;

    const read = readPage({ specs: { posts: { items: "article.post", fields: { author: "attr:data-author", title: "text:h3" } } } });

    expect(read.rows.posts).toEqual([{ author: "sam", title: "Any form builder with logic jumps?" }]);
    expect(probePage("article.post").found).toBe(true);
    expect(probePage("article.missing").found).toBe(false);
  });

  it("gives the page's text, description and links", () => {
    document.head.innerHTML = `<meta name="description" content="Forms for makers">`;
    document.body.innerHTML = `<main><h1>Tally</h1><p>Make forms   for free.</p><a href="/pricing">Pricing</a></main>`;

    const read = readPage({ text: true, links: true });

    expect(read.description).toBe("Forms for makers");
    expect(read.text).toContain("Make forms for free.");
    expect(read.links).toEqual([{ href: "https://www.reddit.com/pricing", text: "Pricing" }]);
  });

  it("answers within what the agent accepts on a page with an overlong title, description and links", () => {
    // The agent refuses a whole read when one field is over its limit, so these pages could never be read.
    const long = "x".repeat(5000);
    document.head.innerHTML = `<meta name="description" content="About ${long}">`;
    document.title = `Title ${long}`;
    document.body.innerHTML = `<a href="/ok">Fine</a><a href="/t?q=${long}">Tracked</a><a href="data:text/plain,${long}">Data</a>`;

    const read = readPage({ text: true, links: true });

    expect(read.title).toHaveLength(1000);
    expect(read.description).toHaveLength(2000);
    expect(read.links).toEqual([{ href: "https://www.reddit.com/ok", text: "Fine" }]); // a link cut short leads nowhere
    expect(Outcome.safeParse({ ok: true, read: { ...read, status: 200, visible: true } }).success).toBe(true);
  });
});

describe("which Quest this Chrome connects to", () => {
  it("connects a store install only to Quest's own address, whatever a page or the popup says", () => {
    const store = { development: false };
    expect(pairingServer({ ...store, origin: DEFAULT_SERVER })).toBe(DEFAULT_SERVER);
    expect(pairingServer(store)).toBe(DEFAULT_SERVER);
    expect(pairingServer({ ...store, asked: "https://elsewhere.example" })).toBe(DEFAULT_SERVER); // its popup shows no address field
    expect(pairingServer({ ...store, origin: "http://localhost:8080" })).toBeNull();
    expect(pairingServer({ ...store, origin: "https://elsewhere.example" })).toBeNull();
    // The local edition on this computer, its own connect page or the panel's hello.
    expect(pairingServer({ ...store, origin: LOCAL_SERVER })).toBe(LOCAL_SERVER);
    expect(pairingServer({ ...store, asked: LOCAL_SERVER })).toBe(LOCAL_SERVER);
    expect(pairingServer({ ...store, origin: "http://localhost:8788" })).toBeNull();
  });

  it("lets an unpacked build connect to a dev agent, on this computer by default", () => {
    const dev = { development: true };
    expect(pairingServer({ ...dev, origin: "http://localhost:8080" })).toBe("http://localhost:8080");
    expect(pairingServer({ ...dev, asked: " http://127.0.0.1:8790/ " })).toBe("http://127.0.0.1:8790");
    expect(pairingServer({ ...dev, asked: "https://tunnel.example" })).toBe("https://tunnel.example");
    expect(pairingServer({ ...dev, asked: "" })).toBe(DEV_SERVER);
    expect(pairingServer(dev)).toBe(DEV_SERVER);
    expect(pairingServer({ ...dev, asked: "javascript:alert(1)" })).toBeNull();
    expect(pairingServer({ ...dev, asked: "https://agent.example/some/path" })).toBeNull();
    expect(refusal({ ...dev, asked: "javascript:alert(1)" })).toBe("That is not a Quest address.");
  });

  it("never connects an unpacked build to production, which runs the published extension only", () => {
    const dev = { development: true };
    expect(pairingServer({ ...dev, origin: DEFAULT_SERVER })).toBeNull();
    expect(pairingServer({ ...dev, asked: `${DEFAULT_SERVER}/` })).toBeNull();
    expect(refusal({ ...dev, origin: DEFAULT_SERVER })).toMatch(/dev extension.*never to Quest's own/);
    expect(refusal({ development: false, origin: "http://localhost:8080" })).toBe(`This Chrome connects only to Quest at ${new URL(DEFAULT_SERVER).host}, or to Quest on this computer (${new URL(LOCAL_SERVER).host}).`);
  });

  it("counts only an unpacked install as a developer's", async () => {
    expect(await unpacked({ getSelf: async () => ({ installType: "development" }) })).toBe(true);
    for (const installType of ["normal", "sideload", "admin", "other"]) expect(await unpacked({ getSelf: async () => ({ installType }) }), installType).toBe(false);
    expect(await unpacked({ getSelf: async () => Promise.reject(new Error("not allowed")) })).toBe(false);
    expect(await unpacked(undefined)).toBe(false);
  });

  it("treats a release loaded unpacked, the zip messaging.quest offers, as a customer's install", async () => {
    expect(await unpacked({ getSelf: async () => ({ installType: "development" }) }, true)).toBe(false);
  });
});

describe("where Quest's tabs may go", () => {
  it("opens public web pages only", () => {
    expect(refuseUrl("https://www.reddit.com/r/SaaS/")).toBeNull();
    expect(refuseUrl("http://localhost:8080/")).toMatchObject({ reason: "blocked" });
    expect(refuseUrl("http://192.168.1.1/")).toMatchObject({ reason: "blocked" });
    expect(refuseUrl("http://router.lan/")).toMatchObject({ reason: "blocked" });
    expect(refuseUrl("http://nas/")).toMatchObject({ reason: "blocked" });
    expect(refuseUrl("file:///C:/Users/")).toMatchObject({ reason: "invalid_url" });
    expect(refuseUrl("https://user:pw@example.com/")).toMatchObject({ reason: "invalid_url" });
  });

  it("knows a private address when Chrome reports where a page came from", () => {
    for (const ip of ["10.0.0.1", "172.16.5.4", "192.168.0.10", "127.0.0.1", "169.254.169.254", "::1", "fd00::1"]) expect(isPrivateIp(ip), ip).toBe(true);
    for (const ip of ["93.184.216.34", "151.101.1.140", "2606:4700::1111"]) expect(isPrivateIp(ip), ip).toBe(false);
  });

  it("pictures a page with empty or inline frames, never one that frames a private address", () => {
    // Habr's article pages (2026-10-13): four about:blank frames beside the page.
    for (const url of ["about:blank", "about:srcdoc", "data:text/html,hi", "blob:https://habr.com/0b1c", "https://www.youtube.com/embed/x"]) expect(privateFrame(url), url).toBe(false);
    for (const url of ["http://192.168.1.1/admin", "http://localhost:3000/", "http://router.lan/", "https://user:pw@example.com/"]) expect(privateFrame(url), url).toBe(true);
  });
});

describe("keeping the computer awake", () => {
  it("is on by default while connected, off once they turn it off, and never while disconnected", () => {
    expect(keepsAwake({ connected: true, awake: undefined })).toBe(true); // never touched the switch
    expect(keepsAwake({ connected: true, awake: true })).toBe(true);
    expect(keepsAwake({ connected: true, awake: false })).toBe(false);
    expect(keepsAwake({ connected: false, awake: true })).toBe(false);
  });

  it("asks Chrome for the system, not the screen, and lets go when it should", () => {
    const calls: string[] = [];
    const power = { requestKeepAwake: (level: string) => calls.push(`keep ${level}`), releaseKeepAwake: () => calls.push("release") };

    syncAwake(power, { connected: true, awake: undefined });
    syncAwake(power, { connected: true, awake: false });
    syncAwake(power, { connected: false, awake: undefined });

    expect(calls).toEqual(["keep system", "release", "release"]);
  });
});

describe("posting what the customer tapped Post it on", () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const SIGNED_IN = () => json({ kind: "t2", data: { name: "dana_builds", modhash: "mh1" } });

  /** Reddit, as the tab's fetch sees it: an answer per path, and every request remembered. */
  function reddit(answers: Record<string, () => Response>) {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return answers[url]?.() ?? new Response("", { status: 404 });
    });
    return calls;
  }
  const sent = (call: { init?: RequestInit } | undefined) => Object.fromEntries(new URLSearchParams(String(call?.init?.body)));
  afterEach(() => vi.unstubAllGlobals());

  it("posts a reply as the signed-in account, under what it answers, with that account's own form token", async () => {
    const calls = reddit({
      "/api/me.json": SIGNED_IN,
      "/api/comment": () => json({ json: { errors: [], data: { things: [{ kind: "t1", data: { id: "t1_n1", parent: "t1_c1" } }] } } }),
    });
    const thread = "https://www.reddit.com/r/SaaS/comments/abc123/need_a_form_tool/";
    const form = redditForm({ platform: "reddit", url: thread, parent: "t1_c1", text: "Tally does this." });

    const r = await redditPost(form.action, form.fields);
    expect(r).toMatchObject({ ok: true, name: "dana_builds" });
    expect(form.seen!((r as { data?: unknown }).data)).toBe("https://www.reddit.com/r/SaaS/comments/abc123/comment/n1/");
    expect(calls.map((c) => c.url)).toEqual(["/api/me.json", "/api/comment"]);
    expect(calls[1]?.init?.method).toBe("POST");
    expect(sent(calls[1])).toEqual({ thing_id: "t1_c1", text: "Tally does this.", uh: "mh1", api_type: "json" });
    expect(commentUrl(thread, "")).toBe(thread);
  });

  it("posts a new text post in a community, and sends a private message", async () => {
    const calls = reddit({
      "/api/me.json": SIGNED_IN,
      "/api/submit": () => json({ json: { errors: [], data: { url: "https://old.reddit.com/r/nocode/comments/xyz/forms/", name: "t3_xyz" } } }),
      "/api/compose": () => json({ json: { errors: [] } }),
    });

    const post = redditForm({ platform: "reddit", kind: "post", url: "https://www.reddit.com/r/nocode/", community: "nocode", title: "Forms", text: "What do you use?" });
    const r = await redditPost(post.action, post.fields);
    expect(sent(calls[1])).toEqual({ sr: "nocode", kind: "self", title: "Forms", text: "What do you use?", sendreplies: "true", uh: "mh1", api_type: "json" });
    expect(post.seen!((r as { data?: unknown }).data)).toBe("https://www.reddit.com/r/nocode/comments/xyz/forms/");

    const message = redditForm({ platform: "reddit", kind: "message", url: "https://www.reddit.com/user/sam/", to: "sam", subject: "Your form question", text: "Hi Sam" });
    expect(await redditPost(message.action, message.fields)).toMatchObject({ ok: true });
    expect(calls.at(-1)?.url).toBe("/api/compose");
    expect(sent(calls.at(-1))).toEqual({ to: "sam", subject: "Your form question", text: "Hi Sam", uh: "mh1", api_type: "json" });
    expect(message.seen!(null)).toBe("https://www.reddit.com/message/sent/");

    // Nothing incomplete goes out.
    expect(redditForm({ platform: "reddit", kind: "post", url: "x", community: "nocode", title: "", text: "Hi" })).toEqual({ refused: "the post needs a title of up to 300 characters" });
    expect(redditForm({ platform: "reddit", kind: "message", url: "x", to: "not a name", subject: "Hi", text: "Hi" })).toEqual({ refused: "the message has nobody to go to" });
    expect(redditForm({ platform: "reddit", url: "x", parent: "", text: "Hi" })).toEqual({ refused: "the reply has no post or comment to go under" });
  });

  it("posts nothing when nobody is signed in, and passes on Reddit's own refusals in its words", async () => {
    const calls = reddit({ "/api/me.json": () => json({}) });
    expect(await redditPost("comment", { thing_id: "t3_abc123", text: "Hi there" })).toMatchObject({ ok: false, reason: "login" });
    expect(calls.map((c) => c.url)).toEqual(["/api/me.json"]);

    const refusal = (errors: unknown[][]) => reddit({ "/api/me.json": SIGNED_IN, "/api/comment": () => json({ json: { errors } }) });
    refusal([["RATELIMIT", "you are doing that too much. try again in 5 minutes.", "ratelimit"]]);
    expect(await redditPost("comment", { thing_id: "t3_abc123", text: "Hi there" })).toEqual({
      ok: false,
      reason: "rate_limited",
      message: "you are doing that too much. try again in 5 minutes. (RATELIMIT)",
    });
    refusal([["THREAD_LOCKED", "that thread is locked", "parent"]]);
    expect(await redditPost("comment", { thing_id: "t3_abc123", text: "Hi there" })).toMatchObject({ reason: "refused", message: "that thread is locked (THREAD_LOCKED)" });

    reddit({ "/api/me.json": SIGNED_IN, "/api/comment": () => json({}, 403) });
    expect(await redditPost("comment", { thing_id: "t3_abc123", text: "Hi there" })).toMatchObject({ reason: "refused" });
  });
});
