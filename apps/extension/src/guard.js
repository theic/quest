/**
 * Where Quest's tabs may go. The agent checks every address before it sends
 * one; this is the second check, on the machine whose network it would reach:
 * public web pages only, never the customer's router, intranet or this computer.
 */

const LOCAL_NAMES = /(^|\.)(localhost|local|lan|home|internal|intranet|corp|localdomain|home\.arpa)$/i;

/** True for loopback, private, link-local, carrier-grade NAT, multicast and IPv6 local addresses. */
export function isPrivateIp(ip) {
  const v = String(ip ?? "").toLowerCase().replace(/^\[|\]$/g, "");
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
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
  if (v.includes(":")) {
    if (v === "::" || v === "::1") return true;
    if (v.startsWith("::ffff:")) return isPrivateIp(v.slice(7));
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(v);
  }
  return false;
}

/** Why Quest's tabs must not open this address, or null when it may. */
export function refuseUrl(raw) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    return { reason: "invalid_url", message: `"${raw}" is not a web address` };
  }
  if (!/^https?:$/.test(url.protocol)) return { reason: "invalid_url", message: "only http and https pages are read" };
  if (url.username || url.password) return { reason: "invalid_url", message: "addresses with a login in them are not read" };
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host.includes(".") && !host.includes(":")) return { reason: "blocked", message: "that address is not on the public internet" };
  if (LOCAL_NAMES.test(host) || isPrivateIp(host)) return { reason: "blocked", message: "that address is not on the public internet" };
  return null;
}

/**
 * Whether a frame keeps the page out of a picture: one at an address Quest's tabs could not
 * open (this computer, the local network, a login in the address). Empty and inline frames
 * (about:blank, srcdoc, data:, blob:) are the page's own content: Habr has four on every
 * article (measured 2026-10-13), and counting them refused every picture there.
 */
export function privateFrame(raw) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    return false;
  }
  return /^https?:$/.test(url.protocol) && refuseUrl(url.href) !== null;
}
