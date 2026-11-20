/**
 * Runs on messaging.quest. Someone Quest met in a thread or a message got a link with a code (`?i=<code>`): the landing
 * keeps it, and this hands it to the extension, so the chat in the popup starts as theirs, picking up where the thread
 * left off (the founder, 2026-11-15: "The onboarding starts even before you get the link or installed the extension: in
 * a public thread or DM"). It also says the extension is here, so the landing's one button can say "Open Quest".
 */
(() => {
  const code = (new URLSearchParams(location.search).get("i") || localStorage.getItem("questInvite") || "").trim();
  document.documentElement.dataset.questExtension = "1";
  document.dispatchEvent(new Event("quest-extension"));
  if (/^[A-Za-z0-9_-]{4,64}$/.test(code)) chrome.runtime.sendMessage({ type: "invite", code }).catch(() => undefined);
})();
