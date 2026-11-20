import type { Logger } from "@mq/core";
import { Hono, type Context } from "hono";

/** What the route needs from the accounts (infra/pg-accounts.ts). */
export interface NewsOptOut {
  byUnsubscribeToken(token: string): Promise<{ email: string; optedOut: boolean } | null>;
  optOut(token: string): Promise<{ email: string } | null>;
}

/** The path v1's emails put in their unsubscribe links; messaging.quest passes it on to the agent. */
export const UNSUBSCRIBE_PATH = "/api/broadcast/unsubscribe";

const TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const esc = (s: string): string =>
  s.replace(/[<>&"]/g, (ch) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[ch] ?? ch);

const NOTHING_ELSE = "Messaging Quest now works in Telegram and sends nothing else to this address.";

function page(heading: string, line: string, form?: string): string {
  const button = form ? `<form method="post" action="${form}"><button type="submit">Unsubscribe me</button></form>` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${heading}</title><style>
:root{color-scheme:dark}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0c0b;color:#e8e8dc;
  font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:24px}
.card{max-width:420px;text-align:center;border:1px solid #2a2c28;border-radius:16px;padding:32px}
h1{font-size:20px;margin:0 0 8px}p{color:#c2c3b9;font-size:14px;line-height:1.5;margin:0 0 20px;word-break:break-word}
button{background:#ceff32;color:#0b0c0b;border:0;border-radius:10px;padding:11px 20px;font-weight:600;font-size:14px;cursor:pointer}
a{color:#ceff32}
</style></head><body><div class="card"><h1>${heading}</h1><p>${line}</p>${button}
<p><a href="https://www.messaging.quest/">messaging.quest</a></p></div></body></html>`;
}

/**
 * Unsubscribe links from the emails v1 sent. The token in the link is the capability, so there is
 * no sign-in. GET only asks and POST records it (also what a mail client's one-click unsubscribe,
 * RFC 8058, sends): a scanner that opens every link in an email unsubscribes nobody.
 */
export function unsubscribeRoutes(deps: { accounts: NewsOptOut; log: Logger }): Hono {
  const app = new Hono();
  const invalid = (c: Context) => c.html(page("Invalid link", "This unsubscribe link is not valid."), 400);

  app.get(UNSUBSCRIBE_PATH, async (c) => {
    const token = c.req.query("t") ?? "";
    if (!TOKEN.test(token)) return invalid(c);
    const account = await deps.accounts.byUnsubscribeToken(token);
    if (!account) return invalid(c);
    if (account.optedOut) return c.html(page("Already unsubscribed", `No more product news to ${esc(account.email)}. ${NOTHING_ELSE}`));
    return c.html(page("Stop product news?", `No more product news to ${esc(account.email)}. ${NOTHING_ELSE}`, `${UNSUBSCRIBE_PATH}?t=${token}`));
  });

  app.post(UNSUBSCRIBE_PATH, async (c) => {
    const token = c.req.query("t") ?? "";
    if (!TOKEN.test(token)) return invalid(c);
    const account = await deps.accounts.optOut(token);
    if (!account) return invalid(c);
    deps.log.info("accounts.unsubscribed", {});
    return c.html(page("Unsubscribed", `No more product news to ${esc(account.email)}. ${NOTHING_ELSE}`));
  });

  return app;
}
