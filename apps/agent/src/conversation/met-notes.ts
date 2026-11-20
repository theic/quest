/**
 * Where Quest met someone before they came in, read from the code their link carried. Quest's own account runs on dev
 * and its customers arrive on production, so a code made in one database is asked of that database's public functions
 * (the same ones the maker's page reads): only what the page or the thread already showed.
 *
 * - `m_<page code>`: they pressed "Keep looking for me" on a page Quest made for them (/m/<code>).
 * - `t<code>`: a link Quest gave them in a thread or a message on dev (drafts hand-off), a "t" before dev's code.
 */
const DB = {
  live: ["https://atjukklkmfwhmbbzxaod.supabase.co", "sb_publishable_hG7fm_52dqZDw7haT-NhGQ_f0jpYrsN"],
  dev: ["https://bglbnziyilxkxgzortuf.supabase.co", "sb_publishable_59ruBk4aIqdQgWEC9do_6Q_S-s1J4LQ"],
} as const;

type Fetch = typeof fetch;

async function rpc(db: readonly [string, string], fn: string, body: unknown, get: Fetch): Promise<unknown> {
  const r = await get(`${db[0]}/rest/v1/rpc/${fn}`, { method: "POST", headers: { apikey: db[1], "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(6000) });
  return r.ok ? r.json() : null;
}

const short = (s: unknown, n: number): string => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

/** The page's code inside a start code, "t" first when it is dev's; null for anything else. */
export const pageCode = (code: string): string | null => /^m_(t?[A-Fa-f0-9]{10})$/.exec(code.trim())?.[1] ?? null;

/** What Quest knows of someone from the code they came with, as a note for their manager; null when it says nothing. */
export async function metNote(code: string, get: Fetch = fetch): Promise<string | null> {
  const said = code.trim();
  try {
    const page = pageCode(said);
    if (page) {
      const row = (await rpc(page.startsWith("t") ? DB.dev : DB.live, "match_page", { code: page.replace(/^t/, "") }, get)) as { maker?: string; made?: string; launch?: string; people?: { author?: string; quote?: string; url?: string; fit?: boolean }[] } | null;
      if (!row?.launch) return null;
      const people = (row.people ?? []).slice(0, 6).map((p) => `${short(p.author, 40)} (${short(p.url, 160)}): "${short(p.quote, 140)}"${p.fit ? " (might fit, not written to)" : ""}`);
      return [
        `On a public page Quest made for them (messaging.quest/m/${page}), they pressed "Keep looking for me".`,
        `They are ${short(row.maker, 80)}; what they made, from their own post ${short(row.launch, 200)}: ${short(row.made, 300) || "see the post"}.`,
        people.length ? `Already found for them: ${people.join("; ")}.` : null,
        "They want more people like those. They have not said their site: read their post for it, or ask for the link in one line.",
      ].filter(Boolean).join(" ");
    }
    const dev = /^t([A-Za-z0-9]{6,32})$/.exec(said)?.[1];
    if (dev) {
      const note = await rpc(DB.dev, "invite_note", { code: dev }, get);
      return typeof note === "string" && note.trim() ? note.trim().slice(0, 3000) : null;
    }
  } catch {
    return null;
  }
  return null;
}
