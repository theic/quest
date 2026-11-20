/**
 * Which model writes like the customer: the writer itself (drafts/writer.ts, its prompt, its tells check
 * and its second try), on twelve jobs in two founders' voices: Reddit replies, a post, a DM, X and LinkedIn
 * replies, one in Portuguese, one card changed from their note. Each starts from a draft a teammate wrote
 * (the Voca Vela replies are MiMo's own, from the dev copy of the founder's finds). Prints each model's
 * words, the tells left, what it cost and how long it took; writes them all to JSON.
 *
 *   node --experimental-strip-types scripts/try-writer.ts [model[:effort|off] …]
 *   MQ_OUT=<path> …   (where the JSON goes; default try-writer.json here)
 *   MQ_ENV_FILE=<path to .env.local> …   (when the key lives in another checkout)
 *
 * effort is minimal, low, medium or high; off turns thinking off, which some models refuse.
 */
import { writeFileSync } from "node:fs";
import type { CustomerId, ModelCall } from "@mq/core";
import { OpenRouterModels, type ModelSeat } from "../apps/agent/src/agents/models.ts";
import { Writer, type Voice, type WritingJob } from "../apps/agent/src/drafts/writer.ts";
import { ENV_PATH, readEnvFile } from "./env-file.ts";

const key = readEnvFile(ENV_PATH).get("OPENROUTER_API_KEY");
if (!key) throw new Error("OPENROUTER_API_KEY missing from .env.local");

const SPECS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["anthropic/claude-opus-5.5:low", "anthropic/claude-sonnet-5.5:low", "anthropic/claude-fable-5.1:low", "openai/gpt-6.1-sol:low", "deepseek/deepseek-v4-pro-0813:off"];

const VOCA: Voice = {
  name: "Serhii",
  language: "en",
  brief:
    "Voca Vela (vocavela.live): a browser-based live voice tutor and real-time two-way translator. It translates live speech, camera photos of signs, menus and documents, and text in 39 languages, saves phrases from real conversations, and has an AI practice tutor. Founder Serhii Lahutin built it after fleeing Ukraine for Portugal. For people living in a country whose language they don't speak yet: expats, immigrants, refugees, long-stay visitors, and family interpreters who translate for a parent at appointments. Launched, nobody pays yet. Solo founder.",
  rules: ["Messages name him as the founder of Voca Vela.", "Never mention Tally or any other product.", "Plain words, no buzzwords, short sentences."],
  asked: ["Find people who struggle with the local language at the doctor, with letters or with landlords", "ok go"],
};

const MQ: Voice = {
  name: "Serhii",
  language: "en",
  brief:
    "Messaging Quest (messaging.quest): a free AI you hire in Telegram. You tell it who you need (customers, work, hires); it finds the people online asking for that right now and writes to them from your own Chrome, with your OK. For solo founders and indie makers looking for their first customers, and freelancers looking for clients. No spam, no bulk posting, no fake bystander voices.",
  rules: ["Comments name Messaging Quest plainly as his product, without a link, just the name."],
  asked: [
    "Find someone looking to get customers on X and comment about messaging quest, without adding a link, just the name - Messaging Quest.",
    'Do 3 more posts on X, but use simple language and short like "keep it up".',
  ],
};

interface Case {
  readonly id: string;
  readonly voice: Voice;
  readonly job: WritingJob;
}

const CASES: readonly Case[] = [
  {
    id: "chinalife-120",
    voice: VOCA,
    job: {
      kind: "reply", platform: "reddit", place: "r/chinalife", author: "Creative-Question538", title: null,
      quote: "I know some Chinese, but even when I am just ordering a coffee sometimes I get too nervous and my mind blanks. I can't imagine what will happen in that little brain of mine when faced with a dire emergency. … is there an APP to use for translation during phone calls?",
      draft: "In big cities 120 and 110 will usually find an English speaker, in rural areas do not count on it. Keep your address written in Chinese on you, and learn a few words like help, pain, bleeding.\n\nFor the moments when your Chinese blanks out: I'm Serhii, I build Voca Vela, a browser tool that translates live speech both ways. When the paramedics or the guard are standing in front of you, you can put the phone between you and just talk.",
    },
  },
  {
    id: "agingparents-mail",
    voice: VOCA,
    job: {
      kind: "reply", platform: "reddit", place: "r/AgingParents", author: "Maleficent-Fill-9917", title: null,
      quote: "I'm the one in my family who handles my mom's mail. she reads cantonese way better than english, so every few weeks there's a pile waiting for me. medi-cal, insurance, random stuff from the county. Honestly I'm tired. some of it is urgent, most of it isn't, and i can't tell which until i've read the whole thing.",
      draft: "I go through this with language first: a phone camera translator helps a lot when the letter is in a language your parent reads better. You point it at the page and get the point of the notice in seconds, so you can sort urgent from junk without reading every line.\n\nI'm Serhii, founder of Voca Vela. We built live speech translation plus camera translation for letters, signs and documents, and a phrasebook you can save Medi-Cal or insurance phrases into. Happy to tell you more if useful.",
    },
  },
  {
    id: "expats-learning",
    voice: VOCA,
    job: {
      kind: "reply", platform: "reddit", place: "r/expats", author: "Parking_Committee_77", title: null,
      quote: "For those of you who have moved to another country, I'm curious about how you went about learning the local language. What did you actually use to learn and practice the language? … And more importantly, what were you actually looking for when you started learning? Was it mainly speaking practice, structured lessons, flexibility, finding people to practice with, motivation, or something else?",
      draft: "I moved from Ukraine to Portugal and built Voca Vela for exactly this gap. Lessons never matched a real conversation, so it is a browser live voice tutor plus a real-time translator for speech, photos of signs and menus, and text, and it saves phrases from your actual conversations. Speaking practice is the core of it, not tapping through lessons. Happy to answer anything about what worked for me.",
    },
  },
  {
    id: "thailand-label",
    voice: VOCA,
    job: {
      kind: "reply", platform: "reddit", place: "r/Thailand", author: "Grouchy_Nothing_2034", title: null,
      quote: "Her family gave me this and i have no idea what it is. I just want to know the ingredients so i can understand what i am outting into my body. Pls help me out and thank you for your time. ... My wifes family from Laos so Thai is not something they read or write.",
      draft: "I make Voca Vela, a browser translator that reads photos of labels, menus and documents in 39 languages. For something like this you can point your camera at the package and get the ingredients back in English right away, no typing. It also does live speech if you need to ask the shop or family about it. Happy to help you try it on this label if you want.",
    },
  },
  {
    id: "sideproject-post",
    voice: VOCA,
    job: {
      kind: "post", platform: "reddit", place: "r/SideProject", author: null, quote: null,
      title: "I built a live voice translator after moving from Ukraine to Portugal 🚀",
      draft: "After fleeing Ukraine and landing in Portugal, I quickly realized that language apps don't prepare you for real life. Ordering at a café, talking to a landlord, sitting at the câmara — these are the moments that matter.\n\nSo I built Voca Vela: a browser-based live voice tutor and real-time two-way translator. It's not just another translation app — it's designed to help you navigate real conversations seamlessly.\n\nKey features:\n- Live two-way speech translation in 39 languages\n- Camera translation for signs, menus and documents\n- Saves phrases from your real conversations\n- AI practice tutor\n\nIt's live at vocavela.live. Would love your feedback! What features would you want to see next?",
    },
  },
  {
    id: "dm-doctor",
    voice: VOCA,
    job: {
      kind: "message", platform: "reddit", place: "u/Quiet-Lake-1234", author: "Quiet-Lake-1234",
      quote: "my dad has a cardiology appointment next week and the clinic says they can't guarantee an interpreter. last time he nodded along to everything and understood maybe half.",
      title: "About your dad's cardiology appointment",
      draft: "Hi! I saw your post about your dad's cardiology appointment and I totally understand how stressful that must be. I'm Serhii, the founder of Voca Vela, a live two-way voice translator that works right in the browser. It's designed exactly for moments like this — you can put the phone between your dad and the doctor and they can talk naturally in their own languages. It also translates photos of documents, so discharge papers are covered too. Would you be open to trying it before the appointment? Happy to help you set it up!",
    },
  },
  {
    id: "portugal-pt",
    voice: VOCA,
    job: {
      kind: "reply", platform: "reddit", place: "r/portugal", author: "brasileira_em_braga", title: null,
      quote: "Alguém sabe se nas Finanças de Braga atendem em inglês? O meu marido é americano e não fala nada de português, e temos de tratar do NIF dele na próxima semana.",
      draft: "Depende muito do funcionário — em Braga é comum não falarem inglês. Leve todos os documentos já traduzidos e, se puder, marque atendimento por telefone antes. Sou o Serhii, fundador do Voca Vela, um tradutor de voz ao vivo no navegador: o seu marido pode pôr o telemóvel entre ele e o funcionário e falar normalmente. É exatamente para estas situações!",
    },
  },
  {
    id: "edit-shorter",
    voice: { ...VOCA, asked: [...VOCA.asked, "too long and too salesy. shorter, and don't say founder, just that I made it"] },
    job: {
      kind: "reply", platform: "reddit", place: "r/taiwan", author: "Unable-Grape-8374", title: null,
      quote: "Most restaurants don't have English menus (even in some touristy hotspots) - Most customer service staff/waiters/cashiers don't speak or understand English … Hospitals/doctors clinics most of the time won't have English forms (from my prenatal experience), though some doctors can speak some English. … I do use google translate and all the apps to get me through the day.",
      draft: "The hospital forms and the cashier moments are the ones that add up. Plenty of people here get through them by putting a live translator on the phone between them and the other person, so the conversation can just happen.\n\nI'm Serhii, I built Voca Vela for exactly this. It translates live speech both ways in the browser, and the camera reads menus and forms. It's for real conversations here, not lessons.",
    },
  },
  {
    id: "x-day47",
    voice: MQ,
    job: {
      kind: "reply", platform: "x.com", place: "@buildwithnoa", author: "@buildwithnoa", title: null,
      quote: "Day 47 of building in public. Still 0 paying customers. Posting every day and it feels like nobody is listening. How did you get your first 10?",
      draft: "Keep going! The first 10 are always the hardest. What worked for me is finding people who are already asking for what you sell instead of broadcasting. I'm building Messaging Quest, an AI that finds those people for you and writes to them from your own accounts. It's been a game-changer for early traction! 🚀",
    },
  },
  {
    id: "x-colddm",
    voice: MQ,
    job: {
      kind: "reply", platform: "x.com", place: "@mira_ships", author: "@mira_ships", title: null,
      quote: "cold DMs on X feel so spammy. what's a non-cringe way to find early users for a B2B tool?",
      draft: "Totally agree — cold DMs feel spammy because they're untargeted. The non-cringe way is to reply where people are already asking for help with the problem you solve. That's exactly why I built Messaging Quest: it finds those conversations in real time and drafts replies from your own account, so you're joining a conversation, not interrupting one.",
    },
  },
  {
    id: "x-launch",
    voice: MQ,
    job: {
      kind: "reply", platform: "x.com", place: "@tomasbuilds", author: "@tomasbuilds", title: null,
      quote: "Shipped v1 of my invoicing app today. 3 months of nights and weekends. Now the scary part: finding people who actually want it.",
      draft: "Congrats on shipping! 🎉 That's a huge milestone. The scary part is real, but you've got this. If you want help finding people who are actively looking for an invoicing tool, Messaging Quest can scan conversations across the web and help you reach out. Keep it up!",
    },
  },
  {
    id: "linkedin-freelance",
    voice: MQ,
    job: {
      kind: "reply", platform: "linkedin.com", place: "a post by Dana Whitfield", author: "Dana Whitfield", title: null,
      quote: "Six months freelancing as a brand designer. Referrals dried up in August and I'm realizing I never built a way to find clients myself. How do other freelancers find work when the network goes quiet?",
      draft: "Great question, Dana! Many freelancers face this exact challenge. The key is to shift from passive referrals to actively finding clients who are already looking for help. I'm the founder of Messaging Quest, an AI assistant that finds people online who are asking for services like yours and helps you reach out to them in a personal way. Happy to share more if helpful!",
    },
  },
  // Translations: a teammate drafts in English, the person wrote in their own language. The words must read
  // as a native speaker typed them, not as a translation (the founder's word, 2026-10-14).
  {
    id: "x-es",
    voice: MQ,
    job: {
      kind: "reply", platform: "x.com", place: "@lucia_saas", author: "@lucia_saas", title: null,
      quote: "Tres meses con mi SaaS de reservas para peluquerías y 0 clientes de pago. ¿Dónde encontrasteis a vuestros primeros usuarios? Ya no sé qué más probar.",
      draft: "Three months is normal, don't give up! What worked for me is finding people who are already asking for a tool like yours and replying to them directly. I built Messaging Quest, an AI that finds those conversations for you. You've got this!",
    },
  },
  {
    id: "linkedin-de",
    voice: MQ,
    job: {
      kind: "reply", platform: "linkedin.com", place: "a post by Jonas Bergmann", author: "Jonas Bergmann", title: null,
      quote: "Seit einem Jahr selbstständig als Webentwickler. Empfehlungen laufen gut, aber ich habe keinen Plan, wie ich neue Kunden finde, wenn die mal ausbleiben. Wie macht ihr das?",
      draft: "Great question! Referrals are great until they stop. The trick is to find people who are already asking for a developer right now, in forums and on social media, and answer them. I made Messaging Quest, it finds those people and drafts replies from your own account.",
    },
  },
  {
    id: "facebook-uk",
    voice: { ...VOCA, language: "uk" },
    job: {
      kind: "reply", platform: "facebook.com", place: "the group Українці в Лісабоні", author: "Олена Коваль", title: null,
      quote: "Дівчата, хто ходив до сімейного лікаря в центрі здоров'я без португальської? Мене записали на наступний четвер, а я боюся, що нічого не зрозумію і не зможу пояснити, що болить.",
      draft: "Don't worry, many of us went through this. Write down your symptoms in Portuguese before the visit and bring your documents. I'm Serhii, I made Voca Vela, a voice translator in the browser: you can put the phone between you and the doctor and both talk in your own languages.",
    },
  },
  {
    id: "x-ptbr",
    voice: MQ,
    job: {
      kind: "reply", platform: "x.com", place: "@dev_rafa", author: "@dev_rafa", title: null,
      quote: "lancei meu app de controle financeiro faz 2 semanas e até agora só minha mãe usou kkkk alguém tem dica de onde achar os primeiros usuários?",
      draft: "Haha, the mom user is a classic! Look for people already complaining about tracking their money and reply to them. I built Messaging Quest, it finds those people for you. Keep it up!",
    },
  },
  // The new direction (2026-10-14): their brand, built in public. A weekly post in their voice, from a promo draft.
  {
    id: "x-buildinpublic",
    voice: MQ,
    job: {
      kind: "post", platform: "x.com", place: null, author: null, quote: null, title: null,
      draft: "🚀 Week 6 of building Messaging Quest in public! 📈 This week: 41 new users (up from 12!), $0 MRR (still free!), shipped a brand new writer that makes every reply sound like YOU. The journey continues! What should I build next? 👇 #buildinpublic #indiehackers",
    },
  },
];

interface Result {
  readonly model: string;
  readonly case: string;
  readonly calls: number;
  readonly tells: readonly string[];
  readonly title: string | null;
  readonly text: string;
  readonly cost: number;
  readonly ms: number;
  readonly input: number;
  readonly cached: number;
  readonly reasoning: number;
  readonly error?: string;
}

const failures: string[] = [];
const quiet = { info: () => {}, debug: () => {}, error: () => {}, warn: (_e: string, f: Record<string, unknown>) => failures.push(String(f["error"] ?? "")) } as never;

async function runModel(spec: string): Promise<Result[]> {
  const [model, effort = "low"] = spec.split(/:(?=[a-z]+$)/);
  const seat: ModelSeat = {
    id: model!, fallbacks: [], maxTokens: 1_200, temperature: 0.6,
    reasoning: effort !== "off", ...(effort !== "off" ? { effort: effort as ModelSeat["effort"] } : {}),
  };
  const unused: ModelSeat = { id: "unused", fallbacks: [], maxTokens: 100, temperature: 0, reasoning: false };
  const models = new OpenRouterModels(key!, { manager: unused, researcher: unused, volume: unused, writer: seat, vision: unused });
  const out: Result[] = [];
  // One after another, as a run's drafts come: the second and later read the founder's voice from the cache.
  for (const c of CASES) {
    const calls: ModelCall[] = [];
    const writer = new Writer({ models, voice: async () => c.voice, spend: { record: (call) => calls.push(call) }, log: quiet });
    const started = Date.now();
    const w = await writer.write((c.voice.brief === MQ.brief ? "mq" : "voca") as CustomerId, c.job);
    out.push({
      model: spec, case: c.id, calls: calls.length, tells: w.tells, title: w.title, text: w.text, ms: Date.now() - started,
      cost: calls.reduce((a, k) => a + (k.usage.cost ?? 0), 0),
      input: calls.reduce((a, k) => a + k.usage.input, 0),
      cached: calls.reduce((a, k) => a + k.usage.cached, 0),
      reasoning: calls.reduce((a, k) => a + k.usage.reasoning, 0),
      ...(w.rewritten ? {} : { error: failures.at(-1) ?? "the writer failed; the draft went on as it was" }),
    });
  }
  return out;
}

const results = (await Promise.all(SPECS.map(runModel))).flat();

for (const spec of SPECS) {
  const rs = results.filter((r) => r.model === spec);
  const ok = rs.filter((r) => !r.error);
  const avg = (f: (r: Result) => number): number => ok.reduce((a, r) => a + f(r), 0) / Math.max(ok.length, 1);
  console.log(
    `\n==== ${spec}  ${ok.length}/${rs.length} written, ${ok.filter((r) => r.calls === 1).length} on the first try, ${ok.filter((r) => r.tells.length).length} with tells left; ` +
      `$${avg((r) => r.cost).toFixed(4)} a message, ${(avg((r) => r.ms) / 1000).toFixed(1)} s, ${Math.round(avg((r) => r.input))} tokens in (${Math.round(avg((r) => r.cached))} cached), ${Math.round(avg((r) => r.reasoning))} thinking`,
  );
  for (const r of rs) {
    console.log(`  [${r.case}] ${r.calls} call${r.calls === 1 ? "" : "s"}, $${r.cost.toFixed(4)}, ${(r.ms / 1000).toFixed(1)} s${r.tells.length ? `, LEFT: ${r.tells.map((t) => t.split(":")[0]).join(" | ")}` : ""}${r.error ? `, ERROR ${r.error.slice(0, 160)}` : ""}`);
    if (r.title) console.log(`    TITLE: ${r.title}`);
    console.log(`    ${r.text.replace(/\n+/g, " / ")}`);
  }
}
writeFileSync(process.env["MQ_OUT"] ?? "try-writer.json", JSON.stringify({ at: new Date().toISOString(), cases: CASES, results }, null, 2));
