// Asks Chrome for the microphone once, for the popup's voice messages: a popup cannot show Chrome's prompt itself.
(async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    document.getElementById("head").textContent = "Done";
    document.getElementById("say").textContent = "Open Quest again and press the mic. This tab closes by itself.";
    setTimeout(() => window.close(), 2500);
  } catch {
    document.getElementById("head").textContent = "The microphone is blocked";
    document.getElementById("say").textContent = "Allow it with the icon at the right of the address bar, then reload this page.";
  }
})();
