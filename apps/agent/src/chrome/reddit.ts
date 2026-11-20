import type { ChromeJob, ChromeRead, DomSpec, FoundPost, PageText } from "@mq/core";

/**
 * Reddit, read the way a person reads it: its pages on www.reddit.com, in the
 * customer's Chrome, logged out.
 *
 * Measured 2026-09-27 in a real Chrome, logged out:
 * - old.reddit.com sends a logged-out visitor to a login page ("accounts are
 *   required to access old Reddit"), so it is not used.
 * - A search page has 7 posts on its first screen, as
 *   [data-testid=search-post-unit]: the link, the title, <time datetime>, the
 *   votes and comments; no author and no body. It renders in a minimised window.
 * - A thread is <shreddit-post> (author, created-timestamp, post-title, body in
 *   [slot=text-body]) and <shreddit-comment>s (author, <time>, body in
 *   [slot=comment]); v1 measured the same on 2026-09-04, and found some Reddit
 *   pages render only while Chrome draws them, so a thread that comes back
 *   empty from a hidden window is read again on screen.
 * - Reddit runs a JavaScript check on a new visitor (the page reloads with
 *   `js_challenge=1`); a browser passes it by itself. A visitor that keeps no
 *   cookies is checked on every page, and after a few gets "Prove your
 *   humanity", a CAPTCHA, which Quest never solves.
 *
 * v1's measurements (skills/reddit/shapes.mjs, 2026-08): a search scoped to one
 * community found a real ask in 42% of reads, a site-wide search in 10%.
 */

const WWW = "www.reddit.com";

export const isReddit = (url: URL): boolean => /(^|\.)reddit\.com$/i.test(url.hostname);
export const isRedditThread = (url: URL): boolean => isReddit(url) && /\/comments\/[a-z0-9]+/i.test(url.pathname);

/** The address a person opens, for cards and links: www, without tracking or check parameters. */
export function personUrl(raw: string): string {
  try {
    const u = new URL(raw);
    if (isReddit(u)) u.hostname = WWW;
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return raw;
  }
}

/** "SaaS", "r/SaaS", "/r/SaaS/" → "SaaS"; null when it is not a community name. */
export function communityName(raw: string | undefined): string | null {
  const name = (raw ?? "").trim().replace(/^\/?r\//i, "").replace(/\/+$/, "");
  return /^[A-Za-z0-9_]{2,21}$/.test(name) ? name : null;
}

/**
 * Sorted by relevance inside the time window. Sorted by "new", Reddit matches any one word and
 * the newest posts win: "Typeform too expensive alternative" brought r/Mechwarrior5 and spam
 * (live, 2026-09-27). The window (`t`) keeps the results recent.
 */
export function searchUrl(query: string, community: string | null, within: string): string {
  const q = encodeURIComponent(query);
  return community
    ? `https://${WWW}/r/${community}/search/?q=${q}&type=posts&restrict_sr=1&sort=relevance&t=${within}`
    : `https://${WWW}/search/?q=${q}&type=posts&sort=relevance&t=${within}`;
}

const SEARCH: DomSpec = {
  items: "[data-testid='search-post-unit']",
  limit: 25,
  fields: {
    href: "href:a[data-testid='post-title']|href:a[href*='/comments/']",
    title: "text:[data-testid='post-title-text']|text:a[data-testid='post-title']",
    at: "attr:datetime@time|attr:ts@faceplate-timeago",
    counts: "text:[data-testid='search-counter-row']",
  },
};
/** A community's own listing, and some search layouts, carry whole posts. */
const POSTS: DomSpec = {
  items: "shreddit-post",
  limit: 25,
  fields: {
    title: "attr:post-title",
    author: "attr:author",
    href: "attr:permalink",
    at: "attr:created-timestamp",
    comments: "attr:comment-count",
    body: "text:[slot=text-body]",
    community: "attr:subreddit-prefixed-name",
    // Reddit's own id for the post ("t3_…"), what a reply goes under. Its address has it too.
    thing: "attr:id",
  },
};
const COMMENTS: DomSpec = {
  items: "shreddit-comment",
  limit: 40,
  fields: {
    author: "attr:author",
    at: "attr:datetime@time|attr:ts@faceplate-timeago",
    body: "text:[slot=comment]",
    permalink: "attr:permalink",
    thing: "attr:thingid",
    // The comment it answers ("t1_…"); absent on one that answers the post (measured 2026-09-28).
    parent: "attr:parentid",
  },
};

export function searchJob(url: string): ChromeJob {
  return { url, take: { text: true, specs: { search: SEARCH, posts: POSTS } }, waitFor: "[data-testid='search-post-unit'], shreddit-post", settleMs: 6_000 };
}

export function threadJob(url: URL): ChromeJob {
  const u = new URL(url.href);
  u.hostname = WWW;
  // A comment's own address waits for its comments, so one that is there is never read as missing.
  const waitFor = commentRef(u.href) ? "shreddit-comment" : "shreddit-post";
  return { url: u.href, take: { text: true, specs: { post: POSTS, comments: COMMENTS } }, waitFor, settleMs: 6_000 };
}

/** The same job in a window Chrome is drawing: for a page that rendered nothing while hidden. */
export const drawnJob = (job: ChromeJob): ChromeJob => ({ ...job, drawn: true, settleMs: 8_000 });

/** True when Reddit showed a refusal or a CAPTCHA instead of the page. */
export const redditRefused = (r: ChromeRead): boolean =>
  /blocked by network security|prove your humanity|complete the challenge below|whoa there,? pardner|too many requests/i.test(`${r.title}\n${r.text.slice(0, 2_000)}`);

/** What the team is told when Reddit shows a check: a refusal, which Quest takes as such. */
export const REDDIT_CHECK =
  "Reddit showed a check (\"prove your humanity\") or refused the page in the customer's Chrome. Quest does not solve those: skip Reddit in this task.";

/** Reddit's own "nothing matched". */
export const noResults = (r: ChromeRead): boolean => /couldn['’]t find any results|no results found|there doesn['’]t seem to be anything here/i.test(r.text.slice(0, 3_000));

/** True when the read has no rows of any kind: a page that did not render (or not the page asked for). */
export const noRows = (r: ChromeRead): boolean => Object.values(r.rows).every((rows) => rows.length === 0);

/** Nothing rendered while Chrome was not drawing the page: worth one more read on screen. */
export const wantsDrawing = (r: ChromeRead): boolean => noRows(r) && !r.visible && !redditRefused(r) && !noResults(r);

/* ------------------------------------------------------------ reading rows */

type Row = Readonly<Record<string, unknown>>;

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** Reddit's dates: ISO, sometimes with a "+0000" offset, or milliseconds since 1970. */
export function redditDate(v: unknown): Date | null {
  const s = str(v)?.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  if (!s) return null;
  const d = /^\d{11,}$/.test(s) ? new Date(Number(s)) : new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

const author = (v: unknown): string | null => {
  const a = str(v)?.replace(/^u\//i, "") ?? null;
  return a && a !== "[deleted]" ? a : null;
};

/** "20 votes·44 comments" → 44; "1.2k comments" → 1200; a bare number stays itself. */
export function commentCount(v: unknown): number | null {
  const s = str(v);
  if (!s) return null;
  const m = /([\d.,]+)\s*(k)?\s*comments?/i.exec(s) ?? /^([\d.,]+)\s*(k)?$/i.exec(s);
  if (!m?.[1]) return null;
  const n = Number(m[1].replace(/,/g, ""));
  return Number.isFinite(n) ? Math.round(n * (m[2] ? 1_000 : 1)) : null;
}

const sourceOf = (community: unknown, url: string): string => {
  const name = communityName(str(community) ?? undefined) ?? /\/r\/([^/]+)/i.exec(url)?.[1] ?? null;
  return name ? `reddit:r/${name}` : "reddit";
};

const rowsOf = (r: ChromeRead, ...names: string[]): Row[] => names.flatMap((n) => [...(r.rows[n] ?? [])]);

const POST_ID = /\/comments\/([a-z0-9]+)/i;
/** A comment's own address: /r/x/comments/<post>/comment/<id>/, or the older /r/x/comments/<post>/<slug>/<id>/. */
const COMMENT_ID = /\/comments\/[a-z0-9]+\/(?:comment\/|[^/]+\/)([a-z0-9]+)\/?$/i;

/** The comment a Reddit address points at ("t1_…"), or null for a thread's own address. */
export const commentRef = (url: string): string | null => thingId("t1", null, url);

/** The post a Reddit address is on ("t3_…"), or null when it is not a thread. */
export const postRef = (url: string): string | null => thingId("t3", null, url);

/** A comment's own address on Reddit, from its thread's address and its id ("t1_…"). */
export function commentPermalink(thread: string, ref: string): string {
  const path = /\/r\/[^/]+\/comments\/[a-z0-9]+/i.exec(thread)?.[0];
  const id = ref.replace(/^t1_/i, "");
  return path && /^[a-z0-9]+$/i.test(id) ? `https://${WWW}${path}/comment/${id}/` : thread;
}

/** "dana", "u/dana", "/user/dana/", a profile's address → "dana"; null when it is not a Reddit username. */
export function redditUser(raw: string | undefined): string | null {
  const s = (raw ?? "").trim();
  const fromUrl = /reddit\.com\/(?:u|user)\/([^/?#]+)/i.exec(s)?.[1];
  const name = (fromUrl ?? s).replace(/^\/?(?:u|user)\//i, "").replace(/\/+$/, "");
  return /^[A-Za-z0-9_-]{3,20}$/.test(name) ? name : null;
}

/** Reddit's id for a thing, from its attribute or else its address: "t3_1abc" for a post, "t1_xyz" for a comment. */
function thingId(kind: "t1" | "t3", attr: unknown, url: string | null): string | null {
  const given = str(attr)?.toLowerCase() ?? null;
  if (given?.startsWith(`${kind}_`) && /^t\d_[a-z0-9]+$/.test(given)) return given;
  const id = (kind === "t3" ? POST_ID : COMMENT_ID).exec(url ?? "")?.[1];
  return id ? `${kind}_${id.toLowerCase()}` : null;
}

/**
 * Posts from a search page. A search result has no author or body, so it is a
 * preview: the thread has to be read before anyone is quoted.
 */
export function postsFrom(r: ChromeRead, limit: number): FoundPost[] {
  const out: FoundPost[] = [];
  const seen = new Set<string>();
  for (const row of rowsOf(r, "search", "posts")) {
    const href = str(row.href);
    if (!href) continue;
    let url: string;
    try {
      url = personUrl(new URL(href, "https://www.reddit.com").href);
    } catch {
      continue;
    }
    if (!/\/comments\//.test(url) || seen.has(url)) continue;
    seen.add(url);
    const body = str(row.body);
    out.push({
      source: sourceOf(row.community, url),
      url,
      author: author(row.author),
      title: str(row.title),
      text: (body ?? "").slice(0, 1_500),
      postedAt: redditDate(row.at),
      replies: commentCount(row.counts ?? row.comments),
      ...(body && author(row.author) ? {} : { preview: true }),
    });
    if (out.length >= limit) break;
  }
  return out;
}

const day = (d: Date | null): string => (d ? d.toISOString().slice(0, 10) : "date unknown");

/** A line saying a post was taken down, not a rule saying one will be ("posts like this will be removed"). */
const REMOVED = /\b(was|has been|been) (removed|deleted)\b|\bremoved by (reddit|the moderators|moderators?|the mods|admins?)\b|^\[(removed|deleted)\]$/i;

/** A thread as one page of text: the post, then its comments, each with who wrote it and when. */
export function threadFrom(r: ChromeRead, asked: string): PageText | null {
  const [post] = rowsOf(r, "post");
  if (!post) return null;
  const url = personUrl(asked);
  const title = str(post.title);
  const who = author(post.author);
  const at = redditDate(post.at);
  const source = sourceOf(post.community, url);
  const all = rowsOf(r, "comments").map((c) => ({
    who: author(c.author),
    at: redditDate(c.at),
    body: str(c.body),
    ref: thingId("t1", c.thing, str(c.permalink)),
    parentRef: /^t1_[a-z0-9]+$/i.test(str(c.parent) ?? "") ? str(c.parent)!.toLowerCase() : null,
  }));
  const comments = all.filter((c) => c.body);
  // A deleted or removed comment keeps its place and id, as "[deleted]" with no words ("Comment
  // removed by moderator" to a visitor; measured 2026-09-28, an AutoModerator removal in r/test).
  const gone = all.flatMap((c) => (!c.body && !c.who && c.ref ? [c.ref] : []));
  // A text post that shows a stranger no words may have been taken down (live, 2026-10-04: a new account's
  // post in r/SideProject, its title and author but no body). The page's own line says so, when it has one.
  const body = str(post.body);
  const from = title ? Math.max(0, r.text.indexOf(title)) : 0;
  const notice = body ? null : (r.text.slice(from, from + 1_500).split("\n").map((l) => l.trim()).find((l) => l.length < 300 && REMOVED.test(l)) ?? null);
  const text = [
    `${title ?? "(untitled)"}`,
    `Posted by ${who ? `u/${who}` : "someone"} in ${source.replace(/^reddit:/, "")} on ${day(at)}.`,
    "",
    body ?? (notice ? `(no text: "${notice}")` : "(no text: a link or image post)"),
    "",
    comments.length ? `Comments (${comments.length} shown):` : "No comments shown.",
    ...comments.map((c) => `- ${c.who ? `u/${c.who}` : "someone"} (${day(c.at)}): ${c.body}`),
  ].join("\n");
  return {
    url,
    title: title ?? r.title,
    description: null,
    text: text.slice(0, 20_000),
    post: {
      source,
      author: who,
      title,
      postedAt: at,
      ref: thingId("t3", post.thing, url),
      ...(body ? {} : { notice, bare: r.text.replace(/\s+/g, " ").slice(0, 600) }),
    },
    comments: comments.map((c) => ({ author: c.who, postedAt: c.at, text: c.body ?? "", ref: c.ref, parentRef: c.parentRef })),
    ...(gone.length ? { gone } : {}),
  };
}
