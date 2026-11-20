import { CONTACT_NOTES, contactKey, type Contact, type ContactCheck, type ContactRepository, type CustomerId } from "@mq/core";
import type { Queryable } from "./db.ts";
import { ReadCache } from "./read-cache.ts";

interface ContactRow {
  customer_id: string;
  key: string;
  site: string;
  handle: string;
  name: string | null;
  profile_url: string | null;
  site_url: string | null;
  about: string;
  needs: string | null;
  can_give: string | null;
  given: string[];
  notes: { at: string; text: string }[];
  checked_at: Date;
  created_at: Date;
  updated_at: Date;
}

const fromRow = (r: ContactRow): Contact => ({
  customerId: r.customer_id as CustomerId,
  key: r.key,
  site: r.site,
  handle: r.handle,
  name: r.name,
  profileUrl: r.profile_url,
  siteUrl: r.site_url,
  about: r.about,
  needs: r.needs,
  canGive: r.can_give,
  given: r.given ?? [],
  notes: (r.notes ?? []).map((n) => ({ at: new Date(n.at), text: n.text })),
  checkedAt: r.checked_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const clip = (s: string | null | undefined, max: number): string | null => (s?.trim() ? s.trim().slice(0, max) : null);

/** mq.contacts: the people Quest got to know for a customer, kept for good. */
export class PgContacts implements ContactRepository {
  readonly #db: Queryable;
  readonly #list: ReadCache<Contact>;

  /** `cacheMs` keeps `list` for a moment (read-cache.ts). */
  constructor(db: Queryable, cacheMs = 0) {
    this.#db = db;
    this.#list = new ReadCache(cacheMs, 400);
  }

  async get(customer: CustomerId, key: string): Promise<Contact | null> {
    const { rows } = await this.#db.query<ContactRow>(`select * from mq.contacts where customer_id = $1 and key = $2`, [customer, key]);
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async list(customer: CustomerId, limit: number): Promise<Contact[]> {
    return this.#list.get(customer, limit, async (limit) => {
      const { rows } = await this.#db.query<ContactRow>(`select * from mq.contacts where customer_id = $1 order by updated_at desc limit $2`, [customer, limit]);
      return rows.map(fromRow);
    });
  }

  async keep(customer: CustomerId, c: ContactCheck): Promise<Contact> {
    // A plan keeps its Introduce lines whole: cut at 300 characters, every maker's yes found no one to introduce (live,
    // 2026-11-15: the plan's first sentences took 230, so the first person's line ended mid-handle and the rest were gone).
    const note = clip(c.note, c.note?.trimStart().startsWith("Plan:") ? 3000 : 300);
    const gave = clip(c.gave, 300);
    const { rows } = await this.#db.query<ContactRow>(
      `insert into mq.contacts as k (customer_id, key, site, handle, name, profile_url, site_url, about, needs, can_give, given, notes)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
               case when $11::text is null then '{}'::text[] else array[$11::text] end,
               case when $12::text is null then '[]'::jsonb else jsonb_build_array(jsonb_build_object('at', now(), 'text', $12::text)) end)
       on conflict (customer_id, key) do update set
         name = coalesce(excluded.name, k.name),
         profile_url = coalesce(excluded.profile_url, k.profile_url),
         site_url = coalesce(excluded.site_url, k.site_url),
         about = excluded.about,
         needs = coalesce(excluded.needs, k.needs),
         can_give = coalesce(excluded.can_give, k.can_give),
         given = case when $11::text is null then k.given else (k.given || array[$11::text])[greatest(1, cardinality(k.given) + 2 - $13):] end,
         notes = case when $12::text is null then k.notes else
           (select coalesce(jsonb_agg(n order by i), '[]'::jsonb) from jsonb_array_elements(k.notes || jsonb_build_array(jsonb_build_object('at', now(), 'text', $12::text))) with ordinality as e(n, i)
             where i > jsonb_array_length(k.notes) + 1 - $13) end,
         checked_at = now(),
         updated_at = now()
       returning *`,
      [
        customer,
        contactKey(c.site, c.handle),
        c.site,
        c.handle.trim().replace(/^@/, ""),
        clip(c.name, 200),
        clip(c.profileUrl, 500),
        clip(c.siteUrl, 500),
        c.about.trim().slice(0, 1000),
        clip(c.needs, 500),
        clip(c.canGive, 500),
        gave,
        note,
        CONTACT_NOTES,
      ],
    );
    // Kept lists go newest first: the record it wrote moves to the top.
    const kept = fromRow(rows[0]!);
    this.#list.lift(customer, kept, (k) => k.key === kept.key);
    return kept;
  }
}
