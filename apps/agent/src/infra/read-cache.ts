/**
 * A customer's last list, kept in memory (live, 2026-11-15: on dev the same 250 drafts were read 6,573 times in
 * 41 hours, 756 MB, most of the database's egress). It is read once at `least` rows, so a short read and a long one
 * share it. A write through the same store either patches what is kept (`patch`, `prepend`: the store knows what it
 * changed) or forgets it; a read that began before a write is not kept. Only this process writes these tables, so nothing
 * it reads is older than its own last write. Forgetting on every write and keeping 30 s missed nearly every read (live,
 * the next night: reads came every 20 s and writes between them), so a store that patches keeps its lists for minutes.
 * Off (0 ms) in tests.
 */
export class ReadCache<T> {
  readonly #ms: number;
  readonly #least: number;
  readonly #kept = new Map<string, { at: number; limit: number; rows: T[] }>();
  #gen = 0;

  constructor(ms: number, least = 0) {
    this.#ms = ms;
    this.#least = least;
  }

  async get(key: string, limit: number, load: (limit: number) => Promise<T[]>): Promise<T[]> {
    if (this.#ms <= 0) return load(limit);
    const kept = this.#kept.get(key);
    if (kept && kept.limit >= limit && Date.now() - kept.at < this.#ms) return kept.rows.slice(0, limit);
    const gen = this.#gen;
    const size = Math.max(limit, this.#least);
    const rows = await load(size);
    if (gen === this.#gen) this.#kept.set(key, { at: Date.now(), limit: size, rows });
    return rows.slice(0, limit);
  }

  /** Each kept row as the write left it. */
  patch(change: (row: T) => T): void {
    this.#gen += 1;
    for (const kept of this.#kept.values()) kept.rows = kept.rows.map(change);
  }

  /** A new row at the top of its key's list. */
  prepend(key: string, row: T): void {
    this.#gen += 1;
    const kept = this.#kept.get(key);
    if (kept) kept.rows = [row, ...kept.rows].slice(0, kept.limit);
  }

  /** A row the write made newest: out of where it was in its key's list (`same`), and at the top. */
  lift(key: string, row: T, same: (kept: T) => boolean): void {
    this.#gen += 1;
    const kept = this.#kept.get(key);
    if (kept) kept.rows = [row, ...kept.rows.filter((r) => !same(r))].slice(0, kept.limit);
  }

  /** Each key's list as `change` leaves it (a row added, changed or dropped). */
  each(change: (key: string, rows: T[]) => T[]): void {
    this.#gen += 1;
    for (const [key, kept] of this.#kept) kept.rows = change(key, kept.rows);
  }

  forget(): void {
    this.#gen += 1;
    this.#kept.clear();
  }
}
