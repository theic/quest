import type { CustomerId } from "@mq/core";
import { contactSite, handleOf } from "./handles.ts";

/**
 * Whoever asked to be left alone gets nothing more (the founder, 2026-11-18: "The agent must be very precise about opt
 * outs: if someone asks not to do it, don't"). Live, the same day: someone on Bluesky answered an introduction with
 * "please don't tag me under anything using generative AI". The watch kept it as a warm conversation, planned a second
 * message, and a reply and a private message to them were drafted after it. Their no is kept for good (mq.said_no),
 * and no draft of any kind is offered or sent to them again, a like included; only the customer's own dictated words go.
 */

const NO: readonly RegExp[] = [
  // Said to them, not of the speaker's own habits ("I don't reply to DMs").
  /(?<!\b(i|we) )\b(don['’]?t|do not|stop|quit)( ever| please)? (tag(ging)?|mention(ing)?|messag(e|ing)|dm(ing)?|reply(ing)?|contact(ing)?|email(ing)?|spam(ming)?|bother(ing)?|writ(e|ing) to)\b/i,
  /\b(leave me (alone|out)|not interested|no,? thank(s| you)|unsubscribe|remove me|go away|get lost|f[u*]ck off|piss off|blocked|reported)\b/i,
  // Called a bot or spam to their face: "What is your end game, bot?"
  /,\s*bot\s*[?!.]*$/i,
  /\b(you['’]?re|you are|this is) (a )?(bot|spam|scam)\b/i,
];

/** Whether their words ask to be left alone: no more tags, messages or replies, "not interested", "no thanks". */
export const saysNo = (text: string): boolean => NO.some((re) => re.test(text.replace(/\s+/g, " ").trim()));

export interface Refusal {
  readonly site: string;
  readonly person: string;
  readonly words: string;
}

export interface SaidNoStore {
  list(customerId: CustomerId): Promise<Refusal[]>;
  add(customerId: CustomerId, no: Refusal & { url: string | null }): Promise<void>;
}

const flat = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

export class SaidNo {
  readonly #store: SaidNoStore;
  /** Only this process writes them, so each customer's are read once. */
  readonly #kept = new Map<CustomerId, Promise<Refusal[]>>();

  constructor(store: SaidNoStore) {
    this.#store = store;
  }

  #list(customerId: CustomerId): Promise<Refusal[]> {
    let kept = this.#kept.get(customerId);
    if (!kept) {
      kept = this.#store.list(customerId);
      this.#kept.set(customerId, kept);
      kept.catch(() => this.#kept.delete(customerId));
    }
    return kept;
  }

  /** Their no, kept once a person. */
  async note(customerId: CustomerId, url: string, person: string, words: string): Promise<void> {
    const site = contactSite(url);
    if (!site || !person.trim() || (await this.who(customerId, url, [person]))) return;
    const no = { site, person: person.trim().slice(0, 200), words: words.trim().slice(0, 500) };
    await this.#store.add(customerId, { ...no, url });
    (await this.#list(customerId)).push(no);
  }

  /**
   * The no of whoever something at this address would go to, or null. They are known by the address's own handle and by
   * each name given; an answer read off a list keeps a display name, so a name of five letters or more that sits inside
   * the other counts too ("Saba Reyes" for @sabareyes).
   */
  async who(customerId: CustomerId, url: string, names: readonly (string | null | undefined)[]): Promise<Refusal | null> {
    const site = contactSite(url);
    if (!site) return null;
    const keys = [handleOf(url), ...names].map((n) => flat(n ?? "")).filter((k) => k.length >= 2);
    if (!keys.length) return null;
    const near = (a: string, b: string): boolean => a === b || (a.length >= 5 && b.length >= 5 && (a.includes(b) || b.includes(a)));
    return (await this.#list(customerId)).find((r) => r.site === site && keys.some((k) => near(k, flat(r.person)))) ?? null;
  }

  /** Whoever of them these words name by handle: a tag under someone else's post is theirs to refuse too. */
  async tagged(customerId: CustomerId, text: string): Promise<Refusal | null> {
    const said = text.toLowerCase();
    return (await this.#list(customerId)).find((r) => /^@?[\w-]+([._][\w-]+)+$|^@\w{3,}$/.test(r.person) && said.includes(r.person.replace(/^@/, "").toLowerCase())) ?? null;
  }
}

/** What a tool hears when it drafts for someone who said no. */
export const noRefusal = (r: Refusal): string => `${r.person} asked to be left alone ("${r.words.slice(0, 160)}"). Nothing more goes to them: no reply, no message, no like, no follow, no tag under anyone's post. Draft nothing for them again.`;
