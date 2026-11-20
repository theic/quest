import { SearchError } from "@mq/core";
import { describe, expect, it } from "vitest";
import { QUEST_USER_AGENT, plainText } from "../src/sources/http.ts";
import { publicSources } from "../src/sources/registry.ts";
import { searchTools } from "../src/tasks/search-tools.ts";

/** A fetch that answers from canned bodies by URL prefix and records what was asked. */
function cannedFetch(routes: Record<string, { status?: number; body: unknown }>) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const impl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const hit = Object.entries(routes).find(([prefix]) => url.startsWith(prefix));
    if (!hit) return new Response("not found", { status: 404 });
    const { status = 200, body } = hit[1];
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as typeof fetch;
  return { impl, calls };
}

describe("public sources", () => {
  it("reads each community's search into the same shape, and says who is asking", async () => {
    const { impl, calls } = cannedFetch({
      "https://hn.algolia.com/": {
        body: { hits: [{ objectID: "35495129", created_at: "2023-04-08T10:00:00Z", author: "macro-b", story_title: "Ask HN: analytics", comment_text: "I&#x27;d like to avoid <i>cookie banners</i>" }] },
      },
      "https://api.stackexchange.com/": {
        body: { items: [{ title: "GA4 &amp; consent", link: "https://webmasters.stackexchange.com/q/1", body: "<p>How do I…</p>", owner: { display_name: "ann" }, creation_date: 1758844800, answer_count: 0 }] },
      },
      "https://api.bsky.app/": {
        body: { posts: [{ uri: "at://did:plc:abc/app.bsky.feed.post/3kx", author: { handle: "dana.bsky.social" }, record: { text: "any GA alternative?", createdAt: "2026-09-20T08:00:00Z" }, replyCount: 2 }] },
      },
      "https://lemmy.world/": {
        body: { posts: [{ post: { name: "Self-hosted analytics?", body: "Tired of GA4", ap_id: "https://lemmy.world/post/9", published: "2026-09-21T00:00:00Z" }, creator: { name: "sam" }, community: { name: "selfhosted" }, counts: { comments: 4 } }] },
      },
      "https://api.github.com/": {
        body: { items: [{ html_url: "https://github.com/o/r/issues/5", title: "Drop GA", body: "privacy", user: { login: "kim" }, created_at: "2026-09-22T00:00:00Z", comments: 1 }] },
      },
      "https://mastodon.social/": {
        body: [{ url: "https://eu.social/@lee/1", content: "<p>Leaving <a href='#'>#GoogleAnalytics</a></p>", account: { acct: "lee@eu.social" }, created_at: "2026-09-23T00:00:00Z", replies_count: 0 }],
      },
    });
    const posts = publicSources(impl);

    const hn = await posts.search({ source: "hackernews", query: "google analytics alternative" });
    expect(hn[0]).toMatchObject({ source: "hackernews", url: "https://news.ycombinator.com/item?id=35495129", author: "macro-b", title: "Ask HN: analytics", text: "I'd like to avoid cookie banners" });
    const se = await posts.search({ source: "stackexchange", site: "webmasters", query: "GA4 consent" });
    expect(se[0]).toMatchObject({ source: "stackexchange:webmasters", title: "GA4 & consent", author: "ann", replies: 0 });
    const bsky = await posts.search({ source: "bluesky", query: "GA alternative" });
    expect(bsky[0]?.url).toBe("https://bsky.app/profile/dana.bsky.social/post/3kx");
    const lemmy = await posts.search({ source: "lemmy", query: "analytics" });
    expect(lemmy[0]).toMatchObject({ source: "lemmy:selfhosted", url: "https://lemmy.world/post/9", replies: 4 });
    const gh = await posts.search({ source: "github", query: "google analytics" });
    expect(gh[0]).toMatchObject({ author: "kim", title: "Drop GA" });
    const masto = await posts.search({ source: "mastodon", query: "#Google Analytics" });
    expect(masto[0]).toMatchObject({ source: "mastodon:#GoogleAnalytics", text: "Leaving #GoogleAnalytics" });
    expect(calls.find((c) => c.url.startsWith("https://mastodon.social/"))?.url).toContain("/timelines/tag/GoogleAnalytics");

    expect(calls.every((c) => c.headers["user-agent"] === QUEST_USER_AGENT)).toBe(true);
  });

  it("turns refusals and limits into reasons, and needs a site where a source has many", async () => {
    const { impl } = cannedFetch({
      "https://api.bsky.app/": { status: 403, body: "Forbidden" },
      "https://api.github.com/": { status: 429, body: "slow down" },
    });
    const posts = publicSources(impl);

    await expect(posts.search({ source: "bluesky", query: "x" })).rejects.toMatchObject({ reason: "refused" });
    await expect(posts.search({ source: "github", query: "x" })).rejects.toMatchObject({ reason: "rate_limited" });
    await expect(posts.search({ source: "stackexchange", query: "x" })).rejects.toMatchObject({ reason: "bad_query" });
    await expect(posts.search({ source: "reddit", query: "x" })).rejects.toBeInstanceOf(SearchError);
  });

  it("gives the researcher a tool that lists posts, and says a refusal is final", async () => {
    const { impl } = cannedFetch({
      "https://hn.algolia.com/": { body: { hits: [{ objectID: "1", created_at: "2026-09-20T00:00:00Z", author: "a", title: "Ask HN: cookie-free analytics?", num_comments: 3 }] } },
      "https://api.bsky.app/": { status: 403, body: "Forbidden" },
    });
    const [search] = searchTools(publicSources(impl));

    const found = String(await search!.invoke({ source: "hackernews", query: "cookie free analytics" }));
    expect(found).toContain('[hackernews] 2026-09-20 by a, 3 replies — "Ask HN: cookie-free analytics?"');
    expect(found).toContain("https://news.ycombinator.com/item?id=1");
    const refused = String(await search!.invoke({ source: "bluesky", query: "x" }));
    expect(refused).toMatch(/refused.*do not try to reach it another way/);
  });

  it("reads HTML fragments as plain text", () => {
    expect(plainText("<p>One &amp; two</p><p>three&nbsp;&#8212; four</p>")).toBe("One & two\nthree — four");
    expect(plainText("x".repeat(700), 10)).toHaveLength(10);
  });
});
