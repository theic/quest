import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import { botProblem, DEV, PRODUCTION, stageOfDatabase, stageProblems, supabaseRef, WrongStage } from "../src/environments.ts";

const pooler = (ref: string) => `postgresql://mq_app.${ref}:secret@aws-0-eu-central-1.pooler.supabase.com:5432/postgres`;
const PROD_DB = pooler(PRODUCTION.supabase);
const DEV_DB = pooler(DEV.supabase);

const base = {
  TELEGRAM_BOT_TOKEN: "123456:abcdefghijklmnopqrstuvwxyz",
  TELEGRAM_WEBHOOK_SECRET: "0123456789abcdef0123",
  OPENROUTER_API_KEY: "sk-or-0123456789",
};
const production = { ...base, MQ_ENV: "production", DATABASE_URL: PROD_DB, PUBLIC_URL: PRODUCTION.url, FLY_APP_NAME: PRODUCTION.flyApp, FLY_MACHINE_ID: "m1" };
const dev = { ...base, MQ_ENV: "dev", DATABASE_URL: DEV_DB };

describe("which database an address points at", () => {
  it("reads the Supabase project from the pooler's user or a direct host", () => {
    expect(supabaseRef(PROD_DB)).toBe(PRODUCTION.supabase);
    expect(supabaseRef(`postgresql://postgres:pw@db.${DEV.supabase}.supabase.co:5432/postgres`)).toBe(DEV.supabase);
    expect(supabaseRef("postgresql://postgres:postgres@127.0.0.1:54322/postgres")).toBeNull();
    expect(supabaseRef("not a url")).toBeNull();
    expect(stageOfDatabase(PROD_DB)).toBe("production");
    expect(stageOfDatabase(DEV_DB)).toBe("dev");
    expect(stageOfDatabase("postgresql://localhost/mq")).toBeNull();
  });
});

describe("production and dev, kept apart", () => {
  it("starts production only on its Fly app, with its database, webhook and address", () => {
    const c = loadConfig(production);
    expect(c.stage).toBe("production");
    expect(c.telegram.mode).toBe("webhook");
    expect(c.wakeUrl).toBe(PRODUCTION.url);
    expect(c.models.via).toBe("openrouter");

    for (const [change, problem] of [
      [{ FLY_APP_NAME: undefined }, /only on the Fly app/],
      [{ DATABASE_URL: DEV_DB }, new RegExp(`must be Supabase ${PRODUCTION.supabase} \\(it is ${DEV.supabase}\\)`)],
      [{ TELEGRAM_MODE: "polling" }, /would delete it/],
      [{ PUBLIC_URL: DEV.url }, /PUBLIC_URL must be/],
      [{ CHROME_DEBUG: "1" }, /CHROME_DEBUG/],
      [{ MQ_TEST_CUSTOMER: "00000000-0000-4000-8000-000000000000" }, /MQ_TEST_CUSTOMER/],
      [{ MODELS: "claude-cli" }, /own Claude subscription/],
    ] as const) {
      expect(() => loadConfig({ ...production, ...change }), JSON.stringify(change)).toThrow(problem);
    }
  });

  it("starts a laptop agent as dev unless told otherwise: polling, its pages on localhost, no wake address", () => {
    const c = loadConfig({ ...dev, MQ_ENV: undefined });
    expect(c.stage).toBe("dev");
    expect(c.telegram.mode).toBe("polling");
    expect(c.pagesUrl).toBe(DEV.url);
    expect(c.wakeUrl).toBeNull();
    // A tunnel for the Mini App is still dev's, and still registers no wake address.
    expect(loadConfig({ ...dev, PUBLIC_URL: "https://dev-tunnel.example" }).wakeUrl).toBeNull();
    // On the Claude subscription unless told otherwise, so a dev agent needs no OpenRouter key.
    expect(c.models.via).toBe("claude-cli");
    expect(loadConfig({ ...dev, OPENROUTER_API_KEY: undefined }).models.via).toBe("claude-cli");
    expect(loadConfig({ ...dev, MODELS: "openrouter" }).models.via).toBe("openrouter");
    expect(() => loadConfig({ ...dev, OPENROUTER_API_KEY: undefined, MODELS: "openrouter" })).toThrow(/OPENROUTER_API_KEY is required/);
  });

  it("refuses production's database, address and live money on a dev agent", () => {
    expect(() => loadConfig({ ...dev, DATABASE_URL: PROD_DB })).toThrow(WrongStage);
    expect(() => loadConfig({ ...dev, DATABASE_URL: PROD_DB })).toThrow(/production's database/);
    expect(() => loadConfig({ ...dev, PUBLIC_URL: `${PRODUCTION.url}/` })).toThrow(/production's address/);
    expect(() => loadConfig({ ...dev, STRIPE_SECRET_KEY: "sk_live_123" })).toThrow(/live key/);
    expect(() => loadConfig({ ...dev, FLY_APP_NAME: PRODUCTION.flyApp })).toThrow(/MQ_ENV=production/);
    expect(loadConfig({ ...dev, STRIPE_SECRET_KEY: "sk_test_123" }).stripe?.secretKey).toBe("sk_test_123");
    // A local database is a dev one.
    expect(stageProblems("dev", { databaseUrl: "postgresql://postgres@127.0.0.1:54322/postgres", telegramMode: "polling", publicUrl: null, chromeDebug: true, testCustomer: null, stripeKey: undefined, flyApp: null })).toEqual([]);
  });

  it("runs each bot only where it belongs", () => {
    expect(botProblem("production", PRODUCTION.bot)).toBeNull();
    expect(botProblem("production", DEV.bot)).toMatch(/production's bot is @messagingquestbot/);
    expect(botProblem("dev", DEV.bot)).toBeNull();
    expect(botProblem("dev", "MessagingQuestBot")).toMatch(/production's bot/);
    expect(botProblem("dev", "SomeoneElsesTestBot")).toBeNull();
  });
});
