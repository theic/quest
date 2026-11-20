import type { CustomerId } from "./ids.ts";

/**
 * What the customer shares for their posts (the founder, 2026-10-19: "I want to share assets and my ideas for posts,
 * as well as hear ideas from the agent"): a picture, a video or a file sent in the chat, kept by the chat's own file
 * reference with what it shows, or a link. Quest puts them in posts as theirs; dropped, never deleted.
 */
export type AssetKind = "image" | "video" | "file" | "link";

/** One word said in a video, and where it sits in the source, in seconds. */
export interface ClipWord {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/**
 * What Quest made of a video they gave it (the founder, 2026-10-24: "The bot must be able to process any video I send
 * below one GB"): how it is shaped, what is said in it and when, where it goes quiet, and what the sampled frames show.
 * The manager reads this instead of the video, and an edit cuts and captions by it.
 */
export interface ClipReading {
  readonly seconds: number;
  /** As it is shown, with a phone's rotation applied. */
  readonly width: number;
  readonly height: number;
  readonly fps: number | null;
  readonly hasAudio: boolean;
  /** Where it goes quiet: start and end, in seconds. */
  readonly silences: readonly (readonly [number, number])[];
  /** The language the speech was heard in ("en", "uk", "ru"), when there is speech. */
  readonly language: string | null;
  readonly words: readonly ClipWord[];
  /** What the sampled frames show, in a few sentences. */
  readonly shows: string;
  /** Where the speaker's face sits across the picture, 0 (left) to 1 (right); null when no one is in view. */
  readonly faceX: number | null;
  /** How much of it was listened to: a long video is read only to a limit. */
  readonly heard: number;
  /** Its loudness in LUFS, when it has sound. */
  readonly loudness: number | null;
}

export interface Asset {
  readonly id: string;
  readonly customerId: CustomerId;
  readonly kind: AssetKind;
  /** The chat it came from and its file there (Telegram's file id), read again when a post needs it; "upload" for one sent from their page. */
  readonly channel: string | null;
  readonly fileRef: string | null;
  readonly mime: string | null;
  readonly name: string | null;
  readonly size: number | null;
  /** A link's address. */
  readonly url: string | null;
  /** What it is, in words: what a picture shows, their caption, a link's page. */
  readonly about: string;
  /** What a video says and shows, once it has been read (ideas/clip-reader.ts); null before, and for what is not a video. */
  readonly reading: ClipReading | null;
  readonly createdAt: Date;
}

export type NewAsset = Omit<Asset, "id" | "createdAt" | "reading"> & { readonly reading?: ClipReading | null };

/** The channel of an asset that came from their page's upload button, not from a chat. */
export const UPLOAD_CHANNEL = "upload";

/** An asset's file, as a post attaches it. */
export interface AssetFile {
  readonly name: string;
  readonly type: string;
  /** The bytes, base64. */
  readonly data: string;
}

/**
 * An idea for a post: theirs (Quest does it, theirs before its own), or Quest's own, put to them as a card they say
 * yes or no to. new: Quest's, waiting for their word; yes: theirs, or Quest's they took; no: not this one; done: drafted.
 */
export type IdeaSource = "customer" | "quest";
export type IdeaStatus = "new" | "yes" | "no" | "done";

export interface Idea {
  readonly id: string;
  readonly customerId: CustomerId;
  readonly source: IdeaSource;
  readonly text: string;
  /** Where it goes, when it is for one platform ("x.com", "linkedin.com", "reddit"). */
  readonly platform: string | null;
  /** Their assets it uses. */
  readonly assets: readonly string[];
  readonly status: IdeaStatus;
  readonly cardRef: string | null;
  /** The draft made from it. */
  readonly draftId: string | null;
  readonly createdAt: Date;
  readonly decidedAt: Date | null;
}

export interface NewIdea {
  readonly customerId: CustomerId;
  readonly source: IdeaSource;
  readonly text: string;
  readonly platform: string | null;
  readonly assets: readonly string[];
}

/** A button on one of Quest's idea cards: write it, or not this one. */
export type IdeaAction = "yes" | "no";
