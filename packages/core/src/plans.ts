import type { CustomerId } from "./ids.ts";

/**
 * How the hosted Quest is paid for: free on an invite, or on credits (a newcomer starts with a few dollars free, then buys
 * packs). Credits are dollars of the AI Quest uses for them, shown
 * as money ("$1.00"). Everyone has the same day's limit, counted from their midnight: past it, Quest rests until the next.
 */
export type Access = "invite" | "credits";

/** The credits they bought and what Quest has drawn from them, in dollars. */
export interface Wallet {
  /** Everything credited, first top-up bonus included. */
  readonly paid: number;
  readonly spent: number;
  readonly topUps: number;
}

/** A customer's day so far: what they spent since their midnight, their credits, and the rest they are on. */
export interface DaySpend {
  /** Dollars. */
  readonly spent: number;
  readonly wallet: Wallet | null;
  /** On credits (no invite): Quest stops when they run out. */
  readonly bought: boolean;
  readonly restUntil: Date | null;
}

/** A pack paid for in a Stripe Checkout, counted once. */
export interface TopUp {
  /** Stripe's Checkout session. */
  readonly session: string;
  readonly customerId: CustomerId;
  /** Dollars paid. */
  readonly paid: number;
  /** Dollars added when this is their very first top-up. */
  readonly bonus: number;
}

/** What a top-up came to: the credit (with the bonus when it was their first), the wallet after, and whether it let them in. */
export interface ToppedUp {
  readonly credit: number;
  readonly bonus: number;
  readonly wallet: Wallet;
  readonly letIn: boolean;
}
