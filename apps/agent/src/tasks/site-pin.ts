import type { StructuredToolInterface } from "@langchain/core/tools";
import { tool } from "langchain";
import { platformGuide, platformOf } from "../platforms.ts";

/**
 * A task pinned to the one site the customer named ("on X" is x.com): its tools refuse every other
 * site, in code. Live, 2026-10-14: asked for people on X, the manager started a scout told "Reddit,
 * X, Indie Hackers…", the scout's search has no X, and it spent its run reading Reddit.
 */

/** What people call a site, to its address. */
const ALIASES: Readonly<Record<string, string>> = {
  x: "x.com",
  twitter: "x.com",
  "twitter.com": "x.com",
  "mobile.twitter.com": "x.com",
  "mobile.x.com": "x.com",
  linkedin: "linkedin.com",
  reddit: "reddit.com",
  "old.reddit.com": "reddit.com",
  facebook: "facebook.com",
  fb: "facebook.com",
  "fb.com": "facebook.com",
  instagram: "instagram.com",
  threads: "threads.net",
  "threads.com": "threads.net",
  bluesky: "bsky.app",
  "hacker news": "news.ycombinator.com",
  hackernews: "news.ycombinator.com",
  hn: "news.ycombinator.com",
  "indie hackers": "indiehackers.com",
  indiehackers: "indiehackers.com",
  "product hunt": "producthunt.com",
  producthunt: "producthunt.com",
  youtube: "youtube.com",
  tiktok: "tiktok.com",
  quora: "quora.com",
  github: "github.com",
  medium: "medium.com",
  "stack overflow": "stackoverflow.com",
};

/** "X", "twitter", "https://x.com/someone", "www.LinkedIn.com" → "x.com", "linkedin.com"; null when it names no site. */
export function siteOf(named: string): string | null {
  const raw = named.trim().toLowerCase().replace(/^@/, "");
  if (!raw) return null;
  if (ALIASES[raw]) return ALIASES[raw];
  const host = (() => {
    try {
      return new URL(/^[a-z]+:\/\//.test(raw) ? raw : `https://${raw}`).hostname;
    } catch {
      return null;
    }
  })();
  if (!host || !host.includes(".") || /\s/.test(raw.split("/")[0]!)) return null;
  const bare = host.replace(/^www\./, "");
  return ALIASES[bare] ?? bare;
}

/** The site an address is on, by the same names: twitter.com is x.com, old.reddit.com is reddit.com. */
export function hostOf(url: string): string | null {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    return ALIASES[host] ?? host;
  } catch {
    return null;
  }
}

/**
 * Whether an address is on the site, or on one of its subdomains, or on another address of the same platform: a task
 * kept to Telegram opens t.me as well as web.telegram.org, one kept to Discord its invites on discord.gg.
 */
export function onSite(url: string, site: string): boolean {
  const host = hostOf(url);
  if (host === null) return false;
  if (host === site || host.endsWith(`.${site}`)) return true;
  const platform = platformOf(site);
  return Boolean(platform && platform.key !== "other" && platformOf(host)?.key === platform.key);
}

/**
 * A site whose groups cannot be found from inside it (a group shows only to its members, and neither has a search across
 * groups worth the name): a task kept to it may also search the web for them, Google included (the founder, 2026-11-13:
 * "You can also search in google for telegram chats"; a web search kept to t.me had found no group at all).
 */
const GROUP_SITES = new Set(["web.telegram.org", "discord.com"]);
const groupSearch = (url: string, site: string): boolean => GROUP_SITES.has(site) && /^(google\.[a-z.]+|duckduckgo\.com|tgstat\.com|[a-z]+\.tgstat\.com|telemetr\.io|combot\.org|tdirectory\.me|disboard\.org|top\.gg)$/.test(hostOf(url) ?? "");

/** The search sources that read one site. The others (the web, Lemmy, Mastodon) span many. */
export const SOURCE_SITES: Readonly<Record<string, string>> = {
  reddit: "reddit.com",
  x: "x.com",
  linkedin: "linkedin.com",
  youtube: "youtube.com",
  hackernews: "news.ycombinator.com",
  bluesky: "bsky.app",
  github: "github.com",
};

/** How a site is searched in their browser, for the sites whose search page is known. `<words>` is the search. */
export const SITE_SEARCH: Readonly<Record<string, string>> = {
  "x.com": "find_people with source x for the people a play names, where you have it; search_posts with source x (newest first, each post with its own address); read_page an X page for its posts as rows; to work the page itself, browser_open https://x.com/search?q=<words>&f=live",
  "linkedin.com": "find_people with source linkedin for the people a play names, where you have it; search_posts with source linkedin; to work the page itself, browser_open https://www.linkedin.com/search/results/content/?keywords=<words>&datePosted=%22past-week%22",
  "youtube.com": "search_posts with source youtube (videos; read_page one to see its comments)",
  "facebook.com": "browser_open https://www.facebook.com/search/posts/?q=<words>",
  "threads.net": "browser_open https://www.threads.com/search?q=<words>&serp_type=default&filter=recent (newest first; without filter=recent it shows top posts of any age)",
  // Measured by hand, 2026-11-02: its tag and keyword searches gave posts weeks old and "comment X" bait.
  "instagram.com": "browser_open https://www.instagram.com/explore/people/ (the accounts it suggests: small builders posting fresh work, once they follow a few), and read the people commenting under a small builder's fresh post; a tag, https://www.instagram.com/explore/tags/<tag>/, gives posts weeks old",
  "tiktok.com": "browser_open https://www.tiktok.com/search?q=<words>",
  "medium.com": "browser_open https://medium.com/search?q=<words>, or a tag's newest, https://medium.com/tag/<tag>/archive (startup, saas, side-project, indie-hackers, entrepreneurship)",
  "substack.com": "browser_open https://substack.com/search/<words>?searching=all_types (posts, Notes and people), and the Notes feed, https://substack.com/notes",
  "tumblr.com": "browser_open https://www.tumblr.com/search/<words>?src=typed_query&post_view=list (Latest), or a tag, https://www.tumblr.com/tagged/<tag> (indiedev, gamedev, devlog, startup, small business)",
  "peerlist.io": "browser_open https://peerlist.io/launchpad (this week's launches and their makers, who want first users) and https://peerlist.io/scroll (the newest posts of builders)",
  "indiehackers.com": "read_page https://www.indiehackers.com/newest (its search was retired in 2026), or a group's page",
  "producthunt.com": "browser_open https://www.producthunt.com/search?q=<words>",
  "reddit.com": "search_posts with source reddit (site: r/name for one community)",
  "news.ycombinator.com": "search_posts with source hackernews",
  "bsky.app": "search_posts with source bluesky",
  "web.telegram.org": "inside a chat, its own search (the magnifier at its top); for public groups, the search box at the top of the chat list, and Google: browser_open https://www.google.com/search?q=<words> with words like telegram group for founders, startup founders chat t.me, indie hackers telegram chat (search_posts with source web works too), then open the t.me links it gives; a public channel's posts with no sign-in at https://t.me/s/<name>",
};

/** The lines a pinned task's opening starts with: the site, how to search it, and its rules. */
export function siteBriefing(site: string): string {
  const how = SITE_SEARCH[site];
  const known = platformOf(site);
  return (
    `THIS TASK WORKS ON ${site} ONLY: the customer asked for it there. Search, read and write on ${site}, and nowhere else; ` +
    `your tools refuse every other site.${how ? ` To search it: ${how}.` : ` Search it with its own search page in their browser.`}` +
    (known ? `

${platformGuide(known, ["rules", "writing"])}` : "")
  );
}

const elsewhere = (site: string, url: string): string =>
  `Not done: ${hostOf(url) ?? url} is not ${site}, and this task works on ${site} only (the customer asked for it there).` +
  (SITE_SEARCH[site] ? ` Search ${site} itself: ${SITE_SEARCH[site]}.` : "");

/** Why this search may not run on a task pinned to `site`, or null when it may. */
export function searchRefusal(site: string, source: string, within?: string, query?: string): string | null {
  if (SOURCE_SITES[source] === site) return null;
  if (source === "web" && GROUP_SITES.has(site)) return null;
  // A web search whose own words keep it to the site ("site:t.me first users") is on the site too: live, 2026-11-12,
  // three Telegram runs wrote it so, were refused, and reached nobody.
  const named = source === "web" ? /(?:^|\s)site:(\S+)/i.exec(query ?? "")?.[1] : undefined;
  if (named && onSite(`https://${named.replace(/^https?:\/\//, "")}`, site)) return null;
  if (source === "web" && within && onSite(`https://${within.replace(/^site:/, "").replace(/^https?:\/\//, "")}`, site)) return null;
  return (
    `Not searched: ${source} is not ${site}, and this task works on ${site} only (the customer asked for it there).` +
    (SITE_SEARCH[site] ? ` Search ${site} itself: ${SITE_SEARCH[site]}.` : ` Search ${site} with its own search page in their browser.`)
  );
}

/** Tools whose `url` argument is where they act: read, open, save or write to. */
const URL_TOOLS = new Set(["read_page", "browser_open", "save_find", "outreach_draft", "save_place"]);

/** Where a browser tool's answer says the tab now is (its JSON carries the page's `url`). */
const landedOn = (out: string): string | null => {
  if (!out.startsWith("{")) return null;
  try {
    const url = (JSON.parse(out) as { url?: unknown }).url;
    return typeof url === "string" ? url : null;
  } catch {
    return null;
  }
};

/**
 * The same tools, kept on one site: an address elsewhere is refused before the tool runs, a search
 * of another source is refused, and a click that leaves the site is reported as such, without the
 * other site's page.
 */
export function pinToSite(tools: readonly StructuredToolInterface[], site: string): StructuredToolInterface[] {
  return tools.map((t) => {
    const guarded = t.name === "search_posts" || t.name === "find_people" || t.name === "browser_act" || URL_TOOLS.has(t.name);
    if (!guarded) return t;
    return tool(
      async (args: Record<string, unknown>) => {
        if (t.name === "search_posts" || t.name === "find_people") {
          const refused = searchRefusal(site, String(args["source"] ?? ""), typeof args["site"] === "string" ? args["site"] : undefined, typeof args["query"] === "string" ? args["query"] : undefined);
          if (refused) return refused;
        } else if (URL_TOOLS.has(t.name) && typeof args["url"] === "string" && !onSite(args["url"], site) && !groupSearch(args["url"], site)) {
          return elsewhere(site, args["url"]);
        }
        const out = await t.invoke(args);
        const text = typeof out === "string" ? out : JSON.stringify(out);
        if (t.name === "browser_act" || t.name === "browser_open") {
          const now = landedOn(text);
          if (now && !onSite(now, site) && !groupSearch(now, site)) return `${elsewhere(site, now)} That click left ${site}: open ${site} again before you go on.`;
        }
        return text;
      },
      { name: t.name, description: t.description, schema: t.schema as never },
    ) as unknown as StructuredToolInterface;
  });
}
