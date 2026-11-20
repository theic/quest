/**
 * Posting on Reddit as the customer: a reply, a new post, or a private message,
 * one they tapped "Post it" on, or one Quest sends by itself where they have let
 * it (the agent's drafts/autopilot.ts decides; the job is the same). `redditPost`
 * runs inside the Reddit tab (Chrome copies it
 * there on its own, so it stands alone: no imports, nothing from this module's
 * scope); the rest runs in the worker.
 */

/** The new comment's own address: /r/x/comments/<post>/comment/<id>/ on Reddit; the thread when the id is missing. */
export function commentUrl(thread, id) {
  const path = /\/r\/[^/]+\/comments\/[a-z0-9]+/i.exec(String(thread ?? ""))?.[0];
  const short = String(id ?? "").replace(/^t1_/i, "");
  return path && /^[a-z0-9]+$/i.test(short) ? `https://www.reddit.com${path}/comment/${short}/` : String(thread);
}

/** An address on old Reddit, as a person opens it. */
const onWww = (url) => String(url).replace(/^https:\/\/old\.reddit\.com\//i, "https://www.reddit.com/");

/**
 * What each kind sends, through which of Reddit's forms, after checking it is
 * whole; and where it can be seen once it is up. Null for a post that can't go.
 */
export function redditForm(post) {
  const text = String(post?.text ?? "").trim();
  if (!text || text.length > 10000) return { refused: "it is empty, or too long for Reddit" };
  switch (post?.kind ?? "reply") {
    case "reply": {
      if (!/^t[13]_[a-z0-9]+$/i.test(String(post.parent ?? ""))) return { refused: "the reply has no post or comment to go under" };
      return {
        action: "comment",
        fields: { thing_id: post.parent, text },
        seen: (data) => commentUrl(post.url, data?.things?.[0]?.data?.id ?? data?.things?.[0]?.data?.name),
      };
    }
    case "post": {
      const community = String(post.community ?? "");
      const title = String(post.title ?? "").trim();
      if (!/^[A-Za-z0-9_]{2,21}$/.test(community)) return { refused: "the post has no community to go to" };
      if (!title || title.length > 300) return { refused: "the post needs a title of up to 300 characters" };
      return {
        action: "submit",
        fields: { sr: community, kind: "self", title, text, sendreplies: "true" },
        seen: (data) => (data?.url ? onWww(data.url) : `https://www.reddit.com/r/${community}/new/`),
      };
    }
    case "message": {
      const to = String(post.to ?? "");
      const subject = String(post.subject ?? "").trim();
      if (!/^[A-Za-z0-9_-]{3,20}$/.test(to)) return { refused: "the message has nobody to go to" };
      if (!subject || subject.length > 100) return { refused: "the message needs a subject of up to 100 characters" };
      return { action: "compose", fields: { to, subject, text }, seen: () => "https://www.reddit.com/message/sent/" };
    }
    default:
      return { refused: "Quest does not know that kind of post" };
  }
}

/**
 * Runs in the Reddit tab (Chrome copies it there, so it stands alone): who is
 * signed in, then one of Reddit's own forms (`comment`, `submit`, `compose`)
 * with the account's own form token, the way Reddit's pages send it. Reddit's
 * errors come back in its own words.
 */
export async function redditPost(action, fields) {
  const fail = (reason, message) => ({ ok: false, reason, message });
  let me = null;
  try {
    const res = await fetch("/api/me.json", { credentials: "same-origin", headers: { accept: "application/json" } });
    me = res.ok ? await res.json() : null;
  } catch {
    me = null;
  }
  const modhash = me?.data?.modhash;
  const name = me?.data?.name;
  if (!modhash || !name) return fail("login", "this Chrome is not logged in to Reddit");

  let res;
  try {
    res = await fetch(`/api/${action}`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-modhash": modhash },
      body: new URLSearchParams({ ...fields, uh: modhash, api_type: "json" }),
    });
  } catch (e) {
    return fail("unavailable", `Reddit did not answer (${e instanceof Error ? e.message : String(e)})`);
  }
  if (res.status === 429) return fail("rate_limited", "Reddit asked to slow down (HTTP 429)");
  if (res.status === 401) return fail("login", "Reddit wants you to log in again");
  if (res.status === 403) return fail("refused", "Reddit refused it (HTTP 403): you may not be allowed to post there");
  const out = await res.json().catch(() => null);
  const errors = out?.json?.errors ?? [];
  if (errors.length) {
    const [code, message] = errors[0];
    const reason = code === "RATELIMIT" ? "rate_limited" : code === "USER_REQUIRED" ? "login" : "refused";
    return fail(reason, `${message} (${code})`);
  }
  if (!res.ok) return fail("unavailable", `Reddit answered ${res.status}`);
  return { ok: true, name, data: out?.json?.data ?? null };
}
