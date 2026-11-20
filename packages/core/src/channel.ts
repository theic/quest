/** A place where a person talks to Quest. Telegram first; the web chat is the fallback. */
export type ChannelKind = "telegram" | "web";

/** One chat on one channel: where a message goes. */
export interface ChannelAddress {
  readonly kind: ChannelKind;
  readonly address: string;
}

export const sameAddress = (a: ChannelAddress, b: ChannelAddress): boolean =>
  a.kind === b.kind && a.address === b.address;
