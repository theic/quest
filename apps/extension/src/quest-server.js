/**
 * Which Quest this Chrome may connect to.
 *
 * Once connected, the server gets pages read in this Chrome, where the customer is
 * signed in, and drafts posted from their accounts. So an install from the Chrome
 * Web Store connects only to Quest's own address: a code typed into the popup, or a
 * connect page served from somewhere else, never hands this Chrome to another server.
 * A release loaded unpacked (the zip messaging.quest offers beside the store listing) is
 * a customer's, not a developer's: it connects only to Quest's own address, as a store
 * install does. The one other address a release pairs with is the local edition's, Quest running on this computer
 * (npm start, http://localhost:8787): what it reads stays on this computer.
 *
 * An unpacked build (a developer's, `installType` "development") is the dev extension: it
 * connects to a dev agent (`npm run dev`, @TestPatrikBot, http://localhost:8080 unless the
 * popup says another address), never to production. Production runs the published
 * extension only; to try a build against it, load its release zip (npm run extension:pack).
 */
import { RELEASE } from "./release.js";

/** Production: @messagingquestbot's agent. */
export const DEFAULT_SERVER = "https://mq-v2-agent.fly.dev";
/** The local edition on this computer (npm start): the one address besides production's a release pairs with. */
export const LOCAL_SERVER = "http://localhost:8787";
/** The dev agent on this computer (npm run dev): where an unpacked build pairs unless told otherwise. */
export const DEV_SERVER = "http://localhost:8080";

const isHttp = (s) => /^https?:\/\/[^/]+$/.test(String(s ?? ""));

/**
 * The server to pair with, or null when this install may not connect there.
 * `origin` is the connect page's own origin (never what the page says); `asked` is the
 * address typed in the popup, which only an unpacked build shows.
 * @param {{ development: boolean, origin?: string, asked?: unknown }} where
 * @returns {string | null}
 */
export function pairingServer({ development, origin, asked }) {
  const typed = asked ? String(asked).trim().replace(/\/+$/, "") : "";
  const server = origin ?? (development ? typed || DEV_SERVER : typed === LOCAL_SERVER ? LOCAL_SERVER : DEFAULT_SERVER);
  if (!isHttp(server)) return null;
  if (!development && server === LOCAL_SERVER) return server;
  return development === (server !== DEFAULT_SERVER) ? server : null;
}

/**
 * Why this install may not pair where it was asked to (pairingServer said null), in the words the popup or page shows.
 * @param {{ development: boolean, origin?: string, asked?: unknown }} where
 */
export function refusal({ development, origin, asked }) {
  if (!development) return `This Chrome connects only to Quest at ${new URL(DEFAULT_SERVER).host}, or to Quest on this computer (${new URL(LOCAL_SERVER).host}).`;
  const server = origin ?? String(asked ?? "").trim().replace(/\/+$/, "");
  return server === DEFAULT_SERVER
    ? "This is the dev extension: it connects only to a dev agent (npm run dev), never to Quest's own. Production runs the published extension."
    : "That is not a Quest address.";
}

/**
 * Whether this is a developer's unpacked build. Store, policy and sideloaded installs are not, nor is a
 * release loaded unpacked, nor a Chrome that will not say.
 */
export async function unpacked(management, release = RELEASE) {
  if (release) return false;
  try {
    return (await management.getSelf()).installType === "development";
  } catch {
    return false;
  }
}
