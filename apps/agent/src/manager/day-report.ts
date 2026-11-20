import type { Answered, PlatformDay } from "../infra/pg-reports.ts";

/** What one day's report shows (docs/next-goal-open-source.md: "one report, an HTML file"). */
export interface ReportInput {
  /** "Thu 19 Nov", in their language. */
  readonly day: string;
  /** What Quest told them in the chat tonight: the news, in its own words; null when it said nothing. */
  readonly news: string | null;
  readonly answered: readonly Answered[];
  /** Today, and the week before it for what worked. */
  readonly today: readonly PlatformDay[];
  readonly week: readonly PlatformDay[];
  /** "Needs you: 3 waiting for your ok (...)"; null when nothing waits. */
  readonly needs: string | null;
  readonly paused: readonly string[];
  /** The day's sample (manager/day-sample.ts), its lines. */
  readonly sample: readonly string[];
}

const esc = (s: string): string => s.replace(/[<>&"']/g, (ch) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch);
const web = (u: string | null): string | null => (u && /^https?:\/\//.test(u) ? u : null);
const KINDS = ["reply", "message", "post", "like", "follow"] as const;
const WORD: Readonly<Record<string, string>> = { reply: "replies", message: "messages", post: "posts", like: "likes", follow: "follows" };
const total = (p: PlatformDay): number => Object.values(p.sent).reduce((s, n) => s + n, 0);

/** Answers per word that went up there over the week: what worked, platform by platform, best first. */
export function whatWorked(week: readonly PlatformDay[]): string[] {
  return week
    .map((p) => ({ p, words: (p.sent["reply"] ?? 0) + (p.sent["message"] ?? 0) + (p.sent["post"] ?? 0) }))
    .filter((x) => x.words >= 3)
    .sort((a, b) => b.p.answered / b.words - a.p.answered / a.words)
    .map(({ p, words }) => `${p.platform}: ${p.answered} answered of ${words} replies, messages and posts (${Math.round((100 * p.answered) / words)}%)`);
}

/** The report as one page that reads on a phone, light or dark. */
export function reportHtml(r: ReportInput): string {
  const section = (title: string, body: string) => (body ? `<h2>${esc(title)}</h2>${body}` : "");
  const list = (lines: readonly string[]) => (lines.length ? `<ul>${lines.map((l) => `<li>${l}</li>`).join("")}</ul>` : "");
  const answered = list(
    r.answered.map((a) => {
      const href = web(a.url);
      const who = href ? `<a href="${esc(href)}">${esc(a.person)}</a>` : esc(a.person);
      return `${who}${a.words ? `<div class="q">${esc(a.words.slice(0, 280))}</div>` : ""}`;
    }),
  );
  const rows = r.today
    .filter((p) => KINDS.some((k) => p.sent[k]) || p.answered)
    .sort((a, b) => b.answered - a.answered || total(b) - total(a))
    .map((p) => `<tr><td>${esc(p.platform)}</td>${KINDS.map((k) => `<td>${p.sent[k] ?? ""}</td>`).join("")}<td>${p.answered || ""}</td></tr>`)
    .join("");
  const table = rows
    ? `<table><tr><th></th>${KINDS.map((k) => `<th>${WORD[k]}</th>`).join("")}<th>answered</th></tr>${rows}</table>`
    : `<p class="dim">Nothing went up today.</p>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Quest, ${esc(r.day)}</title><style>
:root{--bg:#fff;--fg:#16161a;--dim:#6b6b73;--line:#e6e6ea;--link:#2f6fed;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#0f0f11;--fg:#ececf0;--dim:#8e8e96;--line:#2a2a30;--link:#7aa5ff}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:640px;margin:0 auto;padding:20px 16px 40px}h1{font-size:22px;margin:0 0 4px}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:var(--dim);margin:26px 0 8px}
p{margin:0 0 8px}ul{margin:0;padding-left:18px}li{margin:0 0 8px}a{color:var(--link)}.q{color:var(--dim);font-size:14px}
.dim{color:var(--dim)}.news{white-space:pre-wrap}table{border-collapse:collapse;width:100%;font-size:14px;font-variant-numeric:tabular-nums}
th,td{padding:6px 4px;border-bottom:1px solid var(--line);text-align:right}th:first-child,td:first-child{text-align:left}
th{font-weight:600;color:var(--dim);font-size:12px}.wrap{overflow-x:auto}
</style></head><body><main><h1>Quest, ${esc(r.day)}</h1>
${r.news ? `<p class="news">${esc(r.news)}</p>` : ""}
${section("Needs you", [r.needs, ...r.paused].filter((l): l is string => Boolean(l)).map((l) => `<p>${esc(l)}</p>`).join(""))}
${section(`Who answered (${r.answered.length})`, answered || `<p class="dim">Nobody yet today.</p>`)}
${section("What went up, and where", `<div class="wrap">${table}</div>`)}
${section("What worked this week", list(whatWorked(r.week).map(esc)))}
${section("A sample to skim", r.sample.length ? `<p class="news">${esc(r.sample.join("\n"))}</p>` : "")}
</main></body></html>`;
}
