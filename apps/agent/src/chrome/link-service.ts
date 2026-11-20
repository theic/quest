import { createHash, randomBytes, randomInt } from "node:crypto";
import type { ChromeLink, ChromeLinkRepository, ChromeStatus, Clock, CustomerId, EventSink, Logger } from "@mq/core";
import { DONE_MARK, type Messenger } from "../conversation/messenger.ts";
import { SUPPORT_LINK, SUPPORT_URL } from "../conversation/support.ts";
import type { ChromeBroker } from "./broker.ts";

/** No 0/O, 1/I: a code someone may have to type. */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_TTL_MS = 15 * 60_000;
/**
 * The setup, or a silent Chrome's reconnect link, goes out once in half a day, unless they ask (/connect, or the
 * manager's again: true). A Chrome that is connected but silent is most often just closed or asleep, and a link does
 * nothing for that (four in one morning, live 2026-10-01). The setup went out every few minutes while a newcomer
 * answered the first-day cards, each turn seeing their Chrome not connected (three or four times in the first runs
 * of 2026-10-17); its message stays in the chat, and an expired code's page says to send /connect.
 */
export const OFFER_AGAIN_AFTER_MS = 12 * 3_600_000;
const SEEN_EVERY_MS = 60_000;
const TOKEN_CACHE_MS = 60_000;

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

/** "k7p2 9qxm", "K7P2-9QXM" → "K7P29QXM". */
export const normalizeCode = (raw: string): string => raw.toUpperCase().replace(/[^A-Z0-9]/g, "");

export const newCode = (): string => {
  let code = "";
  for (let i = 0; i < 8; i++) code += ALPHABET[randomInt(ALPHABET.length)];
  return code;
};

/** "K7P29QXM" → "K7P2-9QXM", easier to read and type. */
export const showCode = (code: string): string => `${code.slice(0, 4)}-${code.slice(4)}`;

export interface ChromeLinkServiceDeps {
  readonly links: ChromeLinkRepository;
  readonly broker: ChromeBroker;
  readonly messenger: Pick<Messenger, "say" | "sendLinks">;
  readonly events: EventSink;
  readonly wakeManager: () => void;
  /** Where the agent's pages are served: the connect link points there. */
  readonly publicUrl: string;
  readonly clock: Clock;
  readonly log: Logger;
}

export type OfferOutcome =
  | { readonly sent: true; readonly code: string }
  | { readonly sent: false; readonly why: "connected" }
  | { readonly sent: false; readonly why: "recent"; readonly at: Date };

/**
 * Connecting a customer's Chrome: the setup message with a one-time code, the
 * trade of that code for the extension's token, and how the connection stands.
 */
export class ChromeLinkService {
  readonly #d: ChromeLinkServiceDeps;
  readonly #tokens = new Map<string, { link: ChromeLink; until: number }>();
  readonly #seenAt = new Map<string, number>();
  /** Customers whose manager held a task back for an offline Chrome. */
  readonly #awaited = new Set<string>();

  constructor(deps: ChromeLinkServiceDeps) {
    this.#d = deps;
    deps.broker.whenOnline((id) => void this.#backOnline(id));
  }

  /** The manager held work back for this customer's Chrome: it hears when the Chrome is back. */
  awaitOnline(customerId: CustomerId): void {
    this.#awaited.add(customerId);
  }

  async #backOnline(customerId: CustomerId): Promise<void> {
    if (!this.#awaited.delete(customerId)) return;
    try {
      await this.#d.events.push(customerId, {
        kind: "system",
        topic: "chrome",
        text: "The customer's Chrome is open again. Start the work you held back for it.",
      });
      this.#d.wakeManager();
    } catch (e) {
      this.#d.log.warn("chrome.online_note_failed", { customerId, error: e instanceof Error ? e.message : String(e) });
    }
  }

  /**
   * Sends the customer the steps to install the extension and connect it.
   * `force` (they asked with /connect) sends a fresh code even if one went out
   * a moment ago, and even if a Chrome is connected (they may want another).
   */
  async offer(customerId: CustomerId, opts: { force?: boolean } = {}): Promise<OfferOutcome> {
    const now = this.#d.clock.now();
    const status = await this.status(customerId);
    if (!opts.force) {
      if (status.linked && status.online) return { sent: false, why: "connected" };
      const last = await this.#d.links.lastOffer(customerId);
      if (last && now.getTime() - last.getTime() < OFFER_AGAIN_AFTER_MS) return { sent: false, why: "recent", at: last };
    }
    const code = newCode();
    await this.#d.links.offer(customerId, sha256(code), new Date(now.getTime() + CODE_TTL_MS));
    const base = this.#d.publicUrl;
    const connect = `${base}/connect#${showCode(code)}`;
    // A Chrome that is connected but silent has the extension already: it needs the link, not the install
    // steps (its extension may be asking a Quest address that moved, live 2026-09-30).
    if (status.linked && !status.online) {
      await this.#d.messenger.sendLinks(
        customerId,
        reconnectText(showCode(code)),
        [
          { label: "Reconnect Chrome", url: connect },
          { label: "Set up another Chrome", url: `${base}/chrome` },
          { label: SUPPORT_LINK, url: SUPPORT_URL },
        ],
      );
    } else {
      // One button: the connect page offers the install when the extension is missing, and connects once it is there.
      await this.#d.messenger.sendLinks(customerId, setupText(showCode(code)), [
        { label: "Connect Chrome", url: connect },
        { label: SUPPORT_LINK, url: SUPPORT_URL },
      ]);
    }
    this.#d.log.info("chrome.offered", { customerId });
    return { sent: true, code };
  }

  /**
   * The setup, once, to someone who has told Quest what they work on and was never sent it: the manager is told to
   * call connect_chrome and does not always (live replay, 2026-10-24: "Connect your Chrome and I'll start", with no
   * steps). Never twice, and never to a Chrome that is connected.
   */
  async offerFirst(customerId: CustomerId): Promise<OfferOutcome> {
    if (await this.#d.links.lastOffer(customerId)) return { sent: false, why: "recent", at: (await this.#d.links.lastOffer(customerId))! };
    return this.offer(customerId);
  }

  /** Trades a code for a token. Null when the code is unknown, used or expired. */
  /**
   * The Chrome that met Quest first (someone new who started in its popup, no Telegram): connected at once, with nothing
   * said, since the popup is where they talk.
   */
  async pairNew(customerId: CustomerId, device: string | null): Promise<{ token: string; link: ChromeLink } | null> {
    const code = newCode();
    await this.#d.links.offer(customerId, sha256(code), new Date(this.#d.clock.now().getTime() + CODE_TTL_MS));
    return this.pair(code, device, true);
  }

  async pair(rawCode: string, device: string | null, quiet = false): Promise<{ token: string; link: ChromeLink } | null> {
    const code = normalizeCode(rawCode);
    if (code.length !== 8) return null;
    const token = randomBytes(32).toString("base64url");
    const link = await this.#d.links.redeem(sha256(code), sha256(token), device?.slice(0, 80) ?? null, this.#d.clock.now());
    if (!link) return null;
    // The Chrome it replaces stops working now, not when its cached token runs out; whatever waited on it can stop waiting.
    for (const [hash, t] of this.#tokens) if (t.link.customerId === link.customerId) this.#tokens.delete(hash);
    this.#d.broker.drop(link.customerId);
    this.#awaited.delete(link.customerId);
    this.#d.log.info("chrome.paired", { customerId: link.customerId, device: link.device });
    if (quiet) return { token, link };
    await this.#d.messenger.say(
      link.customerId,
      `${DONE_MARK}Chrome connected${link.device ? ` (${link.device})` : ""}. I read behind your tabs, so keep working. If you close Chrome, I pause until it's back.`,
    );
    await this.#d.events.push(link.customerId, {
      kind: "system",
      topic: "chrome",
      text:
        `The customer connected their Chrome${link.device ? ` (${link.device})` : ""}, and it has been told so. ` +
        "Your team can read and search the web now: start whatever was waiting on it, and tell them with message_user, in a line, what you are starting and when they will hear back.",
    });
    this.#d.wakeManager();
    return { token, link };
  }

  /** The connection a token stands for, or null when it is unknown or disconnected. */
  async authenticate(token: string): Promise<ChromeLink | null> {
    const hash = sha256(token);
    const now = this.#d.clock.now().getTime();
    const hit = this.#tokens.get(hash);
    const link = hit && hit.until > now ? hit.link : await this.#d.links.byToken(hash);
    if (!link) {
      this.#tokens.delete(hash);
      return null;
    }
    if (!hit || hit.until <= now) this.#tokens.set(hash, { link, until: now + TOKEN_CACHE_MS });
    if (now - (this.#seenAt.get(link.id) ?? 0) > SEEN_EVERY_MS) {
      this.#seenAt.set(link.id, now);
      await this.#d.links.seen(link.id, new Date(now));
    }
    return link;
  }

  /** The extension's "Disconnect", or a token that stopped working. */
  async disconnect(link: ChromeLink): Promise<void> {
    const closed = await this.#d.links.revoke(link.id, this.#d.clock.now());
    for (const [hash, t] of this.#tokens) if (t.link.id === link.id) this.#tokens.delete(hash);
    if (!closed) return;
    this.#d.broker.drop(link.customerId);
    this.#d.log.info("chrome.disconnected", { customerId: link.customerId });
    await this.#d.messenger.say(link.customerId, "Chrome disconnected. Quest can't read or search the web until you connect it again: send /connect.");
    await this.#d.events.push(link.customerId, {
      kind: "system",
      topic: "chrome",
      text: "The customer disconnected their Chrome, and was told how to connect it again. Nothing can be read or searched until they do.",
    });
    this.#d.wakeManager();
  }

  async status(customerId: CustomerId): Promise<ChromeStatus> {
    const link = await this.#d.links.active(customerId);
    if (!link) {
      const offeredAt = await this.#d.links.lastOffer(customerId);
      const recent = offeredAt && this.#d.clock.now().getTime() - offeredAt.getTime() < OFFER_AGAIN_AFTER_MS;
      return { linked: false, online: false, device: null, lastSeenAt: null, ...(recent ? { offeredAt } : {}) };
    }
    const contact = this.#d.broker.lastContact(customerId);
    const lastSeenAt = contact && (!link.lastSeenAt || contact > link.lastSeenAt) ? contact : link.lastSeenAt;
    const hidden = this.#d.broker.hiddenReads(customerId);
    return { linked: true, online: this.#d.broker.online(customerId), device: link.device, lastSeenAt, ...(hidden ? { hidden } : {}) };
  }
}

function reconnectText(code: string): string {
  return [
    "I haven't heard from your Chrome in a while. If it's open, open “Reconnect Chrome” in it.",
    "",
    `If that opens somewhere else: in the extension, choose Disconnect this Chrome and enter ${code} (good for 15 minutes).`,
  ].join("\n");
}

function setupText(code: string): string {
  return [
    "I read where your people ask in your own Chrome, so open this there, on a computer. Nothing goes up without your OK.",
    "",
    `If that page doesn't open in Chrome, enter the code ${code} in the extension. It works for 15 minutes.`,
  ].join("\n");
}
