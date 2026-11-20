import { createServer, get, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { miniAppGate, tunnelAddress } from "../../../scripts/dev-tunnel.ts";

const closing: (() => void)[] = [];
afterEach(() => {
  for (const close of closing.splice(0)) close();
});

/** A stand-in for the dev agent: answers every path with what it was asked. */
async function agent(): Promise<number> {
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ method: req.method, path: req.url, body })));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  closing.push(() => server.close());
  return (server.address() as AddressInfo).port;
}

describe("the dev bot's Mini App tunnel", () => {
  it("carries the Mini App to the agent, and nothing else", async () => {
    const agentPort = await agent();
    const gate = await miniAppGate(agentPort);
    closing.push(gate.close);
    const ask = (path: string, init?: RequestInit) => fetch(`${gate.url}${path}`, init);

    expect(await (await ask("/glass")).json()).toEqual({ method: "GET", path: "/glass", body: "" });
    const signed = await ask("/glass/data", { method: "POST", body: JSON.stringify({ initData: "signed" }) });
    expect(await signed.json()).toEqual({ method: "POST", path: "/glass/data", body: '{"initData":"signed"}' });
    for (const path of ["/glass/data", "/glass/power", "/glass/front", "/i18n/browser.js", "/i18n/locales/uk.json"]) expect((await ask(path, { method: path.startsWith("/glass") ? "POST" : "GET" })).status, path).toBe(200);

    // The extension's routes, CHROME_DEBUG's unsigned reader, the webhook and the wake stay on this computer.
    for (const path of ["/chrome/next", "/debug/chrome/read", "/telegram", "/wake", "/health", "/plan/x/checkout", "/", "/glassy", "/glass/data/x"]) {
      expect((await ask(path)).status, path).toBe(404);
    }
    // The pages a chat button opens go back to this computer, where the extension's connect script runs.
    for (const path of ["/connect", "/chrome", "/plan/c0ffee.sig-n_1"]) {
      const sent = await ask(`${path}?x=1`, { redirect: "manual" });
      expect([sent.status, sent.headers.get("location")], path).toEqual([302, `http://localhost:${agentPort}${path}?x=1`]);
    }
    expect((await ask("/plan/x/checkout", { method: "POST" })).status).toBe(404);
    expect((await ask("/glass", { method: "PUT" })).status).toBe(404);
    // Sent as written (fetch would resolve the dots first): the gate reads a path as the agent would.
    for (const path of ["/i18n/../debug/chrome/read", "/glass/%2e%2e/debug/chrome/read", "/i18n/%2E%2E/chrome/next"]) {
      const status = await new Promise<number>((resolve, reject) => get(`${gate.url}${path}`, (res) => (res.resume(), resolve(res.statusCode ?? 0))).on("error", reject));
      expect(status, path).toBe(404);
    }
  });

  it("answers 502 while the agent is not up yet", async () => {
    const port = await agent();
    closing.splice(0).forEach((close) => close());
    const gate = await miniAppGate(port);
    closing.push(gate.close);
    expect((await fetch(`${gate.url}/glass`)).status).toBe(502);
  });

  it("reads the tunnel's address from cloudflared's log", () => {
    const log = [
      "2026-10-23T09:00:00Z INF Requesting new quick Tunnel on trycloudflare.com...",
      "2026-10-23T09:00:02Z INF +--------------------------------------------------------------------------------------------+",
      "2026-10-23T09:00:02Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |",
      "2026-10-23T09:00:02Z INF |  https://quiet-river-sample-words.trycloudflare.com                                        |",
    ].join("\n");
    expect(tunnelAddress(log)).toBe("https://quiet-river-sample-words.trycloudflare.com");
    expect(tunnelAddress("INF Requesting new quick Tunnel on trycloudflare.com...")).toBeNull();
  });
});
