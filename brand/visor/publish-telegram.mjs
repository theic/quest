// Puts the Visor on Telegram through the Bot API (9.4+). Node 22, no dependencies.
//   TELEGRAM_BOT_TOKEN=... node publish-telegram.mjs photo
//     sets the 6 s Active loop as the bot's animated profile photo (everyone sees the same one)
//   TELEGRAM_BOT_TOKEN=... node publish-telegram.mjs stickers <owner_user_id>
//     creates the six-state sticker set "quest_by_<bot username>", owned by that Telegram user
//     (the owner must have started the bot); prints its t.me/addstickers link
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DIR = fileURLToPath(new URL(".", import.meta.url));
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) throw new Error("Set TELEGRAM_BOT_TOKEN.");

// The order is the order in the pack; the first emoji is the one Telegram suggests it for.
const STICKERS = [
  ["active", ["👋", "🙂"]],
  ["search", ["🔍", "👀"]],
  ["news", ["✨", "🎉"]],
  ["wait", ["🤔", "❓"]],
  ["sleep", ["😴", "💤"]],
  ["off", ["🔌", "📴"]],
];

const file = (name, type) => new Blob([readFileSync(DIR + name)], { type });

async function call(method, form) {
  const url = `https://api.telegram.org/bot${TOKEN}/${method}`;
  const res = await (form ? fetch(url, { method: "POST", body: form }) : fetch(url));
  const body = await res.json();
  if (!body.ok) throw new Error(`${method}: ${body.error_code} ${body.description}`);
  return body.result;
}

const [cmd, owner] = process.argv.slice(2);

if (cmd === "photo") {
  const form = new FormData();
  form.set("photo", JSON.stringify({ type: "animated", animation: "attach://visor", main_frame_timestamp: 0 }));
  form.set("visor", file("quest-visor-photo.mp4", "video/mp4"), "quest-visor-photo.mp4");
  await call("setMyProfilePhoto", form);
  console.log("Profile photo set.");
} else if (cmd === "stickers" && owner) {
  const me = await call("getMe");
  const name = `quest_by_${me.username}`;
  const form = new FormData();
  form.set("user_id", owner);
  form.set("name", name);
  form.set("title", "Quest");
  form.set("stickers", JSON.stringify(STICKERS.map(([s, emoji]) => ({ sticker: `attach://${s}`, format: "video", emoji_list: emoji }))));
  for (const [s] of STICKERS) form.set(s, file(`quest-visor-${s}.webm`, "video/webm"), `quest-visor-${s}.webm`);
  await call("createNewStickerSet", form);
  console.log(`Sticker set created: https://t.me/addstickers/${name}`);
} else {
  console.log("Usage: node publish-telegram.mjs photo | stickers <owner_user_id>");
}
