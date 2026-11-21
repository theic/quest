import type { CustomerId } from "@mq/core";
import type { Queryable } from "./db.ts";

/** What went up on a platform, by kind, and who answered there. */
export interface PlatformDay {
  readonly platform: string;
  readonly sent: Readonly<Record<string, number>>;
  /** People who answered there in the window. */
  readonly answered: number;
}

/** Someone who answered, as the watch recorded them. */
export interface Answered {
  readonly person: string;
  readonly url: string | null;
  readonly words: string;
}

/** What the report draws as charts (manager/day-report.ts). */
export interface ReportCharts {
  /** One a day, oldest first, today last. */
  readonly trend: readonly { readonly day: string; readonly words: number; readonly light: number; readonly answered: number }[];
  /** Today, by their hour, 0 to 23. */
  readonly hours: readonly { readonly hour: number; readonly words: number; readonly light: number }[];
  /** How far people got, all time: conversation, trial, active, paying. */
  readonly funnel: readonly { readonly stage: string; readonly n: number }[];
}

/** How long a report is kept. */
const KEEP_DAYS = 60;

const siteOf = (url: string | null): string =>
  (url ?? "").replace(/^https?:\/\/(www\.|old\.|m\.)?/, "").split("/")[0]!.replace(/^twitter\.com$/, "x.com").replace(/^reddit$/, "reddit.com") || "?";

/** The daily reports (mq.reports) and the counts they are made of, read straight from the database. */
export class PgReports {
  readonly #db: Queryable;

  constructor(db: Queryable) {
    this.#db = db;
  }

  /** Each platform's day since `since`: what went up by kind, and who answered. */
  async platforms(customerId: CustomerId, since: Date): Promise<PlatformDay[]> {
    const [sent, answered] = await Promise.all([
      this.#db.query<{ platform: string | null; kind: string; n: number }>(
        `select platform, kind, count(*)::int n from mq.drafts where customer_id = $1 and sent_at >= $2 group by 1, 2`,
        [customerId, since],
      ),
      this.#db.query<{ url: string | null; person: string | null }>(
        `select url, person from mq.results where customer_id = $1 and stage = 'conversation' and created_at >= $2`,
        [customerId, since],
      ),
    ]);
    const by = new Map<string, { sent: Record<string, number>; people: Set<string> }>();
    const at = (p: string) => by.get(p) ?? (by.set(p, { sent: {}, people: new Set() }), by.get(p)!);
    for (const r of sent.rows) {
      const row = at(siteOf(r.platform?.includes("/") ? r.platform : r.platform ? `https://${r.platform}` : null));
      row.sent[r.kind] = (row.sent[r.kind] ?? 0) + r.n;
    }
    for (const r of answered.rows) at(siteOf(r.url)).people.add(r.person ?? r.url ?? "");
    return [...by].map(([platform, r]) => ({ platform, sent: r.sent, answered: r.people.size }));
  }

  /**
   * The report's charts: each day since `since` in their time zone (words that went up, likes and follows, people who
   * answered), today's sends by their hour, and how far people got, all time.
   */
  async charts(customerId: CustomerId, since: Date, dayStart: Date, tz: string): Promise<ReportCharts> {
    const [days, answers, hours, stages] = await Promise.all([
      this.#db.query<{ day: string; words: number; light: number }>(
        `select to_char(sent_at at time zone $3, 'YYYY-MM-DD') as day,
                count(*) filter (where kind in ('reply', 'message', 'post'))::int words,
                count(*) filter (where kind in ('like', 'follow'))::int light
           from mq.drafts where customer_id = $1 and sent_at >= $2 group by 1`,
        [customerId, since, tz],
      ),
      this.#db.query<{ day: string; n: number }>(
        `select to_char(created_at at time zone $3, 'YYYY-MM-DD') as day, count(distinct coalesce(person, url))::int n
           from mq.results where customer_id = $1 and stage = 'conversation' and created_at >= $2 group by 1`,
        [customerId, since, tz],
      ),
      this.#db.query<{ hour: number; words: number; light: number }>(
        `select extract(hour from sent_at at time zone $3)::int as hour,
                count(*) filter (where kind in ('reply', 'message', 'post'))::int words,
                count(*) filter (where kind in ('like', 'follow'))::int light
           from mq.drafts where customer_id = $1 and sent_at >= $2 group by 1`,
        [customerId, dayStart, tz],
      ),
      this.#db.query<{ stage: string; people: number; told: number | null }>(
        `select stage, count(person)::int people,
                (array_agg(count order by created_at desc) filter (where person is null))[1] told
           from mq.results where customer_id = $1 group by 1`,
        [customerId],
      ),
    ]);
    const byDay = new Map<string, { words: number; light: number; answered: number }>();
    const at = (d: string) => byDay.get(d) ?? (byDay.set(d, { words: 0, light: 0, answered: 0 }), byDay.get(d)!);
    for (const r of days.rows) Object.assign(at(r.day), { words: r.words, light: r.light });
    for (const r of answers.rows) at(r.day).answered = r.n;
    const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
    const trend: ReportCharts["trend"][number][] = [];
    for (let t = since.getTime(); t <= Date.now() + 1000; t += 86_400_000) {
      const day = fmt.format(new Date(t));
      if (trend.at(-1)?.day !== day) trend.push({ day, ...(byDay.get(day) ?? { words: 0, light: 0, answered: 0 }) });
    }
    const hourly = Array.from({ length: 24 }, (_, hour) => {
      const r = hours.rows.find((h) => h.hour === hour);
      return { hour, words: r?.words ?? 0, light: r?.light ?? 0 };
    });
    const funnel = ["conversation", "trial", "active", "paying"].map((stage) => {
      const r = stages.rows.find((s) => s.stage === stage);
      return { stage, n: Math.max(r?.people ?? 0, r?.told ?? 0) };
    });
    return { trend, hours: hourly, funnel };
  }

  /** Who answered since `since`, newest first. */
  async answered(customerId: CustomerId, since: Date, limit = 40): Promise<Answered[]> {
    const { rows } = await this.#db.query<{ person: string | null; url: string | null; evidence: string | null }>(
      `select person, url, evidence from mq.results where customer_id = $1 and stage = 'conversation' and created_at >= $2
        order by created_at desc limit $3`,
      [customerId, since, limit],
    );
    return rows.map((r) => ({ person: r.person ?? "someone", url: r.url, words: r.evidence ?? "" }));
  }

  async save(customerId: CustomerId, day: string, html: string): Promise<void> {
    await this.#db.query(
      `insert into mq.reports (customer_id, day, html) values ($1, $2, $3)
       on conflict (customer_id, day) do update set html = excluded.html, created_at = now()`,
      [customerId, day, html],
    );
    await this.#db.query(`delete from mq.reports where customer_id = $1 and day < current_date - $2::int`, [customerId, KEEP_DAYS]);
  }

  async get(customerId: CustomerId, day: string): Promise<string | null> {
    const { rows } = await this.#db.query<{ html: string }>(`select html from mq.reports where customer_id = $1 and day = $2`, [customerId, day]);
    return rows[0]?.html ?? null;
  }

  /** The days with a report, newest first. */
  async days(customerId: CustomerId, limit = 14): Promise<string[]> {
    const { rows } = await this.#db.query<{ day: string }>(`select day::text from mq.reports where customer_id = $1 order by day desc limit $2`, [customerId, limit]);
    return rows.map((r) => r.day);
  }
}
