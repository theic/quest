/** The same address, however it was written: no fragment, no tracking tags, no trailing slash, lower-case host. */
export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw.trim());
    u.hash = "";
    u.hostname = u.hostname.toLowerCase();
    for (const key of [...u.searchParams.keys()]) if (/^utm_|^ref$|^fbclid$/i.test(key)) u.searchParams.delete(key);
    return u.toString().replace(/\/+$/, "").replace(/\/\?/, "?");
  } catch {
    return raw.trim();
  }
}
