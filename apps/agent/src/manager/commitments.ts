import {
  checkTimeFor,
  type Clock,
  type Commitment,
  type CommitmentRepository,
  type CommitmentSchedule,
  type CustomerId,
  type Logger,
  type NewCommitment,
} from "@mq/core";

/** A commitment counts as due this close to its time: the queue's clock is the database's. */
export const DUE_SLACK_MS = 60_000;

/** A next step nobody did when it fell due waits a day, this many times, then it is dropped. */
export const NEXT_STEP_MOVES = 3;

export const isDue = (c: Pick<Commitment, "dueAt">, now: Date): boolean => c.dueAt.getTime() <= now.getTime() + DUE_SLACK_MS;

/**
 * What Quest owes, and the wakes that hold it to its times. Every change goes through here, so a
 * commitment and its wake never disagree: a new one is woken for before its time, a moved one at
 * its new time, a settled one not at all.
 */
export class Commitments {
  readonly #repo: CommitmentRepository;
  readonly #schedule: CommitmentSchedule;
  readonly #clock: Clock;
  readonly #log: Logger;

  constructor(deps: { repo: CommitmentRepository; schedule: CommitmentSchedule; clock: Clock; log: Logger }) {
    this.#repo = deps.repo;
    this.#schedule = deps.schedule;
    this.#clock = deps.clock;
    this.#log = deps.log;
  }

  async add(customerId: CustomerId, c: NewCommitment): Promise<Commitment> {
    const now = this.#clock.now();
    const added = await this.#repo.add(customerId, c, checkTimeFor(c.kind, now, c.dueAt, c.onTime));
    await this.#schedule.commitmentAt(customerId, added.id, added.checkAt);
    this.#log.info("commitments.added", { customerId, id: added.id, kind: added.kind, source: added.source, dueAt: added.dueAt.toISOString() });
    return added;
  }

  async settle(customerId: CustomerId, id: string, status: "kept" | "dropped", note: string | null): Promise<Commitment | null> {
    const closed = await this.#repo.close(customerId, id, status, note);
    if (closed) {
      await this.#schedule.commitmentAt(customerId, closed.id, null);
      this.#log.info("commitments.settled", { customerId, id, status });
    }
    return closed;
  }

  async move(customerId: CustomerId, id: string, dueAt: Date, words: string | null, note: string | null): Promise<Commitment | null> {
    const had = await this.#repo.get(customerId, id);
    if (!had || had.status !== "open") return null;
    const checkAt = checkTimeFor(had.kind, this.#clock.now(), dueAt, had.onTime);
    const moved = await this.#repo.move(customerId, id, { dueAt, checkAt, words, note });
    if (moved) {
      await this.#schedule.commitmentAt(customerId, moved.id, moved.checkAt);
      this.#log.info("commitments.moved", { customerId, id, dueAt: dueAt.toISOString(), moves: moved.moves });
    }
    return moved;
  }

  /**
   * After a turn woken early for one (before its time, to say "I need longer" while there is still
   * time): still open and not moved, it is woken for again at its time.
   */
  async lookAgainAtDue(customerId: CustomerId, id: string): Promise<void> {
    const c = await this.#repo.get(customerId, id);
    if (!c || c.status !== "open" || isDue(c, this.#clock.now())) return;
    await this.#schedule.commitmentAt(customerId, c.id, c.dueAt);
  }

  get(customerId: CustomerId, id: string): Promise<Commitment | null> {
    return this.#repo.get(customerId, id);
  }

  open(customerId: CustomerId): Promise<Commitment[]> {
    return this.#repo.open(customerId);
  }

  settled(customerId: CustomerId, limit: number): Promise<Commitment[]> {
    return this.#repo.settled(customerId, limit);
  }
}
