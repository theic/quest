import { z } from "zod";

const Row = z.record(z.string(), z.unknown());
const Read = z.object({
  url: z.string().max(4_000),
  status: z.number().int().nullable(),
  title: z.string().max(1_000),
  description: z.string().max(2_000).nullable(),
  text: z.string().max(200_000),
  links: z.array(z.object({ href: z.string().max(4_000), text: z.string().max(400) })).max(500),
  rows: z.record(z.string(), z.array(Row).max(500)),
  visible: z.boolean(),
});
const Posted = z.object({ url: z.string().url().max(2_000), account: z.string().min(1).max(100) });
/**
 * What the extension may answer a job with: a page it read, a browser session's view, a post
 * that went up, or why not. One field over its limit and the whole answer is refused, so the
 * extension's own tests hold what it sends to this (apps/extension/test).
 */
/**
 * A control on a session's page. Every field the agent uses is named here: zod drops the rest, and a field it
 * dropped never arrived (2026-10-15: `limit`, sent since 0.9.3, was dropped, so a bio too long for X's 160 went
 * round the poster instead of stopping it).
 */
const Control = z.object({
  ref: z.string().max(100),
  role: z.string().max(100),
  label: z.string().max(400),
  value: z.string().max(10000).nullable(),
  href: z.string().transform((s) => s.slice(0, 4000)).nullable(),
  options: z.array(z.object({ value: z.string().max(1000), label: z.string().max(300) })).max(100).optional(),
  limit: z.number().int().positive().max(1_000_000).optional(),
  pressed: z.boolean().optional(),
  item: z.number().int().min(0).max(1000).optional(),
});
const View = z.object({
  url: z.string().max(4000),
  title: z.string().max(1000),
  text: z.string().max(100000),
  frames: z.array(z.string().max(4000)).max(100).optional(),
  screen: z.object({ id: z.string().max(100), image: z.string().max(1500000).refine((value) => value.startsWith("data:image/jpeg;base64,") || value.startsWith("data:image/png;base64,")), width: z.number().int().positive().max(10000), height: z.number().int().positive().max(10000) }).optional(),
  shot: z.object({ image: z.string().max(1500000).refine((value) => value.startsWith("data:image/jpeg;base64,")), width: z.number().int().positive().max(10000), height: z.number().int().positive().max(10000) }).optional(),
  controls: z.array(Control).max(1500),
  items: z.array(z.string().max(400)).max(100).optional(),
  scroll: z.object({ y: z.number().int(), height: z.number().int().min(0), viewport: z.number().int().min(0) }).optional(),
  loading: z.boolean().optional(),
  focus: z.string().transform((s) => s.slice(0, 300)).optional(),
  dialog: z.string().transform((s) => s.slice(0, 300)).optional(),
});

export const Outcome = z.union([
  z.object({ ok: z.literal(true), view: View }),
  z.object({ ok: z.literal(true), read: Read }),
  z.object({ ok: z.literal(true), posted: Posted }),
  z.object({ ok: z.literal(false), reason: z.string().max(40), message: z.string().max(1_000) }),
]);
