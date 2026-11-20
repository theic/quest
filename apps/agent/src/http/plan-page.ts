import { customerLocale, direction, forLanguage } from "@mq/i18n";
import type { CreditView } from "../billing/credit-words.ts";
import { money, PACKS, restLeft } from "../billing/plans.ts";
import { SUPPORT_LINK, SUPPORT_URL } from "../conversation/support.ts";

const esc = (s: string | number): string =>
  String(s).replace(/[<>&"']/g, (ch) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch);

export interface PlanPageInput {
  readonly language: string | null;
  readonly view: CreditView;
  /** Not let in yet: credits they buy let them in. */
  readonly waiting: boolean;
  /** Their page's own address (/plan/<token>), which the buttons post to. */
  readonly self: string;
  /** They came back from Stripe's page having paid. */
  readonly paid: boolean;
  /** Something stopped the payment: said above the button. */
  readonly problem: string | null;
  readonly now: Date;
}

/** The visor, Quest's mark (brand/visor), small. */
const MARK =
  '<svg viewBox="0 0 512 512" aria-hidden="true"><g transform="translate(41 41) scale(0.815) translate(-13.5 1.6)"><g transform="translate(256 256) scale(0.9) translate(-256 -226)"><g transform="matrix(0.974 -0.225 -0.493 0.870 190 138)"><polygon fill="#1a230a" points="58,60 193,60 227,233 170,182 58,182"/><path fill="#ceff32" fill-rule="evenodd" d="M0,0 L253,0 L302,251 L259,265 L320,321 L339,406 L156,234 L0,241Z M58,60 L193,60 L227,233 L170,182 L58,182Z"/></g><g transform="translate(255 216) rotate(-13) skewX(-12)"><polygon fill="#ceff32" points="-46,-26 -16,-26 -16,26 -46,26"/><polygon fill="#ceff32" points="16,-26 46,-26 46,26 16,26"/></g></g></g></svg>';

const STYLE = `
:root{--bg:#0b0c0b;--card:#141613;--line:#2a2c28;--fg:#e8e8dc;--dim:#a3a59a;--accent:#ceff32;--accent-fg:#0b0c0b;--warn:#ffb547;color-scheme:dark}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--fg)}
body{font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:520px;margin:0 auto;padding:20px 16px 40px}
header{display:flex;align-items:center;gap:10px;margin-bottom:22px;font-weight:700;letter-spacing:.02em}
header svg{width:30px;height:30px;border-radius:8px;background:#000}
h1{font-size:26px;line-height:1.15;margin:0 0 10px}
.tag{display:inline-block;margin-bottom:10px;padding:3px 10px;border-radius:99px;background:var(--accent);color:var(--accent-fg);font-size:13px;font-weight:700}
.lead{color:var(--dim);margin:0 0 18px}
.today{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:12px 14px;margin-bottom:14px;font-size:14px}
.today .row{display:flex;justify-content:space-between;gap:12px}
.balance{font-size:28px;font-weight:800;line-height:1.1;font-variant-numeric:tabular-nums}
.vh{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.buy{display:flex;flex-direction:column;gap:14px;margin-bottom:14px;padding:20px 18px;border:1px solid var(--line);border-radius:22px;background:radial-gradient(90% 60% at 100% 0%,#ffffff0d,transparent 70%),var(--card)}
.packs{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:6px;margin:10px 0 0;padding:0;border:0;min-width:0}
.packs label{position:relative;display:grid;justify-items:center;gap:2px;padding:11px 2px 9px;border:1px solid #3a3d36;border-radius:14px;background:#0b0c0b80;cursor:pointer;font-variant-numeric:tabular-nums}
.packs label:hover{border-color:#ceff3280}
.packs input{position:absolute;opacity:0;pointer-events:none}
.packs b{font-size:16px;font-weight:700;line-height:1.2}
.packs span{font-size:11.5px;font-weight:600;color:var(--dim)}
.packs i{position:absolute;top:-10px;inset-inline-end:-2px;padding:2px 6px;border-radius:99px;background:var(--accent);color:var(--accent-fg);font:700 8.5px/1.3 ui-monospace,monospace;letter-spacing:.04em;text-transform:uppercase;font-style:normal;white-space:nowrap}
.packs label:has(:checked){border-color:var(--accent);background:#ffffff0f}
.packs label:has(:focus-visible){outline:2px solid var(--accent);outline-offset:3px}
.get{display:flex;align-items:baseline;gap:10px;margin:0;font-size:15px;font-weight:600;color:var(--dim)}
.get b{display:none;font-size:52px;font-weight:800;line-height:1;letter-spacing:-.04em;color:var(--fg);font-variant-numeric:tabular-nums}
.agents{display:grid;grid-template-columns:repeat(20,minmax(0,1fr));gap:4px}
.agents i{aspect-ratio:1;border-radius:50%;background:#ffffff17}
.say{margin:0;color:var(--dim);font-size:14px}
.pay{display:flex;flex-direction:column;gap:8px}
.pay a,.pay button{display:flex;align-items:center;justify-content:center;min-height:48px;padding:10px 18px;border:1px solid var(--line);border-radius:99px;background:transparent;color:var(--fg);font:inherit;font-weight:700;text-align:center;text-decoration:none;cursor:pointer}
.pay a{display:none}
.pay .first{border-color:var(--accent);background:var(--accent);color:var(--accent-fg)}
.pay :is(a,button):not(.first):hover{border-color:var(--accent)}
.more{display:flex;flex-direction:column;gap:8px}
.more a{color:var(--dim);font-size:14px}
.fine{color:var(--dim);font-size:13px;margin:12px 0 0}
.fine a{color:inherit}
.problem{border:1px solid var(--warn);color:var(--warn);border-radius:12px;padding:10px 12px;margin-bottom:12px;font-size:14px}
.done{text-align:center;padding-top:30px}
.done .tick{width:64px;height:64px;margin:0 auto 16px;border-radius:50%;display:grid;place-items:center;background:var(--accent);color:var(--accent-fg);font-size:34px;font-weight:800}
@media (max-width:360px){.packs b{font-size:14px}.packs span{font-size:10.5px}.get b{font-size:44px}}
`;

/** Of the 20 dots, how many each pack lights: more credits keep more agents working at once (the landing said so first). */
const AGENTS: Readonly<Record<number, number>> = { 20: 5, 100: 20 };

/** The pack picked: one at a time, no script; its total and its dots show (`:has`). */
const PICKED = `${PACKS.map((pack) => `.buy:has([value="${pack.usd}"]:checked) .get-${pack.usd}{display:inline}.buy:has([value="${pack.usd}"]:checked) .agents i:nth-child(-n+${AGENTS[pack.usd] ?? 1}){background:var(--fg)}`).join("\n")}`;

/**
 * The page a customer buys credits on (the button under "I'm out of credits", /plan, Settings on their
 * page): how they use Quest, their credits left and today's use, and the packs as the landing showed them: one picked at
 * a time, what it gives with the first top-up's bonus while it is theirs, the agents it keeps busy, then Pay by card
 * (Stripe's page). Someone on an invite sees that Quest is free for them,
 * and no packs. In their language.
 */
export function planPage(p: PlanPageInput): string {
  const t = forLanguage(p.language);
  const locale = customerLocale(p.language);
  const usd = (n: number) => money(n, p.language);
  const page = (title: string, body: string) =>
    `<!doctype html><html lang="${esc(locale)}" dir="${direction(locale)}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="robots" content="noindex">
<title>${esc(title)}</title><style>${STYLE}${PICKED}</style></head><body><main><header>${MARK}<span>Quest</span></header>${body}<p class="fine"><a href="${SUPPORT_URL}" target="_blank" rel="noopener">${esc(t(SUPPORT_LINK))}</a></p></main></body></html>`;

  if (p.paid) {
    return page(t("Credits for Quest"), `<section class="done"><div class="tick">✓</div><h1>${esc(t("Thank you!"))}</h1><p class="lead">${esc(t("Stripe is confirming your payment. Quest tells you in Telegram the moment it's through."))}</p></section>`);
  }

  const { view } = p;
  const sells = p.waiting || view.access === "credits" || view.balance !== null;
  const lead = p.waiting || view.access === "credits"
    ? t("Credits pay for what Quest does for you. They don't expire.")
    : t("You're on an invite, so Quest is free for you.");

  const back = (ms: number) => { const left = restLeft(ms); return t(left.key, { count: left.count }); };
  const resting = !view.restUntil
    ? ""
    : view.resting === "credits"
      ? `<div class="row"><span>${esc(t("Out of credits: top up to go on"))}</span></div>`
      : `<div class="row"><span>${esc(t("Resting until your midnight"))}</span><span>${esc(t("back in {time}", { time: back(view.restUntil.getTime() - p.now.getTime()) }))}</span></div>`;
  const left = view.balance !== null
    ? `<div class="today"><div class="row"><span>${esc(t("Credits left"))}</span></div><div class="balance">${esc(usd(view.balance))}</div></div>`
    : "";
  const today = !p.waiting && resting ? `<div class="today">${resting}</div>` : "";

  const last = PACKS.length - 1;
  const bonusOf = (pack: (typeof PACKS)[number]) => (view.firstTopUp ? pack.bonus : 0);
  const packs = PACKS.map((pack, i) => {
    const bonus = bonusOf(pack) ? `<span>+ ${esc(money(pack.bonus, p.language, false))}</span>` : "";
    const doubled = bonusOf(pack) === pack.usd ? `<i>${esc(t("Credits doubled"))}</i>` : "";
    return `<label><input type="radio" name="pack" value="${pack.usd}"${i === last ? " checked" : ""}><b>${esc(money(pack.usd, p.language, false))}</b>${bonus}${doubled}</label>`;
  }).join("");
  const gets = PACKS.map((pack) => `<b class="get-${pack.usd}">${esc(money(pack.usd + bonusOf(pack), p.language, false))}</b>`).join("");
  const problem = p.problem ? `<div class="problem">${esc(p.problem)}</div>` : "";
  const buy = sells
    ? `<form class="buy" method="post" action="${esc(p.self)}/checkout">
<fieldset class="packs"><legend class="vh">${esc(t("Pick a pack"))}</legend>${packs}</fieldset>
<p class="get"><span>${esc(t("You get"))}</span> ${gets}</p>
<div class="agents" aria-hidden="true">${"<i></i>".repeat(20)}</div>
<p class="say">${esc(t("More credits keep more agents working at once, so you grow faster."))}</p>
${problem}<div class="pay"><button class="first" type="submit">${esc(t("Pay by card"))}</button></div>
</form>
<p class="fine">${esc(t("Paid once. No subscription."))}${view.firstTopUp ? ` ${esc(t("The bonus comes with your first top-up."))}` : ""}</p>`
    : "";
  const body = `<h1>${esc(t("Credits for Quest"))}</h1>
<p class="lead">${esc(lead)}</p>
${left}${today}${buy}`;
  return page(t("Credits for Quest"), body);
}
