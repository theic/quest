import type { MachinePower, WorkSchedule } from "@mq/core";
import { describe, expect, it, vi } from "vitest";
import { silentLogger } from "../src/infra/system.ts";
import { IdleSleeper, type Loop } from "../src/lifecycle/idle-sleeper.ts";
import { Traffic } from "../src/lifecycle/traffic.ts";
import { FakeClock } from "./fakes.ts";

class FakeLoop implements Loop {
  running = true;
  busy = false;
  starts = 0;
  /** Set to hold stop() open until the test lets it go. */
  hold: Promise<void> | null = null;
  start(): void {
    this.running = true;
    this.starts++;
  }
  async stop(): Promise<void> {
    if (this.hold) await this.hold;
    this.running = false;
  }
}

class FakePower implements MachinePower {
  canSleep = true;
  suspends = 0;
  async suspend(): Promise<void> {
    this.suspends++;
  }
}

const IDLE = 120_000;

function setup(opts: { due?: Date | null; canSleep?: boolean; open?: number } = {}) {
  const clock = new FakeClock();
  const traffic = new Traffic(() => clock.t);
  const loops = [new FakeLoop(), new FakeLoop()];
  const power = new FakePower();
  power.canSleep = opts.canSleep ?? true;
  const connections = { open: opts.open ?? 0 };
  let due: Date | null = opts.due ?? null;
  const work: WorkSchedule = { nextWorkAt: async () => due };
  const sleeper = new IdleSleeper(
    { loops, traffic, work, connections, power, clock, log: silentLogger },
    { idleMs: IDLE, checkMs: 1_000, horizonMs: 120_000, drainMs: 50, resumeTimeoutMs: 5_000 },
  );
  return { clock, traffic, loops, power, connections, sleeper, setDue: (d: Date | null) => (due = d) };
}

describe("the idle sleeper", () => {
  it("sleeps after the idle period, with its loops stopped, and wakes them on the next request", async () => {
    const { clock, traffic, loops, power, sleeper } = setup();

    await sleeper.check();
    expect(power.suspends).toBe(0); // just started: not idle yet

    clock.advance(IDLE);
    const sleeping = sleeper.check();
    await vi.waitFor(() => expect(power.suspends).toBe(1));
    expect(sleeper.state).toBe("asleep");
    expect(loops.every((l) => !l.running)).toBe(true);

    const done = traffic.begin(); // a Telegram update resumes the machine
    await sleeping;
    done();
    expect(sleeper.state).toBe("awake");
    expect(loops.every((l) => l.running && l.starts === 1)).toBe(true);
  });

  it("stays up while something is running or a request is in flight", async () => {
    const { clock, traffic, loops, power, sleeper } = setup();
    clock.advance(IDLE);
    loops[0]!.busy = true;
    await sleeper.check();
    loops[0]!.busy = false;
    const done = traffic.begin();
    await sleeper.check();
    done();
    expect(power.suspends).toBe(0);

    // Busy counts as activity: the idle period starts over from the last time it was seen.
    clock.advance(IDLE - 1);
    await sleeper.check();
    expect(power.suspends).toBe(0);
  });

  it("stays up when work falls due soon, and sleeps when it is far off", async () => {
    const { clock, power, sleeper, setDue, traffic } = setup();
    clock.advance(IDLE);
    setDue(new Date(clock.t + 30_000)); // a retry in 30 s
    await sleeper.check();
    expect(power.suspends).toBe(0);

    setDue(new Date(clock.t + 3_600_000)); // the next heartbeat in an hour: the wake job will call
    const sleeping = sleeper.check();
    await vi.waitFor(() => expect(power.suspends).toBe(1));
    traffic.begin()();
    await sleeping;
  });

  it("gives up the sleep when a request comes in while it settles", async () => {
    const { clock, traffic, loops, power, sleeper } = setup();
    let release!: () => void;
    loops[0]!.hold = new Promise<void>((r) => (release = r));
    clock.advance(IDLE);

    const sleeping = sleeper.check();
    await vi.waitFor(() => expect(sleeper.state).toBe("settling"));
    const done = traffic.begin();
    release();
    await sleeping;
    done();

    expect(power.suspends).toBe(0);
    expect(sleeper.state).toBe("awake");
    expect(loops.every((l) => l.running)).toBe(true);
  });

  it("does not suspend while database connections stay open, so none is stale on resume", async () => {
    const { clock, loops, power, sleeper } = setup({ open: 1 });
    clock.advance(IDLE);
    await sleeper.check();
    expect(power.suspends).toBe(0);
    expect(loops.every((l) => l.running)).toBe(true);
  });

  it("never sleeps where the machine cannot", async () => {
    const { clock, loops, power, sleeper } = setup({ canSleep: false });
    clock.advance(IDLE * 10);
    await sleeper.check();
    expect(power.suspends).toBe(0);
    expect(loops.every((l) => l.running && l.starts === 0)).toBe(true);
  });
});
