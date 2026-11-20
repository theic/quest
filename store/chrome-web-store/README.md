# The Chrome Web Store kit

Everything the listing needs, in one folder. `listing.md` holds the copy and every answer on
the dashboard's privacy tab; the images are here. None of it ships in the extension:
`npm run extension:pack` zips only what Chrome runs (scripts/pack-extension.mjs).

| File | Slot | Size |
| --- | --- | --- |
| `icon-128.png` | Store icon | 128 × 128, 96 px of art and 16 px clear around it |
| `screenshot-1-hire.png` | Screenshot 1 | 1280 × 800 |
| `screenshot-2-your-chrome.png` | Screenshot 2 | 1280 × 800 |
| `screenshot-3-connect.png` | Screenshot 3 | 1280 × 800 |
| `screenshot-4-your-call.png` | Screenshot 4 | 1280 × 800 |
| `screenshot-5-nothing-hidden.png` | Screenshot 5 | 1280 × 800 |
| `promo-small-440x280.png` | Small promo tile (required) | 440 × 280 |
| `promo-marquee-1400x560.png` | Marquee promo tile | 1400 × 560 |

## Where the pixels come from

- **The mark** is the Q from `brand/visor/render/mq.js` (`MQ.original()`), drawn as vectors at
  each size. The same render writes the extension's `icons/icon-{16,32,48,128}.png`: the toolbar
  sizes fill their square, the 128 keeps the store's 16 px margin. The promo tiles use the Visor.
- **The popup is real**: `apps/extension/popup.html` drawn by its own code, with a stand-in
  `chrome` API that answers `status` (connected and reading, or waiting for a code).
- **The chat is the landing's demo** (`apps/web/public/index.html`, `.phone`), photographed at
  chapters 3, 5, 6 and 7. It is a sample conversation: Latepay, u/maya_draws and u/samwrites are
  made up, so no real person's post or account is published to the store.
- **The browser window, the Telegram link message and the Connect card** are drawn in
  `scenes.html`, with the bot's and the Connect page's own words.

## Remaking them

```bash
node store/chrome-web-store/render.cjs
```

It needs Google Chrome (Playwright drives it as `channel: "chrome"`) and the network for the
site's fonts. It rewrites every image above and the extension's icons; the pieces it photographs
on the way go to `.artifacts/store-parts`. Change words in `scenes.html`, and the popup's or the
chat's in their own files, then run it again.

## Publishing

1. `npm run check`
2. `npm run extension:pack` → `.artifacts/extension/messaging-quest-<version>.zip`. It refuses
   to write a package that misses a file the manifest, the popup, its stylesheet or a script needs.
3. In the [developer dashboard](https://chrome.google.com/webstore/devconsole): New item, upload
   the zip, then fill in Store listing, Privacy practices, Distribution and Test instructions
   from `listing.md`, attaching the images above.
4. Submit for review. An extension with `debugger` and access to all sites gets the long review.
5. Done 2026-10-19: the listing is
   https://chromewebstore.google.com/detail/messaging-quest/kojgkphccdbkkclgadbdheblpebmiapj. Every
   `a[data-store]` on the landing and the bot's `chrome.html` / `connect.html` point at it, with the zip
   folded under it as the second way in.
6. Later versions: bump `version` in `apps/extension/manifest.json`, pack, upload to the same item.

## Decide before you submit

- **Sending without a tap.** The store's spam policy says an extension may not "send messages on
  behalf of the user without giving the user the ability to confirm the content and intended
  recipients". Today a founder whose brief is settled gets autonomy everywhere (`mq.trust` `*`
  = 3, set in `manager/tools.ts` by `trust.initialize`), including private messages and email.
  The listing says so plainly, and "ask me first" exists, but a reviewer may still read it as
  sending without confirmation, and a rejection or a later takedown hits every installed user at
  once. The safer default for store users: autonomy only after the customer turns it on in the
  chat, and private messages and email always on a tap.
- **The privacy policy.** It covers the extension (section 2), but section 4 still describes
  Featured cards (the ads model the landing dropped), and it has no Chrome Web Store "Limited
  Use" line. Suggested addition to section 2: "The use of information received from the
  Messaging Quest extension adheres to the Chrome Web Store User Data Policy, including the
  Limited Use requirements."
- **The summary.** The manifest's description, "Find the right people with Quest.", is what
  shows under the name in search. A clearer one would say where it works ("Your assistant in
  Telegram finds people and writes to them, from your own Chrome."), but it is translated in
  ten catalogs (`packages/i18n`), so a change goes through them.
