/**
 * The composition root: the only place that knows which adapter stands behind
 * which port. Everything else receives its collaborators through its constructor.
 */
import { lookup } from "node:dns/promises";
import { SharedPeople } from "./infra/shared-people.ts";
import { peopleRoutes } from "./http/people-routes.ts";
import { PanelSettings } from "./conversation/panel-settings.ts";
import { serve } from "@hono/node-server";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { draftId, findId, HostGuard, platformFor, type BrowserView, type CustomerId, type SpendLog, trustKey, type TrustRepository } from "@mq/core";
import { modelsFor, transcriberFor } from "./model-source.ts";
import { Checkout } from "./billing/checkout.ts";
import { Energy } from "./billing/energy.ts";
import { CreditWords } from "./billing/credit-words.ts";
import { PlanLinks } from "./billing/plans.ts";
import { BROKER_DEFAULTS, ChromeBroker, QUIET } from "./chrome/broker.ts";
import { CustomerBrowser } from "./chrome/browser.ts";
import { BrowserPoster } from "./chrome/browser-poster.ts";
import { BrowserVision } from "./chrome/browser-vision.ts";
import { SiteLanes } from "./chrome/site-lanes.ts";
import { outreachSpec } from "./tasks/outreach.ts";
import { ChromeLinkService } from "./chrome/link-service.ts";
import { ChromeReach } from "./chrome/reach.ts";
import { loadConfig } from "./config.ts";
import { botProblem, WrongStage } from "./environments.ts";
import { ChannelRegistry } from "./conversation/channel-registry.ts";
import { ChatNews, WebChannel } from "./conversation/web-channel.ts";
import { ExtensionChat } from "./conversation/extension-chat.ts";
import { InboundService } from "./conversation/inbound-service.ts";
import { WayIn } from "./conversation/way-in.ts";
import { ModelPictureReader } from "./conversation/pictures.ts";
import { Answering } from "./conversation/answering.ts";
import { IntakeService } from "./conversation/intake.ts";
import { ModelIntakeGuesser } from "./conversation/intake-guess.ts";
import { Messenger } from "./conversation/messenger.ts";
import { chromeDebugRoutes, chromeRoutes } from "./http/chrome-routes.ts";
import { glassRoutes } from "./http/glass-routes.ts";
import { Acquaintances } from "./contacts/acquaintances.ts";
import { PgContacts } from "./infra/pg-contacts.ts";
import { PgSaidNo } from "./infra/pg-said-no.ts";
import { SaidNo } from "./contacts/said-no.ts";
import { emailCompose, theirChannel } from "./contacts/their-channel.ts";
import { quoteAppears } from "./tasks/seen-pages.ts";
import { leadCheck } from "./finds/lead-check.ts";
import { picturesOn, PostShots } from "./chrome/post-shots.ts";
import { Power } from "./lifecycle/power.ts";
import { productNames, saysYes, titled, WarmUp } from "./drafts/warm-up.ts";
import { IdeaService } from "./ideas/idea-service.ts";
import { PgAssetRepository, PgIdeaRepository } from "./infra/pg-ideas.ts";
import { planRoutes } from "./http/plan-routes.ts";
import { unsubscribeRoutes } from "./http/unsubscribe-routes.ts";
import { createServer } from "./http/server.ts";
import { createPool, keepUpWhenSavesFail } from "./infra/db.ts";
import { FlyMachine, stayAwake } from "./infra/fly-machine.ts";
import { PgAccounts } from "./infra/pg-accounts.ts";
import { PgBilling } from "./infra/pg-billing.ts";
import { PgChromeLinks } from "./infra/pg-chrome-links.ts";
import { PgCustomerRepository } from "./infra/pg-customers.ts";
import { PgEventQueue } from "./infra/pg-events.ts";
import { PgDraftRepository } from "./infra/pg-drafts.ts";
import { PgFindRepository } from "./infra/pg-finds.ts";
import { PgGlass } from "./infra/pg-glass.ts";
import { PgTrustRepository } from "./infra/pg-trust.ts";
import { PgSpendLog } from "./infra/pg-spend.ts";
import { PgDayLedger, PgMemoryRepository } from "./infra/pg-memory.ts";
import { PgPlaceRepository } from "./infra/pg-places.ts";
import { PgCommitmentRepository } from "./infra/pg-commitments.ts";
import { PgResultRepository, PgRouteRepository } from "./infra/pg-results.ts";
import { PgQuestionRepository } from "./infra/pg-questions.ts";
import { PgBoards } from "./infra/pg-boards.ts";
import { PgDecks } from "./infra/pg-decks.ts";
import { PgInvites } from "./infra/pg-invites.ts";
import { askActs, Deck } from "./asks/deck.ts";
import { PgSearches } from "./infra/pg-searches.ts";
import { PgTaskStore } from "./infra/pg-tasks.ts";
import { PgTranscript } from "./infra/pg-transcript.ts";
import { PgWakeSchedule } from "./infra/pg-wake.ts";
import { StripeApi } from "./infra/stripe.ts";
import { JsonLogger, systemClock } from "./infra/system.ts";
import { Errands } from "./lifecycle/errands.ts";
import { randomBytes } from "node:crypto";
import { customerLocale, forLanguage, systemMessage } from "@mq/i18n";
import { ACROSS_GAP_MAX_MS, Outbox, SITE_GAP_MAX_MS, SKIM_MS } from "./drafts/outbox.ts";
import { PgOutbox } from "./infra/pg-outbox.ts";
import { IdleSleeper } from "./lifecycle/idle-sleeper.ts";
import { Traffic } from "./lifecycle/traffic.ts";
import { Autopilot, platformName } from "./drafts/autopilot.ts";
import { whoKey } from "./drafts/one-reply.ts";
import { DraftService } from "./drafts/draft-service.ts";
import { voiceFrom, writtenLately, Writer } from "./drafts/writer.ts";
import { FirstSweep } from "./finds/sweep.ts";
import { PairFinder } from "./finds/pair-finder.ts";
import { FollowUps } from "./finds/follow-ups.ts";
import { metNote, pageCode } from "./conversation/met-notes.ts";
import { OutList, type OutListChannel } from "./drafts/out-list.ts";
import { asksBot, Brakes } from "./drafts/brakes.ts";
import { daySample, needsYou } from "./manager/day-sample.ts";
import { reportHtml } from "./manager/day-report.ts";
import { PgReports } from "./infra/pg-reports.ts";
import { reportRoutes } from "./http/report-routes.ts";
import { namesTheirs } from "./drafts/warm-up.ts";
import { PgDraftMarks } from "./infra/pg-draft-marks.ts";
import { atTheirTime, theirHour, wall } from "./lib/their-time.ts";
import { doneDraft, pagePeople, everyoneFor, introductionDraft, Introducer, introsOf, linkStep, linksOf, MATCH_MAX, MATCH_MIN, nameDraft, pageDraft, stepTwoDraft } from "./finds/introducer.ts";
import { handleOf } from "./contacts/handles.ts";
import { matchPageUrl, PgKnownPeople } from "./infra/pg-known.ts";
import { PlayFinder } from "./finds/play-finder.ts";
import { FindService } from "./finds/find-service.ts";
import { AnswerReader } from "./finds/answer-reader.ts";
import { ReplyWatch } from "./finds/reply-watch.ts";
import { EXPLORING_STARTS_A_DAY, LOOK_BACK, Rotation } from "./tasks/rotation.ts";
import { modelRest } from "./lib/model-rest.ts";
import { fediverseHome } from "./chrome/fediverse.ts";
import { HeldCheck } from "./drafts/held-check.ts";
import { HeartbeatScheduler } from "./manager/heartbeat.ts";
import { ManagerLoop } from "./manager/manager-loop.ts";
import { ManagerTurn } from "./manager/manager-turn.ts";
import { Commitments } from "./manager/commitments.ts";
import { QuestionService } from "./questions/question-service.ts";
import { publicSourceList } from "./sources/registry.ts";
import { explorerSpec } from "./tasks/explorer.ts";
import { researcherSpec } from "./tasks/researcher.ts";
import { scoutSpec } from "./tasks/scout.ts";
import { SubagentCatalog } from "./tasks/subagents.ts";
import { TaskBoard } from "./tasks/task-board.ts";
import { TaskRunner } from "./tasks/task-runner.ts";
import { TaskService } from "./tasks/task-service.ts";
import { TelegramBotApi } from "./telegram/bot-api.ts";
import { TelegramPoller } from "./telegram/poller.ts";
import { TelegramChannel } from "./telegram/telegram-channel.ts";
import { RoutedReach } from "./web/routed-reach.ts";
import { DailyCredits, TavilyClient } from "./web/tavily-client.ts";
import { TavilyReach } from "./web/tavily-reach.ts";

const config = loadConfig();
const log = new JsonLogger({ worker: config.worker, stage: config.stage });

// Production runs @messagingquestbot and dev never does (environments.ts): a laptop polling production's bot would
// delete its webhook and take every customer's messages. Known before anything touches the bot or the database.
const telegram = new TelegramBotApi(config.telegram.token);
// The local edition may have no bot at all (Telegram is their optional remote control): then nothing asks Telegram.
const withTelegram = Boolean(config.telegram.token);
const bot = !withTelegram ? null : await telegram.getMe().catch((e: unknown) => {
  // A laptop cannot poll without Telegram anyway; production keeps serving its webhook through an outage of getMe.
  if (config.stage !== "production") throw e;
  log.warn("agent.bot_unchecked", { error: e instanceof Error ? e.message : String(e) });
  return null;
});
const wrongBot = bot ? botProblem(config.stage, bot.username) : null;
if (wrongBot) throw new WrongStage(config.stage, [wrongBot]);

// The local edition's database (PGlite) is one session behind its socket, which queues each protocol message from
// every connection into it: two connections' prepared statements and transactions run into each other (live,
// 2026-11-20: "bind message supplies 4 parameters, but prepared statement requires 1" ended the first run). One
// connection, so each query and transaction goes whole, in turn.
const pool = createPool(config.databaseUrl, config.local ? 1 : 8, log);
keepUpWhenSavesFail(log);
// The checkpoint tables come from supabase/migrations: setup() would need rights mq_app does not have.
const checkpointer = new PostgresSaver(pool, undefined, { schema: "mq" });
await pool.query("select 1 from mq.checkpoints limit 0");

// Stores
// Kept a minute: read about 16 times a minute while their work runs (pg-customers.ts).
const customers = new PgCustomerRepository(pool, "live", 60_000);
// Every message Quest writes, wherever it goes, is news for the chat in their extension's popup (web-channel.ts).
const chatNews = new ChatNews();
const transcript = new (class extends PgTranscript {
  override async recordOutgoing(...args: Parameters<PgTranscript["recordOutgoing"]>): Promise<void> {
    await super.recordOutgoing(...args);
    chatNews.bump(args[0]);
  }
})(pool);
const events = new PgEventQueue(pool, "live", config.testCustomer);
const taskStore = new PgTaskStore(pool, "live", config.testCustomer);
const questionStore = new PgQuestionRepository(pool);
const findStore = new PgFindRepository(pool);
// Lists many loops read every few seconds are kept in memory for 5 min (read-cache.ts): drafts patched by each write,
// results and contacts forgotten on each write. Only this process writes them.
const LISTS_KEPT_MS = 5 * 60_000;
const draftStore = new PgDraftRepository(pool, "live", LISTS_KEPT_MS);
const places = new PgPlaceRepository(pool);
const memory = new PgMemoryRepository(pool);
const day = new PgDayLedger(pool);
const chromeLinks = new PgChromeLinks(pool);
const trust = new PgTrustRepository(pool);
const results = new PgResultRepository(pool, LISTS_KEPT_MS);
// The people Quest gets to know for them, kept for good, and how close it is with each (contacts/acquaintances.ts).
const people = new Acquaintances({ contacts: new PgContacts(pool, LISTS_KEPT_MS), drafts: draftStore, results, clock: systemClock });
const routes = new PgRouteRepository(pool);

// The outside world. Pages, Reddit and web search are read in each customer's own Chrome;
// a page read there must be on the public internet, never on their own network.
const telegramChannel = new TelegramChannel(telegram, async (to) => (await customers.findByChannel(to))?.language ?? null, { appUrl: config.miniAppUrl, pagesUrl: config.pagesUrl });
const webChannel = new WebChannel({ customers, news: chatNews });
const channels = new ChannelRegistry([telegramChannel, webChannel]);
// While they answer a first-day card, their Chrome takes no work (conversation/answering.ts).
const answering = new Answering(systemClock);
const broker = new ChromeBroker(config.chromeDebug ? { ...BROKER_DEFAULTS, jobTimeoutMs: 300_000 } : BROKER_DEFAULTS, Date.now, { hold: answering });
answering.whenChanged((id) => broker.recheck(id));
const guard = new HostGuard({ resolve: async (host) => (await lookup(host, { all: true })).map((a) => a.address), unresolved: "refuse" });
const chromeReach = new ChromeReach(broker, guard, publicSourceList(), log);
// With a Tavily key, public pages and web search also run while the customer's Chrome is closed.
const reach = config.tavily
  ? new RoutedReach({
      chrome: chromeReach,
      tavily: new TavilyReach({ client: new TavilyClient(config.tavily.key), guard, credits: new DailyCredits(config.tavily.creditsPerDay), log }),
      log,
    })
  : chromeReach;
// OpenRouter, or on a dev laptop with MODELS=claude-cli the Claude subscription and a Whisper of its own (model-source.ts).
const models = await modelsFor(config, { log });
const catalog = new SubagentCatalog([researcherSpec({ needsChrome: !config.tavily }), scoutSpec(), explorerSpec(), outreachSpec()]);
// What every model call used and cost, a row each in mq.model_calls (mq.model_spend sums them by day); and each
// customer's day looked at after their calls: past their plan's credits, Quest rests until their midnight (billing/).
const spendRows = new PgSpendLog(pool, log);
const spend: SpendLog = {
  record: (call) => {
    spendRows.record(call);
    if (call.customerId && (call.usage.cost ?? 0) > 0) energy.note(call.customerId);
  },
};
const vision = new BrowserVision(models, spend);
// Every word that goes out as the customer passes through the writer seat, with their voice in front of it.
const writer = new Writer({ models, voice: voiceFrom({ customers, memory, transcript, clock: systemClock }), lately: writtenLately({ drafts: draftStore, finds: findStore, clock: systemClock }), spend, log, roll: Math.random });
// A person's moment before each click, keystroke and scroll, never the same twice (the founder, 2026-11-04: "organically, with random
// pauses between actions").
const browser = new CustomerBrowser(broker, guard, vision, { pauses: { act: [1_200, 4_500], scroll: [700, 2_500] } });
const postShots = new PostShots({ browser, db: pool, log });
// The work going on, kept as it goes: their page draws it live, and their chat's Quest button says how many runs are at it.
const board = new TaskBoard({ channels, customers, boards: new PgBoards(pool), paces: (since) => taskStore.paces(since), clock: systemClock, log });
// What acts as the customer on a site goes there one at a time, in turn.
const lanes = new SiteLanes();
// A Mastodon post on another server is opened from the server their own account is on, as their memories name it.
const fediHome = async (id: CustomerId): Promise<string | null> => fediverseHome((await memory.list(id, 200)).map((m) => m.text));
const poster = new BrowserPoster({ browser, reddit: broker, models, log, spend, vision, lanes, progress: board, posting: (c, s, url) => broker.posting(c, s, url) });
poster.home = fediHome;

// The application
const messenger = new Messenger({ customers, channels, transcript, log });
// Pay as you go: free on an invite, or on a free start and credit packs bought through Stripe. Everyone's
// day has the same limit: reached, Quest rests until their midnight and their runs stop; out of credits, until a top-up.
const billing = new PgBilling(pool);
const planLinks = new PlanLinks(config.linkSecret, config.pagesUrl);
const reports = new PgReports(pool);
const panelSettings = new PanelSettings({
  customers,
  places,
  alone: (id, platform) => autopilot.alone(id, trustKey(platform)),
  reports: async (id) => (await reports.days(id)).map((day) => ({ day, url: planLinks.report(id, day) })),
  model: config.models.via === "claude-cli" ? "Your Claude subscription" : config.models.via === "codex-cli" ? "Your ChatGPT subscription" : "OpenRouter",
});
const creditWords = new CreditWords({ customers, messenger, events, links: planLinks, welcome: (id, said) => wayIn.welcome(id, said), clock: systemClock, log });
const invites = new PgInvites(pool);
const energy = new Energy({ billing, customers, words: creditWords, runs: { rest: (id, until) => runner.rest(id, until) }, ...(config.dayLimitUsd ? { dayLimitUsd: config.dayLimitUsd } : {}), clock: systemClock, log });
const stripe = config.stripe ? new StripeApi(config.stripe.secretKey) : null;
const checkout = stripe ? new Checkout({ stripe, billing, customers, credited: (id, top) => energy.toppedUp(id, top), log }) : null;
const chrome = new ChromeLinkService({
  links: chromeLinks,
  broker,
  messenger,
  events,
  wakeManager: () => manager.wake(),
  publicUrl: config.pagesUrl,
  clock: systemClock,
  log,
});
// Your move: everything that waits on them in one ranked line, one ask at a time in one message of their chat, which
// turns to the next on a tap (asks/deck.ts). Finds, drafts, the team's questions and Quest's ideas go there, not on
// cards of their own.
const ideaStore = new PgIdeaRepository(pool);
const deck = new Deck({
  customers,
  channels,
  store: new PgDecks(pool),
  finds: findStore,
  drafts: draftStore,
  questions: questionStore,
  ideas: ideaStore,
  // No offer to go alone any more: their own behaviour decides it (drafts/autopilot.ts), so the deck asks nothing of it.
  outbox: { waiting: (id) => outbox.waiting(id) },
  results,
  transcript,
  drawn: async (id) => {
    chatNews.bump(id);
  },
  acts: askActs(() => ({ finds, drafts, questions, ideas, autopilot })),
  clock: systemClock,
  log,
});
const questions = new QuestionService({
  questions: questionStore,
  tasks: taskStore,
  events,
  messenger,
  askCap: config.questionsAtOnce,
  log,
  deck,
});
// "Post it" posts in the customer's Chrome after the tap is answered; the agent stays up until it is done.
const errands = new Errands(log);
// Everything that goes out as them waits its turn here, and for their Chrome; it outlives a restart (drafts/outbox.ts).
// While they answer a first-day card, what is due waits with the rest of their Chrome's work.
const outbox = new Outbox(
  { store: new PgOutbox(pool), errands, online: (id) => broker.online(id), off: (id) => power.isOff(id), held: (id) => answering.until(id) !== null, stepWaiting: (id) => broker.stepWaiting(id), changed: (id) => outList.changed(id), clock: systemClock, log },
  // Never on a beat: each gap is drawn between its shortest and its longest. Words going up alone are shown first.
  { siteGapMaxMs: SITE_GAP_MAX_MS, acrossGapMaxMs: ACROSS_GAP_MAX_MS, skimMs: SKIM_MS },
);
// Quest asks before its first posts on a platform, and posts there by itself once they approved a few.
// Switched off (/off), nothing goes up, by itself or on a tap: `power` is made below, once the runner is.
const marks = new PgDraftMarks(pool);
// Brakes on bad signs: a kind stops on a platform for a day, and they are told.
const brakes = new Brakes({ db: pool, say: (id, text) => messenger.say(id, text), clock: systemClock, log });
await brakes.load();
// Their "go ahead" lifts a brake there too.
const trustForTurns: TrustRepository = {
  initialize: (c) => trust.initialize(c),
  approved: (c, p) => trust.approved(c, p),
  approve: (c, p) => trust.approve(c, p),
  alone: (c, p) => trust.alone(c, p),
  offered: (c) => trust.offered(c),
  answer: (c, p, yes) => trust.answer(c, p, yes),
  set: async (c, p, approved, explicit) => {
    await trust.set(c, p, approved, explicit);
    if (explicit && approved >= 3) await brakes.lift(c, p.startsWith("*") ? null : p.replace(/ (posts|likes|follows|messages)$/, ""));
  },
};
const autopilot = new Autopilot({ trust, messenger, clock: systemClock, off: (id) => power.isOff(id), brakes, record: (id, platform, kind) => marks.record(id, platform, kind) });
// Once a kind has earned it on a platform, Quest offers on Your move to do it there alone; only their yes lets it.
autopilot.offers = (id) => deck.changed(id);
// The product comes last: drafts and finds alike stay plain until a platform is warm and the person talks back.
const warmUp = new WarmUp({ customers, drafts: draftStore, finds: findStore, results, clock: systemClock });
// While a first-day card waits on them no find card goes out: the takes answer the first sweep's finds one at a time.
const finds = new FindService({ finds: findStore, drafts: draftStore, events, messenger, poster, errands, outbox, places, autopilot, writer, warmUp, cardsAtOnce: config.cardsAtOnce, deck, clock: systemClock, log });
// What Quest writes for the customer to post as themselves: a card each, with Post it, Edit and Skip.
// Voice messages are heard as they come in, and from then on count as typed; pictures and videos are looked at the same way.
const transcriber = await transcriberFor(config, { spend, log });
const pictures = new ModelPictureReader({ models, spend });
// What they share for their posts, and the ideas for them, theirs and Quest's.
const ideas = new IdeaService({ ideas: ideaStore, assets: new PgAssetRepository(pool), messenger, deck, channels, events, wakeManager: () => manager.wake(), clock: systemClock, log });
// A no takes them out of the people Quest knows too, and, from a local install, out of the shared list.
const saidNoStore = new PgSaidNo(pool);
const saidNo = new SaidNo({
  list: (customer) => saidNoStore.list(customer),
  add: async (customer, no) => {
    await saidNoStore.add(customer, no);
    await known.forget(no.site, no.person).catch(() => {});
  },
});
const drafts = new DraftService({ marks, saidNo, answeredSince: async (id, person, since) => { const k = whoKey(person); return k.length >= 3 && (await results.list(id, 300)).some((r) => r.stage === "conversation" && r.at > since && (whoKey(r.person) === k || whoKey(r.person).includes(k) || k.includes(whoKey(r.person) || "\u0000"))); }, drafts: draftStore, finds: findStore, places, messenger, deck, poster, errands, outbox, autopilot, writer, warmUp, people, files: { files: async (id, ids) => [...(await ideas.files(id, ids)), ...(await postShots.files(id, ids))] }, handOff: { mint: async (note) => { const code = await invites.mint(note); return code && config.stage === "dev" ? `t${code}` : code; }, seller: async (id) => /(^|[./])messaging\.quest\b/i.test((await customers.get(id)).siteUrl ?? "") }, clock: systemClock, log, events });
// "Here's what I'm sending": what goes up by itself is shown first, one message a day in their chat and a list in the panel.
const outList = new OutList({
  outbox: { waiting: (id) => outbox.waiting(id) },
  drafts: draftStore,
  channel: async (id) => {
    const to = await customers.primaryChannel(id);
    if (!to) return null;
    const channel = channels.get(to.kind) as unknown as Partial<OutListChannel>;
    return { to, list: typeof channel.showOutList === "function" ? (channel as OutListChannel) : null };
  },
  kept: {
    get: async (id) => (await pool.query<{ out_list: { ref: string; day: string } | null }>(`select out_list from mq.customers where id = $1`, [id])).rows[0]?.out_list ?? null,
    set: async (id, ref, day) => void (await pool.query(`update mq.customers set out_list = $2 where id = $1`, [id, JSON.stringify({ ref, day })])),
  },
  day: async (id) => new Date(wall(systemClock.now(), (await customers.get(id)).timezone)).toISOString().slice(0, 10),
  news: (id) => chatNews.bump(id),
  log,
});
outbox.serve("draft", drafts);
outbox.serve("find", finds);
// A Chrome back after a while: what waited for it goes now.
broker.whenOnline(() => void outbox.kick());
const tasks = new TaskService({ tasks: taskStore, questions: questionStore, answerer: questions, catalog });
// Once their first sweep ended: where they show up is read from their words, and the manager hears the setup is over.
const intake = new IntakeService({
  customers,
  events,
  wakeManager: () => manager.wake(),
  clock: systemClock,
  log,
  guesser: new ModelIntakeGuesser({ models, transcript, memory, spend, log }),
  answering,
});
// Someone new's first sweep: once their brief and their Chrome are there, the sites where their people ask, read by code.
const sweep = new FirstSweep({
  customers,
  reach,
  finds,
  memory,
  models,
  spend,
  messenger,
  online: (id) => broker.online(id),
  off: (id) => power.isOff(id),
  errands,
  progress: board,
  events,
  wakeManager: () => manager.wake(),
  // Its finds go to Your move first, then the manager hears the setup is over.
  after: async (id) => {
    await finds.show(id);
    await intake.begin(id);
  },
  clock: systemClock,
  log,
});
broker.whenOnline((id) => void sweep.maybeStart(id));
// Nobody waits: someone new is in at once, on an invite's code or a free start (conversation/way-in.ts).
// Where Quest met someone before they came in, by the code their link carried (a page made for them, a thread on dev).
const metNotes = new Map<CustomerId, string>();
const wayIn = new WayIn({ customers, invites, billing, transcript, channels, events, wake: (id) => manager.heard(id), log });
// A manager turn starts fresh from the database (the plan, what Quest keeps, the chat): no thread carries over.
const turn = new ManagerTurn({
  wayIn,
  ideas,
  browser,
  customers,
  tasks,
  questions,
  finds,
  drafts,
  trust: trustForTurns,
  places,
  afterReport: async (id) => {
    const c = await customers.get(id);
    const since = atTheirTime(systemClock.now(), c.timezone, 0);
    const sent = await marks.sent(id, since.getTime() > systemClock.now().getTime() ? new Date(since.getTime() - 86_400_000) : since);
    const asks = await deck.asks(id).catch(() => []);
    const draftsOf = asks.flatMap((a) => (a.kind === "draft" ? [a.draft] : a.kind === "group" ? a.drafts : []));
    const waiting = {
      total: asks.length,
      product: draftsOf.filter((d) => namesTheirs(d.text, c.siteUrl)).length,
      messages: draftsOf.filter((d) => d.kind === "message").length,
      profile: draftsOf.filter((d) => d.kind === "profile").length,
      people: draftsOf.filter((d) => d.kind === "reply" && /\?/.test(d.quote ?? "") && !namesTheirs(d.text, c.siteUrl)).length,
    };
    const paused = brakes.list(id).map((b) => `Paused: ${b.kind === "reply" ? "replies" : `${b.kind}s`} on ${platformName(b.platform)} until ${theirHour(b.until, systemClock.now(), c.timezone)} (${b.reason}).`);
    // One report a day, as a page kept for their settings (docs/next-goal-open-source.md, phase 2), linked from the chat.
    const now = systemClock.now();
    const dayStart = since.getTime() > now.getTime() ? new Date(since.getTime() - 86_400_000) : since;
    const tz = c.timezone ?? "UTC";
    const dayKey = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
    const [today, week, answered, recent, charts] = await Promise.all([
      reports.platforms(id, dayStart),
      reports.platforms(id, new Date(now.getTime() - 7 * 86_400_000)),
      reports.answered(id, dayStart),
      transcript.recent(id, 6),
      // The charts are a picture of the same numbers: a failure leaves the words.
      reports.charts(id, new Date(dayStart.getTime() - 13 * 86_400_000), dayStart, tz).catch((e) => (log.warn("report.charts_failed", { customerId: id, error: String(e) }), undefined)),
    ]);
    const news = [...recent].reverse().find((e) => e.direction === "out")?.text ?? null;
    const html = reportHtml({
      day: new Intl.DateTimeFormat(customerLocale(c.language), { timeZone: tz, weekday: "short", day: "numeric", month: "short" }).format(now),
      news,
      answered,
      today,
      week,
      ...(charts ? { charts } : {}),
      needs: needsYou(waiting),
      paused,
      sample: (daySample(sent, (words) => namesTheirs(words, c.siteUrl)) ?? "").split("\n").filter(Boolean),
    });
    await reports.save(id, dayKey, html);
    const t = forLanguage(c.language);
    await messenger.sendLinks(id, t("Tonight's report"), [{ label: t("Open the report"), url: planLinks.report(id, dayKey) }]);
  },
  memory,
  day,
  chrome,
  messenger,
  transcript,
  intake,
  followUps: events,
  // What Quest owes, each with a pending event in mq.events that wakes it before the time it gave.
  commitments: new Commitments({ repo: new PgCommitmentRepository(pool), schedule: events, clock: systemClock, log }),
  results,
  routes,
  catalog,
  models,
  spend,
  activity: board,
  energy,
  sweep,
  // Always exploring: the rotation's runs count against the day's starts too, so the manager keeps room for its own.
  ...(config.answerOnly ? { startsADay: 0 } : config.alwaysExploring ? { startsADay: EXPLORING_STARTS_A_DAY, exploring: true } : {}),
  clock: systemClock,
  log,
});
const manager = new ManagerLoop(
  { inbox: events, turn, messenger, log },
  { worker: config.worker, concurrency: config.managerConcurrency, leaseMs: 180_000, pollMs: 1_000, maxAttempts: 3, batch: 20 },
);
const searches = new PgSearches(pool);
// People for a play, found by code: outreach searches, judges and reads by code, and its model checks each person.
// Everyone Quest comes across, for any customer: the matcher's lists and what a check found that is public.
// The local edition shares the public part with the one database of people at Quest's server, and reads it back.
const known = config.sharedPeople ? new SharedPeople({ local: new PgKnownPeople(pool), ...config.sharedPeople, log }) : new PgKnownPeople(pool);
const finder = new PlayFinder({ models, customers, memory, finds, searches, drafts, known, spend, log });
const pairs = new PairFinder({ models, drafts, spend, known, log });
const runner = new TaskRunner(
  { progress: board, queue: taskStore, tasks: taskStore, questions, events, catalog, models, reach, customers, finds, places, memory, checkpointer, spend, searches, finder, pairs, pageFor: (id, who) => makePage(id, who, true), known, people, seats: config.agentSeats, log, browser, drafts, chromeOnline: (id) => broker.online(id) },
  { worker: config.worker, concurrency: config.taskConcurrency, perCustomer: config.tasksPerCustomer,
    // One run in their Chrome at a time (the founder, 2026-11-14: "the tasks themselves must not interfere and conflict with each other"); the researcher, which only reads, runs beside it.
    solo: catalog.names().filter((n) => n !== "researcher" && catalog.get(n)?.needsChrome),
    leaseMs: 60_000, pollMs: 1_000, maxAttempts: 3 },
);
// The off switch: /off, /on and the switch on their page. Who switched it off before is known before anything runs.
const power = new Power({ customers, messenger, events, runs: runner, chrome: broker, wakeManager: () => manager.wake(), whenOn: (id) => void sweep.maybeStart(id), clock: systemClock, log });
await power.load();
const extensionChat = (): ExtensionChat =>
  new ExtensionChat({ customers, transcript, channel: webChannel, news: chatNews, inbound, deck, off: (id) => power.isOff(id), pairNew: (id, device) => chrome.pairNew(id, device), metBefore: async (id) => (await invites.noteOf(id)) ?? metNotes.get(id) ?? null, out: (id) => outList.lines(id), clock: systemClock, log });
// The panel's way to Telegram: a start link that joins their Telegram to the customer who pressed it. One use, an hour.
const portals = new Map<string, { readonly customerId: CustomerId; readonly until: number }>();
const telegramLink = (customerId: CustomerId): string | null => {
  if (!bot?.username) return null;
  const code = `tg_${randomBytes(9).toString("base64url")}`;
  for (const [k, v] of portals) if (v.until < Date.now()) portals.delete(k);
  portals.set(code, { customerId, until: Date.now() + 3_600_000 });
  return `https://t.me/${bot.username}?start=${code}`;
};
const inbound = new InboundService({ portal: async (from, code) => {
    if (from.channel.kind !== "telegram") return false;
    const kept = portals.get(code);
    const telegram = channels.get("telegram");
    if (!kept || kept.until < Date.now()) {
      await telegram.sendText(from.channel, "That link has run out. Press \"Also talk to Quest in Telegram\" in Quest's panel in Chrome for a new one.");
      return true;
    }
    const here = await customers.findByChannel(from.channel);
    if (here && here.id !== kept.customerId) {
      await telegram.sendText(from.channel, "This Telegram already has a chat of its own with Quest, so it stays as it is.");
      return true;
    }
    portals.delete(code);
    if (!here) await customers.bindChannel(kept.customerId, from.channel, from.userRef);
    log.info("customers.telegram_joined", { customerId: kept.customerId });
    await telegram.sendText(from.channel, systemMessage((await customers.get(kept.customerId)).language, "Connected. This is the same Quest as in your Chrome: write here or there."));
    return true;
  }, met: async (id, code) => {
    const note = await metNote(code);
    if (!note) return;
    metNotes.set(id, note);
    if (pageCode(code)) await customers.update(id, { cameFrom: "match" }).catch(() => undefined);
    log.info("customers.met", { customerId: id, page: Boolean(pageCode(code)) });
    await wayIn.metBy(id, note);
  }, customers, transcript, events, questions, finds, drafts, cards: [drafts, finds], deck, chrome, energy, power, ideas, transcriber, pictures, channels, faces: messenger, wayIn, log, wakeManager: (id) => manager.heard(id) });
// Replies posted with Post it are looked at again for a week, for answers, while the customer's Chrome is open: on Reddit
// by code, elsewhere off their notifications by the volume seat.
// What went up as each customer in the last 8 days, words only, read at most every 20 minutes: the watch asks at every look.
const sentWordsKept = new Map<string, { at: number; words: { own: string[]; quotes: string[] } }>();
const sentWords = async (id: string): Promise<{ own: string[]; quotes: string[] }> => {
  const kept = sentWordsKept.get(id);
  if (kept && Date.now() - kept.at < 20 * 60_000) return kept.words;
  const { rows } = await pool.query<{ body: string; quote: string | null }>(
    `select left(body, 600) as body, left(quote, 300) as quote from mq.drafts where customer_id = $1 and kind in ('reply', 'post', 'message') and sent_at > now() - interval '8 days' and body <> '' order by sent_at desc limit 3000`,
    [id],
  );
  const words = { own: rows.map((r) => r.body), quotes: rows.flatMap((r) => (r.quote ? [r.quote] : [])) };
  sentWordsKept.set(id, { at: Date.now(), words });
  return words;
};
// A second message two days after someone answered, planned where their feed shows it and written by code when due.
const followUps = new FollowUps({
  commitments: new PgCommitmentRepository(pool),
  offer: async (id, d) => {
    const out = await drafts.offer(id, { platform: "browser", kind: d.kind, url: d.url, target: d.target, text: d.text, ...(d.quote ? { quote: d.quote } : {}), author: d.author, helps: true });
    return typeof out === "string" ? out : null;
  },
  profileOf: (id, onUrl, person) => people.profileFor(id, onUrl, person),
  online: () => broker.onlineCustomers(),
  now: () => systemClock.now(),
  log,
});
// A maker's page is a file of the landing, published apart from the agent: its link goes out only once it answers there.
let matchPage = { at: 0, live: false };
const matchPageLive = async (): Promise<boolean> => {
  if (Date.now() - matchPage.at > 10 * 60_000) matchPage = { at: Date.now(), live: await fetch("https://www.messaging.quest/m/", { signal: AbortSignal.timeout(8000) }).then(async (r) => r.ok && (await r.text()).includes('id="fits"'), () => false) };
  return matchPage.live;
};
// A page of people asking for what someone built, for someone nobody was introduced to (a link left under a thread, a
// yes to "want a page?"): one search for their thing alone, and the page says "found", not "got your link".
// Every lead read again before it goes on a page (the founder, 2026-11-20: "double check the leads you find"): a post
// read now that no longer holds their words is left off (one that cannot be read now stays: the search saw it a moment
// ago), and so is anyone a second, stricter judge does not see plainly needing what the maker made (finds/lead-check.ts).
const stillThere = async <T extends { readonly url: string; readonly quote: string; readonly author?: string | null }>(id: CustomerId, people: readonly T[], made: string | null): Promise<T[]> => {
  const reader = reach.forCustomer(id).reader;
  const kept = await Promise.all(people.map(async (p) => {
    const page = await Promise.race([reader.readPage(p.url).catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), 45_000))]);
    return !page || quoteAppears(p.quote.replace(/…$/, "").slice(0, 120), page.text) ? p : null;
  }));
  const there = kept.filter((p): p is Awaited<T> & T => p !== null);
  const out = made ? await leadCheck(models, id, made, there) : there;
  if (out.length < people.length) log.info("page.leads_dropped", { customerId: id, gone: people.length - there.length, unfit: there.length - out.length });
  return out;
};
const makePage = async (id: CustomerId, who: { readonly maker: string; readonly url: string; readonly made: string }, pictured = false): Promise<{ readonly link: string; readonly people: number; readonly listed: readonly { url: string; quote: string }[]; readonly shots?: readonly string[] } | string> => {
  if (!(await matchPageLive())) return "Pages are not live yet.";
  const launch = { source: "page", url: who.url, author: who.maker, title: null, text: who.made.slice(0, 600), postedAt: null, replies: null };
  const found = await Promise.race([pairs.moreFor(id, launch, reach.forCustomer(id).posts, MATCH_MAX + 2), new Promise<never[]>((r) => setTimeout(() => r([]), 120_000))]);
  const listed = await stillThere(id, pagePeople(found, who.maker), who.made);
  if (listed.length < MATCH_MIN) return `Too few people asking for that this week to make a page (${listed.length}, a page needs ${MATCH_MIN}).`;
  const code = await known.keepPage(id, { maker: who.maker, made: who.made, launchUrl: who.url, people: listed, sent: false });
  log.info("page.made", { customerId: id, people: listed.length });
  // For a teammate's reply under their post: pictures of a few of the posts, where that site takes them.
  const shots = pictured && picturesOn(who.url) ? await postShots.take(id, listed, picturesOn(who.url)).catch(() => []) : [];
  return { link: matchPageUrl(code, config.stage === "dev"), people: listed.length, listed, shots };
};
// A platform whose answers dropped sharply is braked: looked at every three hours for whoever's Chrome is open.
const rateLook = setInterval(() => {
  for (const id of broker.onlineCustomers()) void brakes.checkRates(id).catch((e: unknown) => log.warn("brakes.rates_failed", { customerId: id, error: e instanceof Error ? e.message : String(e) }));
}, 3 * 3_600_000);
rateLook.unref();
const followUpLook = setInterval(() => void followUps.look().catch((e: unknown) => log.warn("follow_up.look_failed", { error: e instanceof Error ? e.message : String(e) })), 5 * 60_000);
followUpLook.unref();
const watch = new ReplyWatch(
  { finds: findStore, drafts: draftStore, reach, online: (id) => broker.online(id), onlineCustomers: () => broker.onlineCustomers(), events, memory, autopilot, results, routes, plan: (id, url, author) => people.planFor(id, url, author),
    sentWords: (id) => sentWords(id),
    followUp: (id, a) => followUps.plan(id, a),
    saidNo: (id, a) => drafts.leaveAlone(id, a.url, a.author, a.words),
    // Someone asking if this is a bot is a bad sign whatever else they say: replies stop there for a day.
    heard: async (id, a) => {
      if (asksBot(a.words)) await brakes.pull(id, platformFor(a.url), "reply", `${a.author} asked if this is a bot ("${a.words.slice(0, 80)}")`);
    },
    // A words-first introduction's plan keeps the links offered: the first answer gets them, a later one the step after.
    nextStep: async (id, a) => {
      // The words back to them go where they asked: an email they gave, a DM they asked for, else under their answer.
      // With a page's link, pictures of a few of its posts go too, where the site takes pictures in a reply.
      const answer = async (text: string, extra: { theirs?: true; helps?: true; ask?: string }, subject = "The people I found for you", shots: readonly { url: string; quote: string }[] = []): Promise<boolean> => {
        const where = theirChannel(a.quote);
        const profile = where === "dm" ? await people.profileFor(id, a.url, a.author).catch(() => null) : null;
        const to = where && typeof where === "object"
          ? { kind: "message" as const, url: emailCompose(where.email, subject), target: where.email, title: subject }
          : { kind: profile ? ("message" as const) : ("reply" as const), url: profile ?? a.url, target: a.author };
        const room = picturesOn(to.url);
        const assets = shots.length && room ? await postShots.take(id, shots, room).catch(() => []) : [];
        const out = await drafts.offer(id, { platform: "browser", ...to, text, quote: a.quote, author: a.author, ...extra, ...(assets.length ? { assets } : {}) });
        if (typeof out === "string") log.info("intro.not_written", { customerId: id, url: a.url, why: out.slice(0, 160) });
        return typeof out !== "string";
      };
      const links = linksOf(a.plan);
      // What passed with them, also past the 400 newest (live, 2026-11-16: likes and follows had pushed seven makers'
      // openers, two days old, out of that window, so their "yes, go ahead" found no offer of ours and nothing followed).
      const them = (handleOf(a.url) ?? "").trim().replace(/^(@|u\/)/, "").toLowerCase();
      const seen = await draftStore.recent(id, 400);
      const more = them.length > 1 ? await draftStore.withPerson(id, them, introsOf(a.plan).map((i) => i.url)) : [];
      const recent = [...seen, ...more.filter((d) => !seen.some((s) => s.id === d.id))];
      const handed = links.length > 0 && recent.some((d) => d.status !== "skipped" && links.some((l) => d.text.includes(l)));
      // The links go only to the very person who was offered them (the founder, 2026-11-13: "make no mistakes, like
      // answering the wrong person"): the answer's own address names them, and an offer of ours went up to that handle in
      // the last week. A plan found by a name inside a handle is not enough for that. A no is left to the manager.
      const who = (s: string | null | undefined): string => (s ?? "").trim().replace(/^(@|u\/)/, "").toLowerCase();
      const answerer = who(handleOf(a.url));
      const offered = answerer.length > 1 && recent.some((d) => d.status === "posted" && d.kind === "reply" && [who(d.target), who(d.author)].includes(answerer) && Date.now() - d.createdAt.getTime() < 7 * 86_400_000);
      const agrees = (said: string): boolean =>
        (saysYes(said) || /\b(not at all|feel free|please do|by all means|share it|point them|introduce them|be delighted|happy to|would love|i'?d love|love to (connect|see|take a look|hear)|that would be (great|awesome|amazing|nice)|sounds (good|great)|go for it)\b/i.test(said)) && !/\b(bots?|spam|scam|automated)\b/i.test(said);
      const declined = /\b(no thanks|no thank you|not interested|nah\b|no need|i'?m good|all good|don'?t need|already (found|have|use))/i.test(a.quote);
      if (links.length && !handed && (!offered || declined)) return false;
      // A maker asked if they may be introduced: their yes writes the introduction under each person's post, then tells
      // them it's done with the posts (the founder, 2026-11-14). Once: a post already answered is not written to again.
      const intros = introsOf(a.plan);
      const told = (u: string): boolean => recent.some((d) => d.kind === "reply" && d.url === u && d.status !== "skipped");
      const toMaker = recent.filter((d) => (d.kind === "reply" || d.kind === "message") && d.status !== "skipped" && [who(d.target), who(d.author)].includes(answerer) && Date.now() - d.createdAt.getTime() < 14 * 86_400_000).length;
      // Once: until "done" with the posts went to them. Counting the words that went to them instead missed every maker
      // who had an older opener too (live, 2026-11-15: @anotherbuild said "Sure thing" to the second and got nothing).
      const doneSent = recent.some((d) => (d.kind === "reply" || d.kind === "message") && d.status !== "skipped" && [who(d.target), who(d.author)].includes(answerer) && (intros.some((i) => d.text.includes(i.url)) || d.text.includes("messaging.quest/m/")));
      if (intros.length && !doneSent) {
        // Only a plain yes writes the introductions (live, 2026-11-15: "What is your end game, bot?" and "Never released a
        // game on steam" would each have sent their link to strangers). Anything else is the manager's to answer.
        if (!offered || declined || !answerer || !agrees(a.quote)) {
          log.info("intro.not_stepped", { customerId: id, person: answerer, offered, declined, agrees: agrees(a.quote) });
          return false;
        }
        // Whoever asked was told already when the maker heard (askerDraft): that counts as done, and is not written twice.
        // Their yes brings more than the people they were told of: whoever else was found for the launch, and one more
        // search for it now, up to MATCH_MAX in all.
        const everyone = await everyoneFor(intros, {
          kept: (u) => known.pairsFor(u),
          more: (launch) => Promise.race([pairs.moreFor(id, launch, reach.forCustomer(id).posts, MATCH_MAX + 2), new Promise<never[]>((r) => setTimeout(() => r([]), 90_000))]),
          written: (author) => recent.some((d) => (d.kind === "reply" || d.kind === "message") && d.status !== "skipped" && [who(d.target), who(d.author)].includes(who(author)) && Date.now() - d.createdAt.getTime() < 14 * 86_400_000),
        });
        const done: string[] = everyone.filter((i) => told(i.url)).map((i) => i.url);
        // Not `cold`: the maker said yes to exactly this, and a yes is acted on once. Held to the day's cap, every yes on a
        // busy site was lost for good (live, 2026-11-15: ten makers said "go ahead" on Bluesky and nobody was introduced).
        // The outbox still keeps the site's gap between them.
        // Only whoever asked for such a thing gets the link; the rest are on the maker's page, not written to.
        const fits = await stillThere(id, everyone.filter((i) => !i.asked && !told(i.url)), intros[0]!.made ?? null);
        for (const i of everyone.filter((x) => x.asked && !told(x.url))) {
          const out = await drafts.offer(id, { platform: "browser", kind: "reply", url: i.url, target: i.author, text: introductionDraft(i), quote: i.quote, author: i.author, helps: true });
          if (typeof out !== "string") done.push(i.url);
          else log.info("intro.not_written", { customerId: id, url: i.url, why: out.slice(0, 160) });
        }
        if (!done.length && !fits.length) return false;
        log.info("intro.yes", { customerId: id, person: answerer, told: intros.length, reached: done.length, fits: fits.length });
        // Their page: everyone their link went to, on an address of Quest's own, in place of the posts one by one and of
        // the product's name (the founder, 2026-11-17). Only once the landing serves it; until then, as before.
        // A page lists at least MATCH_MIN people; with fewer, the posts go to them as before.
        if (done.length + fits.length >= MATCH_MIN && (await matchPageLive())) {
          const reached = everyone.filter((i) => done.includes(i.url));
          const code = await known.keepPage(id, { maker: a.author, made: intros[0]!.made ?? null, launchUrl: intros[0]!.launch, people: [...reached.map((i) => ({ author: i.author, quote: i.quote, url: i.url })), ...fits.map((i) => ({ author: i.author, quote: i.quote, url: i.url, fit: true }))] }).catch(() => null);
          const firstName = (await customers.get(id)).displayName?.trim().split(/\s+/)[0] || null;
          if (code) return answer(pageDraft(matchPageUrl(code, config.stage === "dev"), reached.length, firstName, Math.random, fits.length), { theirs: true }, undefined, [...reached, ...fits].map((i) => ({ url: i.url, quote: i.quote })));
        }
        if (!done.length) return false;
        // The name goes with "done" (live, 2026-11-14: of 55 who answered in three days nobody had heard what Quest is;
        // few answer a second time, so the step that waited for it never came).
        const me = await customers.get(id);
        const product = titled(productNames(me.siteUrl));
        const named = product ? nameDraft(product) : null;
        return answer(`${doneDraft(done, me.displayName?.trim().split(/\s+/)[0] || null)}${named ? ` ${named.text}` : ""}`, { helps: true, ...(named ? { ask: named.ask } : {}) });
      }
      // A yes to "want a page?" (step two offers one): people asking for what they built, found now and put on a page
      // of their own, whose button is the way on to Quest. Once; with nobody found, the manager answers.
      const toThem = (d: (typeof recent)[number]): boolean => (d.kind === "reply" || d.kind === "message") && [who(d.target), who(d.author)].includes(answerer);
      if (answerer && offered && !declined && agrees(a.quote) && recent.some((d) => toThem(d) && d.status === "posted" && /\bpage\b/i.test(d.text)) && !recent.some((d) => toThem(d) && d.status !== "skipped" && d.text.includes("messaging.quest/m/"))) {
        const made = await people.about(id, a.url, a.author).catch(() => null);
        const page = made ? await makePage(id, { maker: a.author, url: a.url, made }).catch(() => "failed") : "nothing known of what they make";
        if (typeof page === "string") {
          log.info("page.not_made", { customerId: id, person: answerer, why: page.slice(0, 120) });
          return false;
        }
        const firstName = (await customers.get(id)).displayName?.trim().split(/\s+/)[0] || null;
        return answer(pageDraft(page.link, 0, firstName, Math.random, page.people), { theirs: true }, undefined, page.listed);
      }
      // Their next answer, whatever it says, gets the name and the one ask back (the founder, 2026-11-14), unless they
      // have it already. So does anyone with a plan who answers a second time: step three is the name.
      const toldName = async (): Promise<string | null> => {
        const product = titled(productNames((await customers.get(id)).siteUrl));
        if (!product) return null;
        const theirs = recent.filter((d) => (d.kind === "reply" || d.kind === "message") && d.status !== "skipped" && [who(d.target), who(d.author)].includes(answerer));
        return theirs.some((d) => d.text.toLowerCase().includes(product.toLowerCase())) ? null : product;
      };
      if (answerer && offered && !declined && (intros.length ? doneSent : toMaker === 2) && !(links.length && !handed) && (!intros.length || recent.some((d) => d.kind === "reply" && d.status === "posted" && intros.some((i) => d.text.includes(i.url))))) {
        const product = await toldName();
        if (!product) return false;
        const named = nameDraft(product);
        return answer(named.text, { helps: true, ask: named.ask }, product);
      }
      // Each step once (live, 2026-11-13: @jerrylee_maker had been told at 10:31 that more people could come, answered
      // again, and code offered the same in other words at 16:39): past the plan's steps, the manager answers, seeing the thread.
      const ours = recent.filter((d) => (d.kind === "reply" || d.kind === "message") && d.status !== "skipped" && [who(d.target), who(d.author)].includes(answerer) && Date.now() - d.createdAt.getTime() < 14 * 86_400_000).length;
      // The links: only after the opener alone. The step after: only after the opener (and the links, when there were some).
      const giveLinks = links.length > 0 && !handed;
      const expected = giveLinks ? 1 : links.length ? 2 : 1;
      if (!answerer || declined || ours !== expected) return false;
      const text = giveLinks ? linkStep(links) : stepTwoDraft();
      return answer(text, { helps: true });
    },
    likeAnswer: async (id, a) => typeof (await drafts.offer(id, { platform: "browser", kind: "like", url: a.url, target: a.author, text: "", quote: a.quote, author: a.author })) !== "string",
    answers: new AnswerReader({ models, spend, log }), wakeManager: () => manager.wake(), clock: systemClock, log },
  { everyMs: 5 * 60_000 },
);
// Their last week in figures, counted from the records: what a post of their own may brag with. Kept an hour.
const numbersKept = new Map<CustomerId, { at: number; text: string | null }>();
const weekNumbers = async (id: CustomerId): Promise<string | null> => {
  const kept = numbersKept.get(id);
  if (kept && Date.now() - kept.at < 3_600_000) return kept.text;
  const { rows } = await pool.query<{ makers: string; found: string; pages: string; listed: string; words: string; sites: string; answered: string }>(
    `select
       (select count(distinct launch->>'url') from mq.pairs where taken_by = $1 and taken_at > now() - interval '7 days' and note like 'maker: draft%') as makers,
       (select count(*) from mq.pairs where taken_by = $1 and taken_at > now() - interval '7 days' and note like 'maker: draft%') as found,
       (select count(*) from mq.match_pages where customer_id = $1 and created_at > now() - interval '7 days') as pages,
       (select coalesce(sum(jsonb_array_length(people)), 0) from mq.match_pages where customer_id = $1 and created_at > now() - interval '7 days') as listed,
       (select count(*) from mq.drafts where customer_id = $1 and kind in ('reply', 'message', 'post') and sent_at > now() - interval '7 days') as words,
       (select count(distinct platform) from mq.drafts where customer_id = $1 and sent_at > now() - interval '7 days') as sites,
       (select count(distinct person) from mq.results where customer_id = $1 and stage = 'conversation' and created_at > now() - interval '7 days') as answered`,
    [id],
  );
  const r = rows[0];
  const n = (v: string | undefined): number => Number(v ?? 0);
  const lines = r
    ? [
        n(r.makers) ? `- ${n(r.makers)} founders were told about people looking for what they built (${n(r.found)} such people found for them)` : null,
        n(r.pages) ? `- ${n(r.pages)} founders got a page of their own, with ${n(r.listed)} people on them in all` : null,
        n(r.words) ? `- ${n(r.words)} replies, messages and posts went up, on ${n(r.sites)} sites` : null,
        n(r.answered) ? `- ${n(r.answered)} people answered` : null,
      ].filter((l): l is string => l !== null)
    : [];
  const text = lines.length >= 2 ? lines.join("\n") : null;
  numbersKept.set(id, { at: Date.now(), text });
  return text;
};
// Always exploring: while their Chrome is open, their run slots are kept busy on their platforms, in turn.
const rotation = config.alwaysExploring
  ? new Rotation({
      online: () => broker.onlineCustomers(),
      customers,
      tasks: {
        list: (id) => taskStore.listFor(id, { limit: LOOK_BACK, light: true }),
        atWork: async (id) => (await taskStore.listFor(id, { statuses: ["queued", "running", "waiting"], limit: 5, light: true })).length,
        start: (...a) => tasks.start(...a),
      },
      drafts: draftStore,
      results,
      places,
      people,
      restingUntil: async (id) => (await energy.view(id)).restUntil,
      modelsRest: () => modelRest.until(),
      numbers: (id) => weekNumbers(id),
      sending: async (id) => (await outbox.waiting(id)).some((i) => i.status === "sending" || i.dueAt.getTime() <= Date.now()),
      // One run in their Chrome at a time: two took the front of their window from each other.
      perCustomer: 1,
      answerOnly: config.answerOnly,
      now: () => systemClock.now(),
      log,
    })
  : null;
// Introductions by code: the matcher on a clock, and a reply to everyone who can be answered where they posted.
const introducer = config.alwaysExploring && !config.answerOnly
  ? new Introducer({
      online: () => broker.onlineCustomers(),
      allowed: async (id) => {
        const c = await customers.get(id);
        return c.status === "active" && Boolean(c.activatedAt) && !c.offAt && Boolean(c.sweptAt) && !(await energy.view(id)).restUntil && !modelRest.until();
      },
      pairs,
      // The matcher's searches are background reading: a run's pages on the same site go before them.
      posts: (id) => {
        const p = reach.forCustomer(id).posts;
        return { sources: () => p.sources(), search: (q) => QUIET.run(true, () => p.search(q)) };
      },
      known,
      drafts,
      room: (id, url) => drafts.coldRoom(id, url),
      people,
      theirs: async (id) => {
        const c = await customers.get(id);
        const flat = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");
        return [c.displayName ? flat(c.displayName) : "", c.siteUrl ? flat(new URL(c.siteUrl).hostname.replace("www.", "").split(".").slice(0, -1).join("")) : ""].filter(Boolean);
      },
      waiting: async (id) => (await outbox.waiting(id)).length,
      waitingOn: async (id, site) => (await outbox.waiting(id)).filter((i) => i.site === site).length,
      now: () => systemClock.now(),
      log,
    })
  : null;
// A send Quest never saw land is Quest's to look at later, in their Chrome, never theirs (drafts/held-check.ts).
const heldCheck = new HeldCheck({
  online: () => broker.onlineCustomers(),
  held: async (id) => [
    ...(await draftStore.recent(id, 300))
      .filter((x) => x.status === "uncertain")
      .map((x) => ({ key: `draft:${x.id}`, url: x.url, since: x.decidedAt ?? x.createdAt, verify: async (view: BrowserView) => {
        const out = await drafts.verifySent(id, x.id, view);
        return typeof out === "string" ? { posted: false, why: out } : { posted: true };
      } })),
    ...(await findStore.listFor(id, ["shown", "kept", "replied"], 300))
      .filter((x) => x.postState === "uncertain")
      .map((x) => ({ key: `find:${x.id}`, url: x.url, since: x.decidedAt ?? x.shownAt ?? x.createdAt, verify: async (view: BrowserView) => {
        const out = await finds.verifySent(id, x.id, view);
        return typeof out === "string" ? { posted: false, why: out } : { posted: true };
      } })),
  ],
  browser,
  now: () => systemClock.now(),
  log,
});
const heartbeat = new HeartbeatScheduler({
  source: events,
  everyMs: config.heartbeatMs,
  checkMs: 60_000,
  // Long enough for a connected Chrome to ask for work again, so the first turn sees it.
  firstTickMs: BROKER_DEFAULTS.onlineWindowMs,
  onQueued: () => manager.wake(),
  log,
});

// Sleeping: the agent suspends its machine when idle; requests and the database's wake job resume it.
// A connected Chrome's long poll is a request in flight, so the agent stays awake while one is open.
const traffic = new Traffic(() => systemClock.now().getTime());
const schedule = new PgWakeSchedule(pool, config.heartbeatMs);
// Only production registers where the wake job calls: one row per database, and a laptop never sleeps.
const wakeKey = config.wakeUrl ? await schedule.register(config.wakeUrl) : null;
const sleeper = new IdleSleeper(
  {
    loops: [manager, runner, heartbeat, errands, outbox, watch, board, heldCheck, ...(rotation ? [rotation] : []), ...(introducer ? [introducer] : [])],
    traffic,
    work: schedule,
    connections: { get open() { return pool.totalCount; } },
    power: config.fly ? new FlyMachine(config.fly.app, config.fly.machineId) : stayAwake,
    clock: systemClock,
    log,
  },
  { idleMs: config.sleepAfterMs, checkMs: 15_000, horizonMs: 120_000, drainMs: 45_000, resumeTimeoutMs: 120_000 },
);

const app = createServer({
  webhookSecret: config.telegram.webhookSecret,
  inbound,
  pinNotices: telegramChannel,
  traffic,
  wake: {
    key: () => wakeKey,
    nudge: () => {
      manager.wake();
      runner.wake();
    },
  },
  log,
  health: () => ({ worker: config.worker, edition: config.local ? "local" : "hosted" }),
  routes: [
    chromeRoutes({ telegramLink, links: chrome, broker, log, tabs: config.chromeTabs, pagesADay: config.chromePagesADay, front: async (id) => (await customers.get(id)).chromeFront, off: (id) => power.isOff(id), power: (id, on) => power.set(id, on, "tap"), chat: extensionChat(), settings: panelSettings }),
    // The Mini App answers only to Telegram's signed init data: without a bot there is nothing to sign it.
    ...(withTelegram ? [glassRoutes({ botToken: config.telegram.token, customers, glass: new PgGlass(pool), chrome, energy, power, log })] : []),
    unsubscribeRoutes({ accounts: new PgAccounts(pool), log }),
    reportRoutes({ links: planLinks, reports }),
    // The shared database of people, for every local install: only the hosted agent keeps it.
    ...(config.local ? [] : [peopleRoutes({ known, log })]),
    planRoutes({ links: planLinks, energy, customers, checkout, webhookSecret: config.stripe?.webhookSecret ?? null, log }),
    ...(config.chromeDebug ? [chromeDebugRoutes(broker, reach)] : []),
  ],
});
// The Quest button by the message box opens the customer's own page. Telegram wants https, so a laptop agent has one
// through the tunnel npm run dev opens (MINI_APP_URL). While their work runs, their chat's own button says so (task-board.ts).
if (config.miniAppUrl && withTelegram) {
  await telegram
    .setChatMenuButton({ menu_button: { type: "web_app", text: "Quest", web_app: { url: config.miniAppUrl } } })
    .catch((e: unknown) => log.warn("telegram.menu_failed", { error: e instanceof Error ? e.message : String(e) }));
  // A laptop's tunnel has a new address every start, and each chat keeps the old one until its own button changes.
  if (config.stage === "dev") {
    for (const to of await customers.chats("telegram").catch(() => [])) {
      await telegramChannel.pushButton(to).catch((e: unknown) => log.warn("telegram.menu_failed", { error: e instanceof Error ? e.message : String(e) }));
    }
  }
}
// Posts a stopped machine left claimed (killed mid-post, or crashed) turn uncertain on their cards, before any tap can
// reach this one: one agent machine serves every Chrome, so a claim from before it started is nobody's.
const lostPosts = await Promise.all([drafts.recoverPosts(), finds.recoverPosts(), outbox.recover()]).catch((e: unknown) => {
  log.error("agent.recover_failed", { error: e instanceof Error ? e.message : String(e) });
  return [0, 0, 0];
});
const server = serve({ fetch: app.fetch, port: config.port, hostname: config.chromeDebug || config.local ? "127.0.0.1" : "0.0.0.0" });
const poller = withTelegram && config.telegram.mode === "polling" ? new TelegramPoller(telegram, inbound, log, telegramChannel) : null;
await poller?.start();
manager.start();
runner.start();
board.start();
outbox.start();
heartbeat.start();
watch.start();
heldCheck.start();
rotation?.start();
introducer?.start();
sleeper.start();
log.info("agent.started", {
  stage: config.stage,
  bot: bot ? `@${bot.username}` : null,
  port: config.port,
  team: catalog.names(),
  sleeps: Boolean(config.fly),
  wakeable: Boolean(wakeKey),
  telegram: config.telegram.mode,
  pages: config.pagesUrl,
  stripe: stripe ? (stripe.testMode ? "test" : "live") : "off",
  models: config.models.via,
  lostPosts: lostPosts[0] + lostPosts[1],
});

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log.info("agent.stopping", { signal });
  sleeper.stop();
  energy.stop();
  // A post going up gets a few seconds to finish, then is stopped: one not yet sent gives its card back, one that may
  // have gone up is held for them to look. The server stays open meanwhile, since the post needs their Chrome to reach
  // it. Live, 2026-10-17: closed first, a post waited on a Chrome that could no longer reach the agent until Fly killed
  // the machine, and its card stayed claimed as posting.
  const posts = errands.close();
  // Nothing new goes up now (errands refuse it): what waits in line stays there and goes after the restart.
  await outbox.stop();
  await heartbeat.stop();
  await watch.stop();
  await heldCheck.stop();
  await rotation?.stop();
  await introducer?.stop();
  await poller?.stop();
  // Running tasks go back to the queue; their checkpoints let the next machine continue them.
  const work = Promise.allSettled([manager.stop(), runner.stop()]);
  await posts;
  server.close();
  await work;
  await pool.end();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
