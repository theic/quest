import { createHmac, timingSafeEqual } from "node:crypto";
import { customerLocale } from "@mq/i18n";
import { customerId, type CustomerId, type Wallet } from "@mq/core";
import { atTheirTime } from "../lib/their-time.ts";

/**
 * Pay as you go on the hosted Quest (the founder, 2026-11-03: "a common $5 per day limit without exceptions, for
 * everyone"): free on an invite, else on credits (a free start, then packs). A credit is a dollar of what Quest's model calls cost for the customer (mq.model_calls), shown
 * as money: "$1.00".
 */
export const DAY_LIMIT_USD = 5;

/** Past this share of the day's limit Quest is tired: the manager hears it, and starts only what matters most. */
export const TIRED_AT = 0.8;

/** A pack of credits: what it costs, and what its first top-up adds. */
export interface Pack {
  readonly usd: number;
  readonly bonus: number;
}

/** Two packs; the bonus comes only with their very first top-up. */
export const PACKS: readonly Pack[] = [
  { usd: 20, bonus: 5 },
  { usd: 100, bonus: 40 },
];

export const packOf = (usd: number): Pack | null => PACKS.find((p) => p.usd === usd) ?? null;

/** Their credits left, in dollars. */
export const balance = (w: Wallet | null): number => (w ? Math.max(0, w.paid - w.spent) : 0);

/** A sum in dollars as money in their language: "$1.00", "1,00 $"; a pack's price in whole dollars ("$20") with `cents` false. */
export function money(usd: number, language: string | null, cents = true): string {
  const locale = customerLocale(language);
  const digits = cents ? 2 : 0;
  return new Intl.NumberFormat(locale === "ar" ? "en" : locale, { style: "currency", currency: "USD", currencyDisplay: "narrowSymbol", minimumFractionDigits: digits, maximumFractionDigits: digits }).format(usd);
}

/** Their midnight that began the day `now` falls on, and the next one (UTC when their time zone is not known). */
export function theirDay(now: Date, timezone: string | null): { readonly start: Date; readonly end: Date } {
  // Their clock is read to the second: from `now`'s milliseconds, midnight came out at 00:00:00.448 (live, 2026-10-16).
  const t = new Date(Math.floor(now.getTime() / 1000) * 1000);
  return { start: atTheirTime(t, timezone, 0), end: atTheirTime(t, timezone, 0, 0, 1) };
}

/** A length of time to wait, roughly: "7 h", "45 min". */
export function restLeft(ms: number): { readonly key: "{count} h" | "{count} min"; readonly count: number } {
  const min = Math.max(1, Math.ceil(ms / 60_000));
  return min >= 90 ? { key: "{count} h", count: Math.round(min / 60) } : { key: "{count} min", count: min };
}


/**
 * The page a customer buys credits on is theirs by a signed address (no sign-in: the link in their chat is the key).
 * Signed with a key made from the bot's token, which only the agent holds. A link from before carries an offer's id
 * after the dot, which is read and passed over.
 */
export class PlanLinks {
  readonly #key: Buffer;
  readonly #base: string;

  constructor(botToken: string, baseUrl: string) {
    this.#key = createHmac("sha256", botToken).update("mq-plan-links").digest();
    this.#base = baseUrl.replace(/\/+$/, "");
  }

  token(customerId: CustomerId): string {
    const body = Buffer.from(`${customerId}.`).toString("base64url");
    return `${body}.${this.#sign(body)}`;
  }

  url(customerId: CustomerId): string {
    return `${this.#base}/plan/${this.token(customerId)}`;
  }

  /** A day's report (http/report-routes.ts), signed the same way. */
  report(customerId: CustomerId, day: string): string {
    return `${this.#base}/report/${this.token(customerId)}/${day}`;
  }

  read(token: string): { readonly customerId: CustomerId } | null {
    const [body, sig, extra] = token.split(".");
    if (!body || !sig || extra !== undefined) return null;
    const expected = this.#sign(body);
    if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    const [id] = Buffer.from(body, "base64url").toString("utf8").split(".");
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return null;
    return { customerId: customerId(id) };
  }

  #sign(body: string): string {
    return createHmac("sha256", this.#key).update(body).digest("base64url").slice(0, 22);
  }
}
