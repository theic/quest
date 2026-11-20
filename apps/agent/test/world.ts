import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { findId as toFindId, type Logger } from "@mq/core";
import { MemorySaver } from "@langchain/langgraph";
import type { ModelProvider, ModelRole } from "../src/agents/models.ts";
import { ChannelRegistry } from "../src/conversation/channel-registry.ts";
import { InboundService } from "../src/conversation/inbound-service.ts";
import { Answering } from "../src/conversation/answering.ts";
import { IntakeService, type IntakeGuesser } from "../src/conversation/intake.ts";
import { Messenger } from "../src/conversation/messenger.ts";
import { WayIn } from "../src/conversation/way-in.ts";
import { silentLogger } from "../src/infra/system.ts";
import { Autopilot } from "../src/drafts/autopilot.ts";
import { DraftService } from "../src/drafts/draft-service.ts";
import { voiceFrom, writtenLately, Writer } from "../src/drafts/writer.ts";
import { FindService } from "../src/finds/find-service.ts";
import { FirstSweep, type SweepSizes } from "../src/finds/sweep.ts";
import { Errands, type ErrandTimes } from "../src/lifecycle/errands.ts";
import { Outbox } from "../src/drafts/outbox.ts";
import { ManagerLoop } from "../src/manager/manager-loop.ts";
import { ManagerTurn } from "../src/manager/manager-turn.ts";
import { Commitments } from "../src/manager/commitments.ts";
import { QuestionService } from "../src/questions/question-service.ts";
import { explorerSpec } from "../src/tasks/explorer.ts";
import { researcherSpec } from "../src/tasks/researcher.ts";
import { outreachSpec } from "../src/tasks/outreach.ts";
import { scoutSpec } from "../src/tasks/scout.ts";
import { SubagentCatalog } from "../src/tasks/subagents.ts";
import { TaskBoard } from "../src/tasks/task-board.ts";
import { TaskRunner } from "../src/tasks/task-runner.ts";
import { TaskService } from "../src/tasks/task-service.ts";
import { Energy } from "../src/billing/energy.ts";
import { PlanLinks } from "../src/billing/plans.ts";
import { CreditWords } from "../src/billing/credit-words.ts";
import { Power } from "../src/lifecycle/power.ts";
import { WarmUp } from "../src/drafts/warm-up.ts";
import { IdeaService } from "../src/ideas/idea-service.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CustomerId, Transcriber } from "@mq/core";
import type { PictureReader } from "../src/conversation/pictures.ts";
import {
  FakeChannel,
  FakeChrome,
  FakeClock,
  FakePoster,
  FakePostSearch,
  FakeReach,
  FakeReader,
  MemoryBilling,
  MemoryBoards,
  MemoryCommitments,
  MemoryCustomers,
  MemoryInvites,
  MemoryDay,
  MemoryEvents,
  MemoryKept,
  MemoryDrafts,
  MemoryOutbox,
  MemorySpend,
  MemorySearches,
  FakePictures,
  FakeTranscriber,
  MemoryTrust,
  MemoryFinds,
  MemoryPlaces,
  MemoryQuestions,
  MemoryResults,
  MemoryRoutes,
  MemoryTasks,
  MemoryTranscript, MemoryAssets, MemoryIdeas, MemoryDecks} from "./fakes.ts";
import { askActs, Deck } from "../src/asks/deck.ts";

/** A whole Quest wired with in-memory stores and scripted models: the production graph, minus the network. */
export function makeWorld(
  models: { manager?: BaseChatModel; researcher?: BaseChatModel; volume?: BaseChatModel; writer?: BaseChatModel; vision?: BaseChatModel } = {},
  opts: { seats?: Readonly<Record<string, ModelRole>>; log?: Logger; intake?: { guesser?: IntakeGuesser }; sweep?: Partial<SweepSizes>; dayLimitUsd?: number; errands?: ErrandTimes; outbox?: { siteGapMs?: number; acrossGapMs?: number }; cards?: boolean; wayIn?: boolean } = {},
) {
  const clock = new FakeClock();
  const customers = new MemoryCustomers();
  const transcript = new MemoryTranscript(() => clock.t);
  const events = new MemoryEvents(() => clock.t);
  const taskStore = new MemoryTasks(() => clock.t);
  const questionStore = new MemoryQuestions();
  const findStore = new MemoryFinds(() => clock.t);
  const draftStore = new MemoryDrafts(() => clock.t);
  const places = new MemoryPlaces(() => clock.t);
  const memory = new MemoryKept(() => clock.t);
  const day = new MemoryDay(findStore, taskStore);
  const commitmentStore = new MemoryCommitments(() => clock.t);
  const results = new MemoryResults(() => clock.t);
  const routes = new MemoryRoutes(() => clock.t);
  const poster = new FakePoster();
  const channel = new FakeChannel();
  const channels = new ChannelRegistry([channel]);
  const reader = new FakeReader();
  const posts = new FakePostSearch();
  const reach = new FakeReach(reader, posts);
  const chrome = new FakeChrome();
  const checkpointer = new MemorySaver();
  // Every tool call the manager and the team make, for the try-scripts to print.
  const tools: { who: string; what: string }[] = [];
  const base = opts.log ?? silentLogger;
  const log: Logger = {
    info: (event, data) => {
      if (event === "manager.tool" || event === "tasks.tool") tools.push({ who: event === "manager.tool" ? "Quest" : "team", what: String(data?.["tool"]) });
      base.info(event, data);
    },
    warn: (event, data) => base.warn(event, data),
    error: (event, data) => base.error(event, data),
  };
  const catalog = new SubagentCatalog([researcherSpec(), scoutSpec(), explorerSpec(), outreachSpec()]);
  const provider: ModelProvider = {
    modelFor(role) {
      // The vision seat sees with the manager's scripted model unless a test scripts one of its own.
      const m = models[role] ?? (role === "vision" ? models.manager : undefined);
      if (!m) throw new Error(`no scripted model for ${role}`);
      return m;
    },
  };

  const messenger = new Messenger({ customers, channels, transcript, log });
  // Your move, as main.ts wires it; `cards`: each find, draft, question and idea on a card of its own, as before the deck
  // (old cards still in a chat behave so).
  const ideaStore = new MemoryIdeas(() => clock.t);
  const deckStore = new MemoryDecks();
  const deck = opts.cards
    ? undefined
    : new Deck({
        customers,
        channels,
        store: deckStore,
        finds: findStore,
        drafts: draftStore,
        questions: questionStore,
        ideas: ideaStore,
        outbox: { waiting: (id) => outbox.waiting(id) },
        results,
        transcript,
        acts: askActs(() => ({ finds, drafts, questions, ideas })),
        clock,
        log,
      });
  const questions = new QuestionService({ questions: questionStore, tasks: taskStore, events, messenger, askCap: 2, log, ...(deck ? { deck } : {}) });
  const errands = new Errands(log, opts.errands);
  // Their Chrome, as the outbox sees it: online unless a test puts the customer here.
  const chromeOffline = new Set<string>();
  const outboxStore = new MemoryOutbox(() => clock.t);
  const outbox = new Outbox({ store: outboxStore, errands, online: (id) => !chromeOffline.has(id), off: (id) => power.isOff(id), held: (id) => answering.until(id) !== null, clock, log }, { siteGapMs: 0, acrossGapMs: 0, ...opts.outbox });
  const trust = new MemoryTrust();
  const spend = new MemorySpend(() => clock.t);
  // Each customer's day's budget: past their plan's credits, Quest rests until their midnight (billing/).
  const billing = new MemoryBilling(spend, () => clock.t);
  events.restOf = (id) => billing.rests.get(id) ?? null;
  taskStore.restOf = (id) => billing.rests.get(id) ?? null;
  events.offOf = (id) => Boolean(customers.customers.get(id)?.offAt);
  taskStore.offOf = (id) => Boolean(customers.customers.get(id)?.offAt);
  const planLinks = new PlanLinks("123456:test-token", "https://quest.test");
  // A purchase lets someone waiting in, as the top-up's SQL does.
  billing.letIn = async (id) => {
    const c = customers.customers.get(id);
    if (!c || c.activatedAt) return false;
    await customers.update(id, { activatedAt: new Date(clock.t) });
    return true;
  };
  const creditWords = new CreditWords({ customers, messenger, events, links: planLinks, welcome: (id, said) => wayIn.welcome(id, said), clock, log });
  const energy: Energy = new Energy({ billing, customers, words: creditWords, runs: { rest: (id, until) => runner.rest(id, until) }, ...(opts.dayLimitUsd ? { dayLimitUsd: opts.dayLimitUsd } : {}), clock, log, checkAfterMs: 0 });
  const counted = energy.watching(spend);
  const searches = new MemorySearches(() => clock.t);
  const autopilot = new Autopilot({ trust, messenger, clock, off: (id) => power.isOff(id) });
  // A writer only when a test scripts its model: without one, drafts go on in the words they were drafted in.
  const writer = models.writer ? new Writer({ models: provider, voice: voiceFrom({ customers, memory, transcript, clock }), lately: writtenLately({ drafts: draftStore, finds: findStore, clock }), spend: counted, log }) : undefined;
  // The product comes last: drafts and finds alike stay plain until a platform is warm and the person talks back.
  const warmUp = new WarmUp({ customers, drafts: draftStore, finds: findStore, clock });
  const finds = new FindService({ finds: findStore, drafts: draftStore, events, messenger, poster, errands, outbox, places, autopilot, writer, warmUp, cardsAtOnce: 2, ...(deck ? { deck } : {}), clock, log });
  const assetStore = new MemoryAssets(() => clock.t);
  const ideas = new IdeaService({ ideas: ideaStore, assets: assetStore, messenger, ...(deck ? { deck } : {}), channels, events, wakeManager: () => undefined, clock, log });
  const drafts = new DraftService({ drafts: draftStore, finds: findStore, places, messenger, ...(deck ? { deck } : {}), poster, errands, outbox, autopilot, writer, warmUp, files: ideas, clock, log, events });
  outbox.serve("draft", drafts);
  outbox.serve("find", finds);
  const commitments = new Commitments({ repo: commitmentStore, schedule: events, clock, log });
  const tasks = new TaskService({ tasks: taskStore, questions: questionStore, answerer: questions, catalog });
  const answering = new Answering(clock);
  const intake = new IntakeService({
    answering,
    customers,
    events,
    wakeManager: () => undefined,
    clock,
    log,
    ...opts.intake,
  });
  // The way in, when a test asks for it: someone new is in on an invite, else on a free start.
  const invites = new MemoryInvites(customers);
  const wayIn = new WayIn({ customers, invites, billing, transcript, channels, events, log });
  const turn = new ManagerTurn({
    wayIn,
    ideas,
    customers,
    tasks,
    questions,
    finds,
    drafts,
    trust,
    places,
    memory,
    day,
    chrome,
    messenger,
    transcript,
    intake,
    followUps: events,
    commitments,
    results,
    routes,
    catalog,
    models: provider,
    spend: counted,
    energy,
    sweep: { maybeStart: (id) => sweep.maybeStart(id), running: (id) => sweep.running(id) },
    clock,
    log,
    modelRetryDelayMs: 1,
  });
  const manager = new ManagerLoop(
    { inbox: events, turn, messenger, log },
    { worker: "test", concurrency: 1, leaseMs: 60_000, pollMs: 10, maxAttempts: 2, batch: 20 },
  );
  const boards = new MemoryBoards();
  const board = new TaskBoard({ channels, customers, boards, paces: () => taskStore.paces(), clock, log });
  // Someone new's first sweep, with the line redrawn at once so a test sees every redraw.
  const sweep = new FirstSweep(
    { customers, reach, finds, memory, models: provider, spend: counted, messenger, online: (id) => !chromeOffline.has(id), off: (id) => power.isOff(id), errands, progress: board, events, wakeManager: () => undefined, after: (id) => intake.begin(id), clock, log },
    { lineEveryMs: 0, ...opts.sweep },
  );
  const runner = new TaskRunner(
    { progress: board, queue: taskStore, tasks: taskStore, questions, events, catalog, models: provider, reach, customers, finds, places, memory, checkpointer, spend: counted, searches, ...(opts.seats ? { seats: opts.seats } : {}), log },
    { worker: "test", concurrency: 1, perCustomer: 2, leaseMs: 60_000, pollMs: 10, maxAttempts: 2, modelRetryDelayMs: 1 },
  );
  const transcriber = new FakeTranscriber();
  const pictures = new FakePictures();
  const power = new Power({ customers, messenger, events, runs: runner, wakeManager: () => undefined, clock, log });
  const inbound = new InboundService({ customers, transcript, events, questions, finds, drafts, cards: [drafts, finds], ...(deck ? { deck } : {}), chrome, energy, power, ideas, transcriber, pictures, channels, faces: messenger, ...(opts.wayIn ? { wayIn } : {}), log, wakeManager: () => undefined });

  return { tools, invites, wayIn, deck, deckStore, sweep, outbox, outboxStore, chromeOffline, answering, ideas, ideaStore, assetStore, power, writer, pictures, board, boards, clock, spend, billing, planLinks, creditWords, energy, searches, transcriber, commitments, commitmentStore, results, routes, customers, transcript, events, taskStore, questionStore, findStore, draftStore, drafts, trust, autopilot, places, memory, day, poster, errands, finds, channel, reader, posts, chrome, catalog, messenger, questions, tasks, intake, turn, manager, runner, inbound };
}

export const telegramSender = (chat = "42") => ({
  channel: { kind: "telegram" as const, address: chat },
  userRef: chat,
  displayName: "Dana",
  language: "en",
});
