import { bareHandle, contactKey, isAddress, type Clock, type Closeness, type Contact, type ContactCheck, type ContactRepository, type CustomerId, type Draft, type DraftRepository, type ResultEntry } from "@mq/core";
import { talksWith } from "../drafts/warm-up.ts";
import { contactSite, handleOf, profileUrlOf } from "./handles.ts";

/**
 * Getting to know people slowly (the founder, 2026-11-04: "remembering people is the most important. And get to know
 * them slowly: connect first, warm them up, offer help or provide some feedback immediately if possible"). Quest keeps
 * what a check of someone found (contacts.ts) and reads how close it is with them from what went up to them and what
 * came back: met (checked), connected (a like or a follow of theirs went up), warm (a word to them went up), helped
 * (something given), talking (they answered). Before a first word to anyone, they are checked and connected with.
 */

/** A connection a day old is warm enough to come back to; a word, two days. */
const COME_BACK_AFTER_MS = 20 * 3_600_000;
const WORD_AGAIN_AFTER_MS = 2 * 86_400_000;
/** At most this many people to come back to are named in a run's opening. */
const COME_BACK = 5;

export interface AcquaintanceDeps {
  readonly contacts: ContactRepository;
  readonly drafts: Pick<DraftRepository, "recent">;
  readonly results?: { list(customerId: CustomerId, limit: number): Promise<ResultEntry[]> };
  readonly clock: Clock;
}

/** Whom a draft goes to: the site, and their handle there. */
export function draftPerson(d: Pick<Draft, "kind" | "platform" | "url" | "target" | "author">): { readonly site: string; readonly handle: string } | null {
  const site = d.platform === "reddit" ? "reddit" : contactSite(d.url);
  if (!site) return null;
  const named = d.kind === "follow" || d.kind === "message" ? (isAddress(d.target) ? null : d.target) : d.author;
  const handle = d.kind === "follow" ? (named ?? handleOf(d.url)) : (handleOf(d.url) ?? named);
  return handle?.trim() ? { site, handle: bareHandle(handle) } : null;
}

/** Someone Quest knows, how close it is, and what passed with them last. */
export interface Known {
  readonly contact: Contact;
  readonly closeness: Closeness;
  /** When something of the customer's last went up to them. */
  readonly lastTouch: Date | null;
}

export class Acquaintances {
  readonly #d: AcquaintanceDeps;

  constructor(deps: AcquaintanceDeps) {
    this.#d = deps;
  }

  get(customerId: CustomerId, site: string, handle: string): Promise<Contact | null> {
    return this.#d.contacts.get(customerId, contactKey(site, handle));
  }

  keep(customerId: CustomerId, check: ContactCheck): Promise<Contact> {
    return this.#d.contacts.keep(customerId, check);
  }

  /** Everyone Quest knows on a site (all sites when none), newest first, with how close it is with each. */
  async known(customerId: CustomerId, site: string | null = null, limit = 200): Promise<Known[]> {
    const [contacts, drafts, results] = await Promise.all([this.#d.contacts.list(customerId, limit), this.#d.drafts.recent(customerId, 400), this.#results(customerId)]);
    return contacts.filter((c) => !site || c.site === site).map((c) => this.#closeness(c, drafts, results));
  }

  #closeness(contact: Contact, drafts: readonly Draft[], results: readonly ResultEntry[]): Known {
    const theirs = drafts.filter((d) => {
      const p = draftPerson(d);
      return p && contactKey(p.site, p.handle) === contact.key;
    });
    const up = theirs.filter((d) => d.status === "posted");
    const lastTouch = up.reduce<Date | null>((a, d) => (d.sentAt && (!a || d.sentAt > a) ? d.sentAt : a), null);
    const closeness: Closeness = talksWith(contact.handle, results)
      ? "talking"
      : contact.given.length
        ? "helped"
        : up.some((d) => d.kind === "reply" || d.kind === "message")
          ? "warm"
          : up.some((d) => d.kind === "like" || d.kind === "follow")
            ? "connected"
            : "met";
    return { contact, closeness, lastTouch };
  }

  /**
   * Why a first word to someone may not go yet, or null when it may: they are checked (their profile read, and kept with
   * note_person), and connected with first (a like or a follow of theirs drafted, here or before), unless they talk with
   * the customer already. Reddit has neither, and its replies answer a thread.
   */
  async firstWord(customerId: CustomerId, url: string, who: string | null, connectedNow: boolean): Promise<string | null> {
    const site = contactSite(url);
    const handle = handleOf(url) ?? (who ? bareHandle(who) : null);
    if (!site || site === "reddit" || !handle) return null;
    // A group chat is a thread too, and has no like or follow to connect with first (live, 2026-11-13: in a week no
    // word went up in a Telegram group or a Discord channel).
    if (/(^|\.)(telegram\.org|t\.me|discord\.com)$/.test(site)) return null;
    const contact = await this.get(customerId, site, handle);
    const profile = profileUrlOf(url);
    if (!contact) {
      return `Check them first: read their profile${profile ? ` (read_page ${profile})` : ""} and their site when it names one (read_site, pages 2), then note_person with who they are and what they build. Nobody gets a first word from the customer unchecked.`;
    }
    if (connectedNow) return null;
    const [drafts, results] = await Promise.all([this.#d.drafts.recent(customerId, 400), this.#results(customerId)]);
    if (talksWith(handle, results)) return null;
    const connected = drafts.some((d) => (d.kind === "like" || d.kind === "follow" || d.kind === "reply" || d.kind === "message") && d.status !== "skipped" && draftPerson(d) && contactKey(draftPerson(d)!.site, draftPerson(d)!.handle) === contact.key);
    if (connected) return null;
    return "Connect first: a like on this post of theirs (outreach_draft kind like) or a follow, then the first word. People are got to know slowly: connect, warm up, then help.";
  }

  /**
   * Whether these words are an answer on record: the watch read them off the customer's own notifications. An answer
   * to them is no first word, whoever's page it is under and whatever name the record keeps them by (live, 2026-11-14:
   * a builder who answered the customer's own LinkedIn post was "Check them first" and "quote the thread's exact words"
   * 22 times in a run, and nobody was answered: a comment under their post is on no page the run could read whole).
   */
  async answeredWith(customerId: CustomerId, quote: string | null | undefined): Promise<boolean> {
    const said = (quote ?? "").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 40);
    if (said.length < 12) return false;
    return (await this.#results(customerId)).some((r) => r.stage === "conversation" && r.evidence.toLowerCase().replace(/\s+/g, " ").includes(said));
  }

  /** Whether they already talk with the customer (an answer on record). */
  async talking(customerId: CustomerId, url: string, who: string | null): Promise<boolean> {
    const handle = handleOf(url) ?? (who ? bareHandle(who) : null);
    return Boolean(handle && talksWith(handle, await this.#results(customerId)));
  }

  /**
   * Why a private message to someone may not go yet, or null when it may (the founder, 2026-11-05: "in addition to likes,
   * follows, replies and posts we have to introduce DMs to connect with highly relevant prospects"). Past what any first
   * word needs (`firstWord`): someone who talks with the customer already may get one; anyone else only when the check
   * kept what they are after and what the customer could give them (the fit a message is about), and never a second
   * before they answer the first.
   */
  async dm(customerId: CustomerId, url: string, who: string | null): Promise<string | null> {
    const site = contactSite(url);
    const handle = handleOf(url) ?? (who ? bareHandle(who) : null);
    if (!site || site === "reddit" || !handle) return null;
    const contact = await this.get(customerId, site, handle);
    if (!contact) return null;
    const [drafts, results] = await Promise.all([this.#d.drafts.recent(customerId, 400), this.#results(customerId)]);
    if (talksWith(handle, results)) return null;
    const before = drafts.find((d) => d.kind === "message" && d.status !== "skipped" && draftPerson(d) && contactKey(draftPerson(d)!.site, draftPerson(d)!.handle) === contact.key);
    if (before) return `A private message to @${contact.handle} already ${before.status === "posted" ? "went" : "waits"} (${before.status}), with no answer on record: one at a time. If they have answered in the conversation since, draft again with quote set to their latest words exactly as the conversation page you opened shows them (at least a few words): that is their answer, and the message goes. Otherwise wait.`;
    if (!contact.needs?.trim() || !contact.canGive?.trim())
      return `A private message goes only to someone who fits well: keep with note_person what @${contact.handle} is after (needs) and what the customer could give them (can_give), from their profile and site. When nothing says it, a like and a reply are enough.`;
    return null;
  }

  /**
   * The people on a site to come back to, the warmest first: connected a day ago and never spoken to, or spoken to and
   * not yet helped. Each with what Quest knows, for a run's opening.
   */
  /** The plan kept on the record of whoever wrote a post, or null. */
  async planFor(customerId: CustomerId, postUrl: string, author?: string): Promise<string | null> {
    const site = contactSite(postUrl);
    if (!site) return null;
    const who = handleOf(postUrl);
    const flat = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");
    // An answer is read off a list under a display name ("Shiou" for @iamshiou_tw): the person is found by a name that
    // sits inside their handle, or the other way round, among the people kept on that site with a plan.
    const a = author ? flat(author) : "";
    const near = (h: string): boolean => a.length >= 4 && (flat(h).includes(a) || a.includes(flat(h)));
    const c = author
      ? (await this.#d.contacts.list(customerId, 400)).find((x) => x.site === site && near(x.handle) && x.notes.some((n) => (typeof n === "string" ? n : n.text).includes("Plan:"))) ?? null
      : who ? await this.#d.contacts.get(customerId, contactKey(site, who)) : null;
    const plan = c?.notes.map((n) => (typeof n === "string" ? n : n.text)).reverse().find((n) => n.includes("Plan:"));
    // Long enough for a maker's introductions (introducer.ts `introduceLine`), each a line of its own.
    return plan ? plan.slice(plan.indexOf("Plan:") + 5).trim().slice(0, 2000) : null;
  }

  /** The profile of someone kept on a site, found by the name they answered under (it sits inside their handle or their name, or the other way round); null when nobody kept matches. */
  async profileFor(customerId: CustomerId, onUrl: string, author: string): Promise<string | null> {
    const site = contactSite(onUrl);
    const flat = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");
    const a = flat(author);
    if (!site || a.length < 4) return null;
    const near = (s: string | null): boolean => Boolean(s && flat(s).length >= 4 && (flat(s).includes(a) || a.includes(flat(s))));
    return (await this.#d.contacts.list(customerId, 400)).find((x) => x.site === site && x.profileUrl && (near(x.handle) || near(x.name)))?.profileUrl ?? null;
  }

  async comeBack(customerId: CustomerId, site: string): Promise<string[]> {
    const now = this.#d.clock.now().getTime();
    const due = (await this.known(customerId, site)).filter((k) => {
      const since = now - (k.lastTouch?.getTime() ?? now);
      return (k.closeness === "connected" && since >= COME_BACK_AFTER_MS) || (k.closeness === "warm" && since >= WORD_AGAIN_AFTER_MS);
    });
    return due.slice(0, COME_BACK).map((k) => {
      const c = k.contact;
      const next = k.closeness === "connected" ? "next: a word on their newest post (feedback, or a real question about it)" : `next: help, best with a customer of their own (customers_for)${c.canGive ? `; else ${c.canGive}` : ""}`;
      return `- @${c.handle}${c.profileUrl ? ` ${c.profileUrl}` : ""}: ${c.about}${c.needs ? ` Needs: ${c.needs}` : ""} (${k.closeness}; ${next})`;
    });
  }

  /** What the writer should know of whom it writes to: who they are, what they are after, what passed. Null for a stranger. */
  async about(customerId: CustomerId, url: string, who: string | null): Promise<string | null> {
    const site = contactSite(url);
    const handle = handleOf(url) ?? (who ? bareHandle(who) : null);
    if (!site || !handle) return null;
    const c = await this.get(customerId, site, handle);
    if (!c) return null;
    return [
      `${c.name ?? `@${c.handle}`}: ${c.about}`,
      c.needs ? `What they are after: ${c.needs}` : null,
      c.canGive ? `What the customer could give them: ${c.canGive}` : null,
      c.given.length ? `Given already (never again): ${c.given.join("; ")}` : null,
      c.notes.length ? `What passed: ${c.notes.slice(-3).map((n) => n.text).join("; ")}` : null,
    ]
      .filter(Boolean)
      .join("\n");
  }

  async #results(customerId: CustomerId): Promise<ResultEntry[]> {
    return this.#d.results ? this.#d.results.list(customerId, 300).catch(() => []) : [];
  }
}
