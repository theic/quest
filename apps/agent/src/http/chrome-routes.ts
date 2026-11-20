import { ChromeError, customerId, type ChromeLink, type CustomerId, type Logger, type PostQuery, type WebReach } from "@mq/core";
import type { PanelSettings } from "../conversation/panel-settings.ts";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { ChromeBroker } from "../chrome/broker.ts";
import type { ChromeLinkService } from "../chrome/link-service.ts";
import { Outcome } from "./chrome-outcome.ts";
import { connectPage, installPage, pagesStyle } from "./chrome-pages.ts";
import type { ExtensionChat } from "../conversation/extension-chat.ts";

const Hello = z.object({ device: z.string().max(120).nullish(), language: z.string().max(20).nullish(), invite: z.string().max(64).nullish(), timeZone: z.string().max(64).nullish() });
const Voice = z.object({ audio: z.string().min(1).max(6_000_000), mime: z.string().regex(/^audio\/(webm|ogg)/), seconds: z.number().min(0).max(600).nullish(), replyTo: z.string().max(80).nullish() });
const Say = z.object({ text: z.string().trim().min(1).max(4000), replyTo: z.string().max(80).nullish() });
const Press = z.object({ data: z.string().min(1).max(64) });
/** New chats one address may start in an hour: a backstop on what someone new costs. */
const HELLOS_AN_HOUR = 5;

const Pair = z.object({ code: z.string().min(4).max(40), device: z.string().max(120).nullish() });

/** Presses of a pairing code per address and minute: codes are short-lived, and guessing one is slow. */
const PAIR_TRIES_PER_MINUTE = 10;
const PAIR_ADDRESSES_KEPT = 1_000;

/** How long their switch for Quest's tab coming to the front is taken as read. */
const FRONT_KEPT_MS = 15_000;

/**
 * The extension's side of the agent: the pages the setup message links to,
 * pairing, and the long poll that hands it pages to read and replies to post.
 */
export function chromeRoutes(deps: {
  links: ChromeLinkService;
  broker: ChromeBroker;
  log: Logger;
  now?: () => number;
  /** How many jobs their Chrome takes at once, each in a tab of its own. */
  tabs?: number;
  /** How many pages their Chrome reads in a day; unsaid, the extension keeps its own. */
  pagesADay?: number;
  /** Whether Quest's tab may come to the front of their screen (their switch); on when not known. */
  front?: (customerId: CustomerId) => Promise<boolean>;
  /** Whether they switched Quest off: told to the extension (`x-mq-off`), which closes Quest's tabs. */
  off?: (customerId: CustomerId) => boolean;
  /** The switch in the extension's popup: Quest on or off for them, as the one in their chat. */
  power?: (customerId: CustomerId, on: boolean) => Promise<unknown>;
  /** Their conversation in the popup (conversation/extension-chat.ts). */
  chat?: ExtensionChat;
  /** A link that opens Quest in Telegram as this same customer (the panel's optional way to Telegram); null where there is no bot. */
  telegramLink?: (customerId: CustomerId) => string | null;
  /** The panel's settings view (conversation/panel-settings.ts). */
  settings?: Pick<PanelSettings, "view" | "platform">;
}): Hono {
  const app = new Hono();
  const now = deps.now ?? Date.now;
  const tries = new Map<string, { count: number; since: number }>();
  // Their switch, looked up at most every 15 s: each of their Chrome's pollers asks every 20 s.
  const fronts = new Map<string, { at: number; on: boolean }>();
  const front = async (customerId: CustomerId): Promise<boolean> => {
    const kept = fronts.get(customerId);
    if (kept && now() - kept.at < FRONT_KEPT_MS) return kept.on;
    const on = deps.front ? await deps.front(customerId).catch(() => true) : true;
    fronts.set(customerId, { at: now(), on });
    return on;
  };

  app.get("/chrome", (c) => c.html(installPage()));
  app.get("/connect", (c) => c.html(connectPage()));
  app.get("/pages.css", (c) => c.body(pagesStyle(), 200, { "Content-Type": "text/css; charset=utf-8", "Cache-Control": "public, max-age=300" }));

  app.post("/chrome/pair", async (c) => {
    const from = c.req.header("fly-client-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
    const t = tries.get(from);
    if (t && now() - t.since < 60_000 && t.count >= PAIR_TRIES_PER_MINUTE) return c.json({ error: "Too many tries. Wait a minute." }, 429);
    tries.set(from, t && now() - t.since < 60_000 ? { count: t.count + 1, since: t.since } : { count: 1, since: now() });
    // Addresses whose minute is over go, so presses from many addresses cannot grow the count without end.
    if (tries.size > PAIR_ADDRESSES_KEPT) for (const [at, seen] of tries) if (now() - seen.since >= 60_000) tries.delete(at);

    const body = Pair.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "No code was sent." }, 400);
    const paired = await deps.links.pair(body.data.code, body.data.device ?? null);
    if (!paired) return c.json({ error: "That code has expired or was already used. Send /connect to Quest in Telegram for a new one." }, 400);
    return c.json({ token: paired.token, device: paired.link.device });
  });

  /**
   * Someone new in the popup, with no Telegram and no code from it: Quest starts talking with them there and this Chrome
   * is theirs at once. An invite's code they bring (from a thread or a message where Quest met them) lets them in with it.
   */
  const hellos = new Map<string, { count: number; since: number }>();
  app.post("/chrome/hello", async (c) => {
    if (!deps.chat) return c.json({ error: "Not here yet." }, 404);
    const from = c.req.header("fly-client-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
    const h = hellos.get(from);
    if (h && now() - h.since < 3_600_000 && h.count >= HELLOS_AN_HOUR) return c.json({ error: "Too many tries. Wait an hour, or write to Serhii." }, 429);
    hellos.set(from, h && now() - h.since < 3_600_000 ? { count: h.count + 1, since: h.since } : { count: 1, since: now() });
    if (hellos.size > PAIR_ADDRESSES_KEPT) for (const [at, seen] of hellos) if (now() - seen.since >= 3_600_000) hellos.delete(at);
    const body = Hello.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "Could not start." }, 400);
    const met = await deps.chat.hello({ device: body.data.device ?? null, language: body.data.language ?? null, invite: body.data.invite?.trim() || null, timeZone: body.data.timeZone ?? null });
    if (!met) return c.json({ error: "Could not start. Try again in a minute." }, 500);
    return c.json({ token: met.token });
  });

  const openTabs = new Map<string, number>();
  const authed = new Hono<{ Variables: { link: ChromeLink } }>();
  authed.use("*", async (c, next) => {
    const token = /^Bearer (.+)$/.exec(c.req.header("authorization") ?? "")?.[1];
    const link = token ? await deps.links.authenticate(token) : null;
    if (!link) return c.json({ error: "This Chrome is not connected to Quest any more." }, 401);
    c.set("link", link);
    await next();
  });

  /**
   * The long poll: a page to read, or 204 after `wait` seconds (at most 25: Chrome stops an extension's fetch at 30).
   * Every answer says how many pollers to run (`x-mq-tabs`), each with its own `slot`, and whether Quest's tab may come
   * to the front (`x-mq-front`, their switch on their page), and how many pages it reads in a day (`x-mq-pages`). An
   * extension from before reads none of them, polls alone and keeps its own 400.
   */
  authed.get("/next", async (c) => {
    const link = c.get("link");
    const wait = Math.min(25, Math.max(0, Number(c.req.query("wait") ?? 20) || 0));
    const slot = /^\d{1,2}$/.test(c.req.query("slot") ?? "") ? c.req.query("slot")! : "0";
    // How many tabs of Quest's are open in their Chrome, as the extension counts them: logged when it changes, so
    // what it opened and closed can be read off the log.
    const open = Number(c.req.header("x-mq-open"));
    if (Number.isInteger(open) && openTabs.get(link.customerId) !== open) {
      openTabs.set(link.customerId, open);
      deps.log.info("chrome.tabs_open", { customerId: link.customerId, open });
    }
    c.header("x-mq-tabs", String(deps.tabs ?? 1));
    if (deps.pagesADay) c.header("x-mq-pages", String(deps.pagesADay));
    if (!(await front(link.customerId))) c.header("x-mq-front", "off");
    const job = await deps.broker.next(link.customerId, wait * 1000, c.req.raw.signal, slot);
    // Switched off: the extension closes Quest's tabs and its group now, not after its idle wait. Said as the poll is
    // answered, not as it began: a poll that waited through the switch told the extension the old state, and with
    // several pollers the popup and the badge went back and forth for half a minute.
    if (deps.off?.(link.customerId)) c.header("x-mq-off", "1");
    // News in their chat (a message from Quest, a change on Your move): the extension opens the chat when it moved.
    if (deps.chat) c.header("x-mq-news", String(deps.chat.mark(link.customerId)));
    if (!job) return c.body(null, 204);
    return c.json(job);
  });

  /**
   * The switch in the popup (the founder, 2026-11-11: "a hot turn-off switch"): one click on Quest's icon, in the
   * Chrome it works in. The same off as the chat's and their page's, so all three say the same.
   */
  authed.post("/power", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { on?: unknown };
    if (!deps.power || typeof body.on !== "boolean") return c.json({ error: "Could not switch it." }, 400);
    await deps.power(c.get("link").customerId, body.on);
    return c.json({ off: !body.on });
  });

  /** The panel's second view: platforms on and off, what goes alone where, the model, the past reports. */
  authed.get("/settings", async (c) => {
    if (!deps.settings) return c.json({ error: "Not here yet." }, 404);
    return c.json(await deps.settings.view(c.get("link").customerId));
  });

  authed.post("/settings/platform", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { platform?: unknown; on?: unknown };
    if (!deps.settings || typeof body.platform !== "string" || !/^[\w.-]{2,80}$/.test(body.platform) || typeof body.on !== "boolean") {
      return c.json({ error: "Could not change it." }, 400);
    }
    await deps.settings.platform(c.get("link").customerId, body.platform, body.on);
    return c.json(await deps.settings.view(c.get("link").customerId));
  });

  authed.post("/jobs/:id", async (c) => {
    const link = c.get("link");
    const outcome = Outcome.safeParse(await c.req.json().catch(() => null));
    if (!outcome.success) {
      deps.log.warn("chrome.bad_result", { customerId: link.customerId, error: outcome.error.issues.map(i => i.path.join(".") + ": " + i.code).join("; ").slice(0, 300) });
      deps.broker.complete(link.customerId, c.req.param("id"), { ok: false, reason: "unavailable", message: "the extension sent a read Quest could not use" });
      return c.json({ error: "unreadable result" }, 400);
    }
    const known = deps.broker.complete(link.customerId, c.req.param("id"), outcome.data);
    return known ? c.body(null, 204) : c.json({ error: "nobody waits for that page any more" }, 410);
  });

  /** Their chat as the popup draws it; with `after`, a long poll for anything newer (at most 25 s). */
  authed.get("/chat", async (c) => {
    if (!deps.chat) return c.json({ error: "Not here yet." }, 404);
    const after = c.req.query("after");
    const wait = Math.min(25, Math.max(0, Number(c.req.query("wait") ?? 0) || 0));
    return c.json(await deps.chat.view(c.get("link").customerId, after && /^d{1,16}$/.test(after) ? Number(after) : null, wait * 1000, c.req.raw.signal));
  });

  authed.post("/chat", async (c) => {
    const body = Say.safeParse(await c.req.json().catch(() => null));
    if (!deps.chat || !body.success) return c.json({ error: "Nothing was sent." }, 400);
    await deps.chat.say(c.get("link").customerId, body.data.text, body.data.replyTo ?? null);
    return c.json({ ok: true });
  });

  // A voice message from the popup: base64 of what MediaRecorder made (webm or ogg with opus), at most about 4 minutes.
  authed.post("/chat/voice", async (c) => {
    const body = Voice.safeParse(await c.req.json().catch(() => null));
    if (!deps.chat?.voice || !body.success) return c.json({ error: "Nothing was sent." }, 400);
    const audio = Uint8Array.from(Buffer.from(body.data.audio, "base64"));
    if (!audio.byteLength) return c.json({ error: "Nothing was sent." }, 400);
    await deps.chat.voice(c.get("link").customerId, audio, body.data.mime, body.data.seconds ?? null, body.data.replyTo ?? null);
    return c.json({ ok: true });
  });

  authed.post("/chat/press", async (c) => {
    const body = Press.safeParse(await c.req.json().catch(() => null));
    if (!deps.chat || !body.success) return c.json({ error: "Nothing was pressed." }, 400);
    return c.json({ ack: await deps.chat.press(c.get("link").customerId, body.data.data) });
  });

  // Chrome is the way in, and Telegram an optional remote control: the panel asks for a link that joins their Telegram
  // to this same chat.
  authed.post("/chat/telegram", (c) => {
    const url = deps.telegramLink?.(c.get("link").customerId) ?? null;
    return url ? c.json({ url }) : c.json({ error: "Telegram is not set up here." }, 404);
  });

  authed.get("/me", (c) => c.json({ device: c.get("link").device, connected: true }));

  authed.post("/disconnect", async (c) => {
    await deps.links.disconnect(c.get("link"));
    return c.body(null, 204);
  });

  app.route("/chrome", authed);
  return app;
}

/** For measuring page shapes on a laptop: reads a page in a customer's Chrome and returns what came back. */
export function chromeDebugRoutes(broker: ChromeBroker, reach?: WebReach): Hono {
  const app = new Hono();
  // A search as a teammate's search_posts runs it, and a page as its read_page reads it: for trying searches by hand.
  app.post("/debug/chrome/search", async (c: Context) => {
    const body = (await c.req.json()) as { customerId: string } & PostQuery;
    try {
      const { customerId: id, ...q } = body;
      return c.json(await reach!.forCustomer(customerId(id)).posts.search(q));
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
    }
  });
  app.post("/debug/chrome/page", async (c: Context) => {
    const body = (await c.req.json()) as { customerId: string; url: string; drawn?: boolean };
    try {
      return c.json(await reach!.forCustomer(customerId(body.customerId)).reader.readPage(body.url, body.drawn ? { drawn: true } : {}));
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
    }
  });
  // This router is bound to loopback by main.ts when CHROME_DEBUG=1.
  // Lets a supervised browser test drive the same broker protocol as the extension.
  app.get("/debug/chrome/next", async (c) => {
    const id = c.req.query("customerId");
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return c.json({ error: "customerId required" }, 400);
    const job = await broker.next(customerId(id), 20_000, c.req.raw.signal);
    return job ? c.json(job) : c.body(null, 204);
  });
  app.post("/debug/chrome/results/:id", async (c) => {
    const id = c.req.query("customerId");
    const body = Outcome.safeParse(await c.req.json().catch(() => null));
    if (!id || !/^[0-9a-f-]{36}$/i.test(id) || !body.success) return c.json({ error: "invalid result" }, 400);
    return broker.complete(customerId(id), c.req.param("id"), body.data) ? c.body(null, 204) : c.body(null, 410);
  });
  app.post("/debug/chrome/read", async (c: Context) => {
    const body = (await c.req.json()) as { customerId: string; job: Parameters<ChromeBroker["read"]>[1] };
    try {
      return c.json(await broker.read(customerId(body.customerId), body.job));
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
    }
  });
  // A page as a browser session sees it (its controls, items, login), drawn as the poster's are: then the session closes.
  app.post("/debug/chrome/browse", async (c: Context) => {
    const body = (await c.req.json()) as { customerId: string; url: string; drawn?: boolean; scroll?: number };
    const who = customerId(body.customerId);
    const session = `debug:${Date.now()}`;
    try {
      let view = await broker.browser(who, { session, url: body.url, action: { kind: "snapshot" }, drawn: body.drawn ?? true });
      for (let i = 0; i < (body.scroll ?? 0); i++) view = await broker.browser(who, { session, action: { kind: "scroll", direction: "down" }, drawn: body.drawn ?? true });
      return c.json(view);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
    } finally {
      await broker.browser(who, { session, action: { kind: "close" } }).catch(() => undefined);
    }
  });
  // One step of a browser session kept open between calls, for trying a site's controls by hand: the same broker call the poster makes.
  app.post("/debug/chrome/step", async (c: Context) => {
    const body = (await c.req.json()) as { customerId: string; session: string; url?: string; action: Parameters<ChromeBroker["browser"]>[1]["action"]; drawn?: boolean };
    try {
      return c.json(await broker.browser(customerId(body.customerId), { session: body.session, ...(body.url ? { url: body.url } : {}), action: body.action, drawn: body.drawn ?? true }));
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e), reason: e instanceof ChromeError ? e.reason : null }, 502);
    }
  });
  return app;
}
