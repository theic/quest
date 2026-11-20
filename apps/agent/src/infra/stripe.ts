import { createHmac, timingSafeEqual } from "node:crypto";

/** The parts of a Checkout Session Quest reads. */
export interface StripeCheckoutSession {
  readonly id: string;
  readonly url: string | null;
  readonly mode?: string;
  /** "paid", "unpaid" (a late payment method, not through yet) or "no_payment_required". */
  readonly payment_status?: string;
  /** What Stripe took, in cents, and its currency. */
  readonly amount_total?: number | null;
  readonly currency?: string | null;
  readonly client_reference_id?: string | null;
  readonly customer?: string | null;
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface StripeEvent {
  readonly id: string;
  readonly type: string;
  readonly data: { readonly object: Record<string, unknown> };
}

type Params = Readonly<Record<string, string | number | boolean | null | undefined>>;

/** Stripe's answer was an error: its message, and its code when it gave one. */
export class StripeError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly param: string | null;
  constructor(status: number, message: string, code: string | null, param: string | null) {
    super(message);
    this.status = status;
    this.code = code;
    this.param = param;
  }
}

/**
 * The few calls Quest makes to Stripe, over its REST API with the secret key (no SDK). A pack's price goes with each
 * Checkout (`price_data`), so nothing needs making in Stripe first, in test mode or live; scripts/stripe-setup.ts
 * makes the webhook.
 */
export class StripeApi {
  readonly #key: string;
  readonly #fetch: typeof fetch;

  constructor(secretKey: string, fetchFn: typeof fetch = fetch) {
    this.#key = secretKey;
    this.#fetch = fetchFn;
  }

  /** True in test mode: no money moves. */
  get testMode(): boolean {
    return this.#key.startsWith("sk_test_") || this.#key.startsWith("rk_test_");
  }

  async call<T>(method: "GET" | "POST" | "DELETE", path: string, params: Params = {}): Promise<T> {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) body.append(k, String(v));
    const query = method === "GET" && [...body].length ? `?${body}` : "";
    const res = await this.#fetch(`https://api.stripe.com/v1/${path}${query}`, {
      method,
      headers: { Authorization: `Bearer ${this.#key}`, ...(method === "GET" ? {} : { "Content-Type": "application/x-www-form-urlencoded" }) },
      ...(method === "GET" ? {} : { body: body.toString() }),
      signal: AbortSignal.timeout(20_000),
    });
    const json = (await res.json().catch(() => ({}))) as { error?: { message?: string; code?: string; param?: string } };
    if (!res.ok) throw new StripeError(res.status, json.error?.message ?? `Stripe answered ${res.status}`, json.error?.code ?? null, json.error?.param ?? null);
    return json as T;
  }

  checkout(params: Params): Promise<StripeCheckoutSession> {
    return this.call<StripeCheckoutSession>("POST", "checkout/sessions", params);
  }
}

/**
 * Whether Stripe signed this webhook (docs.stripe.com/webhooks#verify-manually): the `Stripe-Signature` header's
 * `t` and `v1`, an HMAC-SHA256 of `t.payload` with the endpoint's secret, and `t` no older than `toleranceS`.
 */
export function stripeSigned(payload: string, header: string | undefined, secret: string, nowS: number, toleranceS = 300): boolean {
  if (!header || !secret) return false;
  const parts = header.split(",").map((p) => p.split("=") as [string, string | undefined]);
  const t = Number(parts.find(([k]) => k === "t")?.[1]);
  if (!Number.isFinite(t) || Math.abs(nowS - t) > toleranceS) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex"));
  return parts.some(([k, v]) => k === "v1" && v !== undefined && v.length === expected.length && timingSafeEqual(Buffer.from(v), expected));
}

/** A `Stripe-Signature` header for a payload, as Stripe makes one: for tests and for replaying an event to a laptop agent. */
export function stripeSignature(payload: string, secret: string, nowS: number): string {
  return `t=${nowS},v1=${createHmac("sha256", secret).update(`${nowS}.${payload}`).digest("hex")}`;
}
