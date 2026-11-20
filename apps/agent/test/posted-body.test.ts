import type { FoundPost, PostSearch } from "@mq/core";
import { describe, expect, it } from "vitest";
import { answeredBelow, bodyShown } from "../src/chrome/posted-body.ts";
import { answeredSince, xStatus } from "../src/tasks/answered-since.ts";

const BODY = "I made it. MQ is a tool that drives your brand online on autopilot. You hire it in Telegram, it finds people asking for what you built and writes to them from your own accounts. Free, messaging.quest";

describe("a posted body on its page", () => {
  it("shows when its words are there, with the link the way the site shows it", () => {
    expect(bodyShown(`Rubel Ok. What is Messaging Quest? Serhii L ${BODY} 1 reply`, BODY)).toBe(true);
    // Live, 2026-10-14: the reply on X, its link shown X's way. It went up; the exact check held it as unknown.
    expect(bodyShown(`Serhii L @theIcreator · 6 min ${BODY.replace("messaging.quest", "…g.questmessaging.questmessaging.quest")}`, BODY)).toBe(true);
    const linked = "Here is the form I made: https://forms.example.com/start?ref=thread-42 and it is free to try.";
    expect(bodyShown("Here is the form I made: forms.example.com/start?ref=th… and it is free to try.", linked)).toBe(true);
  });

  it("shows with its emoji drawn as pictures", () => {
    // Live, 2026-10-14: X draws 🚀 as an image; the reply to @flutter_loverr had gone up and was held.
    const body = "Thanks! It's free and you run it from Telegram. Keep building 🚀";
    expect(bodyShown("Serhii L @theIcreator Thanks! It's free and you run it from Telegram. Keep building 1 reply", body)).toBe(true);
    expect(bodyShown("Serhii L 👍🏽 Thanks! It's free and you run it from Telegram. Keep building ❤️", body)).toBe(true);
  });

  it("does not show from scattered words or a bare link", () => {
    const linked = "Here is the form I made: https://forms.example.com/start and it is free to try.";
    expect(bodyShown(`Here is the form I made: ${"other words ".repeat(30)} and it is free to try.`, linked)).toBe(false);
    expect(bodyShown("and it is free to try. Here is the form I made:", linked)).toBe(false);
    expect(bodyShown("Free, messaging.quest", "Hi! messaging.quest")).toBe(false);
    expect(bodyShown("anything", "")).toBe(false);
  });
});

describe("their own answer under a post", () => {
  it("is a reply of theirs below it, never their card in X's Relevant people", () => {
    // Live, 2026-11-04: Himanshu's post page, as the poster read it: the post it answered, his post, then the two cards.
    const url = "https://x.com/SamBuilds16/status/2117980998826906073";
    const quote = "I’d keep one exception lane even after approval becomes optional.";
    const page = [
      "Serhii Lahutin @theIcreator · 23h You basically train your own hire, so until you're sure it does the job right",
      "Sam Okafor @SamBuilds16 That makes sense. I’d keep one exception lane even after approval becomes optional.",
      "Sam Okafor @SamBuilds16 Follow Full-stack engineer | Co-founded HeatCodes",
      "Serhii Lahutin @theIcreator Building Messaging Quest: your first hire as a solo founder",
    ];
    expect(answeredBelow(page, quote, "@theIcreator", url)).toBeNull();
    const answered = [...page.slice(0, 2), "Serhii Lahutin @theIcreator · 5m Fair point, an exception lane it is.", ...page.slice(2)];
    expect(answeredBelow(answered, quote, "@theIcreator", url)).toBe("Serhii Lahutin @theIcreator · 5m Fair point, an exception lane it is.");
  });
});

describe("their own answer on X, from X's search", () => {
  it("is found after the post, by the time its id carries", async () => {
    // Theo's post (2 Nov), and the founder's answer under it two days later: the thread in a background tab showed neither.
    const post = xStatus("https://x.com/marcopet_/status/2117307269595447599")!;
    expect(post.handle).toBe("marcopet_");
    expect(post.at.toISOString().slice(0, 10)).toBe("2026-11-02");
    const asked: string[] = [];
    const search = (rows: FoundPost[]): PostSearch => ({ sources: [], search: async (q: { query: string }) => (asked.push(q.query), rows) }) as unknown as PostSearch;
    const mine = { source: "x", url: "https://x.com/theIcreator/status/2117400000000000000", author: "theIcreator", title: null, text: "Boring pays the bills", postedAt: null } as FoundPost;
    const older = { ...mine, url: "https://x.com/theIcreator/status/2117000000000000000" };
    expect(await answeredSince(search([older, mine]), "@theIcreator", post.handle, post.at)).toBe(mine);
    expect(asked).toEqual(["from:theicreator to:marcopet_"]);
    expect(await answeredSince(search([older]), "theIcreator", post.handle, post.at)).toBeNull();
    expect(await answeredSince({ search: async () => { throw new Error("offline"); } } as unknown as PostSearch, "theIcreator", post.handle, post.at)).toBeNull();
  });
});
