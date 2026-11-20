import { describe, expect, it } from "vitest";
import { closeAll, closeOldWindow, closeTab, front, giveBack, GROUP_TITLE, IDLE_MS, idle, isQuestTab, openTab } from "../src/quest-tabs.js";

type Tab = { id: number; windowId: number; active: boolean; groupId: number; url: string };
type Win = { id: number; focused: boolean; state: string; incognito: boolean; type: "normal"; covered?: boolean };
type Group = { id: number; windowId: number; title?: string; color?: string; collapsed?: boolean };

/** Chrome's windows, tabs and tab groups, as far as Quest uses them: closing a group's last tab drops the group, a window's last tab the window. */
function fakeChrome() {
  let next = 1;
  const wins: Win[] = [];
  const tabs: Tab[] = [];
  const groups: Group[] = [];
  const session: Record<string, unknown> = {};
  const must = <T>(x: T | undefined, what: string): T => {
    if (x === undefined) throw new Error(`No ${what}`);
    return x;
  };
  const addWindow = (focused = true) => {
    if (focused) for (const w of wins) w.focused = false;
    const w: Win = { id: next++, focused, state: "normal", incognito: false, type: "normal" };
    wins.push(w);
    return w;
  };
  const activate = (t: Tab) => {
    for (const o of tabs) if (o.windowId === t.windowId) o.active = false;
    t.active = true;
  };
  const addTab = (windowId: number, active: boolean, url = "about:blank") => {
    const t: Tab = { id: next++, windowId, active: false, groupId: -1, url };
    tabs.push(t);
    if (active || !tabs.some((o) => o.windowId === windowId && o.active)) activate(t);
    return t;
  };
  const removeTab = (id: number) => {
    const i = tabs.findIndex((t) => t.id === id);
    if (i < 0) throw new Error("No tab");
    const [t] = tabs.splice(i, 1);
    const left = tabs.filter((o) => o.windowId === t!.windowId);
    if (t!.active && left.length) activate(left.at(-1)!);
    if (t!.groupId !== -1 && !tabs.some((o) => o.groupId === t!.groupId)) groups.splice(groups.findIndex((g) => g.id === t!.groupId), 1);
    if (!left.length) wins.splice(wins.findIndex((w) => w.id === t!.windowId), 1);
  };
  const pick = (keys: string | string[] | null) =>
    keys === null ? structuredClone(session) : Object.fromEntries([keys].flat().filter((k) => k in session).map((k) => [k, structuredClone(session[k])]));
  const chrome = {
    storage: {
      session: {
        get: async (keys: string | string[] | null) => pick(keys),
        set: async (o: Record<string, unknown>) => void Object.assign(session, structuredClone(o)),
        remove: async (keys: string | string[]) => void [keys].flat().forEach((k) => delete session[k]),
      },
    },
    windows: {
      getLastFocused: async () => structuredClone(wins.find((w) => w.focused) ?? wins.at(-1) ?? must(undefined, "window")),
      getAll: async () => structuredClone(wins),
      get: async (id: number) => structuredClone(must(wins.find((w) => w.id === id), "window")),
      create: async () => {
        const w = addWindow(false);
        return { ...structuredClone(w), tabs: [structuredClone(addTab(w.id, true))] };
      },
      update: async (id: number, p: { focused?: boolean; state?: string }) => {
        const w = must(wins.find((x) => x.id === id), "window");
        if (p.state) w.state = p.state;
        if (p.focused) for (const x of wins) { x.focused = x.id === id; if (x.id === id) x.covered = false; }
      },
      remove: async (id: number) => {
        for (const t of tabs.filter((t) => t.windowId === id)) removeTab(t.id);
      },
    },
    tabs: {
      get: async (id: number) => structuredClone(must(tabs.find((t) => t.id === id), "tab")),
      create: async (p: { windowId: number; active: boolean; url?: string }) => structuredClone(addTab(p.windowId, p.active, p.url)),
      query: async (q: { active?: boolean; windowId?: number; groupId?: number }) =>
        structuredClone(tabs.filter((t) => (q.active === undefined || t.active === q.active) && (q.windowId === undefined || t.windowId === q.windowId) && (q.groupId === undefined || t.groupId === q.groupId))),
      update: async (id: number, p: { active?: boolean }) => {
        if (p.active) activate(must(tabs.find((t) => t.id === id), "tab"));
      },
      remove: async (ids: number | number[]) => [ids].flat().forEach(removeTab),
      group: async (p: { groupId?: number; tabIds: number[]; createProperties?: { windowId: number } }) => {
        const id = p.groupId ?? next++;
        if (p.groupId === undefined) groups.push({ id, windowId: p.createProperties!.windowId });
        for (const t of tabs) if (p.tabIds.includes(t.id)) t.groupId = id;
        return id;
      },
    },
    tabGroups: {
      get: async (id: number) => structuredClone(must(groups.find((g) => g.id === id), "group")),
      update: async (id: number, p: Partial<Group>) => void Object.assign(must(groups.find((g) => g.id === id), "group"), p),
      query: async (q: { title?: string }) => structuredClone(groups.filter((g) => q.title === undefined || g.title === q.title)),
    },
  };
  /** The customer's window, with their tabs, the last one in front. */
  const theirs = (n = 2) => {
    const w = addWindow(true);
    const own = Array.from({ length: n }, (_, i) => addTab(w.id, true, `https://example.com/${i}`));
    return { window: w, own };
  };
  // Chrome draws the tab in front of a window on screen.
  const drawn = async (id: number) => {
    const t = tabs.find((x) => x.id === id);
    const w = wins.find((x) => x.id === t?.windowId);
    return Boolean(t?.active && w && w.state !== "minimized" && !w.covered);
  };
  return { chrome, wins, tabs, groups, session, theirs, drawn, activate };
}

describe("Quest's tabs in the customer's Chrome", () => {
  it("open as a group of their own in the customer's window, behind the tab they are on", async () => {
    // The founder, 2026-10-15: "can the agent just open a tab group instead of a new chrome window? Like claude does".
    const c = fakeChrome();
    const { window, own } = c.theirs();
    const a = await openTab(c.chrome);
    const b = await openTab(c.chrome);
    expect(c.wins).toHaveLength(1);
    expect([a.windowId, b.windowId]).toEqual([window.id, window.id]);
    expect(c.groups).toEqual([{ id: expect.any(Number), windowId: window.id, title: GROUP_TITLE, color: "blue", collapsed: false }]);
    expect(c.tabs.filter((t) => t.groupId === c.groups[0]!.id).map((t) => t.id)).toEqual([a.id, b.id]);
    expect(c.tabs.find((t) => t.active)?.id).toBe(own[1]!.id);
    expect(await isQuestTab(c.chrome, a.id)).toBe(true);
    expect(await isQuestTab(c.chrome, own[1]!.id)).toBe(false);
  });

  it("come to the front only to be drawn, and give the customer's tab back", async () => {
    const c = fakeChrome();
    const { own } = c.theirs();
    const a = await openTab(c.chrome);
    expect(await front(c.chrome, a.id, c.drawn)).toBe(true);
    expect(c.tabs.find((t) => t.active)?.id).toBe(a.id);
    await giveBack(c.chrome);
    expect(c.tabs.find((t) => t.active)?.id).toBe(own[1]!.id);
  });

  it("leave the customer on the tab they moved to themselves", async () => {
    const c = fakeChrome();
    const { own } = c.theirs();
    const a = await openTab(c.chrome);
    await front(c.chrome, a.id, c.drawn);
    c.activate(c.tabs.find((t) => t.id === own[0]!.id)!);
    await giveBack(c.chrome);
    expect(c.tabs.find((t) => t.active)?.id).toBe(own[0]!.id);
  });

  it("bring their window up when it is minimised or another window has the keyboard, and give that back", async () => {
    const c = fakeChrome();
    const { window } = c.theirs();
    const a = await openTab(c.chrome);
    const other = c.theirs(1).window;
    expect(c.wins.find((w) => w.id === other.id)?.focused).toBe(true);
    c.wins.find((w) => w.id === window.id)!.state = "minimized";
    expect(await front(c.chrome, a.id, c.drawn, { focus: true })).toBe(true);
    expect(c.wins.find((w) => w.id === window.id)).toMatchObject({ state: "normal", focused: true });
    await giveBack(c.chrome);
    expect(c.wins.find((w) => w.id === other.id)?.focused).toBe(true);
  });

  it("raise a window another app covers, though Chrome calls it focused", async () => {
    // Live, 2026-10-15: under other apps' windows, Chrome still called its window focused and drew nothing.
    const c = fakeChrome();
    const { window } = c.theirs();
    const a = await openTab(c.chrome);
    c.wins.find((w) => w.id === window.id)!.covered = true;
    expect(await front(c.chrome, a.id, c.drawn)).toBe(true);
    expect(c.wins.find((w) => w.id === window.id)?.covered).toBe(false);
  });

  it("close, the one in front giving the customer's tab back first, and the group goes with the last", async () => {
    const c = fakeChrome();
    const { own } = c.theirs();
    const a = await openTab(c.chrome);
    const b = await openTab(c.chrome);
    await front(c.chrome, b.id, c.drawn);
    await closeTab(c.chrome, b.id);
    expect(c.tabs.find((t) => t.active)?.id).toBe(own[1]!.id);
    expect(c.groups).toHaveLength(1);
    await closeTab(c.chrome, a.id);
    expect(c.groups).toEqual([]);
    expect(c.tabs.map((t) => t.id)).toEqual(own.map((t) => t.id));
    expect(c.session).toMatchObject({ questTabs: [], questGroup: null });
    // A tab of theirs is never closed as Quest's.
    await closeTab(c.chrome, own[0]!.id);
    expect(c.tabs).toHaveLength(2);
  });

  it("all close when Quest is done, never one of the customer's, even dragged into the group", async () => {
    // The founder, 2026-10-15: "And delete the group after using."
    const c = fakeChrome();
    const { own } = c.theirs(3);
    const a = await openTab(c.chrome);
    const b = await openTab(c.chrome);
    c.tabs.find((t) => t.id === own[0]!.id)!.groupId = c.groups[0]!.id;
    await front(c.chrome, a.id, c.drawn);
    await closeAll(c.chrome);
    expect(c.tabs.map((t) => t.id)).toEqual(own.map((t) => t.id));
    expect(c.tabs.find((t) => t.active)?.id).toBe(own[2]!.id);
    expect(await isQuestTab(c.chrome, b.id)).toBe(false);
    // The next job opens a new group.
    const again = await openTab(c.chrome);
    expect(c.tabs.find((t) => t.id === again.id)?.groupId).not.toBe(c.tabs.find((t) => t.id === own[0]!.id)?.groupId);
  });

  it("open a window of their own only when Chrome shows none, and it closes with them", async () => {
    const c = fakeChrome();
    const a = await openTab(c.chrome);
    expect(c.wins).toHaveLength(1);
    expect(c.wins[0]).toMatchObject({ focused: false });
    await openTab(c.chrome);
    expect(c.wins).toHaveLength(1);
    await closeAll(c.chrome);
    expect(c.wins).toEqual([]);
    expect(await isQuestTab(c.chrome, a.id)).toBe(false);
  });

  it("wait for a quiet spell before closing", () => {
    const now = 1_000_000;
    expect(idle(now - IDLE_MS, false, now)).toBe(true);
    expect(idle(now - IDLE_MS + 1, false, now)).toBe(false);
    expect(idle(now - IDLE_MS * 10, true, now)).toBe(false);
    expect(idle(undefined, false, now)).toBe(true);
  });

  it("from before 0.9.3, in a window of its own, close on the update", async () => {
    const c = fakeChrome();
    const { own } = c.theirs();
    const old = c.theirs(2);
    c.groups.push({ id: 900, windowId: old.window.id, title: "Quest is reading" });
    for (const t of old.own) c.tabs.find((x) => x.id === t.id)!.groupId = 900;
    await closeOldWindow(c.chrome);
    expect(c.wins.map((w) => w.id)).toEqual([own[0]!.windowId]);
    expect(c.tabs.map((t) => t.id)).toEqual(own.map((t) => t.id));
  });
});
