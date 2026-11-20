// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://community.example.org/topic/42"}
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Outcome } from "../../agent/src/http/chrome-outcome.ts";
import { browserPage, domQuiet, scrollPage } from "../src/browser-page.js";

beforeEach(() => {
  // happy-dom has no layout. Real Chrome supplies these rectangles.
  vi.spyOn(Element.prototype, "getClientRects").mockReturnValue([{ width: 100, height: 20, top: 0, bottom: 20, left: 0, right: 100 }] as never);
  document.body.innerHTML = "";
});
afterEach(() => vi.restoreAllMocks());
const control = (name: string) => browserPage().controls!.find((c: { label: string }) => c.label === name)!;

describe("browser controls without a platform adapter", () => {
  it("fills a forum's controlled editor and sends through its ordinary UI", () => {
    document.body.innerHTML = '<p>Looking for a form builder</p><label for="reply">Reply</label><textarea id="reply"></textarea><button>Post reply</button><section id="thread"></section>';
    const editor = document.querySelector("textarea")!;
    let input = "";
    editor.addEventListener("input", () => { input = editor.value; });
    document.querySelector("button")!.addEventListener("click", () => { document.querySelector("section")!.textContent = editor.value; editor.value = ""; });
    expect(browserPage({ kind: "fill", ref: control("Reply").ref, text: "I build a simpler form tool." })).toEqual({ acted: true });
    expect(input).toBe("I build a simpler form tool.");
    expect(browserPage().text).not.toContain(input);
    expect(browserPage({ kind: "click", ref: control("Post reply").ref })).toEqual({ acted: true });
    expect(browserPage().text).toContain(input);
  });

  it("supports a messenger rich-text composer in an open shadow root", () => {
    document.body.innerHTML = '<chat-composer></chat-composer>';
    const root = document.querySelector("chat-composer")!.attachShadow({ mode: "open" });
    root.innerHTML = '<div role="textbox" contenteditable="true" aria-label="Message"></div><button>Send</button>';
    const ref = control("Message").ref;
    browserPage({ kind: "fill", ref, text: "Hello Alex\nHere is the link you asked for." });
    expect(root.querySelector("div")!.textContent).toBe("Hello Alex\nHere is the link you asked for.");
    expect(browserPage().controls!.find((c: { label: string }) => c.label === "Message")?.value).toContain("Hello Alex");
  });

  it("leaves a rich editor to trusted input, and still fills a plain field itself", () => {
    // Live, 2026-10-14: a DOM edit under X's Draft.js composer tripled the link it posted.
    document.body.innerHTML = '<div role="textbox" contenteditable="true" aria-label="Post text"><p>old words</p></div><textarea aria-label="Title"></textarea>';
    expect(browserPage({ kind: "fill", ref: control("Post text").ref, text: "Free, messaging.quest", trusted: true })).toEqual({ acted: true, type: true });
    expect(document.querySelector("div")!.textContent).toBe("old words");
    expect(document.activeElement).toBe(document.querySelector("div"));
    expect(browserPage({ kind: "fill", ref: control("Title").ref, text: "A title", trusted: true })).toEqual({ acted: true });
    expect(document.querySelector("textarea")!.value).toBe("A title");
  });

  it("tells a field's limit, and types nothing into a field too short for the words", () => {
    // Live, 2026-10-15: X's bio takes 160 characters. A script's value skips maxlength, so 174 went in and never saved.
    document.body.innerHTML = '<label for="bio">Bio</label><textarea id="bio" maxlength="160">Experienced software engineer.</textarea><input aria-label="Search">';
    expect(control("Bio").limit).toBe(160);
    expect(control("Search").limit).toBeUndefined();
    expect(browserPage({ kind: "fill", ref: control("Bio").ref, text: "x".repeat(174) })).toEqual({ error: "refused", message: "This field takes at most 160 characters, and the words have 174. Nothing was typed." });
    expect(document.querySelector("textarea")!.value).toBe("Experienced software engineer.");
    expect(browserPage({ kind: "fill", ref: control("Bio").ref, text: "Messaging Quest\nmessaging.quest" })).toEqual({ acted: true });
    expect(document.querySelector("textarea")!.value).toBe("Messaging Quest\nmessaging.quest");
  });

  it("rejects stale references and replaced controls rather than clicking the wrong recipient", () => {
    document.body.innerHTML = '<button>Send to Alex</button>';
    const ref = control("Send to Alex").ref;
    document.querySelector("button")!.textContent = "Send to someone else";
    expect(browserPage({ kind: "click", ref }).error).toBe("stale");
    const fresh = control("Send to someone else").ref;
    browserPage();
    expect(browserPage({ kind: "click", ref: fresh }).error).toBe("stale");
  });

  it("never exposes or fills password, OTP or payment fields", () => {
    document.body.innerHTML = '<input type="password" value="secret"><input autocomplete="one-time-code" value="123456"><input autocomplete="cc-number" value="1234">';
    const view = browserPage();
    expect(JSON.stringify(view)).not.toMatch(/secret|123456|1234/);
    expect(browserPage({ kind: "fill", ref: view.controls![0]!.ref, text: "another" }).error).toBe("refused");
  });

  it("fills an email's recipient, subject and same-origin frame editor, then uses its Send button", () => {
    document.body.innerHTML = '<label for="to">To</label><input id="to" type="email"><label for="subject">Subject</label><input id="subject"><iframe></iframe><button>Send email</button><article></article>';
    const frame = document.querySelector("iframe")!;
    const doc = frame.contentDocument!;
    const win = frame.contentWindow as unknown as { Element: typeof Element };
    vi.spyOn(win.Element.prototype, "getClientRects").mockReturnValue([{ width: 100, height: 20, top: 0, bottom: 20, left: 0, right: 100 }] as never);
    doc.body.innerHTML = '<div contenteditable="true" aria-label="Email body"></div>';
    browserPage({ kind: "fill", ref: control("To").ref, text: "alex@example.org" });
    browserPage({ kind: "fill", ref: control("Subject").ref, text: "Your forms question" });
    browserPage({ kind: "fill", ref: control("Email body").ref, text: "Here is the tool you asked for." });
    expect(document.querySelector<HTMLInputElement>("#to")!.value).toBe("alex@example.org");
    expect(document.querySelector<HTMLInputElement>("#subject")!.value).toBe("Your forms question");
    document.querySelector("button")!.addEventListener("click", () => { document.querySelector("article")!.textContent = doc.body.textContent; doc.querySelector("div")!.textContent = ""; });
    browserPage({ kind: "click", ref: control("Send email").ref });
    expect(browserPage().text).toContain("Here is the tool you asked for.");
  });

  it("exposes native select options and rejects an unavailable choice", () => {
    document.body.innerHTML = '<label for="category">Category</label><select id="category"><option value="questions">Questions</option><option value="showcase">Showcase</option></select>';
    expect(control("Category").options).toEqual([{ value: "questions", label: "Questions" }, { value: "showcase", label: "Showcase" }]);
    expect(browserPage({ kind: "select", ref: control("Category").ref, value: "missing" }).error).toBe("stale");
    browserPage({ kind: "select", ref: control("Category").ref, value: "showcase" });
    expect(document.querySelector<HTMLSelectElement>("select")!.value).toBe("showcase");
  });

  it("tells which post a control acts on, a toggle's state, and an icon button by the picture inside it", () => {
    // A feed's Like buttons all say "Like": only the post they sit in tells them apart.
    document.body.innerHTML =
      '<article><p>Ari: got our first 5 customers</p><button aria-pressed="true"><svg aria-label="Liked"></svg></button></article>' +
      '<article><p>Bob: congrats, what worked?</p><button aria-label="Like" aria-pressed="false"></button></article><button>Post</button>';
    const view = browserPage();
    expect(view.items).toEqual(["Ari: got our first 5 customers", "Bob: congrats, what worked?"]);
    expect(view.controls!.map((c: { label: string; pressed?: boolean; item?: number }) => [c.label, c.pressed, c.item])).toEqual([
      ["Liked", true, 0],
      ["Like", false, 1],
      ["Post", undefined, undefined],
    ]);
    expect(view.scroll).toMatchObject({ y: 0 });
    expect(typeof view.loading).toBe("boolean");
    const controls = view.controls!.map((c: object & { ref: string }) => ({ ...c, ref: `0:${c.ref}` }));
    expect(Outcome.safeParse({ ok: true, view: { url: view.url, title: view.title, text: view.text, controls, items: view.items, scroll: view.scroll, loading: view.loading } }).success).toBe(true);
  });

  it("reads the words below the screen too, and offers controls only on it", () => {
    vi.spyOn(Element.prototype, "getClientRects").mockImplementation(function (this: Element) {
      const top = this.closest?.("#far") ? 2000 : 0;
      return [{ width: 100, height: 20, top, bottom: top + 20, left: 0, right: 100 }] as never;
    });
    document.body.innerHTML = '<p>On screen</p><section id="far"><p>Further down the thread</p><button>Reply below</button></section>';
    const view = browserPage();
    expect(view.text).toContain("Further down the thread");
    expect(view.controls!.map((c: { label: string }) => c.label)).not.toContain("Reply below");
  });

  it("waits for a page to stop changing, and scrolls what scrolls it", async () => {
    document.body.innerHTML = "<div id='feed'></div>";
    const feed = document.getElementById("feed")!;
    let n = 0;
    const timer = setInterval(() => { if (n++ < 3) feed.append(document.createElement("p")); }, 30);
    const waited = await domQuiet(2000, 150);
    clearInterval(timer);
    expect(waited).toBeGreaterThanOrEqual(150);
    expect(waited).toBeLessThan(2000);
    expect(await scrollPage("down", 50)).toMatchObject({ grew: false });
  });

  it("answers within what the agent accepts on a page with an overlong title, role and option", () => {
    // One field over the agent's limit and the whole view was refused, so the session could not go on.
    document.title = "T".repeat(3000);
    document.body.innerHTML = `<a href="/go" role="${"link ".repeat(40)}">Go</a><label for="plan">Plan</label><select id="plan"><option value="a">A</option><option value="${"v".repeat(1200)}">Long</option></select>`;

    const view = browserPage();

    expect(view.title).toHaveLength(1000);
    expect(control("Plan").options).toEqual([{ value: "a", label: "A" }]);
    expect(control("Go").role.length).toBeLessThanOrEqual(100);
    const controls = view.controls!.map((c: object & { ref: string }) => ({ ...c, ref: `0:${c.ref}` }));
    expect(Outcome.safeParse({ ok: true, view: { url: view.url, title: view.title, frames: [view.url], text: view.text, controls } }).success).toBe(true);
  });
});

describe("attaching one of their pictures", () => {
  it("puts it in the file field of the composer whose add-photo control it was given, and sends nothing", async () => {
    document.body.innerHTML = '<input type="file" accept="image/*" id="avatar"><div role="dialog"><button aria-label="Add photos or video">+</button><input type="file" accept="image/jpeg,image/png,video/mp4" id="media" hidden><div role="textbox" contenteditable="true" aria-label="Post text"></div></div>';
    const { attachFile } = await import("../src/browser-page.js");
    const media = document.querySelector<HTMLInputElement>("#media")!;
    let changed = 0;
    media.addEventListener("change", () => changed++);
    expect(attachFile({ ref: control("Add photos or video").ref, name: "launch.jpg", type: "image/jpeg", data: btoa("\xff\xd8\xff") })).toEqual({ acted: true });
    expect(changed).toBe(1);
    expect(media.files?.[0]?.name).toBe("launch.jpg");
    expect(document.querySelector<HTMLInputElement>("#avatar")!.files?.length ?? 0).toBe(0);
  });

  it("refuses where nothing takes the file, and a stale control", async () => {
    const { attachFile } = await import("../src/browser-page.js");
    document.body.innerHTML = '<input type="file" accept=".pdf"><button>Post</button>';
    expect(attachFile({ ref: null, name: "launch.jpg", type: "image/jpeg", data: btoa("x") })).toMatchObject({ error: "refused" });
    expect(attachFile({ ref: "old:1", name: "launch.jpg", type: "image/jpeg", data: btoa("x") })).toMatchObject({ error: "stale" });
  });
});
