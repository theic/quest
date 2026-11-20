/**
 * Production and dev, kept apart (the founder, 2026-10-22: "@messagingquestbot - production only, connected to the
 * remote server and published chrome extension. @TestPatrikBot - local always; uses local server and the latest dev
 * mode extension").
 *
 * Production is the Fly app mq-v2-agent: Supabase atjukklkmfwhmbbzxaod, @messagingquestbot by its webhook, and the
 * extension from the Chrome Web Store. Dev is a laptop: Supabase bglbnziyilxkxgzortuf, @TestPatrikBot by polling,
 * and the extension loaded unpacked. Each refuses the other's database, bot and address when it starts: a laptop
 * polling @messagingquestbot would delete production's webhook and take every customer's messages, and one on
 * production's database would claim their work and point production's wake job at itself.
 *
 * `MQ_ENV` says which one runs: fly.toml sets it to production, and `npm run dev` to dev.
 */
export type Stage = "production" | "dev" | "local";

export const STAGES: readonly Stage[] = ["production", "dev"];

export const PRODUCTION = {
  flyApp: "mq-v2-agent",
  url: "https://mq-v2-agent.fly.dev",
  supabase: "atjukklkmfwhmbbzxaod",
  bot: "messagingquestbot",
  envFile: ".env.production.local",
} as const;

export const DEV = {
  url: "http://localhost:8080",
  supabase: "bglbnziyilxkxgzortuf",
  bot: "TestPatrikBot",
  envFile: ".env.local",
} as const;

/**
 * The Supabase project a database address points at: the pooler's user ("mq_app.<ref>") or a direct host
 * ("db.<ref>.supabase.co"). Null for any other database, such as a local one.
 */
export function supabaseRef(databaseUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    return null;
  }
  const user = /\.([a-z0-9]{20})$/.exec(decodeURIComponent(url.username))?.[1];
  if (user && url.hostname.endsWith(".supabase.com")) return user;
  return /^db\.([a-z0-9]{20})\.supabase\.co$/.exec(url.hostname)?.[1] ?? null;
}

/** Which stage a database belongs to, by its Supabase project; null for one that is neither. */
export function stageOfDatabase(databaseUrl: string): Stage | null {
  const ref = supabaseRef(databaseUrl);
  return ref === PRODUCTION.supabase ? "production" : ref === DEV.supabase ? "dev" : null;
}

/** A Stripe secret or restricted key that moves real money. */
export const liveStripeKey = (key: string | undefined): boolean => /^(sk|rk)_live_/.test(key?.trim() ?? "");

const sameOrigin = (a: string | null | undefined, b: string): boolean => {
  try {
    return Boolean(a) && new URL(a as string).origin === new URL(b).origin;
  } catch {
    return false;
  }
};

export interface StageSetting {
  readonly databaseUrl: string;
  readonly telegramMode: "webhook" | "polling";
  readonly publicUrl: string | null;
  readonly chromeDebug: boolean;
  readonly testCustomer: string | null;
  readonly stripeKey: string | undefined;
  /** FLY_APP_NAME: set on a Fly Machine. */
  readonly flyApp: string | null;
  /** MODELS: claude-cli is the founder's own Claude subscription, for a laptop agent only. */
  readonly models?: "openrouter" | "claude-cli" | "codex-cli";
}

/** Why this setting may not run as `stage`, one line each; [] when it may. */
export function stageProblems(stage: Stage, s: StageSetting): string[] {
  const out: string[] = [];
  const db = supabaseRef(s.databaseUrl);
  if (stage === "production") {
    if (s.flyApp !== PRODUCTION.flyApp) out.push(`production runs only on the Fly app ${PRODUCTION.flyApp} (FLY_APP_NAME is ${s.flyApp ?? "unset"}); on a laptop, run the dev agent: npm run dev`);
    if (db !== PRODUCTION.supabase) out.push(`production's DATABASE_URL must be Supabase ${PRODUCTION.supabase} (it is ${db ?? "another database"})`);
    if (s.telegramMode !== "webhook") out.push("production takes Telegram's updates by its webhook: TELEGRAM_MODE=polling would delete it");
    if (!sameOrigin(s.publicUrl, PRODUCTION.url)) out.push(`production's PUBLIC_URL must be ${PRODUCTION.url}`);
    if (s.chromeDebug) out.push("CHROME_DEBUG is for a laptop agent, never production");
    if (s.testCustomer) out.push("MQ_TEST_CUSTOMER is for a laptop agent, never production");
    if (s.models === "codex-cli") out.push("MODELS=codex-cli runs on someone's own ChatGPT subscription: a laptop agent's, never production's");
    if (s.models === "claude-cli") out.push("MODELS=claude-cli runs on the founder's own Claude subscription: a laptop agent's, never production's");
  } else {
    if (s.flyApp === PRODUCTION.flyApp) out.push(`the Fly app ${PRODUCTION.flyApp} is production: set MQ_ENV=production (fly.toml does)`);
    if (db === PRODUCTION.supabase) out.push(`DATABASE_URL is production's database (Supabase ${PRODUCTION.supabase}); dev runs on ${DEV.supabase}, from ${DEV.envFile}`);
    if (sameOrigin(s.publicUrl, PRODUCTION.url)) out.push(`PUBLIC_URL is production's address; dev serves its pages at ${DEV.url}`);
    if (liveStripeKey(s.stripeKey)) out.push("STRIPE_SECRET_KEY is a live key: dev takes only Stripe's test keys");
  }
  return out;
}

/** Why the bot this token belongs to may not serve `stage`; null when it may. */
export function botProblem(stage: Stage, username: string): string | null {
  const prod = username.toLowerCase() === PRODUCTION.bot.toLowerCase();
  if (stage === "production" && !prod) return `production's bot is @${PRODUCTION.bot}, but TELEGRAM_BOT_TOKEN is @${username}'s`;
  if (stage !== "production" && prod) return `TELEGRAM_BOT_TOKEN is @${PRODUCTION.bot}'s, production's bot: dev runs @${DEV.bot} (${DEV.envFile})`;
  return null;
}

export class WrongStage extends Error {
  constructor(stage: Stage, problems: readonly string[]) {
    super(`This agent may not start as ${stage}:\n  - ${problems.join("\n  - ")}`);
    this.name = "WrongStage";
  }
}
