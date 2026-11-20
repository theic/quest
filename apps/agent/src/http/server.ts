import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { LOCALES } from "@mq/i18n";
import type { Logger } from "@mq/core";
import { Hono, type Context } from "hono";
import type { InboundService } from "../conversation/inbound-service.ts";
import type { Traffic } from "../lifecycle/traffic.ts";
import type { TgUpdate } from "../telegram/bot-api.ts";
import type { PinNotices } from "../telegram/poller.ts";
import { parseUpdate } from "../telegram/updates.ts";

const sameSecret = (given: string | undefined, expected: string): boolean => {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

export interface WakeHook {
  /** The key the database's wake job sends; null until the agent has registered. */
  key(): string | null;
  /** Work fell due: look at the queues now. */
  nudge(): void;
}

export function createServer(deps: {
  webhookSecret: string;
  inbound: InboundService;
  /** Telegram's notes about Quest's own pins: deleted as they come in. */
  pinNotices?: PinNotices;
  traffic: Traffic;
  wake: WakeHook;
  log: Logger;
  health: () => Record<string, unknown>;
  /** More routes (the extension's), served behind the same traffic count. */
  routes?: readonly Hono[];
}): Hono {
  const app = new Hono();

  // Fly's health checks are not someone needing the agent, so they do not keep it awake.
  // They do not touch the database either: an open connection would hold off a sleep.
  app.get("/health", (c) => c.json({ ok: true, ...deps.health() }));

  // Public, bundled interface translations. Exact allowlist; no customer data or arbitrary paths.
  const languageAssets = new Set(["browser.js", "browser.css", "language.js", ...LOCALES.map((l) => `locales/${l}.json`)]);
  app.get("/i18n/*", async (c) => {
    const name = c.req.path.slice("/i18n/".length);
    if (!languageAssets.has(name)) return c.notFound();
    const body = await readFile(new URL(`../../../../packages/i18n/src/${name}`, import.meta.url), "utf8");
    c.header("Content-Type", `${name.endsWith(".json") ? "application/json" : name.endsWith(".css") ? "text/css" : "text/javascript"}; charset=utf-8`);
    c.header("Cache-Control", "public, max-age=300");
    return c.body(body);
  });

  // The landing's own pieces that the Chrome setup pages share (public/chrome.html, connect.html): its two faces, the
  // Visor and the zip dialog's script, read from apps/web/public so there is one copy. Exact names; nothing else.
  const SITE_TYPES: Record<string, string> = { woff2: "font/woff2", css: "text/css; charset=utf-8", svg: "image/svg+xml", js: "text/javascript; charset=utf-8" };
  const siteAsset = /^(fonts\/[\w-]+\.(woff2|css)|quest\.svg|install\.js)$/;
  const fromSite = async (c: Context) => {
    const name = c.req.path.slice(1);
    if (!siteAsset.test(name)) return c.notFound();
    const body = await readFile(new URL(`../../../web/public/${name}`, import.meta.url)).catch(() => null);
    if (!body) return c.notFound();
    c.header("Content-Type", SITE_TYPES[name.slice(name.lastIndexOf(".") + 1)]!);
    // A font file gets a new name when it changes (the landing's fonts.css); the rest may change under its name.
    c.header("Cache-Control", name.endsWith(".woff2") ? "public, max-age=31536000, immutable" : "public, max-age=300");
    return c.body(body);
  };
  app.get("/fonts/:file", fromSite);
  app.get("/quest.svg", fromSite);
  app.get("/install.js", fromSite);

  app.use("*", async (_c, next) => {
    const done = deps.traffic.begin();
    try {
      await next();
    } finally {
      done();
    }
  });

  /** The database's wake job calls this when work falls due while the agent sleeps. The request itself resumes the machine. */
  app.post("/wake", (c) => {
    const key = deps.wake.key();
    if (!key || !sameSecret(c.req.header("x-mq-wake"), key)) return c.text("forbidden", 403);
    deps.wake.nudge();
    return c.body(null, 204);
  });

  /**
   * Telegram's webhook. It only has to be fast and never fail: the update is
   * recorded and queued, and the manager answers on its own thread. A 200 even
   * on errors stops Telegram redelivering an update that will fail the same way.
   */
  app.post("/telegram/webhook", async (c) => {
    if (!sameSecret(c.req.header("x-telegram-bot-api-secret-token"), deps.webhookSecret)) return c.text("forbidden", 403);
    let update: TgUpdate;
    try {
      update = await c.req.json<TgUpdate>();
    } catch {
      return c.json({ ok: true });
    }
    try {
      if (await deps.pinNotices?.dropPinNotice(update)) return c.json({ ok: true });
      const inbound = parseUpdate(update);
      if (inbound) await deps.inbound.handle(inbound);
    } catch (e) {
      deps.log.error("telegram.update_failed", { error: e instanceof Error ? e.message : String(e) });
    }
    return c.json({ ok: true });
  });

  for (const r of deps.routes ?? []) app.route("/", r);

  return app;
}
