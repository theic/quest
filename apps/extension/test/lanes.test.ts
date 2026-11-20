import { describe, expect, it } from "vitest";
import { frontFor, HOST_FLOOR_MS, MAX_TABS, mayFront, nextNavAt, oneAtATime, tabsFrom } from "../src/lanes.js";

describe("several tabs at once", () => {
  it("runs as many pollers as the agent asks for, one when it says nothing, never more than its ceiling", () => {
    expect(tabsFrom(null)).toBe(1); // an agent from before several tabs
    expect(tabsFrom("3")).toBe(3);
    expect(tabsFrom("9")).toBe(MAX_TABS);
    expect(tabsFrom("0")).toBe(1);
    expect(tabsFrom("two")).toBe(1);
  });

  it("does what shares state one at a time, in the order asked, even after one fails", async () => {
    const lock = oneAtATime();
    const order: string[] = [];
    const slow = lock(async () => { await new Promise((r) => setTimeout(r, 20)); order.push("slow"); throw new Error("broke"); });
    const fast = lock(async () => { order.push("fast"); return 2; });
    await expect(slow).rejects.toThrow("broke");
    await expect(fast).resolves.toBe(2);
    expect(order).toEqual(["slow", "fast"]);
  });

  it("paces alone as it always has, from the last page on any site; with several tabs, by each host", () => {
    const now = 100_000;
    // Alone: Reddit after a page anywhere waits its 8 to 15 s.
    expect(nextNavAt({ now, host: "www.reddit.com", lastAny: now, lastHost: 0, alone: true, random: () => 0 })).toBe(now + 8_000);
    expect(nextNavAt({ now, host: "example.com", lastAny: now - 60_000, lastHost: 0, alone: true, random: () => 0 })).toBe(now);
    // Several: a page on another host does not hold this one; its own host's last page does, by the floor.
    expect(nextNavAt({ now, host: "example.com", lastAny: now, lastHost: 0, alone: false })).toBe(now);
    expect(nextNavAt({ now, host: "example.com", lastAny: now, lastHost: now - 500, alone: false })).toBe(now - 500 + HOST_FLOOR_MS);
    expect(nextNavAt({ now, host: "reddit.com", lastAny: 0, lastHost: now, alone: false })).toBe(now + 8_000);
  });
});

describe("what comes to the front", () => {
  it("brings a session's tab up for a picture or input by sight, a fill, and a site drawn only on screen; not for the rest", () => {
    expect(frontFor({ action: { kind: "screenshot" }, drawn: false })).toBe("input");
    expect(frontFor({ action: { kind: "click_point", screen: "s", x: 1, y: 1 }, drawn: false })).toBe("input");
    expect(frontFor({ action: { kind: "fill", ref: "0:1", text: "hi" }, drawn: false })).toBe("type");
    expect(frontFor({ action: { kind: "snapshot" }, drawn: true })).toBe("drawn");
    expect(frontFor({ action: { kind: "click", ref: "0:3" }, drawn: false })).toBeNull();
    expect(frontFor({ action: { kind: "scroll", direction: "down" }, drawn: false })).toBeNull();
    expect(frontFor({ action: { kind: "close" } })).toBeNull();
    // An agent from before says nothing about drawing: every step came to the front for it, and still does.
    expect(frontFor({ action: { kind: "snapshot" } })).toBe("drawn");
  });

  it("stays in the background when either switch says so", () => {
    expect(mayFront({ local: undefined, agent: true })).toBe(true);
    expect(mayFront({ local: false, agent: true })).toBe(false);
    expect(mayFront({ local: true, agent: false })).toBe(false);
  });
});

describe("a call that never ends", () => {
  it("lets the next one in once it has had its time", async () => {
    const line = oneAtATime(10);
    void line(() => new Promise(() => undefined));
    await expect(line(async () => "next")).resolves.toBe("next");
  });
});
