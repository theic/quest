/**
 * Where Quest works in the customer's Chrome: a tab group of its own in the window they last used, the way
 * a person opens a few tabs for a job, rather than a window of its own. The founder's word, 2026-10-15: "can
 * the agent just open a tab group instead of a new chrome window? Like claude does", and "delete the group
 * after using".
 *
 * Chrome draws only the tab in front of a window it shows, and takes input only there (FACTS.md). So Quest's
 * tabs read in the background, and come to the front only for what needs drawing: a page that shows its posts
 * only on screen, a picture, a click or a keystroke. The customer's tab goes back in front after, unless they
 * moved on themselves. Once Quest has had nothing to do for a while, its tabs close, and Chrome drops the
 * group with its last tab. Only tabs Quest opened are ever closed: one of theirs dragged into the group stays.
 *
 * Every function takes the `chrome` API object, so tests hand in a fake.
 */

export const GROUP_TITLE = "Quest";
/**
 * The dev extension's group has a name of its own. With the published extension in the same Chrome (the founder's:
 * production's bot and dev's), each one closed the other's group every 30 s as a stray of its own (closeStrayGroups),
 * so reads met "No tab with id" and a send's session "expired" between its steps (live, 2026-11-12).
 */
export const DEV_GROUP_TITLE = "Quest DEV";
let title = Promise.resolve(GROUP_TITLE);
/** Told once at start: whether this is the unpacked dev build. */
export function nameGroup(dev) {
  title = Promise.resolve(dev).then((d) => (d ? DEV_GROUP_TITLE : GROUP_TITLE), () => GROUP_TITLE);
}
export const GROUP_COLOR = "blue";
/** Nothing to do for this long, and Quest's tabs close. The alarm looks every 30 s. */
export const IDLE_MS = 90_000;
/** A reading tab no job used for this long closes, while others work on: a site's tab goes soon after its work there. */
export const STALE_TAB_MS = 45_000;
/** Reading tabs Quest keeps at once: past these, the one longest unused is read in again instead of a new one opened. */
export const MAX_READING_TABS = 4;

/**
 * Closes every tab in a group titled as Quest's that is not its group now: an extension that was reloaded or updated
 * forgets its tabs, and its old group stayed open beside the new one (live, 2026-11-11).
 */
export async function closeStrayGroups(chrome) {
  const { group } = await state(chrome);
  const groups = await chrome.tabGroups.query({ title: await title }).catch(() => []);
  for (const g of groups) {
    if (g.id === group) continue;
    const tabs = await chrome.tabs.query({ groupId: g.id }).catch(() => []);
    if (tabs.length) await chrome.tabs.remove(tabs.map((t) => t.id)).catch(() => null);
  }
}
/** The same while a browser session is open: the agent closes it when its run ends. */
export const SESSION_IDLE_MS = 5 * 60_000;

// chrome.storage.session: { questGroup }      its tab group's id
//                         { questTabs }       the ids of the tabs it opened, still open as far as it knows
//                         { questOwnWindow }  a window it opened because Chrome showed none, else null
//                         { giveBack }        { tabId, windowId }: the customer's tab that was in front before Quest's

async function state(chrome) {
  const s = await chrome.storage.session.get(["questGroup", "questTabs", "questOwnWindow", "giveBack"]);
  return { group: s.questGroup ?? null, tabs: Array.isArray(s.questTabs) ? s.questTabs : [], ownWindow: s.questOwnWindow ?? null, giveBack: s.giveBack ?? null };
}

/** A tab of Quest's that is gone (they closed it, or Chrome did) leaves its list, so the count of open tabs is true. */
export async function forgetTab(chrome, tabId) {
  const s = await state(chrome);
  if (s.tabs.includes(tabId)) await chrome.storage.session.set({ questTabs: s.tabs.filter((id) => id !== tabId) });
}

/** Whether a tab is one Quest opened. */
export async function isQuestTab(chrome, tabId) {
  return (await state(chrome)).tabs.includes(tabId);
}

/** The window for a new group: the one they used last, or any of theirs; never Incognito. Null when Chrome shows none. */
async function theirWindow(chrome) {
  const last = await chrome.windows.getLastFocused({ windowTypes: ["normal"] }).catch(() => null);
  if (last && !last.incognito && last.type === "normal") return last.id;
  const all = await chrome.windows.getAll({ windowTypes: ["normal"] }).catch(() => []);
  return all.find((w) => !w.incognito)?.id ?? null;
}

/**
 * A new tab of Quest's, in the background of its group. The group lives in the customer's window; a window
 * of Quest's own opens only when Chrome has none open (it closes with Quest's last tab).
 */
export async function openTab(chrome) {
  const s = await state(chrome);
  const group = s.group === null ? null : await chrome.tabGroups.get(s.group).catch(() => null);
  let windowId = group?.windowId ?? (await theirWindow(chrome));
  let tab;
  let ownWindow = s.ownWindow;
  if (windowId === null) {
    const win = await chrome.windows.create({ url: "about:blank", focused: false, incognito: false, type: "normal", width: 1100, height: 850 });
    windowId = win.id;
    ownWindow = win.id;
    tab = win.tabs?.[0] ?? (await chrome.tabs.query({ windowId }))[0];
  } else {
    tab = await chrome.tabs.create({ windowId, url: "about:blank", active: false });
  }
  // Chrome's Memory Saver discards a background tab under load, and a discarded tab comes back under a new id: a read
  // in flight then failed with "No tab with id" and a post's session "expired" (live, 2026-11-12, with 12 tabs open).
  await Promise.resolve().then(() => chrome.tabs.update(tab.id, { autoDiscardable: false })).catch(() => null);
  let groupId = group?.id ?? null;
  try {
    groupId = await chrome.tabs.group(group ? { groupId: group.id, tabIds: [tab.id] } : { tabIds: [tab.id], createProperties: { windowId } });
    if (!group) await chrome.tabGroups.update(groupId, { title: await title, color: GROUP_COLOR, collapsed: false });
  } catch {
    // A label, nothing more: the tab is Quest's all the same.
  }
  await chrome.storage.session.set({ questGroup: groupId, questTabs: [...s.tabs.filter((id) => id !== tab.id), tab.id], questOwnWindow: ownWindow });
  return tab;
}

/**
 * Brings a tab of Quest's to the front of its window for what is drawn or takes input only there; true once
 * Chrome draws it. The window comes up too when it is minimised, when nothing shows it otherwise, or with
 * `focus` (clicks and keystrokes want it). What was in front before is noted, to give back. `drawn(tabId)`
 * asks the page whether Chrome draws it now.
 */
export async function front(chrome, tabId, drawn, { focus = false, waits = 8 } = {}) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return false;
  const s = await state(chrome);
  try {
    const before = s.giveBack ?? { tabId: null, windowId: tab.windowId, focusedWindowId: null };
    if (!tab.active) {
      const [shown] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
      if (shown && !s.tabs.includes(shown.id)) before.tabId = shown.id;
      await chrome.tabs.update(tabId, { active: true });
    }
    const win = await chrome.windows.get(tab.windowId);
    if (win.state === "minimized") await chrome.windows.update(tab.windowId, { state: "normal" });
    // A tab just brought to the front is drawn a moment later. A window under another app's is not drawn
    // at all, though Chrome may still call it focused: raising it puts it on top (live, 2026-10-15).
    if (focus || !win.focused || !(await soon(drawn, tabId))) {
      const last = await chrome.windows.getLastFocused().catch(() => null);
      if (last?.focused && last.id !== tab.windowId && before.focusedWindowId === null) before.focusedWindowId = last.id;
      await chrome.windows.update(tab.windowId, { focused: true });
    }
    if (before.tabId !== null || before.focusedWindowId !== null) await chrome.storage.session.set({ giveBack: before });
  } catch {
    return false;
  }
  for (let i = 0; i < waits; i++) {
    if (await drawn(tabId)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return drawn(tabId);
}

/** Whether the page is drawn within about half a second. */
async function soon(drawn, tabId) {
  for (let i = 0; i < 4; i++) {
    if (await drawn(tabId)) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

/** What was in front before Quest's tab came up goes back: their tab, and the window they were in. */
export async function giveBack(chrome) {
  const s = await state(chrome);
  if (!s.giveBack) return;
  await chrome.storage.session.set({ giveBack: null });
  const { tabId, windowId, focusedWindowId } = s.giveBack;
  const [shown] = await chrome.tabs.query({ active: true, windowId }).catch(() => []);
  // They moved to another tab of theirs meanwhile: that one stays, and so does where they are.
  if (shown && !s.tabs.includes(shown.id)) return;
  if (tabId !== null) await chrome.tabs.update(tabId, { active: true }).catch(() => null);
  if (focusedWindowId !== null) await chrome.windows.update(focusedWindowId, { focused: true }).catch(() => null);
}

/** Closes one tab of Quest's, the customer's tab back in front first when it was the one shown. */
export async function closeTab(chrome, tabId) {
  const s = await state(chrome);
  if (!s.tabs.includes(tabId)) return;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab?.active) await giveBack(chrome);
  await chrome.tabs.remove(tabId).catch(() => null);
  const left = (await state(chrome)).tabs.filter((id) => id !== tabId);
  await chrome.storage.session.set({ questTabs: left });
  if (!left.length) await forgetPlace(chrome, s.ownWindow);
}

/**
 * Closes every tab of Quest's still in its group, and Chrome drops the group with the last. A window Quest
 * opened for itself closes too, unless the customer has tabs of their own in it now. Never a tab of theirs.
 */
export async function closeAll(chrome) {
  const s = await state(chrome);
  await giveBack(chrome);
  const open = (await Promise.all(s.tabs.map((id) => chrome.tabs.get(id).catch(() => null)))).filter(Boolean);
  // A tab they dragged out of the group is theirs now.
  const ours = open.filter((t) => s.group === null || t.groupId === s.group || t.windowId === s.ownWindow);
  if (ours.length) await chrome.tabs.remove(ours.map((t) => t.id)).catch(() => null);
  // A tab a job opened meanwhile is still Quest's, and its group with it.
  const opened = (await state(chrome)).tabs.filter((id) => !s.tabs.includes(id));
  await chrome.storage.session.set({ questTabs: opened });
  if (!opened.length) await forgetPlace(chrome, s.ownWindow);
}

/** Before 0.9.3 Quest read in a window of its own, its tabs grouped as "Quest is reading": an update closes them. */
export async function closeOldWindow(chrome) {
  const groups = await chrome.tabGroups.query({ title: "Quest is reading" }).catch(() => []);
  for (const g of groups) {
    const tabs = await chrome.tabs.query({ groupId: g.id }).catch(() => []);
    if (tabs.length) await chrome.tabs.remove(tabs.map((t) => t.id)).catch(() => null);
  }
}

async function forgetPlace(chrome, ownWindow) {
  if (ownWindow !== null) {
    const left = await chrome.tabs.query({ windowId: ownWindow }).catch(() => []);
    if (!left.length || left.every((t) => t.url === "about:blank" || t.pendingUrl === "about:blank")) await chrome.windows.remove(ownWindow).catch(() => null);
  }
  await chrome.storage.session.set({ questGroup: null, questOwnWindow: null, giveBack: null });
}

/**
 * Whether Quest has been idle long enough for its tabs to close: nothing running, and the last job a while ago, longer
 * while a browser session the agent has not closed is open (`sessionOpen`): its next step may come after a slow model
 * step (live, 2026-11-04: a like on Threads waited 132 s for one, its tab closed at 90, and the like was held).
 */
export function idle(lastWorkAt, working, now = Date.now(), sessionOpen = false) {
  return !working && now - (Number(lastWorkAt) || 0) >= (sessionOpen ? SESSION_IDLE_MS : IDLE_MS);
}
