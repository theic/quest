// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { focusedSensitive, released, trustedFill, visualAllowed, visualInput } from "../src/browser-visual.js";

const shot = () => ({ id: "current", width: 1200, height: 800, viewportWidth: 600, viewportHeight: 400, at: Date.now() });
function debuggerApi() {
  return { attach: vi.fn(async () => undefined), detach: vi.fn(async () => undefined), sendCommand: vi.fn(async (_target, method, _params?: any) => method === "Page.getLayoutMetrics" ? { cssVisualViewport: { clientWidth: 600, clientHeight: 400 } } : {}) };
}
describe("trusted input in the task tab", () => {
  // Each test starts with the tab not held, as after Chrome took the debugger off it.
  beforeEach(() => released(42));
  it("supports canvas keyboard events without typing a submission key", async () => {
    const api = debuggerApi();
    await visualInput(api, 42, {kind:"type_text",screen:"current",text:"Hi!",method:"keys"}, shot());
    expect(api.sendCommand).toHaveBeenCalledWith({tabId:42}, "Input.dispatchKeyEvent", {type:"keyDown",key:"H",text:"H"});
    await expect(visualInput(api, 42, {kind:"type_text",screen:"current",text:"Hi\nSend",method:"keys"}, shot())).rejects.toThrow("control characters");
    expect(api.sendCommand).not.toHaveBeenCalledWith({tabId:42}, "Input.dispatchKeyEvent", expect.objectContaining({key:"Enter"}));
  });
  it("maps pictured pixels to CSS coordinates, and stays on the tab for the next step", async () => {
    const api = debuggerApi();
    await visualInput(api, 42, { kind: "click_point", screen: "current", x: 400, y: 200 }, shot());
    expect(api.attach).toHaveBeenCalledWith({ tabId: 42 }, "1.3");
    expect(api.sendCommand).toHaveBeenCalledWith({ tabId: 42 }, "Input.dispatchMouseEvent", expect.objectContaining({ type: "mouseReleased", x: 200, y: 100 }));
    expect(api.detach).not.toHaveBeenCalled();
    // The next step finds it on: no new attach, so Chrome's bar never comes and goes between a picture and a press.
    await visualInput(api, 42, { kind: "click_point", screen: "current", x: 400, y: 200 }, shot());
    expect(api.attach).toHaveBeenCalledTimes(1);
  });
  it("refuses stale pictures, changed viewports and points outside the tab", async () => {
    const api = debuggerApi();
    await expect(visualInput(api, 42, { kind: "click_point", screen: "old", x: 1, y: 1 }, shot())).rejects.toThrow("expired");
    expect(api.attach).not.toHaveBeenCalled();
    await expect(visualInput(api, 42, { kind: "click_point", screen: "current", x: 1200, y: 1 }, shot())).rejects.toThrow("outside");
    await expect(visualInput(api, 42, { kind: "click_point", screen: "current", x: 1, y: 1 }, { ...shot(), viewportWidth: 800 })).rejects.toThrow("viewport changed");
  });
  it("fills a focused rich editor the way a paste arrives, over what was there", async () => {
    const api = debuggerApi();
    await trustedFill(api, 42, "Free, messaging.quest");
    expect(api.sendCommand.mock.calls.map(([, method, params]) => [method, params?.commands ?? params?.text])).toEqual([
      ["Input.dispatchKeyEvent", ["selectAll"]],
      ["Input.dispatchKeyEvent", undefined],
      ["Input.insertText", "Free, messaging.quest"],
    ]);
  });
  it("lets the tab go a while after its last step, failed or not", async () => {
    vi.useFakeTimers();
    try {
      const api = debuggerApi();
      api.sendCommand.mockImplementation(async (_target, method) => { if (method === "Page.getLayoutMetrics") return { cssVisualViewport: { clientWidth: 600, clientHeight: 400 } }; throw new Error("Input failed"); });
      const failed = expect(visualInput(api, 42, { kind: "press_focused", screen: "current", key: "Enter" }, shot())).rejects.toThrow("Input failed");
      await vi.advanceTimersByTimeAsync(400);
      await failed;
      expect(api.detach).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(90_000);
      expect(api.detach).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
});

describe("what visual typing will not type into", () => {
  it("knows a focused password, one-time code, card or file field, also inside a shadow root", () => {
    const focus = (html: string, inShadow = false) => {
      document.body.innerHTML = "";
      const host = document.createElement("div");
      document.body.append(host);
      const root = inShadow ? host.attachShadow({ mode: "open" }) : host;
      root.innerHTML = html;
      (root.querySelector("input, textarea, div") as HTMLElement).focus();
      return focusedSensitive();
    };
    expect(focus('<input type="password">')).toBe(true);
    expect(focus('<input autocomplete="one-time-code">')).toBe(true);
    expect(focus('<input autocomplete="billing cc-number">')).toBe(true);
    expect(focus('<input type="file">')).toBe(true);
    expect(focus('<input type="password">', true)).toBe(true);
    expect(focus('<input type="text" placeholder="Message">')).toBe(false);
    expect(focus("<textarea></textarea>")).toBe(false);
    expect(focus('<div contenteditable="true" tabindex="0"></div>')).toBe(false);
  });
});

describe("the visual browser controls switch", () => {
  it("is on until they turn it off", () => {
    expect(visualAllowed({ visual: undefined })).toBe(true); // never touched the switch
    expect(visualAllowed({ visual: true })).toBe(true);
    expect(visualAllowed({ visual: false })).toBe(false);
  });

  it("has the debugger permission from install: Chrome refuses it as an optional permission", () => {
    const manifest = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "manifest.json"), "utf8"));
    expect(manifest.permissions).toContain("debugger");
    // The ones Chrome never grants as optional (developer.chrome.com, chrome.permissions).
    const neverOptional = ["debugger", "declarativeNetRequest", "devtools", "geolocation", "mdns", "proxy", "tts", "ttsEngine", "wallpaper"];
    expect((manifest.optional_permissions ?? []).filter((p: string) => neverOptional.includes(p))).toEqual([]);
  });
});
