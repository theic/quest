# The Visor

Quest's mascot: the old Q logo as a small robot, with a screen for a face and an antenna light.
It is drawn from the Q's own outline, traced from the 512 px logo (lime `#C8F60F`, the 13° slant).

- `quest-visor-photo.mp4`: the bot's profile photo. It is the Active loop: 800×800, 6 s, H.264.
  Telegram allows square, at most 10 s, 160 to 1280 px wide, at most 2 MB.
- `quest-visor-<mood>.webm`: the sticker pack `quest_by_messagingquestbot`, one sticker per mood.
  Each is 512 px VP9 with transparency, at most 3 s and under 256 KB. Telegram's limits are in FACTS.md.

  | mood | emoji | when the agent sends it |
  |---|---|---|
  | active | 👋 | first message of their day, a newcomer's quest choice, Chrome connected |
  | search | 🔍 | the reply to a turn that started a search |
  | news | ✨ | find and draft cards, answers to a reply they posted |
  | wait | 🤔 | question cards, a follow-up chase, a message that asks |
  | sleep | 😴 | the evening report |
  | off | 🔌 | Chrome's reconnect link, Chrome disconnected |

  The agent finds each sticker by its first emoji (`MOOD_EMOJI` in
  `apps/agent/src/telegram/telegram-channel.ts`), so keep the emoji when replacing one.
  `conversation/moods.ts` decides when a sticker goes out.

- `publish-telegram.mjs` uploads both with the Bot API. `photo` sets the profile photo, which is one
  photo for everyone. `stickers <owner id>` creates the pack. It reads `TELEGRAM_BOT_TOKEN`. To
  change one sticker in a pack that already exists, use `replaceStickerInSet` rather than running
  `stickers` again.
- The website wears it too: `apps/web/public/quest.svg` (the mark alone on the title screen and above the
  last call, beside the name in the footer and in the phone's chat, with a blink and the antenna light)
  and `favicon.svg` (the mark on the dark tile). They are
  in the site's lime `#CEFF32`. `node render.cjs mark` remakes both; then
  `node scripts/render-share-images.cjs` remakes the link preview (`og.png`) and the PNG and .ico icons from them.
- `render/` remakes the files. The drawing is in `mq.js` and the motion in `base.css` and
  `export.css`. Headless Chrome seeks the paused CSS animations frame by frame, then ffmpeg encodes.
  Stickers get a dark cut-out outline so the lime reads on light chats, and nothing on a sticker
  fades: a faded shape over its outline turns into a grey ghost.
