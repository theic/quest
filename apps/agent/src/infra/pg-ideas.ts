import { customerId, type Asset, type AssetKind, type AssetRepository, type ClipReading, type CustomerId, type Idea, type IdeaRepository, type IdeaSource, type IdeaStatus, type NewAsset, type NewIdea } from "@mq/core";
import type { Queryable } from "./db.ts";

interface AssetRow {
  id: string;
  customer_id: string;
  kind: AssetKind;
  channel: string | null;
  file_ref: string | null;
  mime: string | null;
  name: string | null;
  size: number | null;
  url: string | null;
  about: string;
  reading: ClipReading | null;
  created_at: Date;
}

const toAsset = (r: AssetRow): Asset => ({
  id: r.id,
  customerId: customerId(r.customer_id),
  kind: r.kind,
  channel: r.channel,
  fileRef: r.file_ref,
  mime: r.mime,
  name: r.name,
  size: r.size,
  url: r.url,
  about: r.about,
  reading: r.reading ?? null,
  createdAt: r.created_at,
});

const ASSET_COLUMNS = "id, customer_id, kind, channel, file_ref, mime, name, size, url, about, reading, created_at";

/** What they share for their posts: mq.assets. */
export class PgAssetRepository implements AssetRepository {
  readonly #db: Queryable;

  constructor(db: Queryable) {
    this.#db = db;
  }

  async add(a: NewAsset): Promise<Asset> {
    const { rows } = await this.#db.query<AssetRow>(
      `insert into mq.assets (customer_id, kind, channel, file_ref, mime, name, size, url, about, reading)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb) returning ${ASSET_COLUMNS}`,
      [a.customerId, a.kind, a.channel, a.fileRef, a.mime, a.name, a.size, a.url, a.about, a.reading ? JSON.stringify(a.reading) : null],
    );
    return toAsset(rows[0]!);
  }

  async get(id: string): Promise<Asset | null> {
    const { rows } = await this.#db.query<AssetRow>(`select ${ASSET_COLUMNS} from mq.assets where id = $1 and dropped_at is null`, [id]);
    return rows[0] ? toAsset(rows[0]) : null;
  }

  async list(customer: CustomerId, limit: number): Promise<Asset[]> {
    const { rows } = await this.#db.query<AssetRow>(
      `select ${ASSET_COLUMNS} from mq.assets where customer_id = $1 and dropped_at is null order by created_at desc limit $2`,
      [customer, limit],
    );
    return rows.map(toAsset);
  }

  async setReading(id: string, reading: ClipReading): Promise<void> {
    await this.#db.query(`update mq.assets set reading = $2::jsonb where id = $1`, [id, JSON.stringify(reading)]);
  }

  async drop(customer: CustomerId, id: string): Promise<boolean> {
    const { rowCount } = await this.#db.query(`update mq.assets set dropped_at = now() where id = $1 and customer_id = $2 and dropped_at is null`, [id, customer]);
    return (rowCount ?? 0) > 0;
  }
}

interface IdeaRow {
  id: string;
  customer_id: string;
  source: IdeaSource;
  text: string;
  platform: string | null;
  assets: string[];
  status: IdeaStatus;
  card_ref: string | null;
  draft_id: string | null;
  created_at: Date;
  decided_at: Date | null;
}

const toIdea = (r: IdeaRow): Idea => ({
  id: r.id,
  customerId: customerId(r.customer_id),
  source: r.source,
  text: r.text,
  platform: r.platform,
  assets: r.assets ?? [],
  status: r.status,
  cardRef: r.card_ref,
  draftId: r.draft_id,
  createdAt: r.created_at,
  decidedAt: r.decided_at,
});

const IDEA_COLUMNS = "id, customer_id, source, text, platform, assets, status, card_ref, draft_id, created_at, decided_at";

/** Ideas for posts, theirs and Quest's: mq.ideas. */
export class PgIdeaRepository implements IdeaRepository {
  readonly #db: Queryable;

  constructor(db: Queryable) {
    this.#db = db;
  }

  async add(i: NewIdea, status: IdeaStatus): Promise<Idea> {
    const { rows } = await this.#db.query<IdeaRow>(
      `insert into mq.ideas (customer_id, source, text, platform, assets, status) values ($1, $2, $3, $4, $5::uuid[], $6) returning ${IDEA_COLUMNS}`,
      [i.customerId, i.source, i.text, i.platform, i.assets, status],
    );
    return toIdea(rows[0]!);
  }

  async get(id: string): Promise<Idea | null> {
    const { rows } = await this.#db.query<IdeaRow>(`select ${IDEA_COLUMNS} from mq.ideas where id = $1`, [id]);
    return rows[0] ? toIdea(rows[0]) : null;
  }

  async list(customer: CustomerId, limit: number): Promise<Idea[]> {
    const { rows } = await this.#db.query<IdeaRow>(`select ${IDEA_COLUMNS} from mq.ideas where customer_id = $1 order by created_at desc limit $2`, [customer, limit]);
    return rows.map(toIdea);
  }

  async decide(customer: CustomerId, id: string, status: IdeaStatus, draftId: string | null = null): Promise<Idea | null> {
    const { rows } = await this.#db.query<IdeaRow>(
      `update mq.ideas set status = $3, decided_at = now(), draft_id = coalesce($4::uuid, draft_id)
        where id = $1 and customer_id = $2 returning ${IDEA_COLUMNS}`,
      [id, customer, status, draftId],
    );
    return rows[0] ? toIdea(rows[0]) : null;
  }

  async markShown(id: string, cardRef: string | null): Promise<void> {
    await this.#db.query(`update mq.ideas set card_ref = $2 where id = $1`, [id, cardRef]);
  }
}
