import { createHmac, timingSafeEqual } from "node:crypto";
import { customerLocale, forLanguage, nextLanguage, supportedLocale } from "@mq/i18n";
import { everywhere, postsAlone, TRUST_AFTER, type Customer, type CustomerId, type CustomerRepository, type Draft, type DraftAction, type FindAction, type Logger, type Task } from "@mq/core";
import { Hono, type Context } from "hono";
import { platformName } from "../drafts/autopilot.ts";
import { pickedPlatforms } from "../conversation/intake.ts";
import { limitsPage } from "../drafts/day-limits.ts";
import type { PgGlass } from "../infra/pg-glass.ts";
import type { ChromeAccess } from "../manager/tools.ts";
import { glassPage } from "./glass-page.ts";
import type { Energy, EnergyView } from "../billing/energy.ts";

/** How long a Telegram sign-in to the page holds. */
const SIGN_IN_MS = 24 * 3_600_000;

/**
 * The Telegram user a Mini App's init data was signed for (core.telegram.org/bots/webapps,
 * "Validating data received via the Mini App"), or null when it was not signed with this bot's
 * token, or was signed too long ago.
 */
export function telegramUser(initData: string, botToken: string, now: number): string | null {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");
  const check = [...params]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const expected = createHmac("sha256", secret).update(check).digest("hex");
  if (hash.length !== expected.length || !timingSafeEqual(Buffer.from(hash), Buffer.from(expected))) return null;
  const at = Number(params.get("auth_date")) * 1000;
  if (!at || now - at > SIGN_IN_MS) return null;
  try {
    const id = (JSON.parse(params.get("user") ?? "") as { id?: unknown }).id;
    return typeof id === "number" ? String(id) : null;
  } catch {
    return null;
  }
}

/**
/** Their credits as Settings shows them, in dollars: how they use Quest, today's use and limit, the rest, and where to top up. */
function planOnPage(e: EnergyView) {
  return {
    access: e.access,
    used: e.used,
    limit: e.limit,
    balance: e.balance,
    resting: e.restUntil ? e.restUntil.toISOString() : null,
    restingFor: e.resting,
    link: e.link,
  };
}

export function glassRoutes(deps: {
  botToken: string;
  customers: CustomerRepository;
  glass: PgGlass;
  chrome: Pick<ChromeAccess, "status">;
  /** Their plan and the day's credits (billing/energy.ts). */
  energy?: Pick<Energy, "view">;
  /** The off switch at the top of the page (lifecycle/power.ts). */
  power?: { set(customerId: CustomerId, on: boolean, from: "chat" | "page"): Promise<boolean> };
  log: Logger;
  now?: () => number;
}): Hono {
  const app = new Hono();
  const now = deps.now ?? Date.now;

  app.get("/glass", (c) => c.html(glassPage()));

  /** The customer whose Telegram signed the page's init data, or the refusal to send instead. */
  const signedIn = async (c: Context): Promise<Customer | Response> => {
    const body = await c.req.json<{ initData?: unknown }>().catch(() => ({ initData: undefined }));
    const user = typeof body.initData === "string" ? telegramUser(body.initData, deps.botToken, now()) : null;
    if (!user) return c.json({ error: "Open this page from Quest's chat in Telegram." }, 401);
    const customer = await deps.customers.findByChannel({ kind: "telegram", address: user });
    if (!customer) return c.json({ error: "Write to Quest in Telegram first." }, 404);
    // Not in yet (conversation/way-in.ts): their first message lets them in.
    if (!customer.activatedAt) return c.json({ error: "Write to Quest in Telegram first." }, 403);
    return customer;
  };

  // The switch at the top of the page: Quest on or off, as /on and /off in the chat.
  app.post("/glass/power", async (c) => {
    const body = await c.req.raw.clone().json().catch(() => ({})) as { on?: unknown };
    const customer = await signedIn(c);
    if (customer instanceof Response) return customer;
    if (!deps.power || typeof body.on !== "boolean") return c.json({ error: "Could not switch it." }, 400);
    await deps.power.set(customer.id, body.on, "page");
    return c.json({ off: !body.on });
  });

  // The page's language picker: the language is theirs everywhere, so the bot speaks it too (the founder, 2026-10-24:
  // "I'd prefer English and selected that in the mini app, but it didn't change anything"). Auto follows their Telegram.
  app.post("/glass/language", async (c) => {
    const body = await c.req.raw.clone().json().catch(() => ({})) as { locale?: unknown; initData?: unknown };
    const customer = await signedIn(c);
    if (customer instanceof Response) return customer;
    const choice = typeof body.locale === "string" ? body.locale : "";
    const locale = supportedLocale(choice);
    if (choice !== "auto" && !locale) return c.json({ error: "Could not change it." }, 400);
    const telegram = (() => {
      try {
        return (JSON.parse(new URLSearchParams(String(body.initData)).get("user") ?? "{}") as { language_code?: string }).language_code ?? null;
      } catch {
        return null;
      }
    })();
    const language = choice === "auto" ? nextLanguage(null, telegram) : `manual:${locale}`;
    await deps.customers.update(customer.id, { language });
    deps.log.info("glass.language", { customerId: customer.id, language });
    return c.json({ locale: customerLocale(language) });
  });

  // The switch in Settings: whether Quest's tab may come to the front of their screen (their Chrome hears it on its next ask).
  app.post("/glass/front", async (c) => {
    const body = await c.req.raw.clone().json().catch(() => ({})) as { on?: unknown };
    const customer = await signedIn(c);
    if (customer instanceof Response) return customer;
    if (typeof body.on !== "boolean") return c.json({ error: "Could not switch it." }, 400);
    await deps.customers.update(customer.id, { chromeFront: body.on });
    deps.log.info("glass.chrome_front", { customerId: customer.id, on: body.on });
    return c.json({ chromeFront: body.on });
  });

  app.post("/glass/data", async (c) => {
    const customer = await signedIn(c);
    if (customer instanceof Response) return customer;
    const [{ sentToday = [], ...rows }, chrome, energy] = await Promise.all([
      deps.glass.snapshot(customer.id),
      deps.chrome.status(customer.id),
      deps.energy ? deps.energy.view(customer.id).catch(() => null) : Promise.resolve(null),
    ]);
    const preferences = rows["trust"] ?? [];
    const platforms = [...new Set(["reddit", ...preferences.map((t) => String(t["platform"]))])];
    deps.log.info("glass.opened", { customerId: customer.id });
    return c.json({
      name: customer.displayName,
      locale: customerLocale(customer.language),
      off: Boolean(customer.offAt),
      site: customer.siteUrl,
      timezone: customer.timezone,
      chrome: { state: chrome.online ? "open" : chrome.linked ? "silent" : "not connected", device: chrome.device, seen: chrome.lastSeenAt, front: customer.chromeFront },
      posting: platforms.map((key) => {
        const preference = preferences.find((t) => t["platform"] === key) ?? preferences.find((t) => t["platform"] === everywhere(key)) ?? preferences.find((t) => t["platform"] === "*");
        const approved = preference?.["ask_first"] ? 0 : Number(preference?.["approved"] ?? 0);
        // Earned and offered, it waits on their yes on Your move: going alone is theirs to say.
        const alone = postsAlone(approved) && Boolean(preference?.["granted"]);
        return { platform: platformName(key), approved: Math.min(approved, TRUST_AFTER), of: TRUST_AFTER, alone, offered: postsAlone(approved) && !alone };
      }),
      // Each platform's day limits and what went up there in the last day; replies and comments have none.
      limits: limitsPage(
        sentToday.map((d) => ({ kind: d["kind"] as Draft["kind"], platform: String(d["platform"] ?? ""), url: String(d["url"] ?? "") })),
        pickedPlatforms(customer),
      ),
      billing: energy ? planOnPage(energy) : null,
      ...rows,
    });
  });

  return app;
}
