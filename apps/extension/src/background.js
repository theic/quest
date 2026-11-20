/**
 * Messaging Quest for Chrome: the service worker.
 *
 * Once connected to a customer's Quest (a one-time code from the chat), it asks
 * the agent for pages to read (a long poll), reads each in a tab of its own, in
 * a "Quest" tab group in the customer's window (quest-tabs.js), and sends back
 * what the page said. It reads in the customer's own Chrome
 * profile, where they are logged in, so sites show Quest what they show them
 * (the customer's word, 2026-10-02: "it must use the profile where the
 * extension is installed"). A logged-out stranger got Reddit's CAPTCHA after a
 * few pages (measured 2026-09-27); Incognito avoided it but saw no logins.
 * It takes as many jobs at once as the agent asks for (lanes.js), each in a tab
 * of its own; the agent keeps each site's pace and never hands it two pages of
 * one site at once. Only one of its tabs comes to the front at a time, and only
 * for what is drawn or takes input only there; their switch keeps it in the
 * background always.
 * Reading never clicks or types. What it does as the customer comes in two kinds
 * of job: a Reddit post (a reply, a post, a private message), sent through
 * Reddit's own forms in a background tab of Quest's group, never in its reading
 * tab; and a browser session (any other site), where it fills and clicks the
 * page's own controls in a task tab of Quest's group, brought to the front while
 * it works, by references that expire, and with pictures and trusted input when
 * visual controls are on (browser-page.js, browser-visual.js). It never fills a
 * password, one-time code or card field, and covers them before any picture;
 * signing in is the customer's. Once it has had nothing to do for a while, its
 * tabs close, and the group with them.
 * While connected it keeps the computer from sleeping, unless the customer
 * turns that off in the popup (awake.js).
 *
 * Chrome's rules this works within (FACTS.md): a service worker sleeps after
 * 30 s without events and stops a fetch that takes more than 30 s, so the poll
 * waits 20 s and an alarm wakes the loop again every 30 s.
 */
import { syncAwake } from "./awake.js";
import { attachFile, browserPage, domQuiet, loadMore, scrollPage } from "./browser-page.js";
import { questOverlay } from "./cursor.js";
import { focusedSensitive, holdInput, protectPicture, released, trustedFill, typedCheck, visualAllowed, visualInput, visualPicture } from "./browser-visual.js";

// The debugger came off a tab of Quest's (it closed, or the customer cancelled it on Chrome's bar): put on again when needed.
chrome.debugger?.onDetach?.addListener((source) => { if (source.tabId !== undefined) released(source.tabId); });
import { followStamp, STAMP, STAMP_EVERY_MS, stampedBuild } from "./dev-reload.js";
import { frontFor, mayFront, nextNavAt, oneAtATime, tabsFrom } from "./lanes.js";
import { isPrivateIp, privateFrame, refuseUrl } from "./guard.js";
import { redditForm, redditPost } from "./post-reply.js";
import { DEFAULT_SERVER, DEV_SERVER, LOCAL_SERVER, pairingServer, refusal, unpacked } from "./quest-server.js";
import { closeAll, closeOldWindow, closeStrayGroups, closeTab, forgetTab, nameGroup, front, giveBack, idle, isQuestTab, openTab, MAX_READING_TABS, SESSION_IDLE_MS, STALE_TAB_MS } from "./quest-tabs.js";
import { probePage, readPage } from "./read-page.js";

const POLL_WAIT_S = 20;
/** Pages read in a day, until the agent says how many (`x-mq-pages`, between 50 and 5,000). */
const DAILY_PAGES = 800;
/** Looks at the customer's own posts, counted apart: a day's searching never leaves a post unwatched. */
const DAILY_CHECKS = 60;
const LOAD_TIMEOUT_MS = 30000;
/** How long a page may load before its words count, load event or not. */
const USABLE_AFTER_MS = 6000;
/** The longest one job may take here, inside the agent's own 90 s: it answers, late or not. */
const JOB_MS = 85000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hostOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
};
const today = () => new Date().toISOString().slice(0, 10);

/* ----------------------------------------------------------------- state */

// chrome.storage.local:   { server, token, device }             the connection
//                         { day, pages }, { checksDay, checks }   today's reading, and looks at their own posts
//                         { awake }                               false once they turn keeping awake off
//                         { visual }                              false once they turn visual browser controls off
//                         { front }                               false once they keep Quest's tab out of the front
// chrome.storage.session: { tabId, lastNavAt }                    Quest's reading tab (slot 0's; "tabId:<slot>" the others')
//                         { "nav:<host>" }                        when the last page on a host opened (or will)
//                         { visitorTabId, visitorRuleTab }        its tab that reads logged out (":<slot>" for the others)
//                         { "browser:<session>" }                 a browser session's task tab, and its last picture
//                         { questGroup, questTabs, … }            its tab group and the tabs it opened (quest-tabs.js)
//                         { lastWorkAt }                          when its last job ended: idle a while, its tabs close
//                         { shotAt }                              when the last picture for the chat was taken
//                         { link, reading, posting, lastJobAt, note }  what the popup shows

async function connection() {
  const { server, token, device } = await chrome.storage.local.get(["server", "token", "device"]);
  return token ? { server, token, device } : null;
}

async function setStatus(patch) {
  await chrome.storage.session.set(patch);
}

/**
 * The badge between jobs: "OFF" while they switched Quest off (the icon says so without a click), else "DEV" on the dev
 * extension (an unpacked build, which pairs only with a dev agent), else none. Between them, what waits on them: Quest's
 * messages they have not seen, and the asks on Your move.
 */
async function restBadge() {
  const dev = await unpacked(chrome.management);
  const off = (await chrome.storage.session.get("off")).off === true;
  const kept = await chrome.storage.local.get(["lastAsks", "lastUnread"]);
  const asks = (await connection()) ? (Number(kept.lastAsks) || 0) + (Number(kept.lastUnread) || 0) : 0;
  if (dev || off || asks) await chrome.action.setBadgeBackgroundColor({ color: off ? "#6b7280" : asks ? "#4d7c0f" : "#d97706" }).catch(() => undefined);
  await chrome.action.setBadgeText({ text: off ? "OFF" : asks ? String(Math.min(asks, 99)) : dev ? "DEV" : "" });
}

/** Quest went off or on (the agent's answer said so, or the popup's switch): kept for the popup and the badge. Off, its tabs close. */
async function switched(off) {
  // What was kept outlives this worker, which forgets `agentOff` each time Chrome stops it.
  const was = (await chrome.storage.session.get("off")).off === true;
  agentOff = off;
  if (was === off) return;
  await setStatus({ off });
  if (off && !busy) await closeQuestTabs().catch(() => undefined);
  if (!busy) await restBadge().catch(() => undefined);
}

async function forget(note) {
  await chrome.storage.local.remove(["server", "token", "device"]);
  await setStatus({ link: "none", reading: null, posting: null, note: note ?? null });
  await restBadge();
  await keepAwake();
}

/** Keeps the computer awake while this Chrome is connected, unless they turned it off (awake.js). */
async function keepAwake() {
  const { token, awake } = await chrome.storage.local.get(["token", "awake"]);
  return syncAwake(chrome.power, { connected: Boolean(token), awake });
}

/* ------------------------------------------------------------------ loop */

/** How many pollers run, each taking one job at a time in a tab of its own: what the agent's last answer asked for. */
let slots = 1;
/** The slots whose poller runs. */
const polling = new Set();
/** Jobs running now: Quest's tabs stay open, whatever the clock says. */
let busy = 0;
/** Whether their page lets Quest's tab come to the front, as the agent's last answer said. */
let agentFront = true;
/** Whether they switched Quest off, as the agent's last answer said: its tabs close at once. */
let agentOff = false;
/** Dev only: when a new build was first seen. From then no new job is taken, so the reload gets its quiet moment. */
let reloadSince = 0;
/** The tabs a job is in now: never closed as stale. */
const inUse = new Map();
const using = async (tabId, work) => {
  inUse.set(tabId, (inUse.get(tabId) ?? 0) + 1);
  try {
    return await work();
  } finally {
    if (inUse.get(tabId) > 1) inUse.set(tabId, inUse.get(tabId) - 1);
    else inUse.delete(tabId);
    await chrome.storage.session.set({ [`used:${tabId}`]: Date.now() }).catch(() => undefined);
  }
};
/** Pages a day, as the agent's last answer said. */
let dailyPages = DAILY_PAGES;
/** Today's page count, each host's pause, and Quest's tabs are kept one change at a time; one tab in front at a time. */
const counting = oneAtATime();
const pacing = oneAtATime();
// A tab step is short; one that never ends lets the next in (live, 2026-11-14: twice in a day every job, a plain page
// too, ran out its 85 s behind one, for 45 minutes and then for an hour, until the extension was reloaded).
const tabbing = oneAtATime(20000);
// The front of their window: a step that hangs there lets the next one in, well before a job runs out of time.
const fronting = oneAtATime(45000);

/** Asks for work until there is none for a while or the connection fails; the alarm starts it again. */
async function loop(slot = 0) {
  if (polling.has(slot)) return;
  polling.add(slot);
  try {
    // Anything that breaks a round ends the loop until the alarm, rather than escaping the worker as an error. A poller
    // past the number the agent asks for stops after its round.
    while (slot < slots && (await pollOnce(slot).catch((e) => (console.warn("poll failed", e), false)))) {
      // keep asking
    }
  } finally {
    polling.delete(slot);
  }
}

/** What the agent's answer says besides the job: how many pollers to run, whether Quest's tab may come to the front, and its pages a day. */
function heed(res) {
  agentFront = res.headers.get("x-mq-front") !== "off";
  const pages = Number(res.headers.get("x-mq-pages"));
  dailyPages = Number.isInteger(pages) && pages >= 50 && pages <= 5000 ? pages : DAILY_PAGES;
  void switched(res.headers.get("x-mq-off") === "1");
  const news = Number(res.headers.get("x-mq-news"));
  if (Number.isFinite(news) && news > 0) void heard(news).catch((e) => console.warn("news failed", e));
  const n = tabsFrom(res.headers.get("x-mq-tabs"));
  if (n === slots) return;
  slots = n;
  for (let s = 1; s < slots; s++) void loop(s);
}

/** Whether Quest's tab may come to the front now: their switch here, and the one on their page. */
async function frontAllowed() {
  return mayFront({ local: (await chrome.storage.local.get("front")).front, agent: agentFront });
}

/** Why a step that needs Quest's tab in front was not done. */
const FRONT_OFF = "Quest's tab is kept out of the front (their switch), so it cannot picture the page or click and type by sight. Use the page's own controls, or ask them to turn the switch back on in Quest's popup or on their page.";

async function pollOnce(slot) {
  // A new dev build waits to be loaded: a job taken now would only be cut off by the reload.
  if (reloadSince && Date.now() - reloadSince < RELOAD_WAIT_MS * 2) return false;
  const c = await connection();
  if (!c) return false;
  let res;
  try {
    res = await fetch(`${c.server}/chrome/next?wait=${POLL_WAIT_S}&slot=${slot}`, {
      headers: { authorization: `Bearer ${c.token}`, "x-mq-open": String(((await chrome.storage.session.get("questTabs")).questTabs ?? []).length) },
      signal: AbortSignal.timeout((POLL_WAIT_S + 8) * 1000),
    });
  } catch {
    await setStatus({ link: "unreachable" });
    return false;
  }
  if (res.status === 401) {
    await forget("Quest disconnected this Chrome. Send /connect in Telegram to connect it again.");
    return false;
  }
  if (res.status === 204) {
    heed(res);
    await setStatus({ link: "ok", note: null });
    return true;
  }
  if (!res.ok) {
    await setStatus({ link: "unreachable" });
    return false;
  }
  heed(res);
  const job = await res.json().catch(() => null);
  if (typeof job?.id !== "string") {
    await setStatus({ link: "unreachable" });
    return false;
  }
  const posting = job.kind === "post";
  await setStatus(posting ? { link: "ok", posting: hostOf(job.post?.url), note: null } : { link: "ok", reading: hostOf(job.url), note: null });
  await chrome.action.setBadgeText({ text: "…" });
  busy++;
  let outcome;
  try {
    // Whatever a page does, a job answers within JOB_MS and the next one is taken: a job left waiting kept this
    // Chrome from taking any other work until it was restarted.
    const done = (posting ? postJob(job.post) : runJob(job, slot)).catch((e) => fail("unavailable", e instanceof Error ? e.message : String(e)));
    outcome = await Promise.race([done, sleep(JOB_MS).then(() => fail("timeout", "This Chrome took too long on that job. Inspect the page before doing anything else."))]);
  } finally {
    busy--;
    await chrome.storage.session.set({ lastWorkAt: Date.now() });
  }
  if (!busy) await restBadge();
  await setStatus(posting ? { posting: null } : { reading: null, lastJobAt: Date.now() });
  try {
    await fetch(`${c.server}/chrome/jobs/${encodeURIComponent(job.id)}`, {
      method: "POST",
      headers: { authorization: `Bearer ${c.token}`, "content-type": "application/json" },
      body: JSON.stringify(outcome),
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    // The agent went away; the page was read for nothing, and it will ask again.
  }
  return true;
}

/** A job that did not work, in the words the agent accepts (a longer message would lose the whole answer). */
const fail = (reason, message) => ({ ok: false, reason, message: String(message).slice(0, 1000) });

/* --------------------------------------------------------------- reading */

async function runJob(job, slot) {
  if (job.kind === "browser") return browserJob(job.browser);
  const refused = refuseUrl(job.url);
  if (refused) return fail(refused.reason, refused.message);
  if (!(await counting(() => countPage(job.check)))) return fail("limit", `this Chrome has read ${job.check ? dailyChecks() : dailyPages} pages today, as many as Quest reads in a day`);
  await pace(job.url);

  // In the background of Quest's group: the customer's tab stays in front while Quest reads.
  const tabId = job.asVisitor ? await visitorTab(slot) : await questTab(await siteSlot(job.url, slot));
  return using(tabId, () => readIn(tabId, job));
}

/**
 * Which reading tab a page opens in: its site's own, so a site has one reading tab however many pollers read it (the
 * agent hands out one page of a site at a time), and the poller's own only while that one is at a page.
 */
async function siteSlot(url, slot) {
  const host = hostOf(url);
  if (!host) return slot;
  const key = `h:${host}`;
  const { [`tabId:${key}`]: tabId } = await chrome.storage.session.get(`tabId:${key}`);
  return tabId && inUse.has(tabId) ? slot : key;
}

/** Reads a job's page in its tab. */
async function readIn(tabId, job) {
  const nav = watchNavigation(tabId);
  let loaded;
  try {
    loaded = await navigate(tabId, job.url);
  } finally {
    nav.stop();
  }
  const done = nav.result();
  if (done.ip && isPrivateIp(done.ip)) {
    await chrome.tabs.update(tabId, { url: "about:blank" });
    return fail("blocked", "that address leads to a private network, which Quest does not read");
  }
  if (done.error) return fail(errorReason(done.error), `${hostOf(job.url)} could not be opened (${done.error})`);
  if (!loaded) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab || hostOf(tab.url ?? "") !== hostOf(job.url)) return fail("timeout", `${hostOf(job.url)} did not load in time`);
  }

  const probe = await settle(tabId, job.waitFor, job.settleMs);
  // A page that shows its posts only on screen: Quest's tab comes to the front for it, one tab at a time, and goes
  // back after. Kept out of the front by their switch, it reads what the background shows.
  if (job.drawn && !probe.visible && (await frontAllowed())) {
    return fronting(async () => {
      if (!(await front(chrome, tabId, drawnNow))) {
        await giveBack(chrome);
        // Nothing was seen: a look at an answer page waits for the window, and is not spent.
        if (job.check) await counting(() => uncountCheck());
        return fail("hidden", "Your Chrome window is minimised or covered, and this page shows its posts only on screen");
      }
      const again = await settle(tabId, job.waitFor, job.settleMs);
      await deeper(tabId, job);
      return readNow(job, tabId, done, again, true);
    });
  }
  await deeper(tabId, job);
  return readNow(job, tabId, done, probe, false);
}

/**
 * A feed read past its first screen (job.more screens down), so it draws the rows below before it is read: a LinkedIn
 * search gave 3 posts a read, and a run looked at 33 posts in 17 minutes (live, 2026-11-11).
 */
async function deeper(tabId, job) {
  const more = Math.min(Number(job.more) || 0, 5);
  for (let i = 0; i < more; i++) {
    try {
      await inPage(tabId, scrollPage, ["down", 2500], 5000);
      await inPage(tabId, loadMore, [3000], 5000);
    } catch { return; }
  }
}

/** Reads the page in the tab as it stands, and gives the customer's tab back when Quest's came to the front for it. */
async function readNow(job, tabId, done, probe, fronted) {
  let injected;
  try {
    [injected] = (await inject({ target: { tabId }, func: readPage, args: [job.take ?? {}] }, 20000)) ?? [];
  } finally {
    // The customer's own tab is back in front as soon as the page is read.
    if (fronted) await giveBack(chrome);
  }
  const read = injected?.result;
  if (!read) return fail("unavailable", "the page could not be read");
  return { ok: true, read: { ...read, status: done.status ?? null, visible: probe.visible } };
}

/** Whether Chrome draws the page in this tab now. */
async function drawnNow(tabId) {
  return Boolean((await inPage(tabId, probePage, [null], 3000))?.visible);
}

function errorReason(error) {
  if (/NAME_NOT_RESOLVED|NAME_RESOLUTION_FAILED|ADDRESS_UNREACHABLE/.test(error)) return "not_found";
  if (/TIMED_OUT/.test(error)) return "timeout";
  if (/BLOCKED/.test(error)) return "blocked";
  return "unavailable";
}

/** Counts a page against today's allowance (a look at their own post against its own); false when it is spent. */
/**
 * Looks at answer pages a day: a fifth of the day's pages, never under DAILY_CHECKS. Live, 2026-11-05: always exploring,
 * 60 were spent by the afternoon (many on a minimised window), and every reply's look after was skipped until midnight.
 */
const dailyChecks = () => Math.max(DAILY_CHECKS, Math.round(dailyPages / 5));

async function uncountCheck() {
  const got = await chrome.storage.local.get(["checksDay", "checks"]);
  if (got.checksDay === today() && Number(got.checks) > 0) await chrome.storage.local.set({ checks: Number(got.checks) - 1 });
}

async function countPage(check) {
  const [key, cap, dayKey] = check ? ["checks", dailyChecks(), "checksDay"] : ["pages", dailyPages, "day"];
  const got = await chrome.storage.local.get([dayKey, key]);
  const n = got[dayKey] === today() ? Number(got[key]) || 0 : 0;
  if (n >= cap) return false;
  await chrome.storage.local.set({ [dayKey]: today(), [key]: n + 1 });
  return true;
}

/** Waits for this host's turn (lanes.js): the time is taken first, so two tabs never take the same one. */
async function pace(url) {
  const host = hostOf(url) ?? "";
  const key = `nav:${host}`;
  const wait = await pacing(async () => {
    const got = await chrome.storage.session.get(["lastNavAt", key]);
    const at = nextNavAt({ now: Date.now(), host, lastAny: Number(got.lastNavAt) || 0, lastHost: Number(got[key]) || 0, alone: slots === 1 });
    await chrome.storage.session.set({ lastNavAt: at, [key]: at });
    return at - Date.now();
  });
  if (wait > 0) await sleep(wait);
}

/**
 * Quest's reading tab, in the background of its group in the customer's window, opened without taking the
 * keyboard from them. Their own Chrome profile, never Incognito, so the sites they are logged in to show
 * Quest what they show them.
 */
async function questTab(slot = 0) {
  const key = slot ? `tabId:${slot}` : "tabId";
  const { [key]: tabId } = await chrome.storage.session.get(key);
  if (tabId && (await isQuestTab(chrome, tabId))) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab && !tab.incognito) return tab.id;
  }
  const tab = await tabbing(async () => (await spareTab(key)) ?? openTab(chrome));
  await chrome.storage.session.set({ [key]: tab.id });
  return tab.id;
}

/**
 * A reading tab to use again in place of a new one, once Quest has MAX_READING_TABS of them: the one no job is in that
 * was used longest ago, taken from the site it read for. Each site had a tab of its own until it went stale, so a run
 * that read a dozen sites in a minute stood at 12 tabs (live, 2026-11-12). Never a session's tab or a visitor's.
 */
async function spareTab(forKey) {
  const kept = await chrome.storage.session.get(null);
  const reading = Object.entries(kept).filter(([k, id]) => /^tabId(:|$)/.test(k) && k !== forKey && (kept.questTabs ?? []).includes(id));
  if (reading.length < MAX_READING_TABS) return null;
  const free = reading.filter(([, id]) => !inUse.has(id)).sort((a, b) => (Number(kept[`used:${a[1]}`]) || 0) - (Number(kept[`used:${b[1]}`]) || 0))[0];
  if (!free) return null;
  const tab = await chrome.tabs.get(free[1]).catch(() => null);
  await chrome.storage.session.remove(free[0]);
  if (!tab) return null;
  // Taken: nobody else picks it before its job marks it in use.
  inUse.set(tab.id, (inUse.get(tab.id) ?? 0) + 1);
  setTimeout(() => (inUse.get(tab.id) > 1 ? inUse.set(tab.id, inUse.get(tab.id) - 1) : inUse.delete(tab.id)), 3000);
  return tab;
}

const VISITOR_RULE = 1;

/**
 * A second tab in Quest's group that reads as someone who is not logged in,
 * to see what others see. Logged in, Reddit shows the customer their own
 * removed comment as if it were up (measured 2026-10-03), so whether their
 * post or comment still shows to others is only seen from here. Its rule
 * sends no cookies or credentials and keeps none it is given.
 */
async function visitorTab(slot = 0) {
  const key = slot ? `visitorTabId:${slot}` : "visitorTabId";
  const { [key]: visitorTabId } = await chrome.storage.session.get(key);
  if (visitorTabId && (await isQuestTab(chrome, visitorTabId))) {
    const tab = await chrome.tabs.get(visitorTabId).catch(() => null);
    if (tab && (await visitorOnly(tab.id, slot))) return tab.id;
  }
  const tab = await tabbing(() => openTab(chrome));
  await chrome.storage.session.set({ [key]: tab.id, [slot ? `visitorRuleTab:${slot}` : "visitorRuleTab"]: null });
  if (!(await visitorOnly(tab.id, slot))) throw new Error("Quest could not make its tab read as a visitor, so it did not read");
  return tab.id;
}

/** Each slot's visitor tab has a rule of its own, by the rule's id. */
async function visitorOnly(tabId, slot = 0) {
  const key = slot ? `visitorRuleTab:${slot}` : "visitorRuleTab";
  const rule = VISITOR_RULE + slot;
  const { [key]: visitorRuleTab } = await chrome.storage.session.get(key);
  if (visitorRuleTab === tabId) return true;
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [rule],
      addRules: [
        {
          id: rule,
          priority: 1,
          action: {
            type: "modifyHeaders",
            requestHeaders: [
              { header: "cookie", operation: "remove" },
              { header: "authorization", operation: "remove" },
            ],
            responseHeaders: [{ header: "set-cookie", operation: "remove" }],
          },
          condition: {
            tabIds: [tabId],
            resourceTypes: ["main_frame", "sub_frame", "xmlhttprequest", "script", "stylesheet", "image", "font", "media", "websocket", "ping", "other"],
          },
        },
      ],
    });
    await chrome.storage.session.set({ [key]: tabId });
    return true;
  } catch (e) {
    console.warn("visitor rule failed", e);
    return false;
  }
}

/** The main page's status, address and IP as Chrome saw them, or its error. */
function watchNavigation(tabId) {
  const seen = { status: null, ip: null, error: null };
  const filter = { urls: ["<all_urls>"], types: ["main_frame"], tabId };
  const completed = (d) => {
    seen.status = d.statusCode ?? null;
    seen.ip = d.ip ?? null;
    seen.error = null;
  };
  const failed = (d) => {
    if (d.error !== "net::ERR_ABORTED") seen.error = d.error;
  };
  chrome.webRequest.onCompleted.addListener(completed, filter);
  chrome.webRequest.onErrorOccurred.addListener(failed, filter);
  return {
    result: () => seen,
    stop: () => {
      chrome.webRequest.onCompleted.removeListener(completed);
      chrome.webRequest.onErrorOccurred.removeListener(failed);
    },
  };
}

/** Whether a page still loading already has its words: past parsing, with a body worth reading. */
const hasWords = () => document.readyState !== "loading" && (document.body?.innerText?.length ?? 0) > 500;

/**
 * Opens the address in Quest's tab; true once Chrome says it has loaded, or the page has its words, false if it took too
 * long. In a background tab LinkedIn and YouTube can hold their load event for the whole wait (live, 2026-11-05: reads of
 * 40 s, and posts that ran out of the job's time on the opening alone), with the page there long before.
 */
function navigate(tabId, url) {
  return new Promise((resolve) => {
    let started = false;
    const opened = Date.now();
    const timer = setTimeout(() => finish(false), LOAD_TIMEOUT_MS);
    const usable = setInterval(async () => {
      if (!started || Date.now() - opened < USABLE_AFTER_MS) return;
      const answer = await inject({ target: { tabId }, func: hasWords }, 1500).catch(() => null);
      if (answer?.[0]?.result) finish(true);
    }, 1500);
    const onUpdated = (id, change) => {
      if (id !== tabId) return;
      if (change.status === "loading") started = true;
      if (change.status === "complete" && started) finish(true);
    };
    function finish(ok) {
      clearTimeout(timer);
      clearInterval(usable);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve(ok);
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.update(tabId, { url }).catch(() => finish(false));
  });
}

/** Waits for what the reader asked for, up to `settleMs`, then a moment for late content. */
async function settle(tabId, waitFor, settleMs) {
  const until = Date.now() + Math.min(Number(settleMs) || 1500, 10000);
  let probe = { found: false, visible: true };
  for (;;) {
    try {
      const [r] = (await inject({ target: { tabId }, func: probePage, args: [waitFor ?? null] }, 3000)) ?? [];
      probe = r?.result ?? probe;
    } catch {
      // The page is between documents; ask again.
    }
    if ((waitFor && probe.found) || Date.now() >= until) break;
    await sleep(waitFor ? 400 : Math.max(0, until - Date.now()));
  }
  if (waitFor && probe.found) await sleep(600);
  return probe;
}

/* --------------------------------------------------------------- posting */

/**
 * General UI sessions survive service-worker sleep, with a tab isolated from ordinary reading. The session's
 * tab comes to the front only for a step that needs it (lanes.js `frontFor`): a picture or input by sight, or a
 * site whose pages show their posts only while drawn; one tab in front at a time, and none while their switch says
 * so. Closing it gives the customer's tab back.
 */
async function browserJob(job) {
  if (!/^[a-zA-Z0-9:_-]{1,120}$/.test(job?.session ?? "")) return fail("refused", "Invalid browser session.");
  const key = `browser:${job.session}`;
  const shotKey = `${key}:screen`;
  const stored = (await chrome.storage.session.get(key))[key];
  let tab = stored && (await isQuestTab(chrome, stored)) ? await chrome.tabs.get(stored).catch(() => null) : null;
  if (job.action?.kind === "close") {
    // In the line for the front: giving their tab back in the middle of another tab's step would push that tab behind.
    if (tab) await fronting(() => tabbing(() => closeTab(chrome, tab.id)));
    await chrome.storage.session.remove(key);
    await chrome.storage.session.remove(shotKey);
    return { ok: true, view: { url: "about:blank", title: "Closed", text: "", controls: [] } };
  }
  if (job.url) {
    const refused = refuseUrl(job.url);
    if (refused) return fail(refused.reason, refused.message);
  }
  if (!tab) {
    if (!job.url) return fail("unavailable", "The browser session expired. Open the page again.");
    tab = await tabbing(() => openTab(chrome));
    await chrome.storage.session.set({ [key]: tab.id });
  }
  if (job.url) {
    await pace(job.url);
    const nav = watchNavigation(tab.id);
    try {
      await navigate(tab.id, job.url);
      if (nav.result().ip && isPrivateIp(nav.result().ip)) { await chrome.tabs.update(tab.id, { url: "about:blank" }); return fail("blocked", "Private networks are not accessible."); }
      // A 429 is the site asking for a pause, not a refusal: nothing was sent, and it may be tried again later.
      if (nav.result().status === 429) return fail("rate_limited", "The site asked to slow down (HTTP 429). Try again in a few minutes.");
      if ([401,403].includes(nav.result().status)) return fail("refused", `The site refused this page (HTTP ${nav.result().status}). Do not work around it.`);
    } finally { nav.stop(); }
  }
  tab = await chrome.tabs.get(tab.id);
  const refused = refuseUrl(tab.url);
  if (refused) return fail(refused.reason, refused.message);
  const needs = frontFor(job);
  const allowed = Boolean(needs) && (await frontAllowed());
  if (needs === "input" && !allowed) return fail("refused", FRONT_OFF);
  const step = () => sessionStep(tab, job, shotKey, allowed ? needs : null);
  return using(tab.id, () => (allowed ? fronting(step) : step()));
}

/** One step of a session in its tab, brought to the front first when `up` says so. */
async function sessionStep(tab, job, shotKey, up) {
  // Pictures, clicks and keystrokes reach only a tab Chrome draws, in a window that has the keyboard; a page that
  // shows its posts only while drawn needs it drawn, which raises the window only when nothing shows it.
  if (up) await front(chrome, tab.id, drawnNow, { focus: up !== "drawn" });
  // A page just opened is read once it stops changing, not at Chrome's "complete": feeds draw after that.
  if (job.url) await quiet(tab.id, 4000);
  await overlay(tab.id, { kind: "show", ...stepLabel(job, tab.url) });
  // A tab a click opens (a link with target="_blank", window.open) is followed in this one, and closed: the session
  // works in its own tab, and was left reading the page it had clicked away from.
  const opened = [];
  const onCreated = (t) => { if (t.openerTabId === tab.id) opened.push(t); };
  chrome.tabs.onCreated.addListener(onCreated);
  try {
    const out = await act(tab, job, shotKey);
    if (out) return out;
  } finally {
    chrome.tabs.onCreated.removeListener(onCreated);
  }
  if (opened.length) {
    await sleep(400);
    const last = await chrome.tabs.get(opened.at(-1).id).catch(() => null);
    const url = last?.pendingUrl || last?.url || opened.at(-1).pendingUrl || opened.at(-1).url;
    for (const t of opened) await chrome.tabs.remove(t.id).catch(() => undefined);
    if (url && /^https?:/i.test(url) && !refuseUrl(url)) {
      await navigate(tab.id, url);
      await quiet(tab.id, 4000);
    }
  }
  return sessionView(tab.id, job, shotKey);
}

/**
 * An injection's results, or null when Chrome has not answered within `ms`. Every injection is held to a time:
 * one into a page a click had just sent elsewhere was never answered, and the worker, waiting on it, stopped taking
 * work until Chrome restarted it (live, 2026-10-15, a Save that went on to the profile page).
 */
/** Where Quest's cursor was last in each tab, so a page it just opened draws it where it left the last one. In memory. */
const cursorAt = new Map();

/** What the cursor's label says as a step begins; a press or a fill names its control itself (browser-page.js). */
function stepLabel(job, url) {
  const kind = job.action?.kind;
  const host = hostOf(job.url ?? url ?? "") ?? "";
  if (job.url) return { label: `Opening ${host}` };
  if (kind === "scroll" || kind === "scroll_point") return { label: "Scrolling" };
  if (kind === "wait") return { label: "Waiting for the page" };
  if (kind === "screenshot" || kind === "snapshot") return { label: `Reading ${host}` };
  if (kind === "type_text") return { label: "Typing" };
  return {};
}

/** Quest's cursor and glow in a session's page (cursor.js): only a picture of the work, so it never fails or holds a step. */
async function overlay(tabId, cmd) {
  const at = await inPage(tabId, questOverlay, [cmd.kind === "show" ? { from: cursorAt.get(tabId), ...cmd } : cmd], 1500);
  if (at && typeof at.x === "number") cursorAt.set(tabId, at);
}

async function inject(details, ms) {
  return Promise.race([chrome.scripting.executeScript(details), sleep(ms).then(() => null)]);
}

/** An injected script's answer in the main frame, or null when it failed or took longer than `ms`. */
async function inPage(tabId, func, args, ms) {
  const run = inject({ target: { tabId }, func, args }, ms).then((r) => r?.[0]?.result ?? null, () => null);
  return run;
}

/** Resolves once the tab has loaded, or after `ms`. */
function loaded(tabId, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    const onUpdated = (id, change) => { if (id === tabId && change.status === "complete") done(); };
    function done() {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId).then((t) => { if (t.status === "complete") done(); }, done);
  });
}

/**
 * Waits in the page until it stops changing, at most `maxMs`. A page that navigates away meanwhile (a Save that
 * goes to the profile) is waited for to load, then to settle. Live, 2026-10-15: the wait was left hanging on the
 * page a click had left, the job never answered, and the extension stopped taking work until it was reloaded.
 */
async function quiet(tabId, maxMs) {
  const waited = await inPage(tabId, domQuiet, [maxMs, 400], maxMs + 1500);
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab?.status === "loading" && !(await inPage(tabId, hasWords, [], 1500))) {
    await loaded(tabId, 15000);
    await inPage(tabId, domQuiet, [2500, 400], 4000);
  } else if (waited === null) await sleep(500);
}

/** Does the session's action in its tab; a failure to answer with, or nothing when it went through. */
async function act(tab, job, shotKey) {
  const visual = ["click_point", "move_point", "type_text", "press_focused", "scroll_point"].includes(job.action.kind);
  if (visual || job.action.kind === "screenshot") {
    if (!visualAllowed(await chrome.storage.local.get("visual"))) return fail("refused", "Enable visual browser controls in Quest's extension popup, then try again.");
    if (visual) {
      const shot = (await chrome.storage.session.get(shotKey))[shotKey];
      if (!shot || shot.url !== tab.url) return fail("refused", "That picture is stale. Take another screenshot.");
      if (job.action.kind === "type_text") {
        const focus = (await inject({ target: { tabId: tab.id, allFrames: true }, func: focusedSensitive }, 5000).catch(() => [])) ?? [];
        if (focus.some((f) => f.result)) return fail("refused", "The focused field is a password, code or card field. The customer fills those in.");
      }
      await chrome.storage.session.remove(shotKey);
      // The cursor goes to the point first, and is seen arriving before the press.
      if (["click_point", "move_point", "scroll_point"].includes(job.action.kind) && shot.width && shot.height) {
        await overlay(tab.id, { kind: "show", x: job.action.x * shot.viewportWidth / shot.width, y: job.action.y * shot.viewportHeight / shot.height, press: job.action.kind === "click_point" });
        await sleep(300);
      }
      try { await visualInput(chrome.debugger, tab.id, job.action, shot); }
      catch (e) { return fail("refused", e.message); }
      await quiet(tab.id, job.action.kind === "scroll_point" ? 3000 : 2500);
    }
  } else if (job.action.kind === "attach") {
    // One of their own pictures, sent to Quest in their chat, into the composer's file field: nothing is sent.
    const match = /^(\d+):(.+)$/.exec(job.action.ref ?? "");
    const result = await inject({ target: { tabId: tab.id, frameIds: [match ? Number(match[1]) : 0] }, func: attachFile, args: [{ ref: match?.[2] ?? null, name: job.action.name, type: job.action.type, data: job.action.data }] }, 15000);
    if (!result) return fail("timeout", "The page did not take the file in time. Inspect it before anything else.");
    if (result[0]?.result?.error) return fail("refused", result[0].result.message);
    await quiet(tab.id, 5000);
  } else if (job.action.kind !== "snapshot") {
    if (job.action.kind === "scroll" && !job.action.ref) {
      // Most of a screen, on whatever scrolls the page; at a feed's end, a moment for it to draw more.
      await inPage(tab.id, scrollPage, [job.action.direction, 4000], 6000);
      await quiet(tab.id, 2000);
      return undefined;
    }
    const match = /^(\d+):(.+)$/.exec(job.action.ref ?? "");
    if (!match) return fail("refused", "Inspect the page before acting.");
    const allowed = visualAllowed(await chrome.storage.local.get("visual"));
    const trusted = job.action.kind === "fill" && allowed;
    // A real press, key or typing in a plain field only on a tab drawn in front: in the background Chrome may never
    // answer them, and a press nobody can tell went through must not be guessed at.
    const drawn = allowed && (await chrome.tabs.get(tab.id).catch(() => tab)).active;
    const hand = drawn && ["click", "press"].includes(job.action.kind) ? await holdInput(chrome.debugger, tab.id) : null;
    try {
      const result = await inject({ target: { tabId: tab.id, frameIds: [Number(match[1])] }, func: browserPage, args: [{ ...job.action, ref: match[2], trusted, hand: Boolean(hand) || (job.action.kind === "fill" && drawn) }] }, 10000);
      if (!result) return fail("timeout", "The page did not answer that action in time. Inspect it before anything else.");
      const done = result[0]?.result;
      if (done?.error) return fail("refused", done.message);
      if (done?.at) cursorAt.set(tab.id, done.at);
      const late = (what) => sleep(8000).then(() => { throw new Error(`${what} did not go through in time. Inspect the page before anything else.`); });
      if (hand && done?.press) {
        try { await Promise.race([hand.press(done.press), late("The press")]); } catch (e) { return fail("timeout", e.message); }
      }
      if (hand && done?.key) {
        try { await Promise.race([hand.key(done.key), late("The key")]); } catch (e) { return fail("timeout", e.message); }
      }
      if (done?.type) {
        const text = done.text ?? job.action.text;
        // Held to a time: typed into a tab in the background (their switch keeps it there), keys may never be answered.
        try { await Promise.race([trustedFill(chrome.debugger, tab.id, text), sleep(15000).then(() => { throw new Error("Typing into the page did not go through in time. Inspect it before anything else."); })]); }
        catch (e) { return fail("refused", e.message); }
        // A plain field is read back: what it holds is what goes, so it must be the words.
        if (done.text !== undefined) {
          const check = await inject({ target: { tabId: tab.id, frameIds: [Number(match[1])] }, func: typedCheck, args: [text] }, 5000);
          const seen = check?.[0]?.result;
          if (seen && !seen.ok) return fail("refused", `The field did not take the words; it holds "${seen.held}". Inspect it before anything else.`);
        }
      }
    } finally { await hand?.close(); }
    await quiet(tab.id, job.action.kind === "fill" ? 1500 : 3000);
  }
  return undefined;
}

/** The session's page as it stands: every readable frame's words and controls, and a picture when one was asked for. */
async function sessionView(tabId, job, shotKey) {
  const visual = ["click_point", "move_point", "type_text", "press_focused", "scroll_point"].includes(job.action.kind);
  if ((await chrome.tabs.get(tabId)).status === "loading" && !(await inPage(tabId, hasWords, [], 1500))) await loaded(tabId, 15000);
  const tab = await chrome.tabs.get(tabId);
  const redirected = refuseUrl(tab.url);
  if (redirected) return fail(redirected.reason, redirected.message);
  // The page a click went on to has no cursor yet: drawn again, where it was.
  await overlay(tabId, { kind: "show" });
  // Never left waiting on a page that will not answer: the job fails, and the extension takes the next one.
  const frames = await inject({ target: { tabId: tab.id, allFrames: true }, func: browserPage, args: [{ kind: "snapshot" }] }, 15000);
  if (!frames) return fail("timeout", "The page did not answer in time. Inspect it again.");
  const main = frames.find((f) => f.frameId === 0)?.result;
  if (!main) return fail("unavailable", "The page could not be inspected.");
  const allowed = frames.filter((f) => f.result?.url && !refuseUrl(f.result.url));
  const readable = allowed.slice(0, 5);
  // Within what the agent accepts: a page with more frames, or longer addresses, still answers.
  const frameUrls = allowed.map((f) => f.result.url).filter((u) => u.length <= 4000).slice(0, 100);
  // Which post a control acts on is told for the page's own posts; a frame's have their own numbering, so none.
  const controls = readable.flatMap((f) => f.result.controls.map(({ item, ...c }) => ({ ...c, ref: `${f.frameId}:${c.ref}`, ...(f.frameId === 0 && item !== undefined ? { item } : {}) }))).slice(0, 1500);
  const view = {
    url: main.url.slice(0, 4000),
    title: main.title,
    frames: frameUrls,
    text: readable.map((f) => f.result.text).join("\n").slice(0, 100000),
    controls,
    ...(main.items ? { items: main.items.slice(0, 60).map((s) => String(s).slice(0, 200)) } : {}),
    ...(main.scroll ? { scroll: main.scroll } : {}),
    ...(typeof main.loading === "boolean" ? { loading: main.loading } : {}),
    ...(readable.find((f) => f.result.focus)?.result.focus ? { focus: readable.find((f) => f.result.focus).result.focus } : {}),
    ...(main.dialog ? { dialog: main.dialog } : {}),
  };
  if (visual || job.action.kind === "screenshot") {
    if (frames.some((f) => f.result?.url && privateFrame(f.result.url))) return fail("blocked", "This page includes a private frame and cannot be pictured.");
    if (/\/(?:login|signin|sign-in|password|oauth|billing|payment)(?:\/|\?|$)/i.test(tab.url)) return fail("refused", "The customer handles sign-in and sensitive account pages; they are not pictured.");
    await inject({ target: { tabId: tab.id, allFrames: true }, func: protectPicture, args: [true] }, 5000);
    // No model sees Quest's own cursor or glow: hidden for the picture.
    await overlay(tab.id, { kind: "hide" });
    try {
      const picture = await visualPicture(chrome.debugger, tab.id);
      const { image, ...meta } = picture;
      await chrome.storage.session.set({ [shotKey]: { ...meta, url: tab.url } });
      view.screen = { id: picture.id, image, width: picture.width, height: picture.height };
    } finally {
      await inject({ target: { tabId: tab.id, allFrames: true }, func: protectPicture, args: [false] }, 5000).catch(() => undefined);
      await overlay(tab.id, { kind: "unhide" });
    }
  }
  return { ok: true, view };
}

/** Where a reply is posted from: old Reddit first (its comment form is the long-standing one), then Reddit itself. */
const POST_ORIGINS = ["https://old.reddit.com", "https://www.reddit.com"];

/**
 * Posts one thing on Reddit as the customer (a reply, a new post in a community,
 * or a private message): one they tapped "Post it" on, or one Quest sends by
 * itself where they have let it. In a background tab of Quest's group, in
 * their own profile where their Reddit login is, through the forms Reddit's
 * own pages use. The tab closes afterwards. It does not count against the
 * reading allowance, and Quest's reading tab is never used for it.
 */
async function postJob(post) {
  if (post?.platform !== "reddit") return fail("refused", "Other platforms use the generic browser publisher; this job is for the Reddit adapter");
  const form = redditForm(post);
  if (form.refused) return fail("refused", form.refused);

  const { id: tabId } = await tabbing(() => openTab(chrome));
  try {
    for (const origin of POST_ORIGINS) {
      // Loading who is signed in opens the tab on Reddit's own origin, so the post goes out as the site's pages send it.
      const loaded = await navigate(tabId, `${origin}/api/me.json`);
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (!loaded || !tab?.url?.startsWith(`${origin}/`)) continue; // old Reddit sends visitors who aren't signed in elsewhere
      const [injected] = (await inject({ target: { tabId }, func: redditPost, args: [form.action, form.fields] }, 60000)) ?? [];
      const r = injected?.result;
      if (!r) return fail("unavailable", "it could not be posted from the Reddit tab");
      if (!r.ok) return fail(r.reason, r.message);
      return { ok: true, posted: { url: form.seen(r.data), account: r.name } };
    }
    return fail("login", "Reddit showed a login page instead of the account");
  } finally {
    await tabbing(() => closeTab(chrome, tabId));
  }
}

/* ------------------------------------------------------------ connecting */

/** Whether Quest's local edition answers on this computer (npm start): its /health says so. */
async function localQuest() {
  const res = await fetch(`${LOCAL_SERVER}/health`, { signal: AbortSignal.timeout(1500) }).catch(() => null);
  const body = res?.ok ? await res.json().catch(() => null) : null;
  return body?.edition === "local";
}

function deviceName() {
  const brands = navigator.userAgentData?.brands ?? [];
  // Every Chromium browser lists "Chromium" too, in no fixed order: its own name wins.
  const chrome = brands.find((b) => /Google Chrome|Microsoft Edge|Brave|Opera/.test(b.brand)) ?? brands.find((b) => b.brand === "Chromium");
  const platform = navigator.userAgentData?.platform || (/Windows/.test(navigator.userAgent) ? "Windows" : /Mac/.test(navigator.userAgent) ? "macOS" : "Linux");
  const name = chrome ? `${chrome.brand.replace("Google ", "")} ${chrome.version}` : "Chrome";
  return `${name} on ${platform}`;
}

async function pair(server, code) {
  let res;
  try {
    res = await fetch(`${server}/chrome/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, device: deviceName() }),
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    return { ok: false, message: `Quest at ${server} did not answer. Check your connection and try again.` };
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.token) {
    // The same link opened twice: the code is spent, but this Chrome may already be the one it connected.
    if (await stillConnected(server)) return { ok: true, device: (await connection())?.device ?? null, already: true };
    return { ok: false, message: body.error ?? `Quest answered ${res.status}.` };
  }
  await chrome.storage.local.set({ server, token: body.token, device: body.device ?? deviceName() });
  await setStatus({ link: "ok", note: null });
  await keepAwake();
  void loop();
  return { ok: true, device: body.device ?? null };
}

async function stillConnected(server) {
  const c = await connection();
  if (!c || c.server !== server) return false;
  const res = await fetch(`${server}/chrome/me`, { headers: { authorization: `Bearer ${c.token}` } }).catch(() => null);
  return Boolean(res?.ok);
}

async function disconnect() {
  const c = await connection();
  if (c) {
    await fetch(`${c.server}/chrome/disconnect`, { method: "POST", headers: { authorization: `Bearer ${c.token}` } }).catch(() => null);
  }
  await forget(null);
  await closeQuestTabs();
}

/** Closes Quest's tabs, and Chrome drops its group with the last; never one of the customer's. */
async function closeQuestTabs() {
  await tabbing(() => closeAll(chrome));
  const kept = await chrome.storage.session.get(null);
  await chrome.storage.session.remove(["windowId", ...Object.keys(kept).filter((k) => /^(tabId|visitorTabId|visitorRuleTab)(:|$)|^browser:|^used:/.test(k))]);
}

/** Done for now: nothing has run for a while, so Quest's tabs close. The next job opens the group again. */
async function tidy() {
  const kept = await chrome.storage.session.get(null);
  const { lastWorkAt, questTabs } = kept;
  const sessionOpen = Object.keys(kept).some((k) => k.startsWith("browser:") && !k.endsWith(":screen"));
  await tabbing(() => closeStrayGroups(chrome)).catch(() => undefined);
  if (!questTabs?.length) return;
  if (idle(lastWorkAt, busy > 0, Date.now(), sessionOpen)) return closeQuestTabs();
  // At work without a pause, nothing is ever idle: each tab that is done with closes by itself (a session whose run
  // ended without closing it, a reading tab of a slot no longer polled), so the group holds only what is in use.
  const sessions = new Map(Object.entries(kept).filter(([k]) => k.startsWith("browser:") && !k.endsWith(":screen")).map(([k, id]) => [id, k]));
  for (const tabId of questTabs) {
    if (inUse.has(tabId)) continue;
    const used = Number(kept[`used:${tabId}`]) || 0;
    // A tab never used yet was opened a moment ago for a job that is starting.
    if (!used || Date.now() - used < (sessions.has(tabId) ? SESSION_IDLE_MS : STALE_TAB_MS)) continue;
    await fronting(() => tabbing(() => closeTab(chrome, tabId)));
    const key = sessions.get(tabId);
    await chrome.storage.session.remove([`used:${tabId}`, ...(key ? [key, `${key}:screen`] : [])]);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  // A page's tab reaches this only through the connect page's content script, and only to pair; the rest
  // (status, the switches, disconnecting) is the popup's, an extension page with no tab.
  const fromPopup = sender.id === chrome.runtime.id && !sender.tab;
  // The landing (landing.js) hands over the code from the link Quest gave them in a thread; kept until they start.
  if (msg?.type === "invite" && sender.tab) {
    if (/^[A-Za-z0-9_-]{4,64}$/.test(String(msg.code ?? ""))) void chrome.storage.local.get("token").then(({ token }) => !token && chrome.storage.local.set({ invite: String(msg.code) }));
    return false;
  }
  if (msg?.type !== "pair" && !fromPopup) return false;
  (async () => {
    switch (msg?.type) {
      case "seen": {
        // The open panel showed everything up to this message, and the asks it holds now.
        const at = String(msg.at ?? "");
        const { seenAt } = await chrome.storage.local.get("seenAt");
        if (Date.parse(at) && (!seenAt || Date.parse(at) > Date.parse(seenAt))) await chrome.storage.local.set({ seenAt: at });
        await chrome.storage.local.set({ lastUnread: 0, ...(Number.isFinite(msg.asks) ? { lastAsks: msg.asks } : {}) });
        if (!busy) await restBadge().catch(() => undefined);
        return { ok: true };
      }
      case "chat": {
        const c = await connection();
        if (!c) return { ok: false };
        const q = msg.after ? `?after=${encodeURIComponent(msg.after)}&wait=${Number(msg.wait) || 0}` : "";
        const res = await fetch(`${c.server}/chrome/chat${q}`, { headers: { authorization: `Bearer ${c.token}` }, signal: AbortSignal.timeout(30000) }).catch(() => null);
        if (!res?.ok) return { ok: false, status: res?.status ?? 0 };
        return { ok: true, chat: await res.json() };
      }
      case "voice": {
        const c = await connection();
        if (!c) return { ok: false };
        const res = await fetch(`${c.server}/chrome/chat/voice`, {
          method: "POST",
          headers: { authorization: `Bearer ${c.token}`, "content-type": "application/json" },
          body: JSON.stringify({ audio: String(msg.audio ?? ""), mime: String(msg.mime ?? ""), seconds: Number(msg.seconds) || null, replyTo: msg.replyTo ?? null }),
          signal: AbortSignal.timeout(120000),
        }).catch(() => null);
        return { ok: Boolean(res?.ok) };
      }
      case "say":
      case "press": {
        const c = await connection();
        if (!c) return { ok: false };
        const res = await fetch(`${c.server}/chrome/${msg.type === "say" ? "chat" : "chat/press"}`, {
          method: "POST",
          headers: { authorization: `Bearer ${c.token}`, "content-type": "application/json" },
          body: JSON.stringify(msg.type === "say" ? { text: String(msg.text ?? ""), replyTo: msg.replyTo ?? null } : { data: String(msg.data ?? "") }),
          signal: AbortSignal.timeout(120000),
        }).catch(() => null);
        if (!res?.ok) return { ok: false };
        return { ok: true, ...(await res.json().catch(() => ({}))) };
      }
      // Someone new starts talking to Quest here, with no Telegram: the agent makes them a customer and this Chrome theirs.
      case "hello": {
        const development = await unpacked(chrome.management);
        // Quest running on this computer (the local edition) is the one to talk to when it answers.
        const where = { development, asked: msg.server ?? ((await localQuest()) ? LOCAL_SERVER : undefined) };
        const server = pairingServer(where);
        if (!server) return { ok: false, message: refusal(where) };
        const { invite } = await chrome.storage.local.get("invite");
        const res = await fetch(`${server}/chrome/hello`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ device: deviceName(), language: navigator.language ?? null, invite: msg.invite || invite || null, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? null }),
          signal: AbortSignal.timeout(60000),
        }).catch(() => null);
        const body = res ? await res.json().catch(() => ({})) : {};
        if (!res?.ok || !body.token) return { ok: false, message: body.error ?? `Quest at ${server} did not answer. Try again in a minute.` };
        await chrome.storage.local.set({ server, token: body.token, device: deviceName() });
        await chrome.storage.local.remove("invite");
        await setStatus({ link: "ok", note: null });
        await keepAwake();
        void loop();
        return { ok: true };
      }
      // From the connect page: the server is the page's own origin, never something the page says.
      // A store install connects only to Quest's own address, the dev extension never to it (quest-server.js).
      case "pair": {
        const development = await unpacked(chrome.management);
        const where = { development, origin: sender.tab ? sender.origin : undefined, asked: sender.tab ? undefined : msg.server };
        const server = pairingServer(where);
        if (!server) return { ok: false, refused: true, message: refusal(where) };
        return pair(server, String(msg.code ?? ""));
      }
      case "status": {
        const c = await connection();
        const s = await chrome.storage.session.get(["link", "reading", "posting", "lastJobAt", "note"]);
        const { day, pages, awake, visual, front: kept } = await chrome.storage.local.get(["day", "pages", "awake", "visual", "front"]);
        const development = await unpacked(chrome.management);
        return {
          connected: Boolean(c),
          server: c?.server ?? (development ? DEV_SERVER : DEFAULT_SERVER),
          device: c?.device ?? null,
          link: s.link ?? null,
          reading: s.reading ?? null,
          posting: s.posting ?? null,
          lastJobAt: s.lastJobAt ?? null,
          note: s.note ?? null,
          pagesToday: day === today() ? Number(pages) || 0 : 0,
          dailyPages,
          awake: awake !== false,
          visual: visualAllowed({ visual }),
          front: kept !== false,
          // Their page's switch keeps it out of the front too: the popup says so.
          frontByPage: !agentFront,
          // Whether they switched Quest off, here, in their chat or on their page.
          off: (await chrome.storage.session.get("off")).off === true,
          // Only an unpacked build may be pointed at another Quest, so only it shows the address.
          customServer: development,
        };
      }
      // The popup's switch: keeping the computer awake is on until they turn it off.
      case "awake":
        await chrome.storage.local.set({ awake: Boolean(msg.on) });
        return { ok: true, awake: await keepAwake() };
      // The popup's other switch: visual browser controls are on until they turn them off.
      case "visual":
        await chrome.storage.local.set({ visual: Boolean(msg.on) });
        return { ok: true, visual: visualAllowed(await chrome.storage.local.get("visual")) };
      // And the one that keeps Quest's tab out of the front: on (it may come up) until they turn it off.
      case "front":
        await chrome.storage.local.set({ front: Boolean(msg.on) });
        return { ok: true, front: (await chrome.storage.local.get("front")).front !== false };
      // The bar at the top of the chat: Quest on or off, the same one as in their chat. The agent keeps it; off, Quest's
      // tabs close at once, before its next answer says so.
      case "power":
        return setPower(Boolean(msg.on));
      // The way to the same Quest in Telegram, for whoever wants it there too: the agent makes the link.
      case "telegram": {
        const c = await connection();
        if (!c) return { ok: false };
        const res = await fetch(`${c.server}/chrome/chat/telegram`, { method: "POST", headers: { authorization: `Bearer ${c.token}` }, signal: AbortSignal.timeout(20000) }).catch(() => null);
        const url = res?.ok ? (await res.json().catch(() => null))?.url : null;
        return typeof url === "string" && (url.startsWith("https://t.me/") || url.startsWith("https://telegram.me/")) ? { ok: true, url } : { ok: false };
      }
      // The panel's settings (the agent keeps them): platforms on and off, what goes alone, the model, past reports.
      // A report opens only at the agent's own address.
      case "settings": {
        const c = await connection();
        if (!c) return { ok: false };
        const body = msg.platform ? JSON.stringify({ platform: String(msg.platform), on: Boolean(msg.on) }) : null;
        const res = await fetch(`${c.server}/chrome/settings${body ? "/platform" : ""}`, {
          method: body ? "POST" : "GET",
          headers: { authorization: `Bearer ${c.token}`, ...(body ? { "content-type": "application/json" } : {}) },
          body,
          signal: AbortSignal.timeout(20000),
        }).catch(() => null);
        const data = res?.ok ? await res.json().catch(() => null) : null;
        if (!data) return { ok: false };
        const reports = (Array.isArray(data.reports) ? data.reports : []).filter((r) => typeof r?.url === "string" && r.url.startsWith(`${c.server}/report/`));
        return { ok: true, platforms: Array.isArray(data.platforms) ? data.platforms : [], model: String(data.model ?? ""), reports };
      }
      case "disconnect":
        await disconnect();
        return { ok: true };
      default:
        return null;
    }
  })().then(reply, (e) => reply({ ok: false, message: e instanceof Error ? e.message : String(e) }));
  return true;
});

/* ------------------------------------------- the switch, and the chat beside the page */

/** Quest on or off, kept by the agent (the bar at the top of the chat); off, its tabs close at once. */
async function setPower(on) {
  const c = await connection();
  if (!c) return { ok: false };
  const res = await fetch(`${c.server}/chrome/power`, {
    method: "POST",
    headers: { authorization: `Bearer ${c.token}`, "content-type": "application/json" },
    body: JSON.stringify({ on }),
    signal: AbortSignal.timeout(15000),
  }).catch(() => null);
  if (!res?.ok) return { ok: false };
  await switched(!on);
  return { ok: true, on };
}

/**
 * Quest's icon only shows and hides the chat, which is Chrome's side panel: a click opens it, a second closes it
 * (Chrome's own toggle), and nothing opens it by itself. Switching Quest off is the bar at the top of the chat (the
 * founder, 2026-11-18: "The extension own button only function now is to open and close the sidepanel, not stop the
 * browser running"; before, 2026-11-16, the icon was a red stop sign while Quest browsed).
 */
async function iconShowsChat() {
  await chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);
  await chrome.action.setTitle({ title: "Show or hide Quest" }).catch(() => undefined);
  // A worker from before may have left the stop sign on it.
  await chrome.action.setIcon({ path: { 16: "icons/icon-16.png", 32: "icons/icon-32.png" } }).catch(() => undefined);
}

chrome.contextMenus?.onClicked.addListener((info, tab) => {
  // Chrome allows opening the panel only in answer to their own click, as this is.
  if (info.menuItemId === "chat" && tab?.windowId !== undefined) void chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => undefined);
});

/**
 * Quest's mark moved (a message, a change on Your move): the icon's badge says how many asks wait, and that is all.
 * Nothing opens or is drawn over their pages; what Quest says reaches them in the chat they opened, or in Telegram.
 */
const hearing = oneAtATime();
async function heard(mark) {
  await hearing(async () => {
    const { newsMark } = await chrome.storage.session.get("newsMark");
    if (newsMark !== undefined && mark <= newsMark) return;
    await chrome.storage.session.set({ newsMark: mark });
    const c = await connection();
    if (!c) return;
    const res = await fetch(`${c.server}/chrome/chat`, { headers: { authorization: `Bearer ${c.token}` }, signal: AbortSignal.timeout(20000) }).catch(() => null);
    const chat = res?.ok ? await res.json().catch(() => null) : null;
    if (!chat) return;
    await chrome.storage.local.set({ lastAsks: chat.card?.total ?? 0, lastUnread: await unreadIn(chat) });
    if (!busy) await restBadge().catch(() => undefined);
  });
}

/** How many of Quest's messages came after the last one the open panel showed, as Telegram counts unread. */
async function unreadIn(chat) {
  let { seenAt } = await chrome.storage.local.get("seenAt");
  // Never seen (a fresh install, or one from before the count): what is there now counts as read.
  if (!seenAt) {
    seenAt = new Date().toISOString();
    await chrome.storage.local.set({ seenAt });
  }
  const since = Date.parse(seenAt) || 0;
  return (chat.messages ?? []).filter((m) => m.from === "quest" && !m.note && Date.parse(m.at) > since).length;
}

/* ------------------------------------------------------- the dev build */

// The dev extension reloads itself when npm run dev copies another build into its folder (dev-reload.js): between
// jobs, with Quest's tabs closed first, since a reload forgets them.
const devExtension = unpacked(chrome.management);
nameGroup(devExtension);
chrome.tabs.onRemoved.addListener((tabId) => void tabbing(() => forgetTab(chrome, tabId)).catch(() => undefined));
const newBuild = followStamp({ read: () => stampedBuild(fetch, chrome.runtime.getURL(STAMP)), session: chrome.storage.session });
/** A session between two of its steps is waited for this long before the reload goes ahead anyway. */
const RELOAD_WAIT_MS = 120_000;
async function followDevBuild() {
  if (!(await devExtension) || !(await newBuild())) return;
  // It closed Quest's tabs at every idle instant and reloaded only if still idle after: at work without a pause it never
  // reloaded, and a send's tab went between its steps ("The browser session expired", live, 2026-11-12, three in ten
  // minutes). Now: no new job from here, wait for the jobs in flight and for open sessions, then close and reload, once.
  reloadSince ||= Date.now();
  if (busy) return;
  const kept = await chrome.storage.session.get(null);
  const sessionOpen = Object.keys(kept).some((k) => k.startsWith("browser:") && !k.endsWith(":screen"));
  if (sessionOpen && Date.now() - reloadSince < RELOAD_WAIT_MS) return;
  await closeAll(chrome).catch(() => undefined);
  chrome.runtime.reload();
}
void devExtension.then((dev) => dev && setInterval(() => void followDevBuild().catch(() => undefined), STAMP_EVERY_MS));

/* ---------------------------------------------------------------- waking */

function wake() {
  chrome.alarms.create("poll", { periodInMinutes: 0.5 });
  void restBadge().catch(() => undefined);
  void iconShowsChat();
  void keepAwake();
  void loop();
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== "poll") return;
  void followDevBuild().catch(() => undefined);
  // Chrome holds the request while the extension is loaded; asking again costs nothing and outlasts anything that dropped it.
  void keepAwake();
  void loop();
  void tidy().catch(() => undefined);
});
chrome.runtime.onStartup.addListener(wake);
chrome.runtime.onInstalled.addListener(async () => {
  wake();
  chrome.contextMenus?.removeAll(() => {
    chrome.contextMenus.create({ id: "chat", title: "Open the chat", contexts: ["action"] });
  });
  await closeOldWindow(chrome);
  // What the dock of an older version kept: its script on pages already open hides when this goes.
  await chrome.storage.local.remove("dock").catch(() => undefined);
  // A connect page opened before the extension was installed gets its content script now.
  const tabs = await chrome.tabs.query({ url: chrome.runtime.getManifest().content_scripts.filter((s) => s.js.includes("src/connect.js")).flatMap((s) => s.matches) });
  for (const t of tabs) if (t.id) await chrome.tabs.reload(t.id).catch(() => null);
});
// The worker also starts for a message or the alarm; each time, make sure the loop runs.
wake();
