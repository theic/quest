import { describe, expect, it } from "vitest";
import { type NewsOptOut, UNSUBSCRIBE_PATH, unsubscribeRoutes } from "../src/http/unsubscribe-routes.ts";
import { silentLogger } from "../src/infra/system.ts";

const TOKEN = "0b6f3a52-1c7e-4c1a-9d0e-5f2a7b8c9d10";

/** One account, as mq.accounts holds it: its link's token, its email, and the opt-out. */
function accounts(optedOut = false): NewsOptOut & { optedOut: boolean } {
  const state = {
    optedOut,
    async byUnsubscribeToken(token: string) {
      return token === TOKEN ? { email: "dana@example.com", optedOut: state.optedOut } : null;
    },
    async optOut(token: string) {
      if (token !== TOKEN) return null;
      state.optedOut = true;
      return { email: "dana@example.com" };
    },
  };
  return state;
}

describe("unsubscribe links from v1's emails", () => {
  it("asks on a GET and records nothing, so a link scanner unsubscribes nobody", async () => {
    const store = accounts();
    const res = await unsubscribeRoutes({ accounts: store, log: silentLogger }).request(`${UNSUBSCRIBE_PATH}?t=${TOKEN}`);
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain("Stop product news?");
    expect(html).toContain(`action="${UNSUBSCRIBE_PATH}?t=${TOKEN}"`);
    expect(store.optedOut).toBe(false);
  });

  it("records the opt-out on the POST the button or a mail client's one-click sends", async () => {
    const store = accounts();
    const app = unsubscribeRoutes({ accounts: store, log: silentLogger });
    const res = await app.request(`${UNSUBSCRIBE_PATH}?t=${TOKEN}`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Unsubscribed");
    expect(store.optedOut).toBe(true);
    expect(await (await app.request(`${UNSUBSCRIBE_PATH}?t=${TOKEN}`)).text()).toContain("Already unsubscribed");
  });

  it("turns away a malformed or unknown token without touching anything", async () => {
    const store = accounts();
    const app = unsubscribeRoutes({ accounts: store, log: silentLogger });
    for (const t of ["", "not-a-token", "11111111-2222-3333-4444-555555555555"]) {
      expect((await app.request(`${UNSUBSCRIBE_PATH}?t=${t}`, { method: "POST" })).status).toBe(400);
    }
    expect(store.optedOut).toBe(false);
  });

  it("shows the address it read as text, never as markup", async () => {
    const store: NewsOptOut = {
      byUnsubscribeToken: async () => ({ email: '<img src=x onerror="alert(1)">@example.com', optedOut: false }),
      optOut: async () => null,
    };
    const html = await (await unsubscribeRoutes({ accounts: store, log: silentLogger }).request(`${UNSUBSCRIBE_PATH}?t=${TOKEN}`)).text();
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
});
