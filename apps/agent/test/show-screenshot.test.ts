import { HostGuard, type BrowserJob, type BrowserTransport, type BrowserView } from "@mq/core";
import { describe, expect, it } from "vitest";
import { CustomerBrowser } from "../src/chrome/browser.ts";
import { managerPrompt } from "../src/manager/prompt.ts";
import { managerTools, PICTURES_A_TURN } from "../src/manager/tools.ts";
import { makeWorld, telegramSender } from "./world.ts";

/** A page that is pictured whenever it is asked for a screenshot. */
class Page implements BrowserTransport {
  async browser(_customer: unknown, job: BrowserJob): Promise<BrowserView> {
    const screen = job.action.kind === "screenshot" ? { screen: { id: "shot-1", image: `data:image/jpeg;base64,${Buffer.from("jpeg bytes").toString("base64")}`, width: 800, height: 450 } } : {};
    return { url: "https://www.google.com/", title: "Google", text: "Search", controls: [], ...screen };
  }
}

async function setUp() {
  const world = makeWorld();
  const c = await world.customers.create({ channel: telegramSender().channel, userRef: "42", displayName: "Dana", language: "en" });
  const browser = new CustomerBrowser(new Page(), new HostGuard({ resolve: async () => ["8.8.8.8"], unresolved: "refuse" }));
  const tools = Object.fromEntries(
    managerTools({ ...world, customerId: c.id, userTurn: true, customers: world.customers, now: world.clock.now, browser, browserSession: "manager:test" }).map((t) => [t.name, t]),
  );
  const call = (name: string, args: Record<string, unknown> = {}) => tools[name]!.invoke(args) as Promise<string>;
  return { world, c, call };
}

describe("showing them a screenshot", () => {
  it("sends the picture it took to their chat, and notes it on the transcript", async () => {
    const { world, c, call } = await setUp();
    expect(await call("show_screenshot")).toMatch(/^Not sent: no screenshot/);
    expect(world.channel.photos).toHaveLength(0);

    await call("browser_open", { url: "https://www.google.com/" });
    await call("browser_act", { kind: "screenshot" });
    expect(await call("show_screenshot", { caption: "Google, as Quest sees it" })).toBe("Sent: the picture is in their chat now.");

    expect(world.channel.photos).toHaveLength(1);
    expect(Buffer.from(world.channel.photos[0]!.jpeg).toString()).toBe("jpeg bytes");
    expect(world.channel.photos[0]!.caption).toBe("Google, as Quest sees it");
    const said = (await world.transcript.recent(c.id, 5)).map((e) => e.text);
    expect(said).toContain("📷 a screenshot of www.google.com: Google, as Quest sees it");
  });

  it("sends a few at most in a turn", async () => {
    const { world, call } = await setUp();
    await call("browser_open", { url: "https://www.google.com/" });
    await call("browser_act", { kind: "screenshot" });
    for (let i = 0; i < PICTURES_A_TURN; i++) expect(await call("show_screenshot")).toMatch(/^Sent/);
    expect(await call("show_screenshot")).toMatch(/^Not sent: \d pictures this turn/);
    expect(world.channel.photos).toHaveLength(PICTURES_A_TURN);
  });

  it("tells the manager to send pictures with it, and to look up their name on a site before asking which is theirs", () => {
    const prompt = managerPrompt("");
    expect(prompt).toContain("send it with show_screenshot");
    expect(prompt).toContain("never by asking for their handle");
    expect(prompt).toContain("Only when the site cannot tell you");
    expect(prompt).toContain("is dana_k you?");
  });
});
