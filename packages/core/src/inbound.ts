import type { ChannelAddress } from "./channel.ts";
import type { DraftAction } from "./drafts.ts";
import type { FindAction } from "./finds.ts";
import type { DraftId, FindId, QuestionId } from "./ids.ts";

/** Who sent something, as the channel knows them. */
export interface Sender {
  readonly channel: ChannelAddress;
  /** The channel's id for the person (a Telegram user id), stable across chats. */
  readonly userRef: string;
  readonly displayName: string | null;
  readonly language: string | null;
}

/**
 * What a person sent, whatever the channel. Channel adapters translate their own
 * updates into this; everything past the adapter is channel-agnostic.
 */
export type Inbound =
  | {
      readonly type: "text";
      readonly from: Sender;
      readonly text: string;
      readonly messageRef: string;
      /** The message this one replies to, when the person used "reply". */
      readonly replyToRef: string | null;
    }
  | {
      readonly type: "command";
      readonly from: Sender;
      readonly command: string;
      readonly args: string;
      readonly messageRef: string;
    }
  | {
      readonly type: "choice";
      readonly from: Sender;
      readonly questionId: QuestionId;
      readonly option: number;
      /** What the channel needs to acknowledge the press (a Telegram callback query id). */
      readonly ackRef: string;
      /** The message that carried the buttons. */
      readonly messageRef: string | null;
    }
  | {
      /** A button on a find's card: keep, skip, "I replied", or why they skipped. */
      readonly type: "find";
      readonly from: Sender;
      readonly findId: FindId;
      readonly action: FindAction;
      readonly ackRef: string;
    }
  | {
      /** A button on a draft Quest wrote for them: post it, or skip it. */
      readonly type: "draft";
      readonly from: Sender;
      readonly draftId: DraftId;
      readonly action: DraftAction;
      readonly ackRef: string;
    }
  | {
      /** A button on the language choice: "auto" (follow Telegram) or a locale. */
      readonly type: "language";
      readonly from: Sender;
      readonly locale: string;
      readonly ackRef: string;
      /** The message that carried the choice. */
      readonly messageRef: string | null;
    }
  | {
      /** A button on one of Quest's idea cards: write it, or not this one. */
      readonly type: "idea";
      readonly from: Sender;
      readonly ideaId: string;
      readonly action: "yes" | "no";
      readonly ackRef: string;
    }
  | {
      /**
       * A button of the deck itself (Your move): move to an ask, do all of a group, go through it one by one, skip all of
       * it, or yes or no to Quest's offer to go alone on a platform.
       */
      readonly type: "deck";
      readonly from: Sender;
      readonly action: "move" | "all" | "one" | "none" | "yes" | "no";
      readonly key: string;
      readonly ackRef: string;
    }
  | {
      /** The button that switches Quest on (or off), under the message that said it went off (or on). */
      readonly type: "power";
      readonly from: Sender;
      readonly on: boolean;
      readonly ackRef: string;
      /** The message the button is under, redrawn to how things stand. */
      readonly messageRef?: string | null;
    }
  | {
      /** A file or picture they sent (a CV, a screenshot), with the words they sent it with. */
      readonly type: "file";
      readonly from: Sender;
      /** What the channel needs to fetch the file (a Telegram file id). */
      readonly fileRef: string;
      readonly fileName: string;
      readonly mimeType: string | null;
      readonly size: number | null;
      readonly caption: string;
      readonly messageRef: string;
      readonly replyToRef?: string | null;
    }
  | {
      /**
       * Something they said rather than typed: a voice message, or an audio file. It is heard
       * as soon as it comes in, and from then on it is a text message like any other.
       */
      readonly type: "voice";
      readonly from: Sender;
      /** What the channel needs to fetch the recording (a Telegram file id). */
      readonly fileRef: string;
      readonly mimeType: string | null;
      /** The file's name when it came as an audio file; null for a voice message. */
      readonly fileName: string | null;
      /** How long it plays, when the channel says. */
      readonly seconds: number | null;
      readonly size: number | null;
      /** Words typed along with it. */
      readonly caption: string;
      readonly messageRef: string;
      readonly replyToRef: string | null;
    };
