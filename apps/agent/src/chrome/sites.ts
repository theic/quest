import type { ChromeJob, ChromeRead, DomSpec, FoundPost, PostQuery, SourceInfo } from "@mq/core";

/**
 * The big sites, read by code: a search page or a listing is cut into posts (who, when, their words, the post's own
 * address, how many answered) by a spec the extension runs, never read whole by a model. The founder, 2026-10-23:
 * browsing "cheaper and faster". A post is a few hundred characters where the page was 24,000.
 *
 * Measured in the dev founder's Chrome, 2026-10-23, in a background tab (`visible` false) unless it says drawn:
 * - X search (`/search?q=…&f=live`): 5 posts as `article[data-testid=tweet]`, each with `time[datetime]` inside the
 *   link to its status, `[data-testid=tweetText]`, and counts in the aria-labels of reply/retweet/like, in the
 *   account's own language ("22 Відповіді. Відповідь"). A drawn read was refused: Chrome was covered.
 * - LinkedIn content search: 3 posts in the background, 6 drawn. The new layout (server-driven, class names
 *   scrambled) marks each post `componentkey="expanded<id>FeedType_…"`, its words in
 *   `[data-testid=expandable-text-box]`; most posts carry no link of their own (one in six did, `/feed/update/…`), so
 *   the author's recent activity is where to find it. The older layout's `data-urn="urn:li:activity:…"` is kept.
 * - YouTube results: 19 videos as `ytd-video-renderer`, title, channel, a line of its description, "3mo ago".
 * - Indie Hackers: its search is gone ("Indie Hackers retired this feature in 2026", HTTP 410); `/newest` lists 23
 *   posts as `.story` (title, who, comments, "25m").
 * - Threads search, logged out there: "No results." Instagram's keyword search: 3 posts, pictures with no words.
 *   Neither is cut here; Bluesky and Hacker News are searched through their public APIs (`sources/`).
 */
export interface SiteReader {
  /** The source's name in search_posts, and the post's `source`. */
  readonly key: string;
  /** Set when search_posts searches it. */
  readonly info?: SourceInfo;
  /** Its search page for the words. */
  searchUrl?(q: PostQuery, now: Date): string;
  /** Whether this is a page it cuts into posts: a search, a listing, a profile, a thread. */
  cuts(url: URL): boolean;
  job(url: string): ChromeJob;
  postsFrom(r: ChromeRead, now: Date): FoundPost[];
  /** What the page says above its posts, in a few lines: a profile's name, bio and site. Null when none. */
  aboutFrom?(r: ChromeRead): string | null;
  /** Whom the page is read as: the customer's own name on the site. */
  accountFrom?(r: ChromeRead): string | null;
}

type Row = Readonly<Record<string, unknown>>;

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const rowsOf = (r: ChromeRead, name: string): readonly Row[] => r.rows[name] ?? [];
const hostIs = (url: URL, host: string): boolean => url.hostname === host || url.hostname.endsWith(`.${host}`);

const UNIT_MS: Readonly<Record<string, number>> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000, mo: 30 * 86_400_000, y: 365 * 86_400_000 };
const UNIT_OF: Readonly<Record<string, keyof typeof UNIT_MS>> = {
  s: "s", sec: "s", second: "s",
  m: "m", min: "m", minute: "m",
  h: "h", hr: "h", hour: "h",
  d: "d", day: "d",
  w: "w", wk: "w", week: "w",
  mo: "mo", mon: "mo", month: "mo",
  y: "y", yr: "y", year: "y",
};

/** "11m", "1h", "2d • Edited", "3mo ago", "1 year ago", "5 days ago" → about when; null for anything else. */
export function agoDate(raw: unknown, now: Date): Date | null {
  const m = /^(\d+)\s*(s|sec|seconds?|m|min|minutes?|h|hr|hours?|d|days?|w|wk|weeks?|mo|mon|months?|y|yr|years?)\b/i.exec(str(raw) ?? "");
  if (!m) return null;
  const word = m[2]!.toLowerCase();
  const unit = UNIT_OF[word] ?? UNIT_OF[word.replace(/s$/, "")];
  return unit ? new Date(now.getTime() - Number(m[1]) * UNIT_MS[unit]!) : null;
}

/** The first number in a label, in any language: "22 Відповіді. Відповідь" → 22, "1.2K replies" → 1200, "1,5 тис." → 1500. */
export function leadingCount(raw: unknown): number | null {
  const m = /^\s*(\d[\d\s ]*(?:[.,]\d+)?)\s*(k|тис|тыс|m|млн)?/i.exec(str(raw) ?? "");
  if (!m) return null;
  const digits = m[1]!.replace(/[\s ]/g, "");
  const scaled = m[2] ? Number(digits.replace(",", ".")) * (/^(m|млн)$/i.test(m[2]) ? 1_000_000 : 1_000) : Number(digits.replace(/[.,]/g, ""));
  return Number.isFinite(scaled) ? Math.round(scaled) : null;
}

/** An address as a person opens it: without tracking, its fragment, or a trailing slash a site adds. */
function bare(raw: string | null, base: string, keep: readonly string[] = []): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw, base);
    const kept = new URLSearchParams();
    for (const k of keep) {
      const v = u.searchParams.get(k);
      if (v !== null) kept.set(k, v);
    }
    u.search = kept.toString();
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

const daysBack = (within: PostQuery["within"], now: Date): string | null => {
  const days = { day: 1, week: 7, month: 30, year: 365 }[within ?? "year"];
  return new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
};

/* ------------------------------------------------------------------- X */

const TWEETS: DomSpec = {
  items: "article[data-testid='tweet']",
  limit: 40,
  fields: {
    // The status link is the one around the post's time; a quoted post has its own further down.
    href: "href:a[href*='/status/']:has(time)",
    at: "attr:datetime@time",
    name: "text:[data-testid='User-Name']",
    text: "text:[data-testid='tweetText']",
    replies: "attr:aria-label@[data-testid='reply']",
  },
};

/** A profile's header, on a profile page: who they are, their bio, their site, how many follow them. */
const X_PROFILE: DomSpec = {
  items: "[data-testid='primaryColumn']",
  limit: 1,
  fields: {
    name: "text:[data-testid='UserName']",
    bio: "text:[data-testid='UserDescription']",
    site: "text:[data-testid='UserUrl']",
    details: "text:[data-testid='UserProfileHeader_Items']",
    following: "text:a[href$='/following']",
    followers: "text:a[href$='/verified_followers']|text:a[href$='/followers']",
  },
};

/** The left bar's link to their own profile: whom X shows the page to. */
const X_ME: DomSpec = { items: "a[data-testid='AppTabBar_Profile_Link']", limit: 1, fields: { href: "href" } };

const STATUS = /^\/([A-Za-z0-9_]{1,15})\/status\/(\d+)/;

export const X: SiteReader = {
  key: "x",
  info: {
    name: "x",
    covers: "X (Twitter) posts, newest first, read in the customer's own Chrome where they are signed in: about 5 posts a search, each with its own address",
    queryHint: "the few words a person would post, e.g. typeform alternative; X's own words work too: lang:en, -filter:replies, min_faves:2",
  },
  searchUrl: (q, now) => `https://x.com/search?q=${encodeURIComponent(`${q.query} since:${daysBack(q.within ?? "month", now)}`)}&f=live`,
  // A thread is cut too, into its post and the replies under it, each by its own person (2026-10-31: a page of X was
  // 24,000 characters a model read whole, a few hundred in its posts).
  cuts: (url) => (hostIs(url, "x.com") || hostIs(url, "twitter.com")) && !/^\/(i|settings|messages|compose)\b/.test(url.pathname) && !/\/status\/\d+\/(photo|video|analytics|quotes|retweets|likes)\b/.test(url.pathname),
  job: (url) => ({ url, take: { text: true, specs: { tweets: TWEETS, profile: X_PROFILE, me: X_ME } }, waitFor: "article[data-testid='tweet']", settleMs: 8_000 }),
  aboutFrom(r) {
    const p = rowsOf(r, "profile")[0];
    if (!p || (!str(p.name) && !str(p.bio))) return null;
    // X draws a link in a bio as "http://" and its host apart; they read as one.
    const line = (label: string, v: unknown) => (str(v) ? `${label}: ${str(v)!.replace(/https?:\/\/\s*/g, "").replace(/\s*\n\s*/g, " · ")}` : "");
    return [line("Profile", p.name), line("Bio", p.bio), line("Site", p.site), line("Details", p.details), [str(p.following), str(p.followers)].filter(Boolean).join(" · ")]
      .filter(Boolean)
      .join("\n");
  },
  accountFrom(r) {
    const href = bare(str(rowsOf(r, "me")[0]?.href), "https://x.com/");
    const m = href ? /^\/([A-Za-z0-9_]{1,15})\/?$/.exec(new URL(href).pathname) : null;
    return m ? m[1]! : null;
  },
  postsFrom(r) {
    const out: FoundPost[] = [];
    const seen = new Set<string>();
    for (const row of rowsOf(r, "tweets")) {
      const href = bare(str(row.href), "https://x.com/");
      const m = href ? STATUS.exec(new URL(href).pathname) : null;
      const text = str(row.text);
      // No time, no status link: a promoted post, or one that did not finish drawing.
      if (!href || !m || !text || seen.has(m[2]!)) continue;
      seen.add(m[2]!);
      const at = str(row.at);
      out.push({
        source: "x",
        url: `https://x.com/${m[1]}/status/${m[2]}`,
        author: m[1]!,
        title: null,
        text: text.slice(0, 1_500),
        postedAt: at && !Number.isNaN(Date.parse(at)) ? new Date(at) : null,
        replies: leadingCount(row.replies),
      });
    }
    return out;
  },
};

/* ------------------------------------------------------------ LinkedIn */

const LI_POSTS: DomSpec = {
  items: "[componentkey^='expanded'][componentkey*='FeedType_'], div[data-urn^='urn:li:activity']",
  limit: 30,
  fields: {
    urn: "attr:data-urn",
    text: "text:[data-testid='expandable-text-box']|text:.update-components-text|text:.feed-shared-update-v2__description",
    actor: "href:a[href*='/in/']|href:a[href*='/company/']",
    link: "href:a[href*='/feed/update/']|href:a[href*='highlightedUpdateUrn']",
    all: "text",
  },
};

/** "11m", "2d • Edited", "1yr" on a line of its own: when the post went up. */
const LI_AGO = /^(\d+)\s?(s|m|h|d|w|mo|yr|y)\b/;
/** An ad, which stands where the age would: "Promoted", in the languages LinkedIn is read in most. */
const LI_PROMOTED = /^(promoted|sponsored|реклама|просуване|gesponsert|sponsorisé|promocionado|promovido|patrocinado)$/i;

/** A profile's handle as it reads: LinkedIn's carry the letters of their name, percent-encoded. */
const decoded = (slug: string | undefined): string | null => {
  if (!slug) return null;
  try {
    return decodeURIComponent(slug);
  } catch {
    return slug;
  }
};

/** The post's own address, from a link to it or its id; else where the author's last posts are. */
function linkedInPostUrl(row: Row): string | null {
  const link = str(row.link);
  const urn = str(row.urn) ?? (link ? (/urn(?::|%3A)li(?::|%3A)(?:activity|share|ugcPost)(?::|%3A)\d+/i.exec(link)?.[0] ?? null) : null);
  if (urn) return `https://www.linkedin.com/feed/update/${decodeURIComponent(urn)}/`;
  const actor = bare(str(row.actor), "https://www.linkedin.com/");
  const m = actor ? /^\/(in|company)\/([^/]+)/.exec(new URL(actor).pathname) : null;
  if (!m) return null;
  return m[1] === "in" ? `https://www.linkedin.com/in/${m[2]}/recent-activity/all/` : `https://www.linkedin.com/company/${m[2]}/posts/`;
}

export const LINKEDIN: SiteReader = {
  key: "linkedin",
  info: {
    name: "linkedin",
    covers:
      "LinkedIn posts of the last day, week or month, the closest matches first, read in the customer's own Chrome where they are signed in, a few pages deep. A post without an address of its own " +
      "points at its author's recent activity, where it is near the top",
    queryHint: "two or three words such a post must contain, e.g. struggling first users",
  },
  // By closeness, inside the time asked for. Sorted by newest it matched any post of the last minutes that had the
  // words anywhere (live, 2026-11-11: "first users" gave an outage notice and a governor's promise; by closeness,
  // "My first five software products made $0").
  searchUrl: (q) => {
    const posted = { day: "past-24h", week: "past-week", month: "past-month", year: null }[q.within ?? "month"];
    return `https://www.linkedin.com/search/results/content/?keywords=${encodeURIComponent(q.query)}${posted ? `&datePosted=%22${posted}%22` : ""}`;
  },
  cuts: (url) => hostIs(url, "linkedin.com") && /^\/(search\/results\/content|feed\/?$|in\/[^/]+\/recent-activity|company\/[^/]+\/posts)/.test(url.pathname),
  job: (url) => ({ url, take: { text: true, specs: { posts: LI_POSTS } }, waitFor: "[data-testid='expandable-text-box'], div[data-urn^='urn:li:activity']", settleMs: 8_000, more: 4 }),
  postsFrom(r, now) {
    const out: FoundPost[] = [];
    const seen = new Set<string>();
    for (const row of rowsOf(r, "posts")) {
      const text = str(row.text);
      const url = linkedInPostUrl(row);
      if (!text || !url) continue;
      const key = `${url}|${text.slice(0, 80)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const lines = (str(row.all) ?? "").split("\n").map((l) => l.trim());
      if (lines.some((l) => LI_PROMOTED.test(l))) continue;
      const ago = lines.find((l) => LI_AGO.test(l));
      const actor = bare(str(row.actor), "https://www.linkedin.com/");
      out.push({
        source: "linkedin",
        url,
        author: actor ? decoded(/^\/(?:in|company)\/([^/]+)/.exec(new URL(actor).pathname)?.[1]) : null,
        title: null,
        text: text.replace(/\s*…\s*more$/i, "").slice(0, 1_500),
        postedAt: ago ? agoDate(ago, now) : null,
        replies: null,
      });
    }
    return out;
  },
};

/* ------------------------------------------------------------- YouTube */

const VIDEOS: DomSpec = {
  items: "ytd-video-renderer",
  limit: 30,
  fields: {
    href: "href:a#video-title",
    title: "attr:title@a#video-title|text:#video-title",
    channel: "text:ytd-channel-name a",
    channelHref: "href:ytd-channel-name a",
    meta: "text:#metadata-line",
    desc: "text:.metadata-snippet-text|text:#description-text",
  },
};

/** YouTube's "upload date" filters, in its own `sp` codes. */
const YT_WITHIN: Readonly<Record<string, string>> = { day: "EgIIAg%3D%3D", week: "EgIIAw%3D%3D", month: "EgIIBA%3D%3D", year: "EgIIBQ%3D%3D" };

export const YOUTUBE: SiteReader = {
  key: "youtube",
  info: {
    name: "youtube",
    covers:
      "YouTube videos, read in the customer's own Chrome: where the people who care about a topic watch and comment. Results are videos, not asks: " +
      "read_page a recent one to see its comments",
    queryHint: "what someone would type to learn about it, e.g. typeform alternative",
  },
  searchUrl: (q) => `https://www.youtube.com/results?search_query=${encodeURIComponent(q.query)}${q.within ? `&sp=${YT_WITHIN[q.within]}` : ""}`,
  cuts: (url) => hostIs(url, "youtube.com") && url.pathname === "/results",
  job: (url) => ({ url, take: { text: true, specs: { videos: VIDEOS } }, waitFor: "ytd-video-renderer", settleMs: 8_000 }),
  postsFrom(r, now) {
    const out: FoundPost[] = [];
    for (const row of rowsOf(r, "videos")) {
      const href = bare(str(row.href), "https://www.youtube.com/", ["v"]);
      if (!href || !/\/watch\?v=/.test(href)) continue;
      const handle = str(row.channelHref) ? (/\/(@[^/?#]+)/.exec(str(row.channelHref)!)?.[1] ?? null) : null;
      const ago = (str(row.meta) ?? "").split("\n").map((l) => l.trim()).find((l) => /\bago$/i.test(l));
      out.push({
        source: "youtube",
        url: href,
        author: handle ?? str(row.channel),
        title: str(row.title),
        text: (str(row.desc) ?? "").slice(0, 500),
        postedAt: ago ? agoDate(ago, now) : null,
        replies: null,
        preview: true,
      });
    }
    return out;
  },
};

/* -------------------------------------------------------- Indie Hackers */

const STORIES: DomSpec = {
  items: ".story",
  limit: 40,
  fields: {
    href: "href:a.story__text-link",
    title: "text:a.story__text-link",
    user: "text:.story__user",
    comments: "text:.story__count--comments",
    ago: "text:.story__time-ago",
  },
};

/** Indie Hackers lists posts with their titles only, so a post is read before anyone is quoted. Its search is gone. */
export const INDIE_HACKERS: SiteReader = {
  key: "indiehackers",
  cuts: (url) => hostIs(url, "indiehackers.com") && /^\/(newest|top|group\/[^/]+|tag\/[^/]+)?\/?$/.test(url.pathname),
  job: (url) => ({ url, take: { text: true, specs: { stories: STORIES } }, waitFor: ".story", settleMs: 6_000 }),
  postsFrom(r, now) {
    const out: FoundPost[] = [];
    for (const row of rowsOf(r, "stories")) {
      const href = bare(str(row.href), "https://www.indiehackers.com/");
      if (!href || !/\/post\//.test(href)) continue;
      out.push({
        source: "indiehackers",
        url: href,
        author: str(row.user),
        title: str(row.title),
        text: "",
        postedAt: agoDate(row.ago, now),
        replies: leadingCount(row.comments),
        preview: true,
      });
    }
    return out;
  },
};

/** Every site cut by code, Reddit apart (`reddit.ts`, which reads threads too). */
export const SITE_READERS: readonly SiteReader[] = [X, LINKEDIN, YOUTUBE, INDIE_HACKERS];

/** The reader that cuts this page, if one does. */
export function readerFor(raw: string): SiteReader | null {
  if (!URL.canParse(raw)) return null;
  const url = new URL(raw);
  return SITE_READERS.find((s) => s.cuts(url)) ?? null;
}

const day = (d: Date | null): string => (d ? d.toISOString().slice(0, 10) : "date unknown");

/** Posts as a model reads them: one block each, its address, who and when, then the words. */
export function postsText(posts: readonly FoundPost[]): string {
  return posts
    .map((p) =>
      [
        `[${p.source}] ${day(p.postedAt)}${p.author ? ` by ${p.author}` : ""}${p.replies !== null ? `, ${p.replies} replies` : ""}${p.title ? `: "${p.title}"` : ""}`,
        p.url,
        p.text,
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n\n");
}
