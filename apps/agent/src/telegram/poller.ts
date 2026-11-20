import type { Logger } from "@mq/core";
import type { InboundService } from "../conversation/inbound-service.ts";
import { errorText } from "../lib/sleeper.ts";
import { UPDATES, type TelegramBotApi, type TgUpdate } from "./bot-api.ts";
import { parseUpdate } from "./updates.ts";

/** Telegram's notes about Quest's own pins, which go as they come in (the Telegram channel). */
export interface PinNotices {
  dropPinNotice(update: TgUpdate): Promise<boolean>;
}

/**
 * Telegram without a webhook, for running the agent on a laptop: it asks
 * Telegram for updates instead of being sent them. It takes the bot's updates
 * away from the webhook while it runs; `scripts/telegram-webhook.ts` gives them
 * back to the deployed agent afterwards.
 */
export class TelegramPoller {
  readonly #api: TelegramBotApi;
  readonly #inbound: InboundService;
  readonly #log: Logger;
  readonly #notices: PinNotices | null;
  readonly #stop = new AbortController();
  #loop: Promise<void> | null = null;
  #voices: Promise<unknown> = Promise.resolve();

  constructor(api: TelegramBotApi, inbound: InboundService, log: Logger, notices: PinNotices | null = null) {
    this.#api = api;
    this.#inbound = inbound;
    this.#log = log;
    this.#notices = notices;
  }

  async start(): Promise<void> {
    await this.#api.deleteWebhook();
    this.#log.warn("telegram.polling", { note: "the webhook is off while this runs; restore it with scripts/telegram-webhook.ts" });
    this.#loop = this.#run();
  }

  async stop(): Promise<void> {
    this.#stop.abort();
    await this.#loop?.catch(() => undefined);
  }

  async #run(): Promise<void> {
    let offset: number | undefined;
    while (!this.#stop.signal.aborted) {
      try {
        const updates = await this.#api.getUpdates(
          { ...(offset !== undefined ? { offset } : {}), timeout: 25, allowed_updates: UPDATES },
          this.#stop.signal,
        );
        for (const u of updates) {
          offset = u.update_id + 1;
          try {
            if (await this.#notices?.dropPinNotice(u)) continue;
            const inbound = parseUpdate(u);
            if (!inbound) continue;
            // A voice message is heard off the line: live, 2026-11-13, the local Whisper took 44 s on one, and a tap that
            // came behind it was answered past Telegram's 15 s. Voice messages keep their order among themselves.
            if (inbound.type === "voice") {
              this.#voices = this.#voices.then(() => this.#inbound.handle(inbound)).catch((e: unknown) => this.#log.error("telegram.update_failed", { error: errorText(e) }));
              continue;
            }
            await this.#inbound.handle(inbound);
          } catch (e) {
            this.#log.error("telegram.update_failed", { error: errorText(e) });
          }
        }
      } catch (e) {
        if (this.#stop.signal.aborted) return;
        this.#log.warn("telegram.poll_failed", { error: errorText(e) });
        await new Promise((r) => setTimeout(r, 3_000));
      }
    }
  }
}
