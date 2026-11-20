import { EventEmitter } from "node:events";
import type { Logger } from "@mq/core";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { connectionLost, keepUpWhenConnectionsDrop, keepUpWhenSavesFail } from "../src/infra/db.ts";

describe("a dropped database connection", () => {
  it("is logged, not thrown, whether the connection was idle or checked out", () => {
    // Live, 2026-10-18: an idle connection dropped overnight ("write ECONNABORTED") and the laptop agent exited.
    const warned: unknown[] = [];
    const log: Logger = { info: () => undefined, warn: (event, data) => warned.push({ event, ...data }), error: () => undefined };
    const pool = new pg.Pool({ connectionString: "postgres://nobody@127.0.0.1:1/none" });
    expect(() => pool.emit("error", new Error("boom"))).toThrow("boom");

    keepUpWhenConnectionsDrop(pool, log);
    const lost = Object.assign(new Error("write ECONNABORTED"), { code: "ECONNABORTED" });
    expect(() => pool.emit("error", lost, {})).not.toThrow();
    expect(warned).toEqual([{ event: "db.connection_lost", error: "write ECONNABORTED", code: "ECONNABORTED" }]);

    // The checkpointer's transactions hold a client: its error comes to the client, and its query fails with it.
    const client = new EventEmitter();
    pool.emit("connect", client);
    expect(() => client.emit("error", lost)).not.toThrow();
  });

  it("keeps the agent up when a background checkpoint save fails with it, and only then", () => {
    // Live, 2026-10-23: the laptop agent exited on this, from PostgresSaver.putWrites, which LangGraph awaits only at a run's end.
    const warned: unknown[] = [];
    const log: Logger = { info: () => undefined, warn: (event, data) => warned.push({ event, ...data }), error: () => undefined };
    const proc = new EventEmitter();
    keepUpWhenSavesFail(log, proc);

    const broken = new Error("Client has encountered a connection error and is not queryable");
    expect(() => proc.emit("unhandledRejection", broken)).not.toThrow();
    expect(() => proc.emit("unhandledRejection", new Error("Connection terminated unexpectedly"))).not.toThrow();
    expect(() => proc.emit("unhandledRejection", Object.assign(new Error("terminating connection due to administrator command"), { code: "57P01" }))).not.toThrow();
    // Live, 2026-11-04: a save that waited for a connection the pool could not open.
    expect(() => proc.emit("unhandledRejection", new Error("timeout exceeded when trying to connect"))).not.toThrow();
    expect(() => proc.emit("unhandledRejection", Object.assign(new Error("getaddrinfo EAI_AGAIN db.example"), { code: "EAI_AGAIN" }))).not.toThrow();
    // The same evening: Supavisor still counting the sessions a network drop left, at its pool's limit.
    expect(() => proc.emit("unhandledRejection", Object.assign(new Error("(EMAXCONNSESSION) max clients reached in session mode - max clients are limited to pool_size: 15"), { code: "XX000" }))).not.toThrow();
    expect(warned).toHaveLength(6);
    expect(warned[0]).toEqual({ event: "db.connection_lost", error: broken.message, code: undefined, unhandled: true });

    // Anything else still ends the process, as Node would.
    expect(() => proc.emit("unhandledRejection", new TypeError("x is undefined"))).toThrow("x is undefined");
    expect(() => proc.emit("unhandledRejection", Object.assign(new Error("duplicate key"), { code: "23505" }))).toThrow("duplicate key");
    expect(connectionLost("Connection terminated")).toBe(false);
    expect(warned).toHaveLength(6);
  });
});
