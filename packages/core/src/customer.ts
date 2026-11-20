import type { ChannelAddress } from "./channel.ts";
import type { CustomerId } from "./ids.ts";
import type { Profile } from "./profile.ts";

export type CustomerStatus = "onboarding" | "active" | "paused";

/** One person Quest works for. Created on their first message; no form, no email. */
export interface Customer {
  readonly id: CustomerId;
  readonly displayName: string | null;
  /** Detected BCP 47 code; an explicit /language choice is stored as manual:<code>. */
  readonly language: string | null;
  readonly siteUrl: string | null;
  readonly status: CustomerStatus;
  /** What Quest knows about their offer, in the site's own facts. Every teammate reads it. */
  readonly brief: string | null;
  /** Where Quest is and what it is trying next, in its own words; rewritten as it goes. */
  readonly plan: string | null;
  /** Their IANA time zone ("Europe/Kyiv"); null until Quest learns it. */
  readonly timezone: string | null;
  /** The hour of their day the evening report goes out. */
  readonly reportHour: number;
  /** Their takes on their first day (Quest writing as them until it is them), and where they show up, by key. */
  readonly profile: Profile;
  /** Whether Quest's tab may come to the front of their screen (the switch on their page); off, their Chrome works in the background. */
  readonly chromeFront: boolean;
  /**
   * When they switched Quest off (the switch in their chat or on their page, `/off`); null while it is on. Off, the
   * heavy work stops: no runs, nothing in their Chrome, nothing posted, no heartbeat or report. The manager still
   * answers what they write.
   */
  readonly offAt: Date | null;
  /**
   * When their first sweep ended (finds/sweep.ts): the sites where their people ask, read by code once their brief and
   * their Chrome are there. Null until then; the first-day cards wait for it.
   */
  readonly sweptAt: Date | null;
  /**
   * When they were let in (conversation/waitlist.ts): by an invite's code, or by hand in the database. Null while they
   * wait: they can write, and nothing is done for them.
   */
  readonly activatedAt: Date | null;
  readonly createdAt: Date;
}

export interface NewCustomer {
  readonly channel: ChannelAddress;
  readonly userRef: string;
  readonly displayName: string | null;
  readonly language: string | null;
}

export type CustomerPatch = Partial<Pick<Customer, "displayName" | "language" | "siteUrl" | "status" | "brief" | "plan" | "timezone" | "reportHour" | "chromeFront" | "offAt" | "sweptAt" | "activatedAt">> & {
  /** Where they came from, as their start link's tag says ("x", "threads"): kept once, when they first write. */
  readonly cameFrom?: string;
};
