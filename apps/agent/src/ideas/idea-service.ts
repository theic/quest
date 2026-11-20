import type { Asset, AssetFile, AssetRepository, ChannelKind, Clock, CustomerId, EventSink, Idea, IdeaAction, IdeaRepository, Logger } from "@mq/core";
import type { AskDeck } from "../asks/deck.ts";
import type { ChannelRegistry } from "../conversation/channel-registry.ts";
import type { Messenger } from "../conversation/messenger.ts";
import { clip } from "../lib/sleeper.ts";

/** The largest file a post takes along: Telegram hands a bot files of up to 20 MB; a picture is far less. */
export const ATTACH_MAX_BYTES = 8 * 1024 * 1024;

export interface IdeaServiceDeps {
  readonly ideas: IdeaRepository;
  readonly assets: AssetRepository;
  readonly messenger: Pick<Messenger, "showIdea" | "closeIdea">;
  /** Your move (asks/deck.ts): an idea goes there, not on a card of its own. */
  readonly deck?: AskDeck;
  readonly channels: Pick<ChannelRegistry, "get">;
  readonly events: EventSink;
  readonly wakeManager: () => void;
  readonly clock: Clock;
  readonly log: Logger;
}

/**
 * The customer steers (the founder, 2026-10-19: "Even though it is full autopilot, I still want to be in charge of
 * the direction: I want to share assets and my ideas for posts, as well as hear ideas from the agent").
 * - Their assets: every picture or video they send is kept with what it shows (mq.assets), and a link they share for
 *   posts the manager keeps; a post goes up with the pictures it names, attached in their Chrome.
 * - Their ideas for posts are kept as theirs to do (status yes), before any of Quest's own.
 * - Quest's ideas go to them as a card, Write it or Not this one, at most IDEAS_WAITING at a time; a yes wakes the
 *   manager to write it, a no is kept so the idea is not offered again.
 */
export class IdeaService {
  readonly #d: IdeaServiceDeps;

  constructor(deps: IdeaServiceDeps) {
    this.#d = deps;
  }

  /** A picture, a video or a file they sent, kept for their posts. */
  async keepFile(customerId: CustomerId, f: { channel: string; fileRef: string; mime: string | null; name: string | null; size: number | null; about: string }): Promise<Asset> {
    const kind = f.mime?.startsWith("image/") ? "image" : f.mime?.startsWith("video/") ? "video" : "file";
    const asset = await this.#d.assets.add({ customerId, kind, channel: f.channel, fileRef: f.fileRef, mime: f.mime, name: f.name, size: f.size, url: null, about: clip(f.about, 600) });
    return asset;
  }

  /** One of their assets, by id; null when it is not theirs or was dropped. */
  async asset(customerId: CustomerId, id: string): Promise<Asset | null> {
    const a = await this.#d.assets.get(id);
    return a && a.customerId === customerId ? a : null;
  }

  /** A link they shared for their posts. */
  async keepLink(customerId: CustomerId, url: string, about: string): Promise<Asset> {
    return this.#d.assets.add({ customerId, kind: "link", channel: null, fileRef: null, mime: null, name: null, size: null, url, about: clip(about, 600) });
  }

  async assets(customerId: CustomerId, limit = 20): Promise<Asset[]> {
    return this.#d.assets.list(customerId, limit);
  }

  async dropAsset(customerId: CustomerId, id: string): Promise<boolean> {
    return this.#d.assets.drop(customerId, id);
  }

  /** Which of these ids are theirs and can go up with a post (pictures and videos, not too big); and why not, for the rest. */
  async attachable(customerId: CustomerId, ids: readonly string[]): Promise<{ readonly ok: readonly Asset[]; readonly refused: readonly string[] }> {
    const ok: Asset[] = [];
    const refused: string[] = [];
    for (const id of ids) {
      const a = await this.#d.assets.get(id);
      if (!a || a.customerId !== customerId) refused.push(`${id} is not one of their assets`);
      else if (a.kind !== "image" && a.kind !== "video") refused.push(`${id} is a ${a.kind}: only pictures and videos go up with a post (a link goes in the words)`);
      else if (a.size !== null && a.size > ATTACH_MAX_BYTES) refused.push(`${id} is too big to attach (over ${ATTACH_MAX_BYTES / 1024 / 1024} MB)`);
      else ok.push(a);
    }
    return { ok, refused };
  }

  /** The files of these assets, read again from the chat they came in, for a post to attach. */
  async files(customerId: CustomerId, ids: readonly string[]): Promise<AssetFile[]> {
    const out: AssetFile[] = [];
    for (const a of (await this.attachable(customerId, ids)).ok) {
      if (!a.fileRef || !a.channel) continue;
      const bytes = await this.#d.channels.get(a.channel as ChannelKind).download(a.fileRef);
      const ext = a.mime?.split("/")[1]?.replace("jpeg", "jpg") ?? "bin";
      out.push({ name: a.name && a.name !== "picture.jpg" ? a.name : `${a.kind}-${a.id.slice(0, 8)}.${ext}`, type: a.mime ?? "application/octet-stream", data: Buffer.from(bytes).toString("base64") });
    }
    return out;
  }

  async ideas(customerId: CustomerId, limit = 30): Promise<Idea[]> {
    return this.#d.ideas.list(customerId, limit);
  }

  /** Their idea for a post: theirs to have done, before Quest's own. */
  async theirs(customerId: CustomerId, text: string, platform: string | null, assets: readonly string[]): Promise<Idea> {
    const idea = await this.#d.ideas.add({ customerId, source: "customer", text: clip(text, 1_000), platform, assets }, "yes");
    return idea;
  }

  /** A button on an idea's card. Returns the few words the press is acknowledged with. */
  async act(customerId: CustomerId, id: string, action: IdeaAction): Promise<string> {
    const idea = await this.#d.ideas.get(id);
    if (!idea || idea.customerId !== customerId) return "That one is no longer here";
    if (idea.status !== "new") return idea.status === "no" ? "Already passed on" : "Already on it";
    const decided = await this.#d.ideas.decide(customerId, id, action);
    if (!decided) return "That one is no longer here";
    if (idea.cardRef) await this.#d.messenger.closeIdea(customerId, idea.cardRef, decided);
    await this.#d.deck?.changed(customerId, { last: action === "yes" ? `Writing it: ${clip(idea.text, 80)}` : `Not this one: ${clip(idea.text, 80)}` });
    if (action === "yes") {
      await this.#d.events.push(customerId, {
        kind: "system",
        topic: "idea_yes",
        text:
          `They said yes to your idea for a post (idea ${idea.id}): "${idea.text}"${idea.platform ? ` on ${idea.platform}` : ""}` +
          `${idea.assets.length ? `, with their assets ${idea.assets.join(", ")}` : ""}. Write it now as a draft (kind post${idea.assets.length ? ", with those assets" : ""}), ` +
          "then mark the idea done with idea (status done, draft_id).",
      });
      this.#d.wakeManager();
      return "Writing it";
    }
    return "Skipped";
  }

  /** It was drafted (or they passed on it in words): moves on, so the board stops showing it as to do. */
  async decide(customerId: CustomerId, id: string, status: "yes" | "no" | "done", draftId: string | null = null): Promise<Idea | null> {
    return this.#d.ideas.decide(customerId, id, status, draftId);
  }
}

/** An asset on the board. */
function assetLine(a: Asset): string {
  return `  - [${a.id}] ${a.kind}${a.url ? ` ${a.url}` : ""}: ${clip(a.about, 160)}`;
}

/** For the manager's board: their ideas to do (first), Quest's waiting on their word, what they passed on lately, and their assets. */
export function ideaLines(ideas: readonly Idea[], assets: readonly Asset[]): string[] {
  const todo = ideas.filter((i) => i.status === "yes");
  const waiting = ideas.filter((i) => i.source === "quest" && i.status === "new");
  const passed = ideas.filter((i) => i.status === "no").slice(0, 5);
  const line = (i: Idea): string =>
    `  - [${i.id}] ${i.source === "customer" ? "theirs" : "yours"}: "${clip(i.text, 200)}"${i.platform ? ` (${i.platform})` : ""}${i.assets.length ? ` with assets ${i.assets.join(", ")}` : ""}`;
  return [
    ...(todo.length ? ["Ideas for posts to do (theirs first; draft each, then idea status done with the draft's id):", ...todo.map(line)] : []),
    ...(waiting.length ? ["Your ideas waiting for their word on a card:", ...waiting.map(line)] : []),
    ...(passed.length ? ["Ideas they passed on (never offer these again):", ...passed.map(line)] : []),
    ...(assets.length
      ? ["Their assets for posts (draft a post with assets to put one up with it):", ...assets.map(assetLine)]
      : []),
  ];
}
