import {
  askedFields,
  customerId,
  type ChannelAddress,
  type ChannelKind,
  type Customer,
  type CustomerId,
  type CustomerPatch,
  type CustomerRepository,
  type CustomerStatus,
  type AskedWith,
  type IntakeOption,
  type NewCustomer,
  type Profile,
  type ProfileAnswer,
  type ProfileEntry,
  type Scene,
  type Reflection,
} from "@mq/core";
import { isUniqueViolation, type Queryable } from "./db.ts";

interface CustomerRow {
  id: string;
  display_name: string | null;
  language: string | null;
  site_url: string | null;
  status: CustomerStatus;
  brief: string | null;
  plan: string | null;
  timezone: string | null;
  report_hour: number;
  profile: Record<string, RawEntry> | null;
  chrome_front: boolean;
  off_at: Date | null;
  swept_at: Date | null;
  activated_at: Date | null;
  created_at: Date;
}

/** A profile entry as jsonb keeps it: times as ISO strings. */
interface RawEntry {
  askedAt: string;
  ref: string | null;
  answeredAt: string | null;
  choice: string | null;
  answer: string | null;
  options?: readonly IntakeOption[];
  scene?: Scene;
  guess?: readonly string[];
  reflection?: Reflection;
  spoken?: boolean;
}

const toProfile = (raw: Record<string, RawEntry> | null): Profile =>
  Object.fromEntries(
    Object.entries(raw ?? {}).map(([key, e]): [string, ProfileEntry] => [
      key,
      {
        askedAt: new Date(e.askedAt),
        ref: e.ref,
        answeredAt: e.answeredAt ? new Date(e.answeredAt) : null,
        choice: e.choice,
        answer: e.answer,
        ...(e.options ? { options: e.options } : {}),
        ...(e.scene ? { scene: e.scene } : {}),
        ...(e.guess ? { guess: e.guess } : {}),
        ...(e.reflection ? { reflection: e.reflection } : {}),
        ...(e.spoken ? { spoken: true } : {}),
      },
    ]),
  );

const toCustomer = (r: CustomerRow): Customer => ({
  id: customerId(r.id),
  displayName: r.display_name,
  language: r.language,
  siteUrl: r.site_url,
  status: r.status,
  brief: r.brief,
  plan: r.plan,
  timezone: r.timezone,
  reportHour: r.report_hour,
  profile: toProfile(r.profile),
  chromeFront: r.chrome_front,
  offAt: r.off_at,
  sweptAt: r.swept_at,
  activatedAt: r.activated_at,
  createdAt: r.created_at,
});

const COLUMNS = "c.id, c.display_name, c.language, c.site_url, c.status, c.brief, c.plan, c.timezone, c.report_hour, c.profile, c.chrome_front, c.off_at, c.swept_at, c.activated_at, c.created_at";

/**
 * Customers as `get` last read them, shared by every store in this process (live, 2026-11-16: on dev one customer row,
 * 6.7 KB with its brief and profile, was read 52,000 times in two and a half days, about 260 MB). Any write to a column
 * `get` returns, here or in another store (an invite, a pack, a free start), calls `customerChanged`; a change made by
 * hand in the database shows within `cacheMs`.
 */
const kept = new Map<string, { at: number; customer: Customer }>();
let changes = 0;

/** A write changed this customer's row: the next `get` reads it again. */
export function customerChanged(id: string): void {
  changes += 1;
  kept.delete(id);
}

export class PgCustomerRepository implements CustomerRepository {
  readonly #db: Queryable;
  readonly #lane: string;
  readonly #cacheMs: number;

  /** `lane` keeps test rows away from a running agent: it only sees its own lane. `cacheMs` keeps `get` (0: off). */
  constructor(db: Queryable, lane = "live", cacheMs = 0) {
    this.#db = db;
    this.#lane = lane;
    this.#cacheMs = cacheMs;
  }

  async findByChannel(address: ChannelAddress): Promise<Customer | null> {
    const { rows } = await this.#db.query<CustomerRow>(
      `select ${COLUMNS} from mq.customers c join mq.channels ch on ch.customer_id = c.id
        where ch.kind = $1 and ch.address = $2`,
      [address.kind, address.address],
    );
    return rows[0] ? toCustomer(rows[0]) : null;
  }

  async channelOf(id: CustomerId, kind: ChannelKind): Promise<ChannelAddress | null> {
    const { rows } = await this.#db.query<{ address: string }>(`select address from mq.channels where customer_id = $1 and kind = $2 order by last_seen_at desc limit 1`, [id, kind]);
    return rows[0] ? { kind, address: rows[0].address } : null;
  }

  async bindChannel(id: CustomerId, address: ChannelAddress, userRef: string): Promise<void> {
    // Seen long ago: binding it does not make it where Quest writes; their first message from it does.
    await this.#db.query(
      `insert into mq.channels (customer_id, kind, address, user_ref, last_seen_at) values ($1, $2, $3, $4, 'epoch') on conflict (kind, address) do nothing`,
      [id, address.kind, address.address, userRef],
    );
  }

  async create(input: NewCustomer): Promise<Customer> {
    try {
      const { rows } = await this.#db.query<CustomerRow>(
        `with c as (
           insert into mq.customers (display_name, language, lane) values ($1, $2, $6)
           returning id, display_name, language, site_url, status, brief, plan, timezone, report_hour, profile, chrome_front, off_at, swept_at, activated_at, created_at
         ), ch as (
           insert into mq.channels (customer_id, kind, address, user_ref)
           select id, $3, $4, $5 from c
         )
         select ${COLUMNS} from c`,
        [input.displayName, input.language, input.channel.kind, input.channel.address, input.userRef, this.#lane],
      );
      if (!rows[0]) throw new Error("customer insert returned nothing");
      return toCustomer(rows[0]);
    } catch (e) {
      // Two first messages raced; the other one created the customer.
      if (!isUniqueViolation(e)) throw e;
      const existing = await this.findByChannel(input.channel);
      if (!existing) throw e;
      return existing;
    }
  }

  async get(id: CustomerId): Promise<Customer> {
    const had = this.#cacheMs > 0 ? kept.get(id) : undefined;
    if (had && Date.now() - had.at < this.#cacheMs) return had.customer;
    const before = changes;
    const { rows } = await this.#db.query<CustomerRow>(`select ${COLUMNS} from mq.customers c where c.id = $1`, [id]);
    if (!rows[0]) throw new Error(`no customer ${id}`);
    const customer = toCustomer(rows[0]);
    // A read that began before a write is not kept.
    if (this.#cacheMs > 0 && before === changes) kept.set(id, { at: Date.now(), customer });
    return customer;
  }

  async update(id: CustomerId, patch: CustomerPatch): Promise<void> {
    const columns: Record<keyof CustomerPatch, string> = {
      displayName: "display_name",
      language: "language",
      siteUrl: "site_url",
      status: "status",
      brief: "brief",
      plan: "plan",
      timezone: "timezone",
      reportHour: "report_hour",
      chromeFront: "chrome_front",
      offAt: "off_at",
      sweptAt: "swept_at",
      activatedAt: "activated_at",
      cameFrom: "came_from",
    };
    const sets: string[] = [];
    const values: unknown[] = [id];
    for (const [key, column] of Object.entries(columns) as [keyof CustomerPatch, string][]) {
      if (patch[key] === undefined) continue;
      values.push(patch[key]);
      sets.push(`${column} = $${values.length}`);
    }
    if (!sets.length) return;
    customerChanged(id);
    await this.#db.query(`update mq.customers set ${sets.join(", ")} where id = $1`, values);
    customerChanged(id);
  }

  async switchedOff(): Promise<CustomerId[]> {
    const { rows } = await this.#db.query<{ id: string }>(`select id from mq.customers where off_at is not null and lane = $1`, [this.#lane]);
    return rows.map((r) => customerId(r.id));
  }

  async chats(kind: ChannelKind): Promise<ChannelAddress[]> {
    const { rows } = await this.#db.query<{ address: string }>(
      `select ch.address from mq.channels ch join mq.customers c on c.id = ch.customer_id where ch.kind = $1 and c.lane = $2`,
      [kind, this.#lane],
    );
    return rows.map((r) => ({ kind, address: r.address }));
  }

  async markSeen(address: ChannelAddress): Promise<void> {
    await this.#db.query(`update mq.channels set last_seen_at = now() where kind = $1 and address = $2`, [
      address.kind,
      address.address,
    ]);
  }

  async primaryChannel(id: CustomerId): Promise<ChannelAddress | null> {
    const { rows } = await this.#db.query<{ kind: ChannelKind; address: string }>(
      `select kind, address from mq.channels where customer_id = $1 order by last_seen_at desc limit 1`,
      [id],
    );
    return rows[0] ? { kind: rows[0].kind, address: rows[0].address } : null;
  }

  async profileAsked(id: CustomerId, key: string, ref: string | null, at: Date, asked: AskedWith = {}): Promise<void> {
    const entry: RawEntry = { askedAt: at.toISOString(), ref, answeredAt: null, choice: null, answer: null, ...askedFields(asked) };
    customerChanged(id);
    await this.#db.query(`update mq.customers set profile = profile || jsonb_build_object($2::text, $3::jsonb) where id = $1`, [id, key, JSON.stringify(entry)]);
  }

  async profileAnswered(id: CustomerId, key: string, a: ProfileAnswer): Promise<boolean> {
    // Only a question that was asked and waits: two taps at once answer it once.
    customerChanged(id);
    const res = await this.#db.query(
      `update mq.customers
          set profile = jsonb_set(profile, array[$2::text], (profile -> $2::text) || jsonb_build_object('answeredAt', $3::text, 'choice', $4::text, 'answer', $5::text)
                                                     || case when $6::boolean then '{"spoken":true}'::jsonb else '{}'::jsonb end)
        where id = $1 and profile ? $2::text and profile -> $2::text ->> 'answeredAt' is null`,
      [id, key, a.at.toISOString(), a.choice, a.answer, Boolean(a.spoken)],
    );
    return (res.rowCount ?? 0) > 0;
  }
}
