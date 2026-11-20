import { Hono } from "hono";
import { z } from "zod";
import type { Logger } from "@mq/core";
import type { KnownCheck, KnownPeople, SidedPost } from "../infra/pg-known.ts";

/**
 * The shared database of people (docs/next-goal-open-source.md, "The shared people database"): every local install
 * sends the public people it finds here, and reads everyone's back, so a maker found on one laptop meets someone who
 * asked for their thing on another. Only what is public goes in: a post's address, its author's handle, what they made
 * or asked for in their own post, and what their own profile and site say. Never an install's words, drafts or who
 * runs it. Each install sends an anonymous key it made itself (`x-quest-install`), which only counts what it may send.
 */

/** A public address: http(s), a real host, never this machine or a private network. */
const publicUrl = z
  .string()
  .max(500)
  .url()
  .refine((u) => {
    try {
      const { protocol, hostname } = new URL(u);
      return /^https?:$/.test(protocol) && hostname.includes(".") && !/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|\[)/.test(hostname);
    } catch {
      return false;
    }
  });

const Post = z.object({
  side: z.enum(["ask", "launch"]),
  source: z.string().max(60),
  url: publicUrl,
  author: z.string().min(1).max(80),
  title: z.string().max(300).nullish(),
  text: z.string().min(1).max(2000),
  postedAt: z.coerce.date().nullish(),
  replies: z.number().int().nullish(),
});
const Seen = z.object({ posts: z.array(Post).min(1).max(200) });
const Check = z.object({
  site: z.string().max(80),
  handle: z.string().min(1).max(80),
  name: z.string().max(120).nullish(),
  profileUrl: publicUrl.nullish(),
  siteUrl: publicUrl.nullish(),
  about: z.string().min(1).max(600),
  reach: z.string().max(300).nullish(),
});

/**
 * What one install, and one network address, may do a day: well above a busy laptop's day (dev: about 1,500 posts).
 * A key is self-made, so the address's count is what holds someone minting keys: a no removes a person for every
 * install, so few go a day, and reading everyone's is a few looks an hour for a laptop.
 */
const A_DAY = { posts: 5_000, checks: 500, nos: 20, reads: 300 } as const;
type Counted = keyof typeof A_DAY;
const DAY_MS = 86_400_000;

export function peopleRoutes(deps: { known: Pick<KnownPeople, "saw" | "know" | "recent" | "forget">; log: Logger; now?: () => number }): Hono {
  const app = new Hono();
  const now = deps.now ?? Date.now;
  const counts = new Map<string, { since: number } & Record<Counted, number>>();
  const install = (key: string | undefined) => (key && /^[\w-]{20,64}$/.test(key) ? key : null);
  // Fly's proxy sets Fly-Client-IP; behind anything else the first forwarded address, else one bucket for all.
  const addressOf = (c: { req: { header: (n: string) => string | undefined } }) =>
    c.req.header("fly-client-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "direct";
  const room = (keys: readonly string[], what: Counted, n: number): boolean => {
    const fresh = keys.map((k) => {
      const c = counts.get(k);
      return [k, !c || now() - c.since > DAY_MS ? { since: now(), posts: 0, checks: 0, nos: 0, reads: 0 } : c] as const;
    });
    if (fresh.some(([, c]) => c[what] + n > A_DAY[what])) return false;
    for (const [k, c] of fresh) counts.set(k, { ...c, [what]: c[what] + n });
    if (counts.size > 50_000) for (const [k, v] of counts) if (now() - v.since > DAY_MS) counts.delete(k);
    return true;
  };

  app.post("/people/seen", async (c) => {
    const key = install(c.req.header("x-quest-install"));
    if (!key) return c.json({ error: "no install key" }, 401);
    const body = Seen.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "not people" }, 400);
    // A post's quote must be in the post itself: its text is what its author wrote, clipped.
    const posts = body.data.posts.map((p) => ({ ...p, title: p.title ?? null, postedAt: p.postedAt ?? null, replies: p.replies ?? null })) as SidedPost[];
    if (!room([key, `ip:${addressOf(c)}`], "posts", posts.length)) return c.json({ error: "enough for today" }, 429);
    await deps.known.saw(posts);
    deps.log.info("people.seen", { install: key.slice(0, 6), posts: posts.length });
    return c.json({ kept: posts.length });
  });

  app.post("/people/known", async (c) => {
    const key = install(c.req.header("x-quest-install"));
    if (!key) return c.json({ error: "no install key" }, 401);
    const body = Check.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "not a person" }, 400);
    if (!room([key, `ip:${addressOf(c)}`], "checks", 1)) return c.json({ error: "enough for today" }, 429);
    await deps.known.know(body.data as KnownCheck);
    return c.json({ kept: 1 });
  });

  /** Someone told an install to leave them alone: out of the shared list, for every install. */
  app.post("/people/no", async (c) => {
    const key = install(c.req.header("x-quest-install"));
    if (!key) return c.json({ error: "no install key" }, 401);
    const body = z.object({ site: z.string().min(1).max(80), handle: z.string().min(1).max(80) }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "not a person" }, 400);
    if (!room([key, `ip:${addressOf(c)}`], "nos", 1)) return c.json({ error: "enough for today" }, 429);
    await deps.known.forget(body.data.site, body.data.handle);
    deps.log.info("people.no", { install: key.slice(0, 6), site: body.data.site });
    return c.json({ forgotten: 1 });
  });

  /** Everyone's last days, each person's newest post on each side: what an install's matcher reads beside its own. */
  app.get("/people/recent", async (c) => {
    const key = install(c.req.header("x-quest-install"));
    if (!key) return c.json({ error: "no install key" }, 401);
    if (!room([key, `ip:${addressOf(c)}`], "reads", 1)) return c.json({ error: "enough for today" }, 429);
    const days = Math.min(14, Math.max(1, Number(c.req.query("days") ?? 7) || 7));
    const limit = Math.min(1000, Math.max(1, Number(c.req.query("limit") ?? 500) || 500));
    return c.json({ posts: await deps.known.recent(days, limit) });
  });

  return app;
}
