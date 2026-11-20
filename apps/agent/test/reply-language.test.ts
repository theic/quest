import { languageBriefing } from "@mq/i18n";
import { describe, expect, it } from "vitest";
import { otherLanguage, voiceNotes } from "../src/lib/voice.ts";

describe("writing to them in their language", () => {
  it("catches a reply in another language, the way it went out live (2026-10-13)", () => {
    // After screenshots of their X in Ukrainian, to an English-speaking founder.
    const live =
      'Tentei de novo: a janela no X está aberta, mas não consigo escrever nem carregar em "Опублікувати пост". O texto está no cartão: toca em "Post it" e sobe de @theIcreator. Queres que eu publique no X sem perguntar? Diz "post sozinho".';
    expect(otherLanguage(live, "en")).toBe("Portuguese");
    expect(voiceNotes(live, { language: "en" })[0]).toBe("it is written in Portuguese, but they read English: write it in English, whatever language the pages you read were in");
  });

  it("tells the scripts apart, and Russian from Ukrainian", () => {
    expect(otherLanguage("I read your site and found three people asking for an invoicing tool this week.", "ru")).toBe("English");
    expect(otherLanguage("Я прочитал ваш сайт и нашёл трёх человек, которые ищут такой сервис.", "uk")).toBe("Russian");
    expect(otherLanguage("Я прочитав ваш сайт і знайшов трьох людей, які шукають такий сервіс.", "ru")).toBe("Ukrainian");
    expect(otherLanguage("Je lis votre site et je cherche des gens qui ont besoin de ce que vous faites.", "de")).toBe("French");
  });

  it("leaves their language alone, with other people's words, names and links in it", () => {
    expect(otherLanguage("Я прочитал ваш сайт: Tally, Typeform и Jotform там названы прямо, ищу людей в r/SaaS.", "ru")).toBeNull();
    expect(otherLanguage('Someone in r/brasil asked "alguém conhece uma ferramenta para formulários sem código?" and it fits: https://reddit.com/r/brasil/x', "en")).toBeNull();
    // A stray word or two is not a language (the model's own reply at 15:36 the same day).
    expect(otherLanguage("I can't press Post myself: my tools won't type into X's composer, and the publisher waits for your tap. The words are on the card if you want para post it yourself.", "en")).toBeNull();
    expect(otherLanguage("我读了你的网站，找到了三个正在找发票工具的人。", "zh")).toBeNull();
    expect(otherLanguage("On it 👍", "pt")).toBeNull();
  });

  it("is in the briefing every turn: what they read never sets the language", () => {
    expect(languageBriefing("en")).toContain("that never changes the language you write to them in");
  });
});
