import type { CustomerId } from "./ids.ts";

/**
 * Someone Quest got to know for a customer, kept for good (the founder, 2026-11-04: "remembering people is the most
 * important. And get to know them slowly: connect first, warm them up, offer help or provide some feedback immediately
 * if possible"). One per person on a site, keyed by `contactKey`. What a check of them found (their profile, their
 * site) is written here once and read by every later run, the writer and the People tab, so nobody is met cold twice.
 */
export interface Contact {
  readonly customerId: CustomerId;
  /** `<site>:<handle>`, as contactKey makes it: "x.com:dana_builds", "threads.com:maya.codes". */
  readonly key: string;
  /** Where they were met: "x.com", "threads.com", "linkedin.com", "reddit". */
  readonly site: string;
  readonly handle: string;
  readonly name: string | null;
  /** Their profile on that site. */
  readonly profileUrl: string | null;
  /** What they build, when it has an address of its own. */
  readonly siteUrl: string | null;
  /** Who they are and what they build, as their profile and site say. */
  readonly about: string;
  /** What they are after now: first users, feedback on the landing, a cofounder. */
  readonly needs: string | null;
  /** What the customer could give them: feedback on something of theirs, people asking for what they built. */
  readonly canGive: string | null;
  /** What was given to them already, a line each, newest last. */
  readonly given: readonly string[];
  /** What passed, a line each with its day, newest last (at most CONTACT_NOTES). */
  readonly notes: readonly ContactNote[];
  /** When their profile (and their site, when they have one) was read for this record. */
  readonly checkedAt: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ContactNote {
  readonly at: Date;
  readonly text: string;
}

/** What a check of someone found, to keep: every field but the key replaces what was there when given. */
export interface ContactCheck {
  readonly site: string;
  readonly handle: string;
  readonly name?: string | null;
  readonly profileUrl?: string | null;
  readonly siteUrl?: string | null;
  readonly about: string;
  readonly needs?: string | null;
  readonly canGive?: string | null;
  /** Something given to them this time: added to `given`. */
  readonly gave?: string | null;
  /** One line of what happened this time: added to `notes`. */
  readonly note?: string | null;
}

/** The lines of what passed a contact keeps; older ones go. */
export const CONTACT_NOTES = 12;

/** How close Quest is with someone, from what went up to them and what came back: the way it gets to know people. */
export type Closeness = "met" | "connected" | "warm" | "helped" | "talking";
export const CLOSENESS: readonly Closeness[] = ["met", "connected", "warm", "helped", "talking"];

/** A handle as a key holds it: no @ or u/, lower case. */
export const bareHandle = (who: string): string => who.trim().replace(/^@|^\/?u\//i, "").toLowerCase();

/** The key of a person on a site. */
export const contactKey = (site: string, handle: string): string => `${site}:${bareHandle(handle)}`;
