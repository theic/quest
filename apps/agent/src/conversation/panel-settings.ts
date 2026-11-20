import { placeKey, type CustomerId, type CustomerRepository, type PlaceRepository } from "@mq/core";
import { PLATFORMS, type Platform } from "../platforms.ts";
import { pickedPlatforms } from "./intake.ts";

/** One platform as their settings show it: worked on or ruled out, and whether replies there go up by themselves. */
export interface PlatformSetting {
  /** Its key in platforms.ts ("x"), what the panel sends back. */
  readonly platform: string;
  readonly name: string;
  readonly on: boolean;
  readonly alone: boolean;
}

/** The side panel's second view (docs/next-goal-open-source.md): what the chat does not say, and the past reports. */
export interface PanelSettingsView {
  readonly platforms: readonly PlatformSetting[];
  /** The model Quest runs on, in words: "Your Claude subscription", "OpenRouter". */
  readonly model: string;
  readonly reports: readonly { readonly day: string; readonly url: string }[];
}

export interface PanelSettingsDeps {
  readonly customers: Pick<CustomerRepository, "get">;
  readonly places: Pick<PlaceRepository, "listFor" | "save">;
  /** Whether replies on this host go up by themselves (Autopilot.alone with its trust key). */
  readonly alone: (customerId: CustomerId, host: string) => Promise<boolean>;
  readonly reports: (customerId: CustomerId) => Promise<readonly { readonly day: string; readonly url: string }[]>;
  readonly model: string;
}

const keyOf = (p: Platform): string => placeKey(`https://${p.hosts[0]}/`) ?? p.hosts[0]!;

/**
 * Their settings in the side panel: each platform they show up on ("Where they show up"), on or off (off is a place
 * ruled out by them, as set_place files it, which the rotation and the drafts already keep to), whether its replies go
 * up by themselves, the model, and the days that have a report.
 */
export class PanelSettings {
  readonly #d: PanelSettingsDeps;

  constructor(deps: PanelSettingsDeps) {
    this.#d = deps;
  }

  async view(customerId: CustomerId): Promise<PanelSettingsView> {
    const [customer, places, reports] = await Promise.all([
      this.#d.customers.get(customerId),
      this.#d.places.listFor(customerId),
      this.#d.reports(customerId).catch(() => []),
    ]);
    const off = new Set(places.filter((p) => p.verdict === "avoid").map((p) => p.key));
    const picked = pickedPlatforms(customer)
      .map((key) => PLATFORMS.find((p) => p.key === key))
      .filter((p): p is Platform => Boolean(p && p.key !== "email"));
    const platforms = await Promise.all(
      picked.map(async (p) => ({
        platform: p.key,
        name: p.name,
        on: !off.has(p.key) && !p.hosts.some((h) => off.has(h) || off.has(placeKey(`https://${h}/`) ?? h)),
        alone: await this.#d.alone(customerId, p.hosts[0]!).catch(() => false),
      })),
    );
    return { platforms, model: this.#d.model, reports };
  }

  /** On or off for a platform, as their word in the chat files it: off is a place ruled out by them. */
  async platform(customerId: CustomerId, platform: string, on: boolean): Promise<void> {
    const p = PLATFORMS.find((q) => q.key === platform);
    if (!p) return;
    const key = keyOf(p);
    const had = (await this.#d.places.listFor(customerId)).find((q) => q.key === key);
    await this.#d.places.save({
      customerId,
      key,
      name: had?.name ?? p.name,
      url: had?.url ?? `https://${p.hosts[0]}/`,
      verdict: on ? "search" : "avoid",
      rules: on ? (had?.rules?.startsWith("The customer's call") ? null : (had?.rules ?? null)) : "The customer's call: switched off in their settings",
      why: had?.why ?? "their settings",
    });
  }
}
