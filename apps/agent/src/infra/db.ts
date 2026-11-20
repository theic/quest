import type { Logger } from "@mq/core";
import pg from "pg";

/**
 * One pool for the whole process: the repositories and LangGraph's checkpointer
 * share it. Supavisor's session mode (port 5432) keeps prepared statements and
 * LISTEN working, which the checkpointer relies on.
 */
export function createPool(url: string, max = 8, log?: Logger): pg.Pool {
  const pool = new pg.Pool({
    connectionString: url,
    // Supabase's pooler presents a certificate from its own CA. A database on this machine (the local edition's) has none.
    ssl: /@(127\.0\.0\.1|localhost|\[::1\])[:/]/.test(url) ? false : { rejectUnauthorized: false },
    max,
    // Short, so the connections close soon after the loops stop and an idle agent can sleep.
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
  });
  keepUpWhenConnectionsDrop(pool, log);
  return pool;
}

/**
 * A connection the network or the pooler drops (a laptop asleep, Supavisor restarting) is an `error` event, and
 * an `error` event nobody listens to is thrown: the process exits. Live, 2026-10-18, the laptop agent died
 * overnight on "write ECONNABORTED". An idle connection's error comes to the pool, which has already let the
 * connection go and opens a new one when asked. One checked out (the checkpointer's transactions) comes to the
 * client: its query in flight fails with it, and the pool drops the client when it is given back.
 */
export function keepUpWhenConnectionsDrop(pool: pg.Pool, log?: Logger): void {
  pool.on("error", (e) => {
    const data = { error: e.message, code: (e as { code?: string }).code };
    if (log) log.warn("db.connection_lost", data);
    else console.warn("db.connection_lost", data);
  });
  pool.on("connect", (client) => {
    client.on("error", () => undefined);
  });
}

/**
 * The network's codes for a socket gone or a database it cannot reach (a laptop's network down: no route, no DNS), and
 * Postgres's for a connection the server or pooler ended (57P0x, 08xxx).
 */
const LOST_CODE = /^(ECONNRESET|ECONNABORTED|ETIMEDOUT|EPIPE|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|57P0[123]|08\d{3})$/;

/**
 * Whether an error is a database connection that went away under a query, or could not be had: pg's own words for it
 * (pg-pool's "timeout exceeded when trying to connect": live, 2026-11-04, a checkpoint save waited 10 s for a
 * connection and the laptop agent exited), Supavisor's full pool (the same evening: after a network drop it still
 * counted the dead sessions, refused a new one with "(EMAXCONNSESSION) max clients reached", and the agent exited), or
 * its code.
 */
export function connectionLost(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  if (/^Connection terminated|^Client has encountered a connection error and is not queryable$|^timeout exceeded when trying to connect$|^\(EMAXCONNSESSION\)/.test(e.message)) return true;
  return LOST_CODE.test(String((e as { code?: unknown }).code ?? ""));
}

/**
 * LangGraph saves each step's checkpoint in the background and waits for those saves only at the end of the run, so a
 * save whose connection dropped rejects with nothing listening yet, and Node exits on that. Live, 2026-10-23 06:48: the
 * laptop agent exited on "Client has encountered a connection error and is not queryable" from
 * `PostgresSaver.putWrites`; the connection's own error had gone to the query in flight, so nothing was logged. A lost
 * connection is logged instead: the run fails when it waits for its saves, and the queue runs it again. Anything else
 * still ends the process, as Node would.
 */
export function keepUpWhenSavesFail(log?: Logger, proc: Pick<NodeJS.EventEmitter, "on"> = process): void {
  proc.on("unhandledRejection", (reason: unknown) => {
    // A save the server stopped at its statement timeout (57014; live, 2026-11-16 05:03, an insert into
    // checkpoint_writes) is the same case: the run fails when it waits, and the queue runs it again.
    const timedOut = String((reason as { code?: unknown })?.code ?? "") === "57014";
    if (!connectionLost(reason) && !timedOut) throw reason;
    const data = { error: (reason as Error).message, code: (reason as { code?: string }).code, unhandled: true };
    const event = timedOut ? "db.save_timed_out" : "db.connection_lost";
    if (log) log.warn(event, data);
    else console.warn(event, data);
  });
}

/** The narrow slice of pg the repositories use, so tests can hand them anything that queries. */
export interface Queryable {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>>;
}

export const ms = (n: number): string => `${Math.max(0, Math.round(n))} milliseconds`;

export const isUniqueViolation = (e: unknown): boolean =>
  typeof e === "object" && e !== null && "code" in e && (e as { code?: string }).code === "23505";
