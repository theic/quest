import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { glassRoutes, telegramUser } from "../src/http/glass-routes.ts";
import type { PgGlass } from "../src/infra/pg-glass.ts";
import { silentLogger } from "../src/infra/system.ts";
import { makeWorld, telegramSender } from "./world.ts";

const TOKEN = "123456:test-token-not-a-real-one";

/** Init data as Telegram signs it for a Mini App opened by user 42. */
function signed(fields: Record<string, string>, token = TOKEN): string {
  const check = Object.keys(fields)
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  const hash = createHmac("sha256", secret).update(check).digest("hex");
  return new URLSearchParams({ ...fields, hash }).toString();
}

describe("the customer's page", () => {
  it("opens only for the Telegram user the bot's own signature names, and only for a day", () => {
    const now = Date.UTC(2026, 9, 4, 12);
    const fields = { auth_date: String(now / 1000 - 60), query_id: "AAE", user: JSON.stringify({ id: 42, first_name: "Dana" }) };
    expect(telegramUser(signed(fields), TOKEN, now)).toBe("42");
    expect(telegramUser(signed(fields, "999:another-bot"), TOKEN, now)).toBeNull();
    expect(telegramUser(signed(fields).replace("Dana", "Eve"), TOKEN, now)).toBeNull();
    expect(telegramUser(signed({ ...fields, auth_date: String(now / 1000 - 2 * 86_400) }), TOKEN, now)).toBeNull();
    expect(telegramUser("", TOKEN, now)).toBeNull();
  });
});

describe("the page's language", () => {
  it("is the customer's everywhere: the picker changes the chat's language, and auto follows Telegram", async () => {
    const world = makeWorld();
    const c = await world.customers.create({ channel: telegramSender().channel, userRef: "42", displayName: "Dana", language: "pt" });
    await world.customers.update(c.id, { activatedAt: new Date() });
    const now = Date.now();
    const app = glassRoutes({ botToken: TOKEN, customers: world.customers, glass: {} as PgGlass, chrome: {} as never, log: silentLogger, now: () => now });
    const initData = signed({ auth_date: String(Math.floor(now / 1000) - 60), query_id: "AAE", user: JSON.stringify({ id: 42, first_name: "Dana", language_code: "pt-BR" }) });
    const post = (body: Record<string, unknown>) => app.request("/glass/language", { method: "POST", body: JSON.stringify({ initData, ...body }), headers: { "content-type": "application/json" } });

    expect(((await (await post({ locale: "en" })).json()) as { locale: string }).locale).toBe("en");
    expect((await world.customers.get(c.id)).language).toBe("manual:en");

    // Auto goes back to their Telegram's.
    expect(((await (await post({ locale: "auto" })).json()) as { locale: string }).locale).toBe("pt");
    expect((await world.customers.get(c.id)).language).toBe("pt");

    expect((await post({ locale: "klingon" })).status).toBe(400);
    expect((await app.request("/glass/language", { method: "POST", body: JSON.stringify({ initData: "", locale: "en" }), headers: { "content-type": "application/json" } })).status).toBe(401);
  });
});
