import { ChromeError, customerId, draftLabel, HostGuard, pageLogin, PROTECTED_CONTROL, type BrowserControl, type BrowserJob, type BrowserTransport, type BrowserView } from "@mq/core";
import { describe, expect, it } from "vitest";
import { browserTools, CustomerBrowser } from "../src/chrome/browser.ts";
import { notPosted } from "../src/finds/find-service.ts";
import { managerPrompt } from "../src/manager/prompt.ts";
import { holdBack, managerTools } from "../src/manager/tools.ts";
import { chatPulse } from "../src/manager/turn-input.ts";
import { TelegramBotApi } from "../src/telegram/bot-api.ts";
import { draftCardHtml } from "../src/telegram/draft-card.ts";
import { TelegramChannel } from "../src/telegram/telegram-channel.ts";
import { makeWorld, telegramSender } from "./world.ts";

/** What the founder's first run on production found (2026-10-13), each kept from happening again. */

const control = (label: string, href: string | null = null, role = href ? "a" : "button"): BrowserControl => ({ ref: `r:${label}`, role, label, value: null, href });

/** Telegram's Bot API, answering every call and keeping what was sent. */
function telegram() {
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  const fetchStub = (async (url: string, init: { body: string }) => {
    calls.push({ method: url.split("/").at(-1)!, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ ok: true, result: { message_id: calls.length, chat: { id: 42, type: "private" }, date: 0 } }));
  }) as unknown as typeof fetch;
  return { calls, channel: new TelegramChannel(new TelegramBotApi("TOKEN", fetchStub)) };
}

describe("founders and builders only (2026-10-29)", () => {
  it("tells the manager about none of what Quest does not offer, so it cannot reach for it", async () => {
    const prompt = managerPrompt("");
    for (const gone of ["set_quest", "Custom Quest", "Career", "Recruiting", "suggest_answers", "Marc Lou", "make_video", "Write it and Not this one", "idea (from you)", "where card", "progress bar pinned", "Chill", "Ludicrous"]) {
      expect(prompt, gone).not.toContain(gone);
    }
    expect(prompt).toContain("PROFILE CHECKS");
    expect(prompt).toContain("open its notifications first");

    const world = makeWorld();
    const c = await world.customers.create({ channel: telegramSender().channel, userRef: "42", displayName: "Dana", language: "en" });
    const tools = managerTools({ ...world, customerId: c.id, userTurn: false, customers: world.customers, now: world.clock.now });
    const names = tools.map((t) => t.name);
    for (const gone of ["set_quest", "suggest_answers", "make_video"]) expect(names, gone).not.toContain(gone);
    // Their own ideas are kept; Quest offers none of its own.
    const idea = tools.find((t) => t.name === "idea")!;
    expect(JSON.stringify(idea.schema)).not.toContain('"you"');
  });
});

describe("answers to tap", () => {
  it("puts the likely answers in place of the keyboard, and takes them away with the next message", async () => {
    const { calls, channel } = telegram();
    const to = { kind: "telegram" as const, address: "42" };
    await channel.sendText(to, "What should I take off your plate?", ["Answer my Instagram comments", "Post for me on X"]);
    await channel.sendText(to, "On it.");
    await channel.sendText(to, "Done.");
    expect(calls.map((c) => c.body["reply_markup"])).toEqual([
      { keyboard: [[{ text: "Answer my Instagram comments" }], [{ text: "Post for me on X" }]], one_time_keyboard: true, resize_keyboard: true },
      { remove_keyboard: true },
      undefined,
    ]);
  });

  it("are never put up by the manager: its messages are plain text (the founder, 2026-10-29: no buttons spam in the chat)", async () => {
    const world = makeWorld();
    const c = await world.customers.create({ channel: telegramSender().channel, userRef: "42", displayName: "Dana", language: "en" });
    const tools = Object.fromEntries(managerTools({ ...world, customerId: c.id, userTurn: false, customers: world.customers, now: world.clock.now }).map((t) => [t.name, t]));
    expect(tools["suggest_answers"]).toBeUndefined();
    expect(await tools["message_user"]!.invoke({ text: "free plan in the replies: yes or no?" })).toBe("Sent.");
    expect(world.channel.sent.at(-1)?.text).toBe("Free plan in the replies: yes or no?");
    expect(world.channel.sent.at(-1)?.answers ?? []).toEqual([]);
  });
});

describe("connecting Chrome is their move", () => {
  it("lets Quest say what it starts, after the setup messages they did not answer in words", async () => {
    const world = makeWorld();
    const c = await world.customers.create({ channel: telegramSender().channel, userRef: "42", displayName: "Dana", language: "en" });
    const say = async (text: string) => { world.clock.advance(30_000); await world.transcript.recordOutgoing(c.id, "telegram", null, text); };
    await world.transcript.recordIncoming(c.id, "telegram", "61", "I want to answer comments on my instagram.");
    await say("Quest works in your connected browser… [1. Install the extension] [2. Connect Chrome]");
    await say("Chrome setup's in your messages. Once it's connected, tell me what your Instagram is about.");
    const before = chatPulse(await world.transcript.recent(c.id, 50), world.clock.now(), null);
    // Without the connection, a third message would be one too many.
    expect(holdBack(before, 0, world.clock.now())).toBe("they have not answered your last 2 messages");

    await say("✅ Chrome connected (Chrome 155 on Windows). Quest reads in a tab group of its own there, behind your tabs, so you can keep working.");
    world.clock.advance(25_000);
    const after = chatPulse(await world.transcript.recent(c.id, 50), world.clock.now(), null);
    expect(after).toMatchObject({ unanswered: 0, lastFromThem: new Date(world.clock.now().getTime() - 25_000) });
    expect(holdBack(after, 0, world.clock.now())).toBeNull();
  });
});

describe("their name on a site, and whether they're signed in, by looking", () => {
  it("finds their own profile on a signed-in page", () => {
    expect(pageLogin({ url: "https://x.com/home", controls: [control("Home", "https://x.com/home"), control("Profile", "https://x.com/dana_builds")] })).toEqual({ signedOut: false, profile: "https://x.com/dana_builds" });
    expect(pageLogin({ url: "https://www.instagram.com/", controls: [control("Reels", "https://www.instagram.com/reels/"), control("Profile", "https://www.instagram.com/dana.builds/")] })).toEqual({
      signedOut: false,
      profile: "https://www.instagram.com/dana.builds/",
    });
    expect(pageLogin({ url: "https://habr.com/ru/feed/", controls: [control("Профиль", "https://habr.com/ru/users/dana/")] }).profile).toBe("https://habr.com/ru/users/dana/");
    // Someone else's site's profile is not theirs here, and a page with no such link says nothing.
    expect(pageLogin({ url: "https://x.com/home", controls: [control("Profile", "https://example.com/profile")] })).toEqual({ signedOut: false, profile: null });
    expect(pageLogin({ url: "https://news.ycombinator.com/", controls: [control("new", "https://news.ycombinator.com/newest")] })).toEqual({ signedOut: false, profile: null });
  });

  it("sees a sign-in wall at once: its address, or a Log in button", () => {
    expect(pageLogin({ url: "https://www.instagram.com/accounts/login/?next=%2Fdana.builds%2F", controls: [] }).signedOut).toBe(true);
    expect(pageLogin({ url: "https://x.com/i/flow/login", controls: [] }).signedOut).toBe(true);
    expect(pageLogin({ url: "https://www.instagram.com/dana.builds/", controls: [control("Log in"), control("Sign up", "https://www.instagram.com/accounts/emailsignup/")] }).signedOut).toBe(true);
    expect(pageLogin({ url: "https://habr.com/ru/feed/", controls: [control("Войти")] }).signedOut).toBe(true);
    // Instagram's own page: its Log in button stays disabled (so unseen) until something is typed.
    const instagram = [control("Phone number, username, or email", null, "textbox"), control(PROTECTED_CONTROL, null, "textbox"), control("Log in with Facebook"), control("Sign up", "https://www.instagram.com/accounts/emailsignup/")];
    expect(pageLogin({ url: "https://www.instagram.com/", controls: instagram }).signedOut).toBe(true);
    // A password-like field alone (the extension labels file inputs the same way) is no wall.
    expect(pageLogin({ url: "https://x.com/compose/post", controls: [control(PROTECTED_CONTROL, null, "textbox"), control("Post text", null, "textbox")] }).signedOut).toBe(false);
    // Signing in elsewhere, through a site, is not this site's wall.
    expect(pageLogin({ url: "https://blog.example.com/post", controls: [control("Sign in with Google")] }).signedOut).toBe(false);
  });

  it("puts it first on every page a browser tool returns", async () => {
    const pages: Record<string, BrowserView> = {
      "https://www.instagram.com/": { url: "https://www.instagram.com/", title: "Instagram", text: "Log in Sign up", controls: [control("Log in")] },
      "https://x.com/home": { url: "https://x.com/home", title: "Home / X", text: "For you", controls: [control("Profile", "https://x.com/dana_builds")] },
    };
    const transport: BrowserTransport = { browser: async (_c: unknown, job: BrowserJob) => pages[job.url ?? ""]! };
    const browser = new CustomerBrowser(transport, new HostGuard({ resolve: async () => ["8.8.8.8"], unresolved: "refuse" }));
    const [open] = browserTools(browser, customerId("first-run"));
    const out = (url: string) => open!.invoke({ url }).then((s: string) => JSON.parse(s) as Record<string, unknown>);

    const wall = await out("https://www.instagram.com/");
    expect(Object.keys(wall).slice(0, 2)).toEqual(["signedIn", "login"]);
    expect(wall).toMatchObject({ signedIn: false, login: expect.stringContaining("not signed in to instagram.com in this Chrome") });
    expect(await out("https://x.com/home")).toMatchObject({ signedIn: true, yourProfile: "https://x.com/dana_builds", login: expect.stringContaining("Never ask them for it") });
  });

  it("is in the manager's and the researcher's instructions, never asking for a handle or searching for them", () => {
    const prompt = managerPrompt("");
    expect(prompt).toContain("never by asking for their handle");
    expect(prompt).toContain("Never send anyone to search the web for the customer, their name or their accounts");
    expect(prompt).toContain("A page that says signedIn false asks for a sign-in");
  });
});

describe("posting that failed on Quest's side", () => {
  it("says nothing was sent and how to try again, without the inner error", () => {
    const which = draftLabel({ kind: "post", target: "@dana_builds", author: null, platform: "x.com" });
    expect(which).toBe("your post on x.com");
    expect(notPosted(new ChromeError("unavailable", "Could not prepare this draft; no send was attempted. That picture is stale."), which, "x.com")).toBe(
      "I couldn't post your post on x.com, and nothing was sent. Tap Post it to try again, or post it yourself.",
    );
  });

  it("links a post elsewhere to its page, not to a community", () => {
    const card = draftCardHtml({ id: "d1", customerId: "c1", kind: "post", platform: "x.com", url: "https://x.com/compose/post", target: "@dana_builds", title: null, author: null, quote: null, text: "Hello", status: "open" } as never);
    expect(card).toContain(">Open the page</a>");
    expect(card).not.toContain("Open the community");
  });

  it("goes again when they say so in words, as a tap would", async () => {
    const world = makeWorld();
    const c = await world.customers.create({ channel: telegramSender().channel, userRef: "42", displayName: "Dana", language: "en" });
    const offered = await world.drafts.offer(c.id, { platform: "browser", kind: "post", url: "https://x.com/compose/post", target: "@dana_builds", text: "Shipped the new onboarding today, two taps instead of nine", rulesRead: true });
    if (typeof offered === "string") throw new Error(offered);
    const id = offered.draft.id;
    const tools = (theirs: string) =>
      Object.fromEntries(managerTools({ ...world, customerId: c.id, userTurn: true, customers: world.customers, now: world.clock.now, theirs: [{ ref: "80", text: theirs }] }).map((t) => [t.name, t]));

    // Ask first on x.com: without their word, it stays on its card.
    expect(await tools("Try again.")["send_draft"]!.invoke({ id })).toMatch(/^They want to review sends on this platform/);
    expect(await tools("What's next?")["send_draft"]!.invoke({ id, their_words: "Try again" })).toMatch(/^Not sent: "Try again" is not in what they wrote this turn/);
    expect(await tools("Try again.")["send_draft"]!.invoke({ id, their_words: "try again" })).toMatch(/^Posting it as they asked/);
    await world.errands.stop();
    expect(world.poster.posts).toHaveLength(1);
    expect((await world.draftStore.get(id))?.status).toBe("posted");
  });
});
