import { describe, expect, it } from "vitest";
import { SHAPES, drawShape, withoutEmoji, writingTells } from "../src/drafts/tells.ts";
import { loose } from "../src/drafts/writer.ts";

describe("a message's shape", () => {
  it("draws each shape by its weight, and none where a reply has to carry a point", () => {
    expect(new Set([0, 0.2, 0.5, 0.75, 0.99].map((roll) => drawShape({ kind: "reply", platform: "x.com" }, roll)?.name)).size).toBe(SHAPES.length);
    expect(drawShape({ kind: "reply", platform: "reddit" }, 0.5)).toBeNull();
    expect(drawShape({ kind: "post", platform: "x.com" }, 0.5)).toBeNull();
  });

  it("takes an emoji out, and leaves one that is all there is", () => {
    expect(withoutEmoji("Day 25 already 🔥")).toBe("Day 25 already");
    expect(withoutEmoji("🔥")).toBe("🔥");
    expect(withoutEmoji("Germany first, nice 🔥 Are there pigeons?")).toBe("Germany first, nice. Are there pigeons?");
  });

  it("drops the period of one sentence, and only that", () => {
    expect(loose("Looks clean.")).toBe("Looks clean");
    expect(loose("Looks clean")).toBe("Looks clean");
    expect(loose("Shipped that fast?")).toBe("Shipped that fast?");
    expect(loose("Nice. Looks clean.")).toBe("Nice. Looks clean.");
  });

  it("asks nothing right after a message that asked", () => {
    const lately = [{ platform: "x.com", text: "Did you write the viewer yourself?" }];
    expect(drawShape({ kind: "reply", platform: "x.com", lately }, 0.999)?.question).toBeFalsy();
  });

  it("holds the words to the shape, and hears the template", () => {
    const check = { kind: "reply", platform: "linkedin.com", emoji: true } as const;
    const shape = SHAPES[0]!;
    expect(writingTells("A chess game you can finish before the coffee cools", { ...check, shape }).join()).toContain("words");
    const rated = [{ platform: "x.com", text: "A pigeon club is a fun name for an app" }];
    expect(writingTells("Tickets for budgets is such a fun idea", { ...check, lately: rated }).join()).toContain("rating");
    expect(writingTells("Tickets for budgets is such a fun idea", check)).toEqual([]);
    const emoji = [{ platform: "x.com", text: "Nice one 🔥" }, { platform: "x.com", text: "Ha 😂" }];
    expect(writingTells("Clean work 🙂", { ...check, lately: emoji }).join()).toContain("emoji");
    expect(writingTells("Clean work", { ...check, lately: emoji })).toEqual([]);
  });
});
