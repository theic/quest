import type { Draft } from "./drafts.ts";
import type { Find } from "./finds.ts";
import type { Idea } from "./ideas.ts";
import type { Question } from "./questions.ts";

/**
 * Something only they can do, in the one line of what waits on them ("Your move"; the founder, 2026-10-23): a find's
 * reply to post, a draft, a send that may have gone up, a question from the team, Quest's idea for a post, likes (or
 * follows) on one platform together, or a profile check: every change to their profile on one platform, together. Not a record of its own: each is the record that already waits on them.
 */
export type Ask =
  | { readonly kind: "find"; readonly key: string; readonly find: Find }
  | { readonly kind: "draft"; readonly key: string; readonly draft: Draft }
  | { readonly kind: "question"; readonly key: string; readonly question: Question }
  | { readonly kind: "idea"; readonly key: string; readonly idea: Idea }
  /** Quest offers to do a kind on a platform by itself, having earned it (a trust key: "x.com", "x.com likes"). */
  | { readonly kind: "trust"; readonly key: string; readonly platform: string }
  | {
      /**
       * Two or more likes, or follows, on one platform, or the changes of a profile check there: "Do all", or one by one.
       * Nothing else goes all at once.
       */
      readonly kind: "group";
      readonly key: string;
      readonly what: GroupKind;
      readonly platform: string;
      readonly drafts: readonly Draft[];
    };

/** What goes together in one ask: likes, follows, or a profile check's changes. */
export type GroupKind = "like" | "follow" | "profile";
export const GROUP_KINDS: readonly GroupKind[] = ["like", "follow", "profile"];
export const isGroupKind = (k: string): k is GroupKind => (GROUP_KINDS as readonly string[]).includes(k);

/** An ask's key: what the deck's buttons and their page name it by (well under Telegram's 64 bytes with a prefix). */
export const askKeys = {
  find: (id: string): string => `find:${id}`,
  draft: (id: string): string => `draft:${id}`,
  question: (id: string): string => `question:${id}`,
  idea: (id: string): string => `idea:${id}`,
  trust: (platform: string): string => `trust:${platform}`,
  group: (what: GroupKind, platform: string): string => `group:${what}:${platform}`,
};

/** The deck as it shows: the ask in front, where it is in the line, the ones either side, and what just happened. */
export interface DeckView {
  /** Null: nothing waits on them. */
  readonly ask: Ask | null;
  /** Its place in the line, from 1. */
  readonly position: number;
  readonly total: number;
  /** The keys either side, for moving without deciding. */
  readonly prev: string | null;
  readonly next: string | null;
  /** What their last tap did, a line above the ask ("✓ Going up: your reply to u/maya"). */
  readonly last: string | null;
}

/**
 * The deck in their chat, kept so a restart finds it: its message, the ask it shows and where that stood in the line
 * (what takes its place is shown next), the asks it held when last drawn (a key not among them joined since), a group
 * they go through one by one, and the day's notifying sends.
 */
export interface DeckState {
  readonly ref: string | null;
  readonly showing: string | null;
  readonly at: number;
  readonly keys: readonly string[];
  readonly oneByOne: string | null;
  readonly last: string | null;
  /** It says nothing waits. */
  readonly empty: boolean;
  /** The day (UTC) the notices count is for. */
  readonly day: string | null;
  readonly notices: number;
  /** Decks it replaced, newest first: a reply to one is still a reply to the deck. */
  readonly old: readonly string[];
}

export const NO_DECK: DeckState = { ref: null, showing: null, at: 0, keys: [], oneByOne: null, last: null, empty: false, day: null, notices: 0, old: [] };
