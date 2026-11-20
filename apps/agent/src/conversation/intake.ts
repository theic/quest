import { OWN_WORDS, SKIPPED, type Clock, type Customer, type CustomerId, type CustomerRepository, type EventSink, type IntakeQuestion, type Logger } from "@mq/core";
import { approvedTake, takesOf, tunedRules } from "../drafts/voice-habits.ts";
import { clip } from "../lib/sleeper.ts";
import { PLATFORMS } from "../platforms.ts";
import type { Answering } from "./answering.ts";

/**
 * What Quest reads from what it knows by then (their first words, the brief, the sites their Chrome is signed in to):
 * option ids by question key, none where it cannot tell. Asked one thing now: where they show up.
 */
export interface IntakeGuesser {
  guess(customer: Customer, questions: readonly IntakeQuestion[]): Promise<Readonly<Record<string, readonly string[]>>>;
}

/** What the manager is told when the takes end: nothing to tell them, at most one specific thing to ask. */
export const WARM_UP_OVER =
  "The first day's setup is over: their first sweep's finds wait on them on Your move, and how they sound is learned from their notes and edits on those (About them; the writer follows it). Put what matters to the work in the brief and the plan, and steer running work by it. " +
  "If something the work needs is still unclear, ask them the one specific question that settles it, in a line (what they said about their goal, their sites and their product is in the brief and your notes: never ask what they already told you). " +
  "Nothing unclear: ask nothing, and tell them nothing about the setup.";

/**
 * Where they show up, read from their words (never a card: the founder, 2026-10-24, the questions about them were "not
 * the natural way", having said it all in the first message). The ids are the platforms' keys (platforms.ts).
 */
const SHOW_UP: IntakeQuestion = {
  key: "where",
  text: "Where do they want to show up?",
  about: "the platforms the work uses (where they show up)",
  options: ["reddit", "x", "linkedin", "instagram", "facebook", "threads", "tiktok", "youtube", "telegram", "discord", "email"].map((id) => ({ id, label: PLATFORMS.find((p) => p.key === id)?.name ?? id })),
};

/**
 * The first day after the first sweep: where they show up is read from their words (never asked as a card), and the
 * manager hears the setup is over, with one profile check per platform to do. The takes that used to come here (Quest
 * writing as them until they said it was them) are retired: the voice is tuned by their notes and edits on real cards.
 */
export class IntakeService {
  readonly #customers: CustomerRepository;
  readonly #events: EventSink;
  readonly #wakeManager: () => void;
  readonly #clock: Clock;
  readonly #log: Logger;
  readonly #answering: Pick<Answering, "finished"> | null;
  readonly #guesser: IntakeGuesser | null;

  constructor(deps: {
    customers: CustomerRepository;
    events: EventSink;
    wakeManager: () => void;
    clock: Clock;
    log: Logger;
    answering?: Pick<Answering, "finished">;
    /** Reads where they show up from their words. */
    guesser?: IntakeGuesser;
  }) {
    this.#customers = deps.customers;
    this.#events = deps.events;
    this.#wakeManager = deps.wakeManager;
    this.#clock = deps.clock;
    this.#log = deps.log;
    this.#answering = deps.answering ?? null;
    this.#guesser = deps.guesser ?? null;
  }

  /** After a manager turn they spoke in: where they show up, read once there is a brief, until it is known. */
  async afterTurn(customerId: CustomerId, _talking: boolean, spoke = false): Promise<void> {
    const c = await this.#customers.get(customerId);
    if (spoke && c.brief && !c.profile["where"]) await this.#settleWhere(c);
  }

  /** Their first sweep ended: its finds wait on them, and the manager hears the first day's setup is over. */
  async begin(customerId: CustomerId): Promise<void> {
    const c = await this.#customers.get(customerId);
    this.#answering?.finished(c.id);
    if (!c.brief) return;
    await this.#settleWhere(c);
    await this.#platforms(await this.#customers.get(c.id));
    await this.#events.push(c.id, { kind: "system", topic: "about_them", text: WARM_UP_OVER });
    this.#wakeManager();
  }

  /**
   * Where they show up, read from their own words instead of asked: when Quest can tell, it is kept (the manager's board
   * shows it every turn). When it cannot, the manager asks when the work needs a platform.
   */
  async #settleWhere(c: Customer): Promise<void> {
    if (c.profile["where"] || !this.#guesser) return;
    let picks: string[] = [];
    try {
      picks = ((await this.#guesser.guess(c, [SHOW_UP]))["where"] ?? []).filter((id) => SHOW_UP.options.some((o) => o.id === id));
    } catch (e) {
      this.#log.warn("intake.guess_failed", { customerId: c.id, error: e instanceof Error ? e.message : String(e) });
    }
    if (!picks.length) return;
    const at = this.#clock.now();
    await this.#customers.profileAsked(c.id, "where", null, at, { guess: picks });
    await this.#customers.profileAnswered(c.id, "where", { choice: picks.join(","), answer: picks.map((p) => SHOW_UP.options.find((o) => o.id === p)?.label ?? p).join(", "), at });
    this.#log.info("intake.where_read", { customerId: c.id, platforms: picks.length });
  }

  /**
   * Where they show up: those are the platforms the work uses, and the manager does one profile check on each (the
   * founder, 2026-10-29: "one 'profile check' ask per platform. It's where replies turn into clicks").
   */
  async #platforms(c: Customer): Promise<void> {
    const picked = pickedPlatforms(c);
    if (!picked.length) return;
    const names = picked.map((k) => PLATFORMS.find((p) => p.key === k)?.name ?? k);
    await this.#events.push(c.id, {
      kind: "system",
      topic: "platforms",
      text:
        `From what they said, they show up on ${names.join(", ")}. Those are the platforms the work uses: work there first, and nowhere new without asking. ` +
        "Their profile there is where the people they reply to click through, so do a profile check on each once the brief is written (now, if it is): one outreach task that opens their own profile on each site " +
        "and compares it with the brief: their name, a bio or headline that says who they are and what they make, in their voice, and the link to their site where the profile has a field for it. " +
        "Every field that needs changing is drafted (kind profile, within the field's limit, every line true), all of a platform's at once: they get one profile check per platform to approve. " +
        "A profile that already says it right is kept as a fact. Signed out somewhere, say so in a line. Keep it in your plan; nothing to tell them before there is something to approve.",
    });
    this.#wakeManager();
  }
}


/** The platforms they show up on (platform keys), as read from their words. */
export function pickedPlatforms(c: Customer): string[] {
  const e = c.profile["where"];
  return e?.answeredAt && e.choice && e.choice !== SKIPPED && e.choice !== OWN_WORDS ? e.choice.split(",") : [];
}

/**
 * How they sound, for whoever talks to people as them (the outreach teammate, the manager): every rule of how Quest
 * writes as them after the takes, and the take they said is them.
 */
export function voiceLines(c: Customer): string[] {
  const rules = tunedRules(c.profile);
  const approved = approvedTake(c.profile);
  if (!rules.length && !approved) return [];
  return [
    "How they sound (tuned with them on their first day: Quest wrote as them and they said what was off until it was them). Everything written as them follows it, the writer's words included:",
    ...rules.map((r) => `  - ${r}`),
    ...(approved ? [`  - What they said is them, to ${approved.scene.who} ("${clip(approved.scene.says, 160)}"): "${clip(approved.wrote, 400)}"`] : []),
  ];
}

/** Takes from before they were retired: as many as there were. */
const MAX_TAKES = 10;

/** Whether the takes are over: one they said is them, one skipped, or as many as there are. */
const tuned = (c: Customer): boolean => {
  const takes = takesOf(c.profile);
  return takes.some((t) => t.choice === "me" || t.choice === SKIPPED) || takes.filter((t) => t.choice).length >= MAX_TAKES;
};

/** What the manager reads about them from the takes: how they sound, and whether more wait. */
export function aboutThem(c: Customer): string[] {
  if (!takesOf(c.profile).length) return [];
  const rule = "Never ask how they sound yourself, and never remind them of the takes.";
  const lines = voiceLines(c);
  if (!lines.length) return [`About them: the takes (you writing as them until it is them) are in the chat, not answered yet. ${rule}`];
  return ["About them:", ...lines.map((l) => `  ${l}`), ...(tuned(c) ? [] : [`  More takes wait in the chat; they answer when they like. ${rule}`])];
}
