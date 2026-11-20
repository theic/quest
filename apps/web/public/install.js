import { ready, t } from "/i18n/browser.js";
// Plan B (index.html, #install): the extension from a zip. The page's buttons open and close the dialog with
// commandfor, which Chrome knows; this opens it in a browser that does not. It copies the chrome://extensions
// address (a page cannot link to it) and the prompt, and puts the prompt, in the page's language, into the
// ChatGPT and Claude links.

const dialog = document.querySelector("#install");

if (dialog) {
  if (!("commandForElement" in HTMLButtonElement.prototype)) {
    document.addEventListener("click", (event) => {
      const button = event.target.closest?.('button[commandfor="install"]');
      if (!button) return;
      if (button.getAttribute("command") === "close") dialog.close();
      else dialog.showModal();
    });
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close(); // the backdrop, where closedby="any" is not known either
    });
  }

  const prompt = dialog.querySelector(".install-prompt");
  const aim = () => {
    for (const link of dialog.querySelectorAll("a[data-ask]")) link.href = link.dataset.ask + encodeURIComponent(prompt.textContent.trim());
  };
  await ready;
  aim();
  document.addEventListener("languagechange", aim);

  const copied = async (button, text) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return; // the text is on the page to select by hand
    }
    const label = button.innerHTML;
    button.textContent = t("Copied");
    setTimeout(() => { button.innerHTML = label; }, 1600);
  };
  for (const button of dialog.querySelectorAll("[data-copy], [data-copy-from]")) {
    button.addEventListener("click", () => {
      const from = button.dataset.copyFrom && dialog.querySelector(button.dataset.copyFrom);
      void copied(button, from ? from.textContent.trim() : button.dataset.copy);
    });
  }
}
