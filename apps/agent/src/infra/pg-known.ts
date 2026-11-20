import { randomBytes } from "node:crypto";
import { bareHandle, contactKey, type FoundPost } from "@mq/core";
import { contactSite } from "../contacts/handles.ts";
import type { Queryable } from "./db.ts";

/** A post that says what its author made, or what they are asking for. */
export interface SidedPost extends FoundPost {
  readonly side: "ask" | "launch";
  /** An ask found from the maker's side: false when they only show the need and did not ask for such a thing, so only the maker is told. */
  readonly tell?: boolean;
}

/** What the cache knows of someone beyond their post: who they are, and where else they can be reached. */
export interface KnownAbout {
  readonly about: string | null;
  readonly reach: string | null;
  readonly siteUrl: string | null;
  readonly profileUrl: string | null;
}

/** What a check of someone found that is public: their own profile and site said it. */
export interface KnownCheck {
  readonly site: string;
  readonly handle: string;
  readonly name?: string | null;
  readonly profileUrl?: string | null;
  readonly siteUrl?: string | null;
  readonly about: string;
  readonly reach?: string | null;
}

export interface KnownPeople {
  saw(posts: readonly SidedPost[]): Promise<void>;
  know(check: KnownCheck): Promise<void>;
  /** Someone asked to be left alone: out of the cache for good, so no customer is brought to them again. */
  forget(site: string, handle: string): Promise<void>;
  recent(days: number, limit: number): Promise<SidedPost[]>;
  about(posts: readonly FoundPost[]): Promise<Map<string, KnownAbout>>;
  paired(posts: readonly FoundPost[]): Promise<void>;
  pairedLately(days: number): Promise<Set<string>>;
  keepPairs(pairs: readonly { ask: SidedPost; launch: SidedPost; why: string }[]): Promise<number>;
  openPairs(limit: number, notOn?: string): Promise<KeptPair[]>;
  takePair(id: number, customerId: string, note: string): Promise<void>;
  pairsForRun(limit: number, want: (p: KeptPair) => boolean): Promise<KeptPair[]>;
  inPairs(days: number): Promise<Set<string>>;
  askerTold(launchUrl: string): Promise<boolean>;
  /** Every pair kept for one launch, newest first: whoever was found for its maker, taken or not. */
  pairsFor(launchUrl: string): Promise<KeptPair[]>;
  /** A maker's page of the people their link went to; gives its code. */
  keepPage(customerId: string, page: MatchPage): Promise<string>;
}

/** The page a maker gets once they said yes: who made what, and everyone their link went to (mq.match_pages). */
export interface MatchPage {
  readonly maker: string;
  readonly made: string | null;
  readonly launchUrl: string;
  /** `fit`: they only showed the need, so nobody wrote to them; the page lists them apart. */
  readonly people: readonly { readonly author: string; readonly quote: string; readonly url: string; readonly fit?: boolean }[];
  /** False when nobody was sent their link: the page then says the people were found, not written to. */
  readonly sent?: boolean;
}

/** Where a maker's page is read: a static page of the landing, which asks the database for the row by its code ("t" first for dev's). */
export const matchPageUrl = (code: string, dev: boolean): string => `https://www.messaging.quest/m/${dev ? "t" : ""}${code}`;

/** A pair kept in mq.pairs. */
export interface KeptPair {
  readonly id: number;
  readonly ask: SidedPost;
  readonly launch: SidedPost;
  readonly why: string;
}

/** How a search names the site a person is on: what the matcher shows in brackets. */
const SOURCE: Readonly<Record<string, string>> = { "x.com": "x", reddit: "reddit", "linkedin.com": "linkedin", "news.ycombinator.com": "hackernews", "bsky.app": "bluesky", "threads.com": "threads" };

const TELEGRAM = /\bt\.me\/|telegram/i;

/** The person a post is by, as the cache keys them; null with no author or no site. */
export const knownKey = (p: Pick<FoundPost, "url" | "author">): string | null => {
  const site = contactSite(p.url);
  const handle = bareHandle(p.author ?? "");
  return site && handle ? contactKey(site, handle) : null;
};

const said = (p: FoundPost): string => [p.title, p.text].filter(Boolean).join(" | ").replace(/\s+/g, " ").trim().slice(0, 600);

/**
 * mq.known_people: everyone Quest came across for any customer, public background only (the founder, 2026-11-12: "a
 * central database, so every person it finds, from any of its users ... this way we could find a match even quicker").
 * Best effort everywhere: a cache that cannot be written or read never fails the run that met the person.
 */
/**
 * Who is in a pair lately, read once in a while and kept up by this process's own writes (live, 2026-11-16: read whole
 * at every look of the matcher, about a thousand keys each time). Read again after `KEYS_KEPT_MS`, so the old ones age out.
 */
const KEYS_KEPT_MS = 2 * 3_600_000;

export class PgKnownPeople implements KnownPeople {
  readonly #db: Queryable;
  #pairs: { at: number; days: number; asks: Set<string>; launches: Map<string, number> } | null = null;
  #paired: { at: number; days: number; keys: Set<string> } | null = null;

  constructor(db: Queryable) {
    this.#db = db;
  }

  /** The posts a search turned up: each author kept with what they made or what they ask for, the newest of each. */
  async saw(posts: readonly SidedPost[]): Promise<void> {
    const rows = new Map<string, { site: string; handle: string; telegram: boolean; makes: SidedPost | null; wants: SidedPost | null }>();
    for (const p of posts) {
      const key = knownKey(p);
      if (!key || !said(p)) continue;
      const row = rows.get(key) ?? { site: contactSite(p.url)!, handle: bareHandle(p.author ?? ""), telegram: false, makes: null, wants: null };
      const newer = (was: SidedPost | null): SidedPost => (!was || (p.postedAt?.getTime() ?? 0) > (was.postedAt?.getTime() ?? 0) ? p : was);
      if (p.side === "launch") row.makes = newer(row.makes);
      else row.wants = newer(row.wants);
      row.telegram ||= TELEGRAM.test(`${p.text} ${p.url}`);
      rows.set(key, row);
    }
    if (!rows.size) return;
    const list = [...rows.entries()];
    const at = (p: SidedPost | null): string | null => (p ? (p.postedAt ?? new Date()).toISOString() : null);
    await this.#db.query(
      `insert into mq.known_people as k (key, site, handle, telegram, makes, makes_url, makes_at, wants, wants_url, wants_at)
       select * from unnest($1::text[], $2::text[], $3::text[], $4::boolean[], $5::text[], $6::text[], $7::timestamptz[], $8::text[], $9::text[], $10::timestamptz[])
       on conflict (key) do update set
         telegram = k.telegram or excluded.telegram,
         makes = case when excluded.makes is not null and (k.makes_at is null or excluded.makes_at >= k.makes_at) then excluded.makes else k.makes end,
         makes_url = case when excluded.makes is not null and (k.makes_at is null or excluded.makes_at >= k.makes_at) then excluded.makes_url else k.makes_url end,
         makes_at = case when excluded.makes is not null and (k.makes_at is null or excluded.makes_at >= k.makes_at) then excluded.makes_at else k.makes_at end,
         wants = case when excluded.wants is not null and (k.wants_at is null or excluded.wants_at >= k.wants_at) then excluded.wants else k.wants end,
         wants_url = case when excluded.wants is not null and (k.wants_at is null or excluded.wants_at >= k.wants_at) then excluded.wants_url else k.wants_url end,
         wants_at = case when excluded.wants is not null and (k.wants_at is null or excluded.wants_at >= k.wants_at) then excluded.wants_at else k.wants_at end,
         updated_at = now()`,
      [
        list.map(([key]) => key),
        list.map(([, r]) => r.site),
        list.map(([, r]) => r.handle),
        list.map(([, r]) => r.telegram),
        list.map(([, r]) => (r.makes ? said(r.makes) : null)),
        list.map(([, r]) => r.makes?.url ?? null),
        list.map(([, r]) => at(r.makes)),
        list.map(([, r]) => (r.wants ? said(r.wants) : null)),
        list.map(([, r]) => r.wants?.url ?? null),
        list.map(([, r]) => at(r.wants)),
      ],
    );
  }

  /** A check of someone, the public part: who they are, their site, where else they can be reached. */
  async know(c: KnownCheck): Promise<void> {
    const handle = bareHandle(c.handle);
    if (!handle) return;
    const clip = (s: string | null | undefined, max: number): string | null => (s?.trim() ? s.trim().slice(0, max) : null);
    await this.#db.query(
      `insert into mq.known_people as k (key, site, handle, name, profile_url, site_url, about, reach, telegram, checked_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
       on conflict (key) do update set
         name = coalesce(excluded.name, k.name),
         profile_url = coalesce(excluded.profile_url, k.profile_url),
         site_url = coalesce(excluded.site_url, k.site_url),
         about = excluded.about,
         reach = coalesce(excluded.reach, k.reach),
         telegram = k.telegram or excluded.telegram,
         checked_at = now(),
         updated_at = now()`,
      [contactKey(c.site, handle), c.site, handle, clip(c.name, 200), clip(c.profileUrl, 500), clip(c.siteUrl, 500), c.about.trim().slice(0, 1000), clip(c.reach, 500), TELEGRAM.test(`${c.about} ${c.reach ?? ""} ${c.siteUrl ?? ""}`)],
    );
  }

  /** What people made and asked for in the last days, newest first: the matcher's lists, whoever's run found them. */
  async recent(days: number, limit: number): Promise<SidedPost[]> {
    const { rows } = await this.#db.query<{ site: string; handle: string; makes: string | null; makes_url: string | null; makes_at: Date | null; wants: string | null; wants_url: string | null; wants_at: Date | null }>(
      `(select site, handle, makes, makes_url, makes_at, null as wants, null as wants_url, null::timestamptz as wants_at from mq.known_people
         where makes_at > now() - make_interval(days => $1) order by makes_at desc limit $2)
       union all
       (select site, handle, null, null, null, wants, wants_url, wants_at from mq.known_people
         where wants_at > now() - make_interval(days => $1) order by wants_at desc limit $2)`,
      [days, limit],
    );
    return rows.flatMap((r): SidedPost[] => {
      const source = SOURCE[r.site] ?? r.site;
      if (r.makes && r.makes_url) return [{ side: "launch", source, url: r.makes_url, author: r.handle, title: null, text: r.makes, postedAt: r.makes_at, replies: null }];
      if (r.wants && r.wants_url) return [{ side: "ask", source, url: r.wants_url, author: r.handle, title: null, text: r.wants, postedAt: r.wants_at, replies: null }];
      return [];
    });
  }

  async forget(site: string, handle: string): Promise<void> {
    const h = bareHandle(handle);
    if (!site || !h) return;
    // Kept as a no first, so no install's next sighting brings them back (mq.people_no and its trigger).
    await this.#db.query(
      `with no as (insert into mq.people_no (key) values ($1) on conflict do nothing) delete from mq.known_people where key = $1`,
      [contactKey(site, h)],
    );
  }

  /** These posts' authors were handed to a run as one side of a pair. */
  async paired(posts: readonly FoundPost[]): Promise<void> {
    const keys = posts.flatMap((p) => knownKey(p) ?? []);
    if (!keys.length) return;
    await this.#db.query(`update mq.known_people set paired_at = now() where key = any($1::text[])`, [keys]);
    for (const k of keys) this.#paired?.keys.add(k);
  }

  /** Everyone handed out in a pair in the last days, by key: not brought to anyone again so soon. */
  async pairedLately(days: number): Promise<Set<string>> {
    const had = this.#paired;
    if (had && had.days === days && Date.now() - had.at < KEYS_KEPT_MS) return new Set(had.keys);
    const { rows } = await this.#db.query<{ key: string }>(`select key from mq.known_people where paired_at > now() - make_interval(days => $1)`, [days]);
    this.#paired = { at: Date.now(), days, keys: new Set(rows.map((r) => r.key)) };
    return new Set(this.#paired.keys);
  }

  /** Pairs the matcher found, kept once each: the line of introductions to make. Returns how many were new. */
  async keepPairs(pairs: readonly { ask: SidedPost; launch: SidedPost; why: string }[]): Promise<number> {
    let added = 0;
    for (const p of pairs) {
      const { rowCount } = await this.#db.query(
        `insert into mq.pairs (ask, launch, ask_url, launch_url, ask_key, launch_key, why) values ($1, $2, $3, $4, $5, $6, $7) on conflict (ask_url, launch_url) do nothing`,
        [JSON.stringify(p.ask), JSON.stringify(p.launch), p.ask.url, p.launch.url, knownKey(p.ask), knownKey(p.launch), p.why.slice(0, 400)],
      );
      added += rowCount ?? 0;
      if (rowCount && this.#pairs) {
        const ask = knownKey(p.ask);
        const launch = knownKey(p.launch);
        if (ask) this.#pairs.asks.add(ask);
        if (launch) this.#pairs.launches.set(launch, (this.#pairs.launches.get(launch) ?? 0) + 1);
      }
    }
    return added;
  }

  /** Pairs nobody brought together yet, newest first. */
  /** The newest open pairs; `notOn` leaves out makers whose post is on that host (asked in the query, so nothing more leaves the database). */
  async openPairs(limit: number, notOn?: string): Promise<KeptPair[]> {
    const { rows } = await this.#db.query<{ id: string; ask: SidedPost & { postedAt: string | null }; launch: SidedPost & { postedAt: string | null }; why: string | null }>(
      `select id, ask, launch, why from mq.pairs where taken_at is null and found_at > now() - interval '10 days' and ($2::text is null or position($2 in launch->>'url') = 0) order by found_at desc, id limit $1`,
      [limit, notOn ?? null],
    );
    const post = (p: SidedPost & { postedAt: string | null }): SidedPost => ({ ...p, postedAt: p.postedAt ? new Date(p.postedAt) : null });
    return rows.map((r) => ({ id: Number(r.id), ask: post(r.ask), launch: post(r.launch), why: r.why ?? "" }));
  }

  /** Pairs no run was handed yet, newest first; the ones given back are marked handed. */
  async pairsForRun(limit: number, want: (p: KeptPair) => boolean): Promise<KeptPair[]> {
    const { rows } = await this.#db.query<{ id: string; ask: SidedPost & { postedAt: string | null }; launch: SidedPost & { postedAt: string | null }; why: string | null }>(
      `select id, ask, launch, why from mq.pairs where run_at is null and found_at > now() - interval '10 days' order by found_at desc, id limit 80`,
    );
    const post = (p: SidedPost & { postedAt: string | null }): SidedPost => ({ ...p, postedAt: p.postedAt ? new Date(p.postedAt) : null });
    const out = rows.map((r) => ({ id: Number(r.id), ask: post(r.ask), launch: post(r.launch), why: r.why ?? "" })).filter(want).slice(0, limit);
    if (out.length) await this.#db.query(`update mq.pairs set run_at = now() where id = any($1::bigint[])`, [out.map((p) => p.id)]);
    return out;
  }

  /** A pair is taken: this customer's account brings them together, with what came of it. */
  async takePair(id: number, customerId: string, note: string): Promise<void> {
    await this.#db.query(`update mq.pairs set taken_by = $2, taken_at = now(), note = $3 where id = $1`, [id, customerId, note.slice(0, 400)]);
  }

  async pairsFor(launchUrl: string): Promise<KeptPair[]> {
    const { rows } = await this.#db.query<{ id: string; ask: SidedPost & { postedAt: string | null }; launch: SidedPost & { postedAt: string | null }; why: string | null }>(
      `select id, ask, launch, why from mq.pairs where launch_url = $1 and found_at > now() - interval '14 days' order by found_at desc, id limit 20`,
      [launchUrl],
    );
    const post = (p: SidedPost & { postedAt: string | null }): SidedPost => ({ ...p, postedAt: p.postedAt ? new Date(p.postedAt) : null });
    return rows.map((r) => ({ id: Number(r.id), ask: post(r.ask), launch: post(r.launch), why: r.why ?? "" }));
  }

  async keepPage(customerId: string, page: MatchPage): Promise<string> {
    const code = randomBytes(5).toString("hex").toUpperCase();
    await this.#db.query(`insert into mq.match_pages (code, customer_id, maker, made, launch_url, people, sent) values ($1, $2, $3, $4, $5, $6, $7)`, [
      code, customerId, page.maker.slice(0, 120), page.made?.slice(0, 300) ?? null, page.launchUrl,
      JSON.stringify(page.people.map((p) => ({ author: p.author.slice(0, 80), quote: p.quote.slice(0, 200), url: p.url, ...(p.fit ? { fit: true } : {}) }))),
      page.sent !== false,
    ]);
    return code;
  }

  /** Whether someone was already written to about this launch: its link goes to one person, never the same to several. */
  async askerTold(launchUrl: string): Promise<boolean> {
    const { rows } = await this.#db.query(`select 1 from mq.pairs where launch_url = $1 and note like '%asker: draft%' limit 1`, [launchUrl]);
    return rows.length > 0;
  }

  /** People already in a pair lately: an asker once, someone who made a thing up to three times (three people to send them). */
  async inPairs(days: number): Promise<Set<string>> {
    const had = this.#pairs;
    if (!had || had.days !== days || Date.now() - had.at >= KEYS_KEPT_MS) {
      const { rows } = await this.#db.query<{ key: string; n: number; ask: boolean }>(
        `select ask_key as key, 0 as n, true as ask from mq.pairs where ask_key is not null and found_at > now() - make_interval(days => $1) group by ask_key
         union all select launch_key, count(*)::int, false from mq.pairs where launch_key is not null and found_at > now() - make_interval(days => $1) group by launch_key`,
        [days],
      );
      this.#pairs = {
        at: Date.now(),
        days,
        asks: new Set(rows.filter((r) => r.ask).map((r) => r.key)),
        launches: new Map(rows.filter((r) => !r.ask).map((r) => [r.key, r.n])),
      };
    }
    const p = this.#pairs!;
    return new Set([...p.asks, ...[...p.launches].filter(([, n]) => n >= 3).map(([k]) => k)]);
  }

  /** What a check already found about these posts' authors, by the post's address. */
  async about(posts: readonly FoundPost[]): Promise<Map<string, KnownAbout>> {
    const keys = new Map(posts.flatMap((p) => { const k = knownKey(p); return k ? [[k, p.url] as const] : []; }));
    const out = new Map<string, KnownAbout>();
    if (!keys.size) return out;
    const { rows } = await this.#db.query<{ key: string; about: string | null; reach: string | null; site_url: string | null; profile_url: string | null }>(
      `select key, about, reach, site_url, profile_url from mq.known_people where key = any($1::text[]) and (about is not null or reach is not null)`,
      [[...keys.keys()]],
    );
    for (const r of rows) out.set(keys.get(r.key)!, { about: r.about, reach: r.reach, siteUrl: r.site_url, profileUrl: r.profile_url });
    return out;
  }
}
