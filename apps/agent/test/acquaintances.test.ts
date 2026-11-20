import { customerId } from "@mq/core";
import { describe, expect, it } from "vitest";
import { Acquaintances } from "../src/contacts/acquaintances.ts";
import { MemoryContacts, MemoryDrafts } from "./fakes.ts";

const id = customerId("00000000-0000-0000-0000-000000000001");
const post = "https://x.com/ari/status/7";

describe("getting to know people slowly", () => {
  it("gives nobody a first word unchecked, or before a like or a follow", async () => {
    const drafts = new MemoryDrafts();
    const people = new Acquaintances({ contacts: new MemoryContacts(), drafts, clock: { now: () => new Date() } });
    expect(await people.firstWord(id, post, "@ari", false)).toMatch(/^Check them first: read their profile \(read_page https:\/\/x\.com\/ari\)/);
    await people.keep(id, { site: "x.com", handle: "@Ari", about: "Builds Panlytics, analytics for indie apps." });
    expect(await people.firstWord(id, post, "@ari", false)).toMatch(/^Connect first/);
    // A like drafted in this run connects them; so does one drafted before.
    expect(await people.firstWord(id, post, "@ari", true)).toBeNull();
    await drafts.add({ customerId: id, kind: "like", platform: "x.com", url: post, target: "ari", title: null, author: "@ari", quote: "shipped the beta", text: "" });
    expect(await people.firstWord(id, post, "@ari", false)).toBeNull();
    expect((await people.known(id, "x.com")).map((k) => [k.contact.key, k.closeness])).toEqual([["x.com:ari", "met"]]);
    // Reddit's replies answer a thread: no check there.
    expect(await people.firstWord(id, "https://www.reddit.com/r/SaaS/comments/1/", "u/sam", false)).toBeNull();
  });
});
