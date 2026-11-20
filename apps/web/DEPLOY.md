# Publishing the landing

The Vercel project `messaging-quest` belongs to `serhiis-projects-ec767c03`
(`team_2LaFw48cd58uAHlFMUazp6qV`). It also owns `play.messaging.quest` and the old
Next.js app. The newer GitHub-sign-in Vercel account is a different account, and so is the one
the Vercel connector is signed in to: publish with the Vercel CLI, logged in to the owner's
account (`npx.cmd vercel login` on Windows, where PowerShell refuses `npx.ps1`).

The site is static. Prepare a Build Output API artifact containing only its public files and
its routes (`vercel-output.json`):

```sh
node scripts/prepare-web-deploy.mjs
```

Each run creates a fresh artifact in `.artifacts/`, so removed files cannot survive from an
earlier deployment, and links it to the project. Deploy with `--prebuilt --prod --skip-domain`,
then assign **only** `www.messaging.quest` to that deployment:

```sh
vercel deploy --cwd <printed-directory> --prebuilt --prod --skip-domain
vercel alias set <new-deployment-url> www.messaging.quest --scope serhiis-projects-ec767c03
```

Keep `--skip-domain`: a normal production promotion would also move the old app's own address.
`messaging.quest` and `play.messaging.quest` (the old Quest Board, since 2026-10-15) redirect to
`www.messaging.quest` as project domains, so they need nothing here.

The artifact also carries `quest-extension.zip`: the Chrome extension at this commit, packed as a
release (`scripts/pack-extension.mjs`), for the page's "or install it from a zip" and the bot's install
page (the Chrome Web Store listing is the main way in since 2026-10-19). Deploy the landing after the agent the extension needs is on Fly, so the zip and the agent match.

Since the cutover (2026-10-09) nothing is passed to the old app. `/privacy` and `/terms` are the
v2 policies; `/cookies`, `/acceptable-use` and `/refunds` redirect into them; v1's emails'
`/api/broadcast/unsubscribe` links go to the agent (`mq-v2-agent.fly.dev`, which records the
opt-out in `mq.accounts`); every other address that is not a file gets `moved.html` ("Quest lives
in Telegram now") as a 404. `/ingest/*` goes to PostHog's EU Cloud: the page's analytics
(`analytics.js`, on www only) send there through our own domain. `/fonts/*` (the site's own DM Sans and
JetBrains Mono, since 2026-10-22; nothing comes from Google Fonts) is cached for a year, so a changed font
file gets a new name. `apps/web/test/web.test.ts` holds those routes to it.

Before changing the www alias, record its existing deployment URL for rollback. After
publishing, check the landing, `/i18n/locales/uk.json`, `/privacy`, `/terms`, an old address
such as `/login` (404 with the note), an unsubscribe link, `/ingest/static/array.js` (PostHog's
script, 200), `/fonts/dm-sans-latin.woff2` (200, `cache-control` with `immutable`), `/gas-worker.js`
(the weather's flow, 200) and `/video.mp4` (the product video, 200). The previous deployment can be
restored with the same `vercel alias set` command. Never put tokens into source files or
command output.

## Search engines, link previews and AI assistants

`robots.txt` lets every crawler in and names `sitemap.xml`; `llms.txt` is the plain summary AI
assistants read; each page carries its canonical address, Open Graph tags and `og.png`; the landing
also has structured data (JSON-LD). Crawlers do not run the page's scripts, so they read the English
page as served. When a page's text, the Visor or the networks change, update `llms.txt` and the
structured data to match, run `node scripts/render-share-images.cjs` for `og.png` and the icons, and
bump the page's `<lastmod>` in `sitemap.xml`. When `og.png` changes, also raise its `?v=` in the
`og:image` and `twitter:image` tags of all three pages: previews keep a picture by its address, so a
new address is what makes X, Telegram and the rest fetch it again.

After www moves, tell Bing and the other IndexNow engines with `node scripts/indexnow.mjs`. Google
reads the sitemap on its own; Search Console (the `messaging.quest` domain property, verified by its
DNS TXT record) shows coverage and can request a recrawl. Chats and social sites keep their own copy
of a link's preview for days: Telegram's @WebpageBot, Facebook's Sharing Debugger and LinkedIn's Post
Inspector refresh one.
