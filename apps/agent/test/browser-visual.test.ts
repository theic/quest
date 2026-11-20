import { AIMessage } from "@langchain/core/messages";
import { fakeModel } from "@langchain/core/testing";
import { MemorySaver } from "@langchain/langgraph";
import { HostGuard, customerId, type BrowserJob, type BrowserTransport, type BrowserView, type BrowserScreen, type ChromePost } from "@mq/core";
import { describe, expect, it, vi } from "vitest";
import { buildAgent } from "../src/agents/harness.ts";
import { BrowserPoster } from "../src/chrome/browser-poster.ts";
import { browserAction, browserActionSchema, CustomerBrowser, browserTools } from "../src/chrome/browser.ts";
import type { BrowserVisionPort } from "../src/chrome/browser-vision.ts";

const ID = customerId("visual-test");
const IMAGE = "data:image/png;base64,dGVzdC1pbWFnZQ==";
const picture = (id: string): BrowserScreen => ({ id, image: IMAGE, width: 1200, height: 800 });
const draft: Extract<ChromePost, { platform: "browser" }> = { platform: "browser", kind: "message", url: "https://workspace.example.org/alex", target: "Alex", title: null, text: "Hello from Quest." };
const call = (name: string, args: Record<string, unknown>, id: string) => new AIMessage({ content: "", tool_calls: [{ name, args, id }] });
class PicturedWorkspace implements BrowserTransport {
  jobs: BrowserJob[] = [];
  submitted = 0;
  async browser(_id: unknown, job: BrowserJob): Promise<BrowserView> {
    this.jobs.push(job);
    if (job.action.kind === "click_point") this.submitted++;
    return { url: draft.url, title: "Opaque workspace", text: "", controls: [], ...(job.action.kind !== "close" ? { screen: picture(this.submitted ? "sent" : "prepared") } : {}) };
  }
}
const vision = (): BrowserVisionPort => ({ read: async () => "Visible words", navigate: async () => false, prepared: async () => true, receipt: async () => true, toggle: async () => true });
const makeBrowser = (w: BrowserTransport, v: BrowserVisionPort) => new CustomerBrowser(w, new HostGuard({ resolve: async () => ["8.8.8.8"], unresolved: "refuse" }), v);
const model = () => fakeModel().respond(call("publish", { screen: "prepared", x: "100", y: "100" }, "send")).respond(call("publish", { screen: "sent", x: 100, y: 100 }, "duplicate")).respond(call("confirm_visual", { screen: "sent" }, "receipt")).respond(new AIMessage("Done."));
describe("pictured posting and reading", () => {
  it("normalizes decimal pixel strings without accepting arbitrary coercions", () => {
    expect(browserAction(browserActionSchema.parse({ kind: "click_point", screen: "s", x: "438", y: "413.5" }))).toMatchObject({ x: 438, y: 413.5 });
    for (const x of [null, true, "", "1e8", "10001", "1+2", Infinity, -1]) expect(browserActionSchema.safeParse({kind:"click_point",screen:"s",x,y:1}).success).toBe(false);
  });
  it("publishes once without DOM controls after independent preflight and receipt checks", async () => {
    const w = new PicturedWorkspace(); const v = vision();
    const prepared = vi.spyOn(v, "prepared"); const receipt = vi.spyOn(v, "receipt");
    const m = model();
    const poster = new BrowserPoster({ browser: makeBrowser(w, v), reddit: { post: async () => { throw new Error("Not Reddit"); } }, models: { modelFor: () => m }, vision: v });
    expect(await poster.post(ID, draft)).toEqual({ url: draft.url, account: "connected account" });
    expect(w.submitted).toBe(1);
    expect(prepared).toHaveBeenCalledWith(picture("prepared"), draft, expect.objectContaining({ kind: "click_point" }));
    expect(receipt).toHaveBeenCalledWith(picture("sent"), draft, picture("prepared"));
    expect(w.jobs.at(-1)?.action.kind).toBe("close");
  });
  it("holds a send whose separate visual verifier cannot prove delivery", async () => {
    const w = new PicturedWorkspace(); const v = { ...vision(), receipt: async () => false };
    const b = makeBrowser(w, v);
    const poster = new BrowserPoster({ browser: b, reddit: { post: async () => ({ url: "", account: "" }) }, models: { modelFor: model }, vision: v });
    await expect(poster.post(ID, draft)).rejects.toMatchObject({ reason: "uncertain" });
    expect(w.submitted).toBe(1);
    // Its tab closes all the same: what may have gone up is looked at later in a tab of its own (HeldCheck).
    expect(w.jobs.at(-1)?.action.kind).toBe("close");
    expect(b.screen(ID, w.jobs[0]!.session)).toBeUndefined();
  });
  it("rejects unverified recipients before clicking and expires picture refs", async () => {
    const w = new PicturedWorkspace(); const v = { ...vision(), prepared: async () => false };
    const b = makeBrowser(w, v);
    const poster = new BrowserPoster({ browser: b, reddit: { post: async () => ({ url: "", account: "" }) }, models: { modelFor: model }, vision: v });
    await expect(poster.post(ID, draft)).rejects.toMatchObject({ reason: "unavailable" });
    expect(w.submitted).toBe(0);
    await b.open(ID, "read", draft.url);
    await expect(b.act(ID, "read", { kind: "click_point", screen: "old", x: 1, y: 1 })).rejects.toMatchObject({ reason: "refused" });
    const tools = Object.fromEntries(browserTools(b, ID, undefined, "read").map(t => [t.name, t]));
    expect(await tools["browser_act"]!.invoke({ kind: "type_text", screen: "prepared", text: draft.text })).toContain("recorded publisher");
    expect(await tools["read_visual"]!.invoke({})).toContain("Visible words");
    expect(await tools["read_visual"]!.invoke({})).not.toContain(IMAGE);
  });
  it("recovers from a stale picture id instead of giving up the post (X, live 2026-10-13)", async () => {
    // X's composer: a click on its editor re-renders the page with no picture, and the model typed by the one it took before.
    const post: Extract<ChromePost, { platform: "browser" }> = { platform: "browser", kind: "post", url: "https://x.com/compose/post", target: "@dana_builds", title: null, text: "This was posted by messaging.quest" };
    class Composer implements BrowserTransport {
      jobs: BrowserJob[] = [];
      submitted = 0;
      shots = 0;
      async browser(_id: unknown, job: BrowserJob): Promise<BrowserView> {
        this.jobs.push(job);
        if (job.action.kind === "click_point") this.submitted++;
        const pictured = ["screenshot", "click_point", "type_text", "press_focused"].includes(job.action.kind);
        return {
          url: post.url, title: "Post / X", text: "", controls: [{ ref: "0:editor", role: "textbox", label: "Post text", value: "", href: null }],
          ...(pictured ? { screen: picture(this.submitted ? "sent" : `p${++this.shots}`) } : {}),
        };
      }
    }
    const w = new Composer();
    const m = fakeModel()
      .respond(call("prepare", { kind: "screenshot" }, "s1"))
      .respond(call("prepare", { kind: "click", ref: "0:editor" }, "focus"))
      .respond(call("prepare", { kind: "type_text", screen: "p1", text: post.text }, "stale"))
      .respond(call("prepare", { kind: "screenshot" }, "s2"))
      .respond(call("prepare", { kind: "type_text", screen: "p2", text: post.text }, "type"))
      .respond(call("publish", { screen: "p3", x: 900, y: 300 }, "send"))
      .respond(call("confirm_visual", { screen: "sent" }, "receipt"))
      .respond(new AIMessage("Posted."));
    const poster = new BrowserPoster({ browser: makeBrowser(w, vision()), reddit: { post: async () => { throw new Error("Not Reddit"); } }, models: { modelFor: () => m }, vision: vision() });

    expect(await poster.post(ID, post)).toEqual({ url: post.url, account: "connected account" });
    expect(w.submitted).toBe(1);
    // The stale try reached nobody: refused before the extension, and the model was told which picture is current.
    expect(w.jobs.filter((j) => j.action.kind === "type_text").map((j) => "screen" in j.action && j.action.screen)).toEqual(["p2"]);
    expect(JSON.stringify(m.calls)).toContain("Not done, nothing was sent: That picture is stale: the page changed after it was taken, and no picture shows it yet.");
  });
  it("holds no draft for a send it never made: a stale button is checked before the send", async () => {
    const w = new PicturedWorkspace();
    const m = fakeModel().respond(call("publish", { ref: "gone" }, "send")).respond(new AIMessage("Could not send."));
    const poster = new BrowserPoster({ browser: makeBrowser(w, vision()), reddit: { post: async () => ({ url: "", account: "" }) }, models: { modelFor: () => m }, vision: vision() });
    await expect(poster.post(ID, draft)).rejects.toMatchObject({ reason: "unavailable" });
    expect(w.submitted).toBe(0);
    expect(JSON.stringify(m.calls)).toContain("That control is stale. Inspect the page again, then publish with a current ref.");
  });
  it("names the current picture when a reader acts by an old one", async () => {
    const b = makeBrowser(new PicturedWorkspace(), vision());
    await b.open(ID, "read", draft.url);
    await expect(b.act(ID, "read", { kind: "click_point", screen: "old", x: 1, y: 1 })).rejects.toThrow("The current picture is prepared, the one you see now");
  });
  it("sends pictures in model requests without saving them in graph checkpoints", async () => {
    const m = fakeModel().respond(new AIMessage("I see the page."));
    const saver = new MemorySaver();
    const a = buildAgent({ name: "visual", model: m, systemPrompt: "Read this page.", tools: [], stepBudget: 2, scratch: false, images: () => [picture("current")] }, saver);
    const config = { configurable: { thread_id: "visual-privacy" } };
    const result = await a.invoke({ messages: [{ role: "user", content: "Read." }] }, config);
    expect(JSON.stringify(m.calls)).toContain(IMAGE);
    expect(JSON.stringify(result)).not.toContain(IMAGE);
    expect(JSON.stringify(await saver.getTuple(config))).not.toContain(IMAGE);
  });
});
