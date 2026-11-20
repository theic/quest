import { customerId, draftId, type CustomerId, type Draft, type DraftId, type DraftKind, type DraftRepository, type DraftStatus, type NewDraft, type ToldAnswers, type WatchedDraft } from "@mq/core";
import { whoKey } from "../drafts/one-reply.ts";
import type { Queryable } from "./db.ts";
import { ReadCache } from "./read-cache.ts";

interface DraftRow {
  id: string;
  customer_id: string;
  kind: DraftKind;
  platform: string;
  url: string;
  target: string;
  title: string | null;
  author: string | null;
  quote: string | null;
  body: string;
  status: DraftStatus;
  card_ref: string | null;
  created_at: Date;
  decided_at: Date | null;
  sent_url: string | null;
  sent_as: string | null;
  sent_at: Date | null;
  alone: boolean;
  answered_at: Date | null;
  assets: string[] | null;
}

const toDraft = (r: DraftRow): Draft => ({
  id: draftId(r.id),
  customerId: customerId(r.customer_id),
  kind: r.kind,
  platform: r.platform,
  url: r.url,
  target: r.target,
  title: r.title,
  author: r.author,
  quote: r.quote,
  text: r.body,
  status: r.status,
  cardRef: r.card_ref,
  createdAt: r.created_at,
  decidedAt: r.decided_at,
  sentUrl: r.sent_url,
  sentAs: r.sent_as,
  sentAt: r.sent_at,
  alone: r.alone,
  ...(r.answered_at ? { answeredAt: r.answered_at } : {}),
  ...(r.assets?.length ? { assets: r.assets } : {}),
});

const COLUMNS = `id, customer_id, kind, platform, url, target, title, author, quote, body, status, card_ref, created_at, decided_at, sent_url, sent_as, sent_at, alone, answered_at, assets`;

export class PgDraftRepository implements DraftRepository {
  readonly #db: Queryable;
  readonly #lane: string;
  readonly #recent: ReadCache<Draft>;
  readonly #told: ReadCache<ToldAnswers & { id: string }>;

  /** `lane` scopes the posted drafts this repository hands out to look at, as the finds do; `cacheMs` keeps `recent` and `toldAnswers` (read-cache.ts). */
  constructor(db: Queryable, lane = "live", cacheMs = 0) {
    this.#db = db;
    this.#lane = lane;
    this.#recent = new ReadCache(cacheMs, 400);
    this.#told = new ReadCache(cacheMs);
  }

  /** A write returns the rows it changed, and the kept lists take them as they are now (read-cache.ts), so nothing is read again for it. */
  async #write<R extends object = object>(sql: string, params: unknown[]) {
    const out = await this.#db.query<R>(sql, params);
    for (const row of out.rows as unknown as DraftRow[]) {
      if (!row?.id || !row.customer_id) continue;
      const now = toDraft(row);
      this.#recent.patch((d) => (d.id === now.id ? now : d));
    }
    return out;
  }

  async add(d: NewDraft): Promise<Draft> {
    const { rows } = await this.#write<DraftRow>(`insert into mq.drafts (customer_id, kind, platform, url, target, title, author, quote, body, assets, task_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::uuid[], $11) returning ${COLUMNS}`,
      [d.customerId, d.kind, d.platform, d.url, d.target, d.title, d.author, d.quote, d.text, d.assets ?? [], d.taskId ?? null],
    );
    const added = toDraft(rows[0]!);
    this.#recent.prepend(added.customerId, added);
    return added;
  }

  async get(id: DraftId): Promise<Draft | null> {
    const { rows } = await this.#db.query<DraftRow>(`select ${COLUMNS} from mq.drafts where id = $1`, [id]);
    return rows[0] ? toDraft(rows[0]) : null;
  }

  async markShown(id: DraftId, cardRef: string | null): Promise<void> {
    await this.#write(`update mq.drafts set card_ref = $2 where id = $1 returning ${COLUMNS}`, [id, cardRef]);
  }

  async beginPost(id: DraftId, alone = false): Promise<boolean> {
    const { rowCount } = await this.#write(`update mq.drafts set status = 'posting', decided_at = now(), alone = $2 where id = $1 and status = 'open' returning ${COLUMNS}`, [id, alone]);
    return (rowCount ?? 0) > 0;
  }

  async endPost(id: DraftId, uncertain: boolean): Promise<void> {
    await this.#write(`update mq.drafts set status = $2 where id = $1 and status in ('posting', 'uncertain') returning ${COLUMNS}`, [id, uncertain ? "uncertain" : "open"]);
  }

  async leftPosting(): Promise<Draft[]> {
    const { rows } = await this.#db.query<DraftRow>(
      `select ${COLUMNS} from mq.drafts
        where status = 'posting' and customer_id in (select id from mq.customers where lane = $1)
        order by decided_at`,
      [this.#lane],
    );
    return rows.map(toDraft);
  }

  async skip(id: DraftId, answered = false): Promise<Draft | null> {
    const { rows } = await this.#write<DraftRow>(`update mq.drafts set status = 'skipped', decided_at = now(), answered_at = case when $2::boolean then now() end where id = $1 and status = 'open' returning ${COLUMNS}`,
      [id, answered],
    );
    return rows[0] ? toDraft(rows[0]) : null;
  }

  async markSent(id: DraftId, url: string, account: string, alone = false): Promise<Draft | null> {
    const { rows } = await this.#write<DraftRow>(`update mq.drafts set status = 'posted', decided_at = now(), sent_url = $2, sent_as = $3, sent_at = now(), alone = $4
        where id = $1 and status in ('open', 'posting', 'uncertain') returning ${COLUMNS}`,
      [id, url, account, alone],
    );
    return rows[0] ? toDraft(rows[0]) : null;
  }

  async revise(id: DraftId, text: string, title: string | null): Promise<Draft | null> {
    const { rows } = await this.#write<DraftRow>(`update mq.drafts set body = $2, title = coalesce($3, title) where id = $1 and status = 'open' returning ${COLUMNS}`,
      [id, text, title],
    );
    return rows[0] ? toDraft(rows[0]) : null;
  }

  async byCard(customer: CustomerId, cardRef: string): Promise<Draft | null> {
    const { rows } = await this.#db.query<DraftRow>(`select ${COLUMNS} from mq.drafts where customer_id = $1 and (card_ref = $2 or $2 = any(other_refs)) order by card_ref = $2 desc limit 1`, [customer, cardRef]);
    return rows[0] ? toDraft(rows[0]) : null;
  }

  async moveCard(id: DraftId, cardRef: string): Promise<void> {
    // The old ref is read before the update: every expression in a set list sees the row as it was.
    await this.#write(`update mq.drafts set other_refs = case when card_ref is null or card_ref = $2 then other_refs else array_append(other_refs, card_ref) end, card_ref = $2 where id = $1 returning ${COLUMNS}`,
      [id, cardRef],
    );
  }

  async addRef(id: DraftId, ref: string): Promise<void> {
    await this.#write(`update mq.drafts set other_refs = array_append(other_refs, $2) where id = $1 returning ${COLUMNS}`, [id, ref]);
  }

  async sentSince(customer: CustomerId, since: Date): Promise<number> {
    const { rows } = await this.#db.query<{ n: string }>(`select count(*) as n from mq.drafts where customer_id = $1 and sent_at >= $2`, [customer, since]);
    return Number(rows[0]?.n ?? 0);
  }

  async recent(customer: CustomerId, limit: number): Promise<Draft[]> {
    return this.#recent.get(customer, limit, async (limit) => {
      const { rows } = await this.#db.query<DraftRow>(
        `select ${COLUMNS} from mq.drafts where customer_id = $1 order by created_at desc limit $2`,
        [customer, limit],
      );
      return rows.map(toDraft);
    });
  }

  async withPerson(customer: CustomerId, person: string, urls: readonly string[]): Promise<Draft[]> {
    const { rows } = await this.#db.query<DraftRow>(
      `select ${COLUMNS} from mq.drafts
        where customer_id = $1 and created_at > now() - interval '14 days'
          and (lower(ltrim(target, '@')) = $2 or lower(ltrim(author, '@')) = $2 or url = any($3::text[]))
        order by created_at desc limit 50`,
      [customer, person.replace(/^@/, "").toLowerCase(), [...urls]],
    );
    return rows.map(toDraft);
  }

  async repliesTo(customer: CustomerId, platform: string, url: string, target: string | null): Promise<Draft[]> {
    // A post's long number names it whatever the shape of its address (LinkedIn's /posts/…-share-<id>, /feed/update/urn:li:share:<id>).
    const id = /\d{15,}/.exec(url)?.[0] ?? null;
    const { rows } = await this.#db.query<DraftRow>(
      `select ${COLUMNS} from mq.drafts
        where customer_id = $1 and platform = $2 and kind = 'reply'
          and (status in ('posted', 'uncertain', 'posting') or answered_at is not null)
          and (url = $3 or ($4::text is not null and (lower(target) = lower($4) or ($6::text is not null and regexp_replace(lower(ltrim(target, '@')), '[^[:alnum:]]+', ' ', 'g') like $6 || '%'))) or ($5::text is not null and position($5 in url) > 0))
        order by created_at desc limit 60`,
      [customer, platform, url, target?.trim() || null, id, whoKey(target).length >= 5 ? whoKey(target) : null],
    );
    return rows.map(toDraft);
  }

  async dueWatches(now: Date, limit: number, only?: readonly CustomerId[]): Promise<WatchedDraft[]> {
    if (only && !only.length) return [];
    const { rows } = await this.#db.query<DraftRow & { watch_checks: number; watch_seen: string[] }>(
      `select ${COLUMNS}, watch_checks, watch_seen from mq.drafts
        where watch_next_at <= $1 and customer_id in (select id from mq.customers where lane = $2) and ($4::uuid[] is null or customer_id = any($4::uuid[]))
        order by watch_checks, watch_next_at limit $3`,
      [now, this.#lane, limit, only ? [...only] : null],
    );
    return rows.map((r) => ({ draft: toDraft(r), checks: r.watch_checks, seen: r.watch_seen }));
  }

  async watch(id: DraftId, next: Date | null, checks: number, seen: readonly string[]): Promise<void> {
    // A look's save changes none of what `recent` holds, only what `toldAnswers` does: it runs for every send a look
    // covers, so the kept list takes the row as it is now (forgotten on each, it was read 1,265 times in two and a half
    // days, about 150 MB).
    const { rows } = await this.#db.query<{ customer_id: string; url: string }>(
      `update mq.drafts set watch_next_at = $2, watch_checks = $3, watch_seen = $4::text[] where id = $1 returning customer_id, url`,
      [id, next, checks, seen],
    );
    const row = rows[0];
    if (!row) return;
    this.#told.each((customer, kept) => {
      if (customer !== row.customer_id) return kept;
      const rest = kept.filter((t) => t.id !== id);
      return seen.length ? [...rest, { id, url: row.url, seen: [...seen] }] : rest;
    });
  }

  async toldAnswers(customer: CustomerId): Promise<ToldAnswers[]> {
    return this.#told.get(customer, Number.MAX_SAFE_INTEGER, async () => {
      const { rows } = await this.#db.query<ToldAnswers & { id: string }>(`select id, url, watch_seen as seen from mq.drafts where customer_id = $1 and cardinality(watch_seen) > 0`, [customer]);
      return rows;
    });
  }
}
