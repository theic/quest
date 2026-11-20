import { hostname } from "node:os";
import { z } from "zod";
import { MODEL_ROLES, type ModelRole, type ModelSeat } from "./agents/models.ts";
import { DEV, stageProblems, WrongStage, type Stage } from "./environments.ts";

const list = (s: string): string[] =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

const Env = z.object({
  // Which agent this is (environments.ts): "production" on Fly (fly.toml), "dev" on a laptop (npm run dev). Each
  // refuses the other's database, bot and address.
  // "local" is the local edition (scripts/start.ts, npm start): one founder's own computer, its database a folder there.
  MQ_ENV: z.enum(["production", "dev", "local"]).default("dev"),
  PORT: z.coerce.number().int().default(8080),
  DATABASE_URL: z.string().min(1),
  // Optional on the local edition (their own bot, if they want Telegram at all), required elsewhere.
  TELEGRAM_BOT_TOKEN: z.string().min(20).optional(),
  TELEGRAM_WEBHOOK_SECRET: z.string().min(16).optional(),
  // What signs the links to their pages (credits, reports) when there is no bot token to sign them with: the local edition's.
  QUEST_SECRET: z.string().min(16).optional(),
  // The local edition's anonymous key for the shared database of people, and where that database is (Quest's server).
  QUEST_INSTALL_KEY: z.string().regex(/^[\w-]{20,64}$/).optional(),
  PEOPLE_SERVER: z.string().url().default("https://mq-v2-agent.fly.dev"),
  // Needed unless MODELS=claude-cli, which makes no call to OpenRouter.
  OPENROUTER_API_KEY: z.string().min(10).optional(),
  // Where the model calls go: OpenRouter, or (dev only) the Claude subscription logged in on this laptop, through the Claude
  // Code CLI the Agent SDK ships (agents/claude-cli-models.ts), with voice heard by a Whisper on this machine
  // (infra/local-whisper.ts). Unset: production's OpenRouter, dev's Claude CLI, so dev testing costs nothing on OpenRouter
  // (the founder, 2026-11-03). Production refuses claude-cli (environments.ts).
  // codex-cli: the ChatGPT subscription logged in on this computer, through `codex exec` (agents/codex-cli-models.ts),
  // for the local edition; CODEX_CLI_SEATS names a model for a seat ("writer=gpt-6"), else Codex's own.
  MODELS: z.enum(["openrouter", "claude-cli", "codex-cli"]).optional(),
  CODEX_CLI_SEATS: z.string().default(""),
  // With claude-cli, each seat runs on Sonnet or Haiku (CLAUDE_SEATS in agents/claude-cli-models.ts); this moves one:
  // "writer=claude-opus-5-5,volume=claude-sonnet-5-5".
  CLAUDE_CLI_SEATS: z.string().default(""),
  // CLIs at once: each is a process of its own.
  CLAUDE_CLI_CALLS: z.coerce.number().int().positive().default(4),
  // The Whisper that hears voice with claude-cli (Hugging Face's ONNX builds, a "_timestamped" one for each word's time,
  // fetched once into ~/.cache/mq-whisper). Small: a 10 s voice message in 12 s on a laptop's CPU, where Large V3 Turbo
  // took a minute (FACTS.md).
  LOCAL_WHISPER_MODEL: z.string().default("onnx-community/whisper-small_timestamped"),
  // "polling" runs the agent on a laptop: it asks Telegram for updates and takes them away from the webhook. Unset:
  // production's webhook, dev's polling (dev's bot has no webhook).
  TELEGRAM_MODE: z.enum(["webhook", "polling"]).optional(),
  MQ_TEST_CUSTOMER: z.string().uuid().optional(),
  // Serves /debug/chrome/read, for measuring page shapes in a connected Chrome. Never on a deployed agent.
  CHROME_DEBUG: z.enum(["0", "1"]).default("0"),
  // The decisions: DeepSeek V4.1 Flash (FACTS.md, 2026-10-14: of the founder's five misread moments that day, the one
  // model that understood all five: "Mark Lou. ..." from a voice note as Marc Lou's bio, the screenshot as the example,
  // the card note, "English please"; one task for "find someone on X"; $0.0015 a turn against Haiku 5.5's $0.0045).
  MANAGER_MODEL: z.string().default("deepseek/deepseek-v4.1-flash"),
  MANAGER_FALLBACKS: z.string().default("anthropic/claude-haiku-5.5,openai/gpt-6-luna-pro"),
  // Sees for the team: the pictures they send, the posting browser, and the checks that a post went up. Claude
  // Haiku 5.5 (2026-10-14: read every line of Marc Lou's bio off a phone screenshot, where DeepSeek V4.1 Flash
  // missed the list and misread a number; vision structured output works on it).
  VISION_MODEL: z.string().default("anthropic/claude-haiku-5.5"),
  VISION_FALLBACKS: z.string().default("openai/gpt-6-luna-pro,xiaomi/mimo-v2.6-pro"),
  // MiMo V2.6 Pro scores with GLM 5.3 at about a tenth of its price (FACTS.md). A run it fails goes on with Claude
  // Haiku 5.5, which also reads the pictures of a page.
  RESEARCHER_MODEL: z.string().default("xiaomi/mimo-v2.6-pro"),
  RESEARCHER_FALLBACKS: z.string().default("anthropic/claude-haiku-5.5,deepseek/deepseek-v4.1-flash"),
  // Thinking before answering: off for the manager (125 s a step on MiMo, 8 s without), on for the teammates.
  MANAGER_REASONING: z.enum(["on", "off"]).default("off"),
  RESEARCHER_REASONING: z.enum(["on", "off"]).default("on"),
  // The cheap seat (FACTS.md: DeepSeek V4.1 Flash, $0.049 to $0.45 a million input tokens by provider, against MiMo's $0.435), for work where a slip costs little.
  VOLUME_MODEL: z.string().default("deepseek/deepseek-v4.1-flash"),
  VOLUME_FALLBACKS: z.string().default("xiaomi/mimo-v2.6-pro,z-ai/glm-5.3"),
  VOLUME_REASONING: z.enum(["on", "off"]).default("off"),
  // Writes every word that goes out as the customer (drafts/writer.ts). Claude Sonnet 5.5 (FACTS.md, 2026-10-14: of twelve
  // models on seventeen jobs, five of them in Spanish, German, Ukrainian and Portuguese, the closest to Opus 5.5 in voice and
  // in each language, at 0.28 cents a message against Opus's 0.97), then GPT-6 Luna Pro (0.05 cents, plainer) and Gemini
  // 3.8 Flash on other providers. WRITER_MODEL=anthropic/claude-opus-5.5 buys the best. They cannot stop thinking: low effort.
  WRITER_MODEL: z.string().default("anthropic/claude-sonnet-5.5"),
  WRITER_FALLBACKS: z.string().default("openai/gpt-6-luna-pro,google/gemini-3.8-flash"),
  WRITER_EFFORT: z.enum(["minimal", "low", "medium", "high"]).default("low"),
  // Moves a teammate to another seat without a deploy of code: "explorer=volume,scout=volume". Unset: each sits where its spec says.
  AGENT_SEATS: z.string().default(""),
  // Seats whose calls go to the cheapest provider first, discounts counted (DeepSeek V4.1 Flash at $0.02 a million
  // input tokens, cached as well). Not MiMo's: its cheapest provider did not cache (2026-10-14).
  CHEAPEST_SEATS: z.string().default("manager,volume"),
  // Hears voice messages. Whisper Large v3 Turbo: $0.0002 a minute, a 13 s message heard in 1.4 s, right in English and Russian (FACTS.md); GPT-4o Mini Transcribe (OpenAI's own) if it fails.
  TRANSCRIBE_MODEL: z.string().default("openai/whisper-large-v3-turbo"),
  TRANSCRIBE_FALLBACKS: z.string().default("openai/gpt-4o-mini-transcribe"),
  // Reads public pages and searches the web while the customer's Chrome is closed. Unset: only their Chrome reads.
  TAVILY_API_KEY: z.string().optional(),
  // What one customer may spend of Tavily's credits a day (a search or a page read is one).
  TAVILY_CREDITS_PER_DAY: z.coerce.number().int().positive().default(60),
  HEARTBEAT_MINUTES: z.coerce.number().positive().default(60),
  TASK_CONCURRENCY: z.coerce.number().int().positive().default(4),
  TASKS_PER_CUSTOMER: z.coerce.number().int().positive().default(2),
  MANAGER_CONCURRENCY: z.coerce.number().int().positive().default(4),
  QUESTIONS_AT_ONCE: z.coerce.number().int().positive().default(3),
  CARDS_AT_ONCE: z.coerce.number().int().positive().default(3),
  // Jobs a customer's Chrome takes at once, each in a tab of its own, on different sites (chrome/broker.ts).
  CHROME_TABS: z.coerce.number().int().min(1).max(4).default(3),
  // Always exploring (tasks/rotation.ts): while their Chrome is open, code keeps their run slots busy with outreach on
  // the platforms they show up on, in turn. "1" on, "0" off; unset: on for dev (the founder, 2026-11-04: "much more
  // active ... exploring all the time"), off for production, where every run is paid for.
  ALWAYS_EXPLORING: z.enum(["0", "1"]).optional(),
  // Pages their Chrome reads in a day (the extension holds to what the agent says, x-mq-pages). Unset: 800, or 5,000
  // while always exploring (live, 2026-11-14: 3,000 were read by 20:20 UTC, and nothing was read until midnight).
  CHROME_PAGES_A_DAY: z.coerce.number().int().min(50).max(5_000).optional(),
  // Where the agent listens, for the database's wake job. Unset: nothing wakes it but its own traffic.
  PUBLIC_URL: z.string().url().optional(),
  // The customer's own page (a Telegram Mini App) the Quest button opens. Telegram takes only https: unset, it is
  // PUBLIC_URL/glass when that is https. On a laptop, npm run dev points it at a tunnel of its own (scripts/dev-tunnel.ts),
  // so the dev bot has the page and the button without registering a wake address.
  MINI_APP_URL: z.string().url().optional(),
  SLEEP_AFTER_MINUTES: z.coerce.number().positive().default(2),
  // Credit packs through Stripe (billing/checkout.ts). Unset: Quest still rests at the day's limit, and its credits page
  // shows the packs, but nothing can be bought. The webhook secret is the endpoint's (scripts/stripe-setup.ts writes it).
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  // Everyone's day's limit in dollars (billing/plans.ts, $5): a laptop agent can make a day short, to see it run out.
  DAY_LIMIT_USD: z.coerce.number().positive().optional(),
  FLY_APP_NAME: z.string().optional(),
  FLY_MACHINE_ID: z.string().optional(),
});

export interface Config {
  /** Production (the Fly app) or dev (a laptop); environments.ts keeps them apart. */
  readonly stage: Stage;
  readonly testCustomer: string | null;
  readonly port: number;
  readonly databaseUrl: string;
  /** Their Telegram bot; an empty token on a local edition without one. */
  readonly telegram: { readonly token: string; readonly webhookSecret: string; readonly mode: "webhook" | "polling" };
  /** What signs the links to their pages: the bot's token, or the local edition's own secret. */
  readonly linkSecret: string;
  /** The local edition (MQ_ENV=local): one founder's computer, no Fly, no wake job, Telegram optional. */
  readonly local: boolean;
  /** Where the local edition shares the public people it finds, and its key there; null elsewhere (the hosted agent is that database). */
  readonly sharedPeople: { readonly server: string; readonly installKey: string } | null;
  readonly chromeDebug: boolean;
  /** Where the model calls go (MODELS, model-source.ts): OpenRouter, or the Claude CLI on a dev laptop with a local Whisper for voice. */
  readonly models:
    | { readonly via: "openrouter"; readonly key: string }
    | { readonly via: "claude-cli" | "codex-cli"; readonly seats: Readonly<Partial<Record<ModelRole, string>>>; readonly callsAtOnce: number; readonly whisper: string };
  readonly seats: Readonly<Record<ModelRole, ModelSeat>>;
  /** Teammates moved to another seat than their spec's, by name. */
  readonly agentSeats: Readonly<Record<string, ModelRole>>;
  /** The speech-to-text models voice messages go to, in order. */
  readonly transcribeModels: readonly string[];
  /** Set when there is a Tavily key: public reading then runs with the customer's Chrome closed. */
  readonly tavily: { readonly key: string; readonly creditsPerDay: number } | null;
  readonly heartbeatMs: number;
  readonly taskConcurrency: number;
  readonly tasksPerCustomer: number;
  readonly managerConcurrency: number;
  readonly questionsAtOnce: number;
  /** Find cards open in the chat at once; the next follows as the customer decides. */
  readonly cardsAtOnce: number;
  /** Jobs their Chrome takes at once, each in a tab of its own; never two on one site. */
  readonly chromeTabs: number;
  readonly alwaysExploring: boolean;
  readonly chromePagesADay: number;
  /** Where the agent is reached from outside: the database's wake job, and the links in the Chrome setup. */
  readonly publicUrl: string | null;
  /** Where the database's wake job calls: production's address. Dev registers none: a laptop does not sleep. */
  readonly wakeUrl: string | null;
  /** The base of the pages the Chrome setup links to: the public address, or this machine's. */
  readonly pagesUrl: string;
  /** The customer's own page the Quest button opens; null when there is no https address for it. */
  readonly miniAppUrl: string | null;
  readonly sleepAfterMs: number;
  /** Stripe's keys; null while it is not set up. */
  readonly stripe: { readonly secretKey: string; readonly webhookSecret: string | null } | null;
  /** Everyone's day's limit in dollars, where it differs from billing/plans.ts. */
  readonly dayLimitUsd: number | null;
  /** Set on a Fly Machine, which can suspend itself. */
  readonly fly: { readonly app: string; readonly machineId: string } | null;
  /** Who holds a lease: this machine and process. */
  readonly worker: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const e = Env.parse(env);
  const cheapest = new Set(list(e.CHEAPEST_SEATS));
  const stage: Stage = e.MQ_ENV;
  const telegramMode = e.TELEGRAM_MODE ?? (stage === "production" ? "webhook" : "polling");
  const publicUrl = e.PUBLIC_URL?.replace(/\/+$/, "") ?? null;
  const via = e.MODELS ?? (stage === "production" ? "openrouter" : "claude-cli");
  const always = (e.ALWAYS_EXPLORING ?? (stage === "dev" ? "1" : "0")) === "1";
  const problems = stageProblems(stage, {
    databaseUrl: e.DATABASE_URL,
    telegramMode,
    publicUrl,
    chromeDebug: e.CHROME_DEBUG === "1",
    testCustomer: e.MQ_TEST_CUSTOMER ?? null,
    stripeKey: e.STRIPE_SECRET_KEY,
    flyApp: e.FLY_APP_NAME ?? null,
    models: via,
  });
  if (stage !== "local" && (!e.TELEGRAM_BOT_TOKEN || !e.TELEGRAM_WEBHOOK_SECRET)) problems.push("TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET are required (optional only on the local edition)");
  if (stage === "local" && !e.TELEGRAM_BOT_TOKEN && !e.QUEST_SECRET) problems.push("the local edition needs QUEST_SECRET (npm start makes one) when there is no Telegram bot");
  if (problems.length) throw new WrongStage(stage, problems);
  const openRouterKey = e.OPENROUTER_API_KEY;
  if (via === "openrouter" && !openRouterKey) throw new Error("OPENROUTER_API_KEY is required (or MODELS=claude-cli on a dev laptop)");
  return {
    stage,
    testCustomer: e.MQ_TEST_CUSTOMER ?? null,
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    telegram: { token: e.TELEGRAM_BOT_TOKEN ?? "", webhookSecret: e.TELEGRAM_WEBHOOK_SECRET ?? e.QUEST_SECRET ?? "", mode: telegramMode },
    linkSecret: e.TELEGRAM_BOT_TOKEN ?? e.QUEST_SECRET ?? "",
    local: stage === "local",
    sharedPeople: stage === "local" && e.QUEST_INSTALL_KEY ? { server: e.PEOPLE_SERVER, installKey: e.QUEST_INSTALL_KEY } : null,
    chromeDebug: e.CHROME_DEBUG === "1",
    models:
      via === "openrouter" && openRouterKey
        ? { via: "openrouter", key: openRouterKey }
        : via === "codex-cli"
          ? { via: "codex-cli", seats: claudeSeats(e.CODEX_CLI_SEATS), callsAtOnce: e.CLAUDE_CLI_CALLS, whisper: e.LOCAL_WHISPER_MODEL }
          : { via: "claude-cli", seats: claudeSeats(e.CLAUDE_CLI_SEATS), callsAtOnce: e.CLAUDE_CLI_CALLS, whisper: e.LOCAL_WHISPER_MODEL },
    seats: {
      manager: { id: e.MANAGER_MODEL, fallbacks: list(e.MANAGER_FALLBACKS), maxTokens: 8_000, temperature: 0.4, reasoning: e.MANAGER_REASONING === "on", cheapest: cheapest.has("manager") },
      researcher: { id: e.RESEARCHER_MODEL, fallbacks: list(e.RESEARCHER_FALLBACKS), maxTokens: 12_000, temperature: 0.2, reasoning: e.RESEARCHER_REASONING === "on", cheapest: cheapest.has("researcher") },
      volume: { id: e.VOLUME_MODEL, fallbacks: list(e.VOLUME_FALLBACKS), maxTokens: 8_000, temperature: 0.2, reasoning: e.VOLUME_REASONING === "on", cheapest: cheapest.has("volume") },
      writer: { id: e.WRITER_MODEL, fallbacks: list(e.WRITER_FALLBACKS), maxTokens: 1_200, temperature: 0.6, reasoning: true, effort: e.WRITER_EFFORT, cheapest: cheapest.has("writer") },
      vision: { id: e.VISION_MODEL, fallbacks: list(e.VISION_FALLBACKS), maxTokens: 8_000, temperature: 0.2, reasoning: false, cheapest: cheapest.has("vision") },
    },
    agentSeats: agentSeats(e.AGENT_SEATS),
    transcribeModels: [e.TRANSCRIBE_MODEL, ...list(e.TRANSCRIBE_FALLBACKS)],
    tavily: e.TAVILY_API_KEY?.trim() ? { key: e.TAVILY_API_KEY.trim(), creditsPerDay: e.TAVILY_CREDITS_PER_DAY } : null,
    heartbeatMs: e.HEARTBEAT_MINUTES * 60_000,
    taskConcurrency: e.TASK_CONCURRENCY,
    tasksPerCustomer: e.TASKS_PER_CUSTOMER,
    managerConcurrency: e.MANAGER_CONCURRENCY,
    questionsAtOnce: e.QUESTIONS_AT_ONCE,
    cardsAtOnce: e.CARDS_AT_ONCE,
    chromeTabs: e.CHROME_TABS,
    alwaysExploring: always,
    chromePagesADay: e.CHROME_PAGES_A_DAY ?? (always ? 5_000 : 800),
    publicUrl,
    wakeUrl: stage === "production" ? publicUrl : null,
    pagesUrl: publicUrl ?? (e.PORT === 8080 ? DEV.url : `http://localhost:${e.PORT}`),
    miniAppUrl: miniApp(e.MINI_APP_URL, e.PUBLIC_URL),
    sleepAfterMs: e.SLEEP_AFTER_MINUTES * 60_000,
    stripe: e.STRIPE_SECRET_KEY?.trim() ? { secretKey: e.STRIPE_SECRET_KEY.trim(), webhookSecret: e.STRIPE_WEBHOOK_SECRET?.trim() || null } : null,
    dayLimitUsd: e.DAY_LIMIT_USD ?? null,
    fly: e.FLY_APP_NAME && e.FLY_MACHINE_ID ? { app: e.FLY_APP_NAME, machineId: e.FLY_MACHINE_ID } : null,
    worker: `${e.FLY_MACHINE_ID ?? hostname()}:${process.pid}`,
  };
}

/** Where the Quest button opens their page: MINI_APP_URL, else PUBLIC_URL's /glass; only an https address, as Telegram wants. */
export function miniApp(explicit: string | undefined, publicUrl: string | undefined): string | null {
  const url = explicit?.trim() || (publicUrl ? `${publicUrl.replace(/\/+$/, "")}/glass` : "");
  return url.startsWith("https://") ? url : null;
}

/** "manager=claude-sonnet-5-5, volume=claude-haiku-5-5" → each seat's Claude model on the CLI; an unknown seat stops the agent at start. */
export function claudeSeats(raw: string): Partial<Record<ModelRole, string>> {
  const out: Partial<Record<ModelRole, string>> = {};
  for (const pair of list(raw)) {
    const [role, model] = pair.split("=").map((x) => x.trim());
    if (!role || !model || !(MODEL_ROLES as readonly string[]).includes(role)) {
      throw new Error(`CLAUDE_CLI_SEATS: "${pair}" is not seat=model with a seat of ${MODEL_ROLES.join(", ")}`);
    }
    out[role as ModelRole] = model;
  }
  return out;
}

/** "explorer=volume, scout=researcher" → { explorer: "volume", scout: "researcher" }; an unknown seat stops the agent at start. */
export function agentSeats(raw: string): Record<string, ModelRole> {
  const seats: Record<string, ModelRole> = {};
  for (const pair of list(raw)) {
    const [agent, role] = pair.split("=").map((x) => x.trim());
    if (!agent || !role || !(MODEL_ROLES as readonly string[]).includes(role)) {
      throw new Error(`AGENT_SEATS: "${pair}" is not agent=seat with a seat of ${MODEL_ROLES.join(", ")}`);
    }
    seats[agent] = role as ModelRole;
  }
  return seats;
}
