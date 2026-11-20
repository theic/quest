import type { ChannelKind, ChatChannel } from "@mq/core";

/** Every chat surface Quest speaks on. Adding WhatsApp or the web chat is one more entry, nothing else changes. */
export class ChannelRegistry {
  readonly #byKind = new Map<ChannelKind, ChatChannel>();

  constructor(channels: readonly ChatChannel[]) {
    for (const c of channels) this.#byKind.set(c.kind, c);
  }

  get(kind: ChannelKind): ChatChannel {
    const channel = this.#byKind.get(kind);
    if (!channel) throw new Error(`no channel registered for ${kind}`);
    return channel;
  }
}
