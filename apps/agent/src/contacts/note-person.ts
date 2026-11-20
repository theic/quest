import { bareHandle } from "@mq/core";
import { tool } from "langchain";
import { z } from "zod";
import type { SeenPages } from "../tasks/seen-pages.ts";
import type { SubagentContext } from "../tasks/subagents.ts";
import { contactSite, handleOf, isProfileOf, profileUrlOf } from "./handles.ts";

/** The person a page and a name stand for, as the run keeps them apart: "x.com:dana_builds". */
export const personIn = (url: string, who: string | null | undefined): string => `${contactSite(url) ?? ""}:${handleOf(url) ?? bareHandle(who ?? "")}`;

const hostOf = (url: string): string | null => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
};

/**
 * The check of someone, kept for good: who they are and what they build, from their own profile and their site, read in
 * this run (the code holds it: a check is what their pages said, never a guess). Every later run, the writer and the
 * People tab read it, and a first word to them waits for it (Acquaintances.firstWord).
 */
export function notePersonTool(ctx: SubagentContext, seen: SeenPages) {
  return tool(
    async ({ profile, handle, name, about, site, needs, can_give, gave, note, plan, reach }) => {
      if (!ctx.people) return "Keeping people is not configured.";
      const where = contactSite(profile);
      const who = handleOf(profile) ?? (handle ? bareHandle(handle) : null);
      if (!where || !who) return "Give their profile's address (or a post of theirs) and their handle.";
      const pages = seen.all();
      const own = profileUrlOf(profile);
      // Where the address says whose profile it is, that page must have been read; elsewhere, the page they are on.
      const read = own ? pages.some((p) => isProfileOf(p.url, who)) : Boolean(seen.post(profile));
      if (!read) return `Read their profile first (read_page ${own ?? profile}): a check is what their own pages say.`;
      if (site) {
        const host = hostOf(site);
        if (!host) return "Their site's address is not one: give it whole, or leave it out.";
        if (!pages.some((p) => hostOf(p.url) === host)) return `Read their site first (read_site ${site}, pages 2), or leave site out when they have none.`;
      }
      const kept = await ctx.people.keep(ctx.customerId, {
        site: where,
        handle: who,
        name: name ?? null,
        profileUrl: own ?? profile,
        siteUrl: site ?? null,
        about,
        needs: needs ?? null,
        canGive: can_give ?? null,
        gave: gave ?? null,
        note: [note, plan ? `Plan: ${plan}` : null].filter(Boolean).join(" ").slice(0, 600) || null,
      });
      // What is public about them goes to the shared cache too, for every later run, anyone's.
      await ctx.known?.know({ site: where, handle: who, name: name ?? null, profileUrl: own ?? profile, siteUrl: site ?? null, about, reach: reach ?? null }).catch(() => undefined);
      // What was kept before comes back with it: the plan and what was promised (live, 2026-11-14: four makers on Mastodon
      // said yes to an introduction, and the run answering them could not tell whom they had been offered, though
      // their record held the posts).
      const before = kept.notes.slice(0, -1).slice(-3).map((n) => `- ${n.at.toISOString().slice(0, 10)}: ${n.text}`);
      const given = kept.given.slice(-3).map((g) => `- given: ${g}`);
      const lines = [...before, ...given].join("\n").slice(0, 1800);
      const record = lines ? `\nOn their record from before (a plan's "Introduce" and "Links" lines are what they were offered: when they said yes, do that step now):\n${lines}` : "";
      return `Kept @${kept.handle}${kept.notes.length > 1 ? ` (known since ${kept.createdAt.toISOString().slice(0, 10)})` : ""}.${record}`;
    },
    {
      name: "note_person",
      description:
        "Keep what you learned about someone, for good: after reading their profile (and their site, when it names one), " +
        "before any word to them, and again when something passed (what you gave them, what they said). Every later run, " +
        "the words written to them and the customer's People tab read it. A first reply or message to anyone waits for it.",
      schema: z.object({
        profile: z.string().url().describe("Their profile's address (or a post of theirs where profiles have no address of their own)."),
        handle: z.string().min(1).describe("Their handle on that site."),
        name: z.string().max(200).optional(),
        about: z.string().min(10).max(1000).describe("Who they are and what they build, from their profile and site: specific, a sentence or two."),
        site: z.string().url().optional().describe("What they build, when it has an address of its own (read it with read_site first)."),
        needs: z.string().max(500).optional().describe("What they are after now: first users, feedback on their landing, a cofounder."),
        can_give: z.string().max(500).optional().describe("What the customer could give them: feedback on something of theirs, people asking for what they built."),
        gave: z.string().max(300).optional().describe("What was given to them this time, when something was."),
        note: z.string().max(300).optional().describe("One line of what happened this time."),
        plan: z.string().max(300).optional().describe("Before a first word to them: the three steps ahead, a line. What this opener gives them and why they would answer; what you say when they do; what you ask for in the end (try the product, a call, an introduction)."),
        reach: z.string().max(500).optional().describe("Every public contact of theirs you saw, with its address: an email, their X, LinkedIn, Bluesky, Telegram, GitHub. So nobody has to look twice."),
      }),
    },
  );
}
