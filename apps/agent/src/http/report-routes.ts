import { Hono } from "hono";
import type { PlanLinks } from "../billing/plans.ts";
import type { PgReports } from "../infra/pg-reports.ts";

const GONE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Quest</title>
<body style="font:15px system-ui;padding:40px 16px;text-align:center">This report is not here any more.</body>`;

/** A day's report by its signed address (`/report/<token>/<day>`): the link is the key, as the credits page's. */
export function reportRoutes(deps: { links: PlanLinks; reports: Pick<PgReports, "get"> }): Hono {
  const app = new Hono();
  app.get("/report/:token/:day", async (c) => {
    const link = deps.links.read(c.req.param("token"));
    const day = c.req.param("day");
    if (!link || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return c.html(GONE, 404);
    const html = await deps.reports.get(link.customerId, day);
    c.header("Cache-Control", "no-store");
    return html ? c.html(html) : c.html(GONE, 404);
  });
  return app;
}
