import type { Logger, ModelCall, SpendLog } from "@mq/core";
import type { Queryable } from "./db.ts";

/** Every model call's tokens and cost in `mq.model_calls`, a row each, written without waiting. */
export class PgSpendLog implements SpendLog {
  readonly #db: Queryable;
  readonly #log: Logger;

  constructor(db: Queryable, log: Logger) {
    this.#db = db;
    this.#log = log;
  }

  record(call: ModelCall): void {
    const u = call.usage;
    this.#db
      .query(
        `insert into mq.model_calls
           (customer_id, task_id, agent, model, ms, input_tokens, cached_tokens, cache_write_tokens, output_tokens, reasoning_tokens, cost)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [call.customerId, call.taskId, call.agent, call.model, Math.round(call.ms), u.input, u.cached, u.cacheWrite, u.output, u.reasoning, u.cost],
      )
      .catch((e: unknown) => {
        this.#log.warn("spend.failed", { customerId: call.customerId, agent: call.agent, error: e instanceof Error ? e.message : String(e) });
      });
  }
}
