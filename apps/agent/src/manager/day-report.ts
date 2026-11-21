import type { Answered, PlatformDay, ReportCharts } from "../infra/pg-reports.ts";

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
  /** The days, today's hours and how far people got (the founder, 2026-11-20: "charts, not just text"). */
  readonly charts?: ReportCharts;
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
const wordsOf = (p: PlatformDay): number => (p.sent["reply"] ?? 0) + (p.sent["message"] ?? 0) + (p.sent["post"] ?? 0);

/** Answers per word that went up there over the week: what worked, platform by platform, best first. */
export function whatWorked(week: readonly PlatformDay[]): string[] {
  return rates(week).map(({ p, words }) => `${p.platform}: ${p.answered} answered of ${words} replies, messages and posts (${Math.round((100 * p.answered) / words)}%)`);
}

const rates = (week: readonly PlatformDay[]) =>
  week
    .map((p) => ({ p, words: wordsOf(p) }))
    .filter((x) => x.words >= 3)
    .sort((a, b) => b.p.answered / b.words - a.p.answered / a.words);

/** A round top for an axis: 1, 2 or 5 times a power of ten. */
const niceMax = (n: number): number => {
  if (n <= 4) return 4;
  const p = 10 ** Math.floor(Math.log10(n));
  return ([1, 2, 5, 10].find((m) => m * p >= n) ?? 10) * p;
};
const pct = (n: number, of: number): string => `${of ? Math.max(0, Math.min(100, (100 * n) / of)) : 0}%`;
const shortDay = (iso: string): string => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const weekday = (iso: string): string => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "narrow", timeZone: "UTC" });

/** The tiles at the top: who answered today against the week, what went up, and the week's rate. */
function tiles(r: ReportInput): string {
  const trend = r.charts?.trend ?? [];
  const before = trend.slice(-8, -1);
  const avg = before.length ? before.reduce((s, d) => s + d.answered, 0) / before.length : null;
  const today = r.answered.length;
  const usual = avg === null ? null : Math.round(avg);
  const delta = usual === null ? "" : today > usual ? `<span class="up">▲ ${today - usual} over a usual day</span>` : today < usual ? `<span class="dn">▼ ${usual - today} under a usual day (${usual})</span>` : `<span class="mut">a usual day</span>`;
  const words = r.today.reduce((s, p) => s + wordsOf(p), 0);
  const light = r.today.reduce((s, p) => s + (p.sent["like"] ?? 0) + (p.sent["follow"] ?? 0), 0);
  const wWords = r.week.reduce((s, p) => s + wordsOf(p), 0);
  const wAns = r.week.reduce((s, p) => s + p.answered, 0);
  const tile = (label: string, value: string, sub: string) => `<div class="tile"><div class="tl">${label}</div><div class="tv">${value}</div><div class="ts">${sub}</div></div>`;
  return `<div class="tiles">${tile("Answered today", String(today), delta)}${tile("Went up today", String(words), `+ ${light} likes and follows`)}${tile("Answer rate, 7 days", wWords ? `${Math.round((100 * wAns) / wWords)}%` : "–", `${wAns} of ${wWords} words`)}</div>`;
}

/** The last 14 days: words that went up and people who answered, side by side per day; 7 or 14 at a tap. */
function trendChart(c: ReportCharts): string {
  if (!c.trend.length) return "";
  const max = niceMax(Math.max(...c.trend.map((d) => Math.max(d.words, d.answered)), 1));
  const cols = c.trend
    .map((d, i) => {
      const last = i === c.trend.length - 1;
      const tip = `${last ? "Today" : shortDay(d.day)}\n${d.words} replies, messages and posts\n${d.answered} answered\n${d.light} likes and follows`;
      return `<div class="col${i < c.trend.length - 7 ? " old" : ""}${last ? " now" : ""}" data-tip="${esc(tip)}" tabindex="0"><div class="pair"><i class="b s1" data-v="${d.words}" style="height:${pct(d.words, max)}"></i><i class="b s2" data-v="${d.answered}" style="height:${pct(d.answered, max)}"></i></div><span class="xl">${weekday(d.day)}</span></div>`;
    })
    .join("");
  const grid = [1, 0.5].map((f) => `<div class="gl" style="bottom:${f * 100}%"><span data-f="${f}">${Math.round(max * f)}</span></div>`).join("");
  return `<div class="card"><div class="head"><h3>Every day</h3><div class="seg" role="group"><button data-days="7" aria-pressed="false">7 days</button><button data-days="14" aria-pressed="true">14 days</button></div></div>
<div class="legend"><span><i class="sw s1"></i>Replies, messages, posts</span><span><i class="sw s2"></i>People who answered</span></div>
<div class="plot trend" data-range="14">${grid}<div class="cols">${cols}</div></div></div>`;
}

/** Where people answer: the week's rate per site, best first. */
function ratesChart(week: readonly PlatformDay[]): string {
  const rows = rates(week).slice(0, 8);
  if (!rows.length) return "";
  const top = Math.max(...rows.map(({ p, words }) => p.answered / words), 0.01);
  return `<div class="card"><h3>Where people answer, 7 days</h3>${rows
    .map(({ p, words }) => {
      const rate = p.answered / words;
      const tip = `${p.platform}\n${p.answered} answered of ${words} replies, messages and posts\n${(p.sent["like"] ?? 0) + (p.sent["follow"] ?? 0)} likes and follows`;
      return `<div class="hrow" data-tip="${esc(tip)}" tabindex="0"><span class="hl">${esc(p.platform)}</span><span class="track"><i class="hb s1" style="width:${pct(rate, top)}"></i></span><span class="hv">${Math.round(100 * rate)}%<small> ${p.answered}/${words}</small></span></div>`;
    })
    .join("")}</div>`;
}

/** Today by the hour: a strip of 24 cells, darker for more. */
function hoursChart(c: ReportCharts): string {
  const max = Math.max(...c.hours.map((h) => h.words + h.light), 0);
  if (!max) return "";
  const step = (n: number) => (n === 0 ? 0 : 1 + Math.min(4, Math.floor((4 * n) / max)));
  const cells = c.hours
    .map((h) => {
      const tip = `${String(h.hour).padStart(2, "0")}:00 to ${String(h.hour + 1).padStart(2, "0")}:00\n${h.words} replies, messages and posts\n${h.light} likes and follows`;
      return `<i class="cell q${step(h.words + h.light)}" data-tip="${esc(tip)}" tabindex="0"></i>`;
    })
    .join("");
  return `<div class="card"><h3>Today, hour by hour</h3><div class="hours">${cells}</div><div class="hx"><span>0:00</span><span>6:00</span><span>12:00</span><span>18:00</span><span>24:00</span></div>
<div class="scale"><span>less</span><i class="cell q1"></i><i class="cell q2"></i><i class="cell q3"></i><i class="cell q4"></i><i class="cell q5"></i><span>more</span></div></div>`;
}

/** Today on each site, by kind, stacked; the numbers as a table under it. */
function sitesChart(today: readonly PlatformDay[], table: string): string {
  const rows = today.filter((p) => total(p)).sort((a, b) => total(b) - total(a)).slice(0, 10);
  if (!rows.length) return `<div class="card"><h3>Today on each site</h3><p class="dim">Nothing went up today.</p></div>`;
  const max = Math.max(...rows.map(total));
  const bars = rows
    .map((p) => {
      const segs = KINDS.filter((k) => p.sent[k])
        .map((k) => `<i class="pc s${KINDS.indexOf(k) + 1}" style="flex:${p.sent[k]}" data-tip="${esc(`${p.platform}\n${p.sent[k]} ${WORD[k]}`)}" tabindex="0"></i>`)
        .join("");
      return `<div class="hrow"><span class="hl">${esc(p.platform)}</span><span class="track"><span class="stack" style="width:${pct(total(p), max)}">${segs}</span></span><span class="hv">${total(p)}${p.answered ? `<small> ${p.answered} answered</small>` : ""}</span></div>`;
    })
    .join("");
  const legend = KINDS.flatMap((k, i) => (rows.some((p) => p.sent[k]) ? [`<span><i class="sw s${i + 1}"></i>${WORD[k]}</span>`] : [])).join("");
  return `<div class="card"><h3>Today on each site</h3><div class="legend">${legend}</div>${bars}<details><summary>As a table</summary><div class="wrap">${table}</div></details></div>`;
}

/** How far people got, all time. */
function funnelChart(c: ReportCharts): string {
  const top = c.funnel[0]?.n ?? 0;
  if (!top) return "";
  const NAME: Record<string, string> = { conversation: "Talked", trial: "Tried it", active: "Use it", paying: "Pay" };
  return `<div class="card"><h3>How far people got, all time</h3>${c.funnel
    .map((f, i) => `<div class="hrow" data-tip="${esc(`${NAME[f.stage]}: ${f.n}${i ? `, ${Math.round((100 * f.n) / Math.max(1, c.funnel[i - 1]!.n))}% of the step before` : ""}`)}" tabindex="0"><span class="hl">${NAME[f.stage]}</span><span class="track"><i class="hb f${i + 1}" style="width:${f.n ? `max(${pct(f.n, top)}, 6px)` : "0"}"></i></span><span class="hv">${f.n}</span></div>`)
    .join("")}</div>`;
}

/** The report as one page that reads on a phone, light or dark: the numbers as charts first, then the words. */
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
  const table = rows ? `<table><tr><th></th>${KINDS.map((k) => `<th>${WORD[k]}</th>`).join("")}<th>answered</th></tr>${rows}</table>` : "";
  const charts = r.charts;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Quest, ${esc(r.day)}</title><style>
:root{--bg:#f9f9f7;--card:#fcfcfb;--fg:#0b0b0b;--fg2:#52514e;--dim:#898781;--line:#e1e0d9;--axis:#c3c2b7;--ring:rgba(11,11,11,.10);--link:#2a78d6;--up:#006300;--dn:#d03b3b;
--s1:#2a78d6;--s2:#eb6834;--s3:#1baf7a;--s4:#eda100;--s5:#e87ba4;--q0:#f0efec;--q1:#b7d3f6;--q2:#86b6ef;--q3:#5598e7;--q4:#256abf;--q5:#104281;
--f1:#184f95;--f2:#256abf;--f3:#3987e5;--f4:#86b6ef;color-scheme:light}
@media (prefers-color-scheme:dark){:root:where(:not([data-theme="light"])){--bg:#0d0d0d;--card:#1a1a19;--fg:#f0efec;--fg2:#c3c2b7;--dim:#898781;--line:#2c2c2a;--axis:#383835;--ring:rgba(255,255,255,.10);--link:#3987e5;--up:#0ca30c;--dn:#e66767;
--s1:#3987e5;--s2:#d95926;--s3:#199e70;--s4:#c98500;--s5:#d55181;--q0:#262624;--q1:#184f95;--q2:#1c5cab;--q3:#2a78d6;--q4:#5598e7;--q5:#9ec5f4;--f1:#9ec5f4;--f2:#6da7ec;--f3:#3987e5;--f4:#1c5cab;color-scheme:dark}}
:root[data-theme="dark"]{--bg:#0d0d0d;--card:#1a1a19;--fg:#f0efec;--fg2:#c3c2b7;--dim:#898781;--line:#2c2c2a;--axis:#383835;--ring:rgba(255,255,255,.10);--link:#3987e5;--up:#0ca30c;--dn:#e66767;
--s1:#3987e5;--s2:#d95926;--s3:#199e70;--s4:#c98500;--s5:#d55181;--q0:#262624;--q1:#184f95;--q2:#1c5cab;--q3:#2a78d6;--q4:#5598e7;--q5:#9ec5f4;--f1:#9ec5f4;--f2:#6da7ec;--f3:#3987e5;--f4:#1c5cab;color-scheme:dark}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:680px;margin:0 auto;padding:20px 16px 40px}h1{font-size:22px;margin:0 0 4px}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:var(--dim);margin:26px 0 8px}
h3{font-size:15px;margin:0;font-weight:600}
p{margin:0 0 8px}ul{margin:0;padding-left:18px}li{margin:0 0 8px}a{color:var(--link)}.q{color:var(--fg2);font-size:14px}
.dim{color:var(--dim)}.news{white-space:pre-wrap;overflow-wrap:anywhere;color:var(--fg2)}.q{overflow-wrap:anywhere}
.tiles{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:16px 0 12px}
.tile{background:var(--card);box-shadow:inset 0 0 0 1px var(--ring);border-radius:14px;padding:12px}
.tl{font-size:12px;color:var(--fg2)}.tv{font-size:32px;font-weight:650;line-height:1.15;margin:2px 0}.ts{font-size:12px;color:var(--dim)}
.up{color:var(--up)}.dn{color:var(--dn)}.mut{color:var(--dim)}
@media (max-width:420px){.tiles{grid-template-columns:1fr 1fr}.tile:first-child{grid-column:1/-1}.tv{font-size:28px}}
.card{background:var(--card);box-shadow:inset 0 0 0 1px var(--ring);border-radius:14px;padding:14px;margin:0 0 12px}
.head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.seg{display:inline-flex;background:var(--q0);border-radius:8px;padding:2px}
.seg button{all:unset;cursor:pointer;font-size:12px;padding:3px 9px;border-radius:6px;color:var(--fg2)}
.seg button[aria-pressed="true"]{background:var(--card);color:var(--fg);box-shadow:0 0 0 1px var(--ring)}
.legend{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:12px;color:var(--fg2);margin:8px 0 10px}
.legend span{display:inline-flex;align-items:center;gap:6px}.sw{width:10px;height:10px;border-radius:3px;display:inline-block}
.s1{background:var(--s1)}.s2{background:var(--s2)}.s3{background:var(--s3)}.s4{background:var(--s4)}.s5{background:var(--s5)}
.plot{position:relative;height:150px;margin:6px 0 22px 26px;border-bottom:1px solid var(--axis)}
.gl{position:absolute;left:0;right:0;border-top:1px solid var(--line)}.gl span{position:absolute;left:-26px;top:-8px;width:22px;text-align:right;font-size:11px;color:var(--dim);font-variant-numeric:tabular-nums}
.cols{position:absolute;inset:0;display:flex;gap:2px}
.col{flex:1;position:relative;display:flex;justify-content:center;cursor:default;outline:none;border-radius:6px}
.col:hover,.col:focus-visible,.col.on{background:var(--q0)}
.trend[data-range="7"] .col.old{display:none}
.pair{position:absolute;inset:0 0 0 0;display:flex;align-items:flex-end;justify-content:center;gap:2px;padding:0 2px}
.b{display:block;width:min(12px,40%);border-radius:4px 4px 0 0;min-height:0}
.xl{position:absolute;bottom:-20px;font-size:11px;color:var(--dim)}.col.now .xl{color:var(--fg);font-weight:600}
.hrow{display:grid;grid-template-columns:minmax(70px,30%) 1fr auto;align-items:center;gap:10px;padding:5px 4px;border-radius:8px;font-size:14px;outline:none}
.hrow:hover,.hrow:focus-visible,.hrow.on{background:var(--q0)}
.hl{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--fg2)}
.track{display:block;height:12px}.hb{display:block;height:100%;border-radius:0 4px 4px 0}
.stack{display:flex;gap:2px;height:100%}.pc{display:block;height:100%;min-width:3px;outline:none}.pc:last-child{border-radius:0 4px 4px 0}.pc.on,.pc:focus-visible{box-shadow:0 0 0 2px var(--fg)}
.hv{font-variant-numeric:tabular-nums;font-weight:600;text-align:right}.hv small{font-weight:400;color:var(--dim);font-size:12px}
.f1{background:var(--f1)}.f2{background:var(--f2)}.f3{background:var(--f3)}.f4{background:var(--f4)}
.hours{display:grid;grid-template-columns:repeat(24,1fr);gap:2px;margin-top:12px}
.cell{display:block;aspect-ratio:1/1.6;border-radius:3px;background:var(--q0);outline:none}
.cell:hover,.cell:focus-visible,.cell.on{box-shadow:0 0 0 2px var(--fg)}
.q1{background:var(--q1)}.q2{background:var(--q2)}.q3{background:var(--q3)}.q4{background:var(--q4)}.q5{background:var(--q5)}
.hx{display:flex;justify-content:space-between;font-size:11px;color:var(--dim);margin-top:4px}
.scale{display:flex;align-items:center;gap:3px;font-size:11px;color:var(--dim);margin-top:10px}.scale .cell{width:14px;aspect-ratio:1}
details{margin-top:10px;font-size:13px}summary{cursor:pointer;color:var(--fg2)}
table{border-collapse:collapse;width:100%;font-size:13px;font-variant-numeric:tabular-nums;margin-top:8px}
th,td{padding:5px 4px;border-bottom:1px solid var(--line);text-align:right}th:first-child,td:first-child{text-align:left}
th{font-weight:600;color:var(--dim);font-size:11px}.wrap{overflow-x:auto}
#tip{position:fixed;z-index:9;pointer-events:none;background:var(--fg);color:var(--bg);font-size:12px;line-height:1.4;padding:7px 9px;border-radius:8px;white-space:pre;max-width:260px;opacity:0;transition:opacity .12s}
#tip.show{opacity:1}#tip b{font-weight:650}
</style></head><body><main><h1>Quest, ${esc(r.day)}</h1>
${r.news ? `<p class="news">${esc(r.news)}</p>` : ""}
${tiles(r)}
${charts ? trendChart(charts) : ""}
${ratesChart(r.week)}
${charts ? hoursChart(charts) : ""}
${sitesChart(r.today, table)}
${charts ? funnelChart(charts) : ""}
${section("Needs you", [r.needs, ...r.paused].filter((l): l is string => Boolean(l)).map((l) => `<p>${esc(l)}</p>`).join(""))}
${section(`Who answered today (${r.answered.length})`, answered || `<p class="dim">Nobody yet today.</p>`)}
${section("A sample to skim", r.sample.length ? `<p class="news">${esc(r.sample.join("\n"))}</p>` : "")}
</main><div id="tip" role="tooltip"></div><script>
(function(){
  var tip=document.getElementById("tip"),on=null;
  function show(el,x,y){
    if(on&&on!==el)on.classList.remove("on");on=el;el.classList.add("on");
    var lines=el.getAttribute("data-tip").split("\\n");tip.textContent="";
    lines.forEach(function(l,i){var s=document.createElement(i?"div":"b");s.textContent=l;tip.appendChild(s);});
    tip.classList.add("show");
    var r=el.getBoundingClientRect(),w=tip.offsetWidth,h=tip.offsetHeight;
    var px=x==null?r.left+r.width/2:x,py=y==null?r.top:y;
    tip.style.left=Math.max(8,Math.min(innerWidth-w-8,px-w/2))+"px";
    tip.style.top=(py-h-10<8?py+18:py-h-10)+"px";
  }
  function hide(){tip.classList.remove("show");if(on)on.classList.remove("on");on=null;}
  document.addEventListener("pointermove",function(e){var el=e.target.closest&&e.target.closest("[data-tip]");if(el&&e.pointerType==="mouse")show(el,e.clientX,e.clientY);else if(!el&&e.pointerType==="mouse")hide();});
  document.addEventListener("click",function(e){var el=e.target.closest&&e.target.closest("[data-tip]");if(el)show(el);else hide();});
  document.addEventListener("focusin",function(e){var el=e.target.closest&&e.target.closest("[data-tip]");if(el)show(el);});
  document.addEventListener("scroll",hide,{passive:true});
  document.querySelectorAll(".seg button").forEach(function(b){b.addEventListener("click",function(){
    var plot=b.closest(".card").querySelector(".plot"),days=+b.getAttribute("data-days");plot.setAttribute("data-range",days);
    b.parentNode.querySelectorAll("button").forEach(function(x){x.setAttribute("aria-pressed",x===b?"true":"false");});
    // The axis fits the days shown.
    var cols=[].slice.call(plot.querySelectorAll(".col")).slice(-days),top=1;
    cols.forEach(function(c){c.querySelectorAll(".b").forEach(function(i){top=Math.max(top,+i.getAttribute("data-v"));});});
    var p=Math.pow(10,Math.floor(Math.log10(top))),max=top<=4?4:[1,2,5,10].filter(function(m){return m*p>=top;})[0]*p;
    plot.querySelectorAll(".b").forEach(function(i){i.style.height=Math.min(100,100*i.getAttribute("data-v")/max)+"%";});
    plot.querySelectorAll(".gl span").forEach(function(s){s.textContent=Math.round(max*s.getAttribute("data-f"));});
  });});
})();
</script></body></html>`;
}
