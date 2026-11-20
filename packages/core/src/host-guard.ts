import { isIP } from "node:net";
import { ReadError } from "./reading.ts";

/**
 * Addresses Quest's reading must never open: loopback, private ranges, link-local
 * (cloud metadata), carrier-grade NAT, multicast, and IPv6 unique-local (which
 * includes Fly's private network, fdaa::/16). The URLs come from customers, so
 * without this the browser could be pointed at our own services.
 */
export function isPrivateAddress(ip: string): boolean {
  const v = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (isIP(v) === 4) {
    const [a = 0, b = 0] = v.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (isIP(v) === 6) {
    if (v === "::" || v === "::1") return true;
    if (v.startsWith("::ffff:")) return isPrivateAddress(v.slice(7));
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(v);
  }
  return false;
}

const BLOCKED_NAMES = /(^|\.)(localhost|internal|local|flycast|home|lan)$/i;

/**
 * Resolves a host and remembers the verdict for a while, so each request of a page costs one lookup at most.
 * `resolve` is the app's DNS lookup; `unresolved` says what a host that does not resolve is: the cloud
 * browser lets it fail on its own ("allow"), while a page read in a customer's Chrome must not reach a
 * name only their own network knows ("refuse").
 */
export class HostGuard {
  readonly #cache = new Map<string, { private: boolean; until: number }>();
  readonly #ttlMs: number;
  readonly #resolve: (host: string) => Promise<string[]>;

  readonly #unresolved: "allow" | "refuse";

  constructor(opts: { resolve: (host: string) => Promise<string[]>; ttlMs?: number; unresolved?: "allow" | "refuse" }) {
    this.#ttlMs = opts.ttlMs ?? 60_000;
    this.#resolve = opts.resolve;
    this.#unresolved = opts.unresolved ?? "allow";
  }

  /** True when the host is, or resolves to, somewhere the browser must not go. */
  async isPrivate(hostname: string): Promise<boolean> {
    const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (isIP(host)) return isPrivateAddress(host);
    if (BLOCKED_NAMES.test(host)) return true;
    const hit = this.#cache.get(host);
    if (hit && hit.until > Date.now()) return hit.private;
    let verdict = false;
    try {
      verdict = (await this.#resolve(host)).some(isPrivateAddress);
    } catch {
      verdict = this.#unresolved === "refuse";
    }
    this.#cache.set(host, { private: verdict, until: Date.now() + this.#ttlMs });
    return verdict;
  }

  /** Validates an address a customer gave, before any page is opened. */
  async check(raw: string): Promise<URL> {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new ReadError("invalid_url", `"${raw}" is not a web address`);
    }
    if (!/^https?:$/.test(url.protocol)) throw new ReadError("invalid_url", "only http and https addresses can be read");
    if (url.username || url.password) throw new ReadError("invalid_url", "addresses with a login in them are not read");
    if (await this.isPrivate(url.hostname)) throw new ReadError("blocked", "that address is not on the public internet");
    return url;
  }
}
