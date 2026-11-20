import { platformOf } from "../platforms.ts";

/**
 * A link to their own site says where it went up (the founder, 2026-11-11: "target link for each platform is a good
 * idea"): `utm_source=<platform>`, which every analytics reads, so their numbers show which platform sends the people
 * who stay, and the "What works" run reads that instead of guessing. Before it, 128 people answered on dev in two weeks
 * and nothing said whether one of them came.
 */

/** A platform's name in a link's tag: "x", "threads", "linkedin", "reddit". */
export const sourceTag = (platform: string): string =>
  (platformOf(platform)?.key ?? platform.toLowerCase().replace(/^www\./, "").split(".")[0]!).replace(/[^a-z0-9]/g, "") || "quest";

const escaped = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Their site's host from its address: "https://www.acme.io/app" gives "acme.io". */
export const siteHost = (siteUrl: string | null | undefined): string | null => {
  if (!siteUrl) return null;
  try {
    return new URL(/^https?:/i.test(siteUrl) ? siteUrl : `https://${siteUrl}`).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
};

/**
 * The words with each link to their site tagged for the platform it goes up on. A link that already says where it is
 * from is left; an email address or another site is never touched.
 */
export function tagLinks(text: string, host: string | null, platform: string): string {
  if (!host || !text.includes(host.split(".")[0]!)) return text;
  const tag = sourceTag(platform);
  const link = new RegExp(`(?<![\\w@.-])((?:https?://)?(?:www\\.)?${escaped(host)})(/[^\\s?#]*)?(\\?[^\\s#]*)?(?=[\\s#.,;:!)"']|$)`, "gi");
  return text.replace(link, (all: string, base: string, path: string | undefined, query: string | undefined) => {
    if (query && /[?&](utm_source|ref)=/i.test(query)) return all;
    // A full stop or a bracket after the link is the sentence's, not the address's.
    const last = query ?? path ?? "";
    const trail = /[.,;:!?)"']+$/.exec(last)?.[0] ?? "";
    const p = query ? (path ?? "/") : (path ?? "/").slice(0, (path ?? "/").length - (path ? trail.length : 0)) || "/";
    const q = query ? `${query.slice(0, query.length - trail.length)}&` : "?";
    return `${base}${p}${q}utm_source=${tag}${trail}`;
  });
}
