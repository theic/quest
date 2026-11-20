/**
 * Runs on Quest's own connect page (see manifest.json for where). It takes the
 * one-time code from the address's fragment, asks the service worker to trade
 * it for a connection, and says how it went in data attributes on <html>,
 * which the page's own script watches.
 */
(() => {
  const html = document.documentElement;
  const set = (state, message) => {
    html.dataset.mqState = state;
    if (message) html.dataset.mqMessage = message;
    else delete html.dataset.mqMessage;
    document.dispatchEvent(new Event("mq-extension"));
  };
  const code = decodeURIComponent(location.hash.slice(1)).trim();
  if (!code) {
    set("present");
    return;
  }
  set("connecting");
  chrome.runtime.sendMessage({ type: "pair", code }, (res) => {
    // With the published and the dev extension both in this Chrome, each answers the page: the one that may not
    // pair here (refused) never takes the other's success away.
    if (res?.refused && html.dataset.mqState === "connected") return;
    if (chrome.runtime.lastError || !res) return set("failed", "The extension did not answer. Reload this page to try again.");
    if (!res.ok) return set("failed", res.message);
    set("connected");
  });
})();
