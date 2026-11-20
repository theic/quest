# Facts we paid for

Measured, not assumed. Each has a date; the older ones come from v1 (theic/messaging-quest and
theic/messaging.quest, archived). When one stops being true, fix it here.

- **Interface languages (2026-10-08):** English, Russian, Ukrainian, Brazilian Portuguese,
  Spanish, French, German, Simplified Chinese, Hindi and Arabic share static catalogs in
  `packages/i18n`. The landing/extension read browser preferences; Telegram reads each sender's
  `language_code`. `/language <code>` stores `manual:<code>` in the existing language field,
  and `/language auto` restores detection. Website choices are local and never travel in bot
  links. Browser checks cover all ten landing translations at 320, 390 and 1440 px, all four
  populated Mini App tabs, setup pages and the extension popup. Arabic uses RTL; message/button
  truncation preserves grapheme boundaries. `npm run check`: 389 passed, 19 integration tests
  skipped. `packages/i18n/README.md` documents catalog sync and bot-menu deployment.

## Agents and models

- **Deep Agents (deepagents 1.14.1, 2026-09-25).** `createDeepAgent` always adds the `task`
  tool and a general-purpose subagent, and rejects custom tools named `task`,
  `start_async_task`, `check_async_task`, `update_async_task`, `cancel_async_task` or
  `list_async_tasks`. Its `AsyncSubAgentMiddleware` talks to an Agent Protocol server over
  HTTP and has no way to resume a human's answer, so v2 composes `createAgent` with Deep
  Agents' middleware and runs its own task queue.
- **`modelRetryMiddleware` defaults to `onFailure: "continue"`** (2026-09-25): after its
  retries it ends the run with the error text as the model's reply, so a dead provider looks
  like a finished report. Always pass `onFailure: "error"`.
- **LangGraph interrupts.** `graph.invoke` returns `__interrupt__: [{ id, value }]`. Resume
  with `new Command({ resume: { [id]: value } })`; ids not pending are ignored. `invoke(null)`
  continues a run that stopped partway.
- **A run's graph steps are several per model call** (the model, the tools and each
  middleware hook are nodes). A recursion limit of `budget * 4 + 10` tripped at 90 before a
  20-call budget did (live, 2026-09-26). The harness sets it from the budget, and the
  step-budget middleware is what ends a run.
- **`modelCallLimitMiddleware` with `exitBehavior: "end"`** ends the run with its own error
  text as the last AI message, so a task "succeeds" with "Model call limits exceeded" as its
  report (live, 2026-09-26). Use it only as a backstop, with `"error"`.
- **GLM 5.3, denied tools on its last step, writes its tool calls out as text**
  (`<tool_call>search_posts<arg_key>…`) instead of an answer (live, 2026-09-26, twice in
  two scout runs). The manager then read the search words as results. `finalText` strips that
  markup, and scout reports end with facts from the record.
- **LangGraph checkpoints are heavy for reading agents:** every step stores the state again,
  pages read included. One 30-step scout task: 185 checkpoints, about 5 MB. 11 task threads
  came to 54 MB (the Free plan holds 500 MB). `mq.forget_finished_tasks()` (pg_cron, hourly)
  deletes finished tasks' threads after an hour, and orphans. Postgres keeps the file size and
  reuses the space.
- **The scout ignores a search allowance in its prompt:** told to stop after a dozen searches,
  it searched about forty times, read the right thread, never called `save_find` and ran out of
  steps (live, 2026-09-27). Its tools now keep the allowance (14 searches; after 6 with nothing
  saved every result says stop and save), each page it reads ends with "judge this now", and
  its finish-up note says save first: on the last step its tools are gone.
- **`fakeModel().respondWithTools` echoes its whole input as the reply's text**, so a scripted
  run's messages double every step: by step 8 one reply was 313k characters, and Deep Agents'
  summarization started eating the scripted replies (2026-09-28). Script tool calls as
  `new AIMessage({ content: "", tool_calls: [...] })` for anything longer than a few steps.
- **OpenRouter takes at most three models** in the `models` fallback list; a fourth is
  answered with a 400 (v1, 2026-09-07). It sometimes answers 200 with an error body.
- **Measured model picks (v1, 2026-08-30 / 09-01):** GLM 5.3 reads a site well without a
  frontier bill (scout and manager); DeepSeek V4 Flash is the volume judge (2.0 s, zero
  reasoning tokens); Kimi K3 writes replies that don't read like a template. Free models
  (`:free`) are overloaded often enough to be unusable as a default.
- **MiMo V2.6 Pro replaced GLM 5.3 as the default (2026-09-28).** OpenRouter list prices per
  million tokens: MiMo in $0.435 / out $0.87 / cached $0.004; GLM 5.3 in $1.40 / out $4.40 /
  cached $0.26. Artificial Analysis: Intelligence Index 46 vs 45, but GLM leads on its agentic
  tests (Terminal-Bench 42% vs 35%, AutomationBench 62% vs 59%); running the whole index cost
  $207 vs $2,503. MiMo is slower: 46 vs 92 tokens/s, 3.9 s vs 2.6 s to the first token. Only
  three providers serve it (Xiaomi, DeepInfra, GMICloud), so DeepSeek V4.1 Flash (index 39,
  in $0.035 / out $0.29) and GLM 5.3 are its fallbacks. One tool call through
  `scripts/try-model.ts`: 5.1 s (GLM 2.4 s). A manager heartbeat turn cost $0.009.
  The same scout task in the customer's Chrome (Tally brief): MiMo ran 5 min 11 s, read 15
  pages (all 200), saved 1 strong find with the right author and wrote its report, for $0.019
  including one manager turn. GLM's run of it (6 min 12 s) saved 3 maybes, one of them the
  mis-attributed comment; that day's GLM spend, mostly that run and its manager turns, was $0.16.
- **The standing prompt is cached per provider (2026-10-07, `scripts/try-cache.ts` and raw
  requests).** The manager's system prompt is 30,517 characters, about 6,900 tokens. On MiMo V2.6
  Pro a call that reads it from the cache costs $0.00008 to $0.0001 instead of $0.0030 (in 6,946,
  cached 6,784). OpenRouter lists a cache-read price for all four MiMo providers ($0.0036 to $0.004
  a million tokens, against $0.43 to $0.435 in), and each caches the prompt with no `cache_control`:
  pinned to one provider at a time, Xiaomi, DeepInfra, Novita and GMICloud all hit on every call
  once warm. A provider that has not seen the prompt misses its first call or two: the very first
  run, through the agent's own models, cached 0 of 3; DeepInfra hit on its third. Once warm, three
  calls with one `session_id` through the agent's models all hit, and the same prompt sent with no
  session went to a cold provider and paid in full ($0.0030). A `cache_control` block on the system
  message got no hits in three calls on Novita (whether the block or a cold provider, not
  separated). DeepSeek V4.1 Flash cached 6,912 of 6,971 from its second call; its first, uncached,
  cost $0.0021, which is $0.30 a million tokens on the provider OpenRouter picked: Flash's 30
  providers charge $0.049 to $0.45 a million, so "Flash is cheap" depends on where a call lands. The
  heartbeat's $0.009 (above) matches two uncached calls.
- **The voice, live on MiMo (2026-09-28).** Before the voice rules, dashes were in six of the
  last eight messages Quest sent. After them, "anything worth my time today?" got a specific
  answer with a pick ("The one I'd look at first: a nonprofit helper in r/nocode…") and no
  dash; heartbeats stayed quiet both while messages were unanswered and a minute after a chat.
  Quest speaking first on a heartbeat has only been seen in tests so far.
- **The manager's thread grew without end (2026-09-29).** Two days of one customer's turns had
  put 160 KB of messages in `manager:<id>`, all of it sent again with every turn and every
  hourly heartbeat, and its notes file (`/plan.md`) lived in that thread's state. Turns now
  start fresh from the database (CLAUDE.md, "A manager turn starts fresh").
- **MiMo reasons too long for the manager seat (2026-09-29).** One real manager step (11,400
  tokens in, 22 tools): MiMo by default thought 4,315 tokens and took 125 s; `reasoning.effort:
  "low"` timed out at 180 s; `reasoning.enabled: false` answered in 6.7 to 10.3 s over four runs
  with sensible moves (show the waiting finds, close a failed experiment). DeepSeek V4.1 Flash
  took 2 to 57 s (its own reasoning varied from 478 to 1,686 tokens). Live, before the change,
  manager steps ran past the 60 s stall limit and DeepSeek answered after it (64 to 89 s).
  Teammate steps on MiMo with reasoning took 8 to 38 s.
- **A report turn can end without sending the report (2026-09-30).** On Fly, the 20:00 turn
  (a heartbeat plus the `day_report`) made one model call and no tool calls, then ended: the
  day had two experiments and five finds, and nothing reached the customer. The queue had
  already marked the day reported. So a report turn that told the customer nothing now asks
  for the report as its last message and sends it itself.
- **Unchecked, the manager narrates its work (2026-10-01).** In one morning it started 30 scout
  runs and sent 28 updates of 40 to 90 words (search words, review-site filters, page numbers,
  "Experiment #20", "84 finds still wait on your cards") plus four reconnect links, none
  answered, and spent the Chrome's 400-page day before noon. Two rules drove it: a turn could
  start only two tasks before it had to tell the customer something, and a finished task with
  nothing said triggered a check that asked it to speak. Replayed over three days of real
  messages, the new limits let 9 of 45 unprompted messages through; `voiceNotes` flagged 49 of
  56 messages, every one for a reason the customer named.
- **The spend of a run is measurable** as the difference in `GET /api/v1/key` `usage` before
  and after it, while nothing else uses the key. `/api/v1/activity` (per model) answers 403
  to an ordinary key.

## Database (Supabase)

- **Custom roles work through Supavisor** with the user `role.<project-ref>` on the session
  pooler, port 5432 (2026-09-25). For both projects the pooler host is
  `aws-0-eu-central-1.pooler.supabase.com`; `aws-1-…` answers "tenant/user not found".
- **The session pooler takes 15 clients per project** (Free plan): a sixteenth connection is
  refused with `EMAXCONNSESSION max clients reached in session mode` (dev, 2026-09-29, while
  the agent's pool of 8 and a watcher script's 6 were open). One agent machine fits; a second
  one during a deploy overlap, or scripts beside it, can starve it. Scripts use a pool of 1.
- **The role's password is set as a SCRAM verifier** computed locally
  (`scripts/init-secrets.ts`), so the password never passes through a SQL console or a chat.
- **`PostgresSaver.setup()` needs CREATE on the database** (it runs `CREATE SCHEMA IF NOT
  EXISTS` first), which `mq_app` does not have. Its tables come from
  `supabase/migrations/20260925213000_checkpoint_tables.sql`, mirroring its migrations 0-4.
  After upgrading `@langchain/langgraph-checkpoint-postgres`, compare its `migrations.js`.
- **Free plan: no backups.** `pg_dump` before any destructive change to production.
- pg_cron rejects `"1 minute"` as a schedule (v1, 2026-09-21). Unused in v2 so far.
- **The agent's role cannot alter tables**: `alter table mq.customers` as `mq_app` answers
  "must be owner of table customers" (2026-09-28). Migrations go through the Supabase
  connector's `apply_migration`, which records them in the project's migration history.
- **A migration run in Supabase's SQL editor is not quite one run by `apply_migration`** (dev, 2026-10-27,
  `invites`). The editor turned row level security on for the table it made, and `mq_app` does not bypass RLS
  (`rolbypassrls` false), so with no policy the agent would have read no row of it; nothing else in mq the agent uses
  has RLS. A migration that makes a table says `disable row level security` for it. Nor does the editor record the
  migration in the project's history (`list_migrations`). The connector's `apply_migration` asked for a confirmation
  that never reached the founder, three times, and timed out after 60 s each.

## Telegram

- Selling digital goods or services **inside Telegram must use Stars**; Quest's top-ups stay
  on the website with Stripe (core.telegram.org/bots/payments-stars, 2026-09-25).
- `callback_data` is at most 64 bytes: `q:<uuid>:<n>` fits. Messages are at most 4096
  characters; `format.ts` splits at 4000. "typing…" lasts about 5 s.
- HTML parse mode is the forgiving one; anything Telegram still refuses is sent again as
  plain text.
- **A menu button set in BotFather overrides `setChatMenuButton`**: the API answers ok and
  `getChatMenuButton` still returns the old web app (2026-09-26, @TestPatrikBot's
  "Open here" pointing at a dead dev tunnel). Switch it off in BotFather.
- Telegram Web (web.telegram.org/k) opens a chat directly at `#@<username>`; in a narrow
  pane the chat does not scroll to the newest message by itself. In a wide pane there are two
  message boxes and stale bubbles in the DOM: read `.chat.active .bubble`, focus
  `.chat.active .input-message-input`, then type and press Enter. A scripted `.click()` on
  the send button is ignored, and Enter on "/start" can land in the command menu. Inline
  buttons click reliably by accessibility ref (`find` then `left_click` with `ref`).
- **A deploy leaves a sleeping machine asleep**: the next request starts it cold, so the first
  button tap after a deploy took more than 8 s to answer.
- **Telegram Web keeps a draft in the message box**, and a click on it can put the caret in
  the middle: "/quest" went out as "hey, h/questow's it going?…" (2026-09-28). Clear the box
  (ctrl+a, Delete) and check it is empty before typing.
- **Telegram Web can stop showing a chat's new messages**: after 10:29 nothing newer rendered,
  through a reload, while the bot had sent eight more (2026-09-28). `mq.transcript` is the
  record to read; the browser is only for pressing buttons.
- A document message has no `text`; its words come as `caption`. Bots may download files up
  to 20 MB (`getFile`, then `api.telegram.org/file/bot<token>/<path>`).
- **Pictures (live on the test bot's own chat, 2026-10-05):** `sendPhoto` as a multipart form
  (`photo` as a file, `disable_notification=true`) sends a silent picture. `editMessageMedia`
  with `media={"type":"photo","media":"attach://screen"}` and the file in a field named `screen`
  replaces the picture in place. Sending the same picture again was accepted as done (Telegram's
  ok, or its 400 "message is not modified", which `TelegramChannel.replacePhoto` also counts as
  done), and a message id that does not exist was a 400 that came back as "gone", so a new
  message goes out. The test picture was deleted afterwards with `deleteMessage`.

- **Reactions (Bot API, not yet measured live):** `setMessageReaction` takes `chat_id`,
  `message_id` and a list of `{ type: "emoji", emoji }`; a bot sets one reaction at most on a
  message, from Telegram's fixed list of emoji (no ❤️ with its presentation mark: "❤"), and
  setting a new one replaces its old one. `conversation/reactions.ts` keeps Quest to a curated part
  of that list.
- **The bot's photo and its stickers (live on @messagingquestbot, 2026-10-13):**
  - `setMyProfilePhoto` (Bot API 9.4) took `{"type":"animated","animation":"attach://visor","main_frame_timestamp":0}`
    with an 800×800, 6 s, 199 KB H.264 MP4. Telegram Web then plays it in the bot's profile as an
    800×800 looping video and shows it as the avatar in the chat list and the chat header.
    `getUserProfilePhotos` on the bot returns only stills (160, 320, 640 px). TDLib's limits for an
    animated profile photo: square, at most 10 s, 160 to 1280 px wide, at most 2 MB.
  - `createNewStickerSet` took six video stickers (WEBM VP9 with alpha, 512×512, at most 3 s,
    30 fps, 39 to 215 KB) in one multipart call for owner 264944988 (the founder, who had started
    the bot). Telegram's video sticker limits: one side exactly 512 px, at most 3 s, at most
    30 fps, at most 256 KB, no audio. `getStickerSet` gives each sticker's first emoji as `emoji`,
    and file ids for the bot that asked.
  - `getMe` as a POST with an empty multipart body came back with an empty body, not JSON; a
    plain GET works.

## The cloud browser

- **A Fly Machine can suspend itself** with `POST http://flaps/v1/apps/$FLY_APP_NAME/machines/
  $FLY_MACHINE_ID/suspend` over the unix socket `/.fly/api`, no token. The socket is `root:root
  755`, so a non-root process gets EACCES; the agent's entrypoint gives the `node` group access,
  then drops to `node` with `setpriv` (2026-09-26). Suspend needs ≤ 2 GB and no swap. Fly's proxy
  resumes a suspended machine on the next request, even with `auto_stop_machines = "off"`.
  Measured: the agent slept 12:31:25, the database job woke it 28 s after work fell due
  (pg_cron `'30 seconds'` + pg_net), and a Telegram message to the sleeping agent got its reply
  in about 10 s. The cloud browser, on the proxy's own `"suspend"`, went to sleep within about
  6 min of its last read. A resumed machine's clock lags a few seconds until NTP catches up.
- **Fly's proxy autostop sees only HTTP**: left to itself it suspends a machine mid-task (Fly
  community, "Machines being suspended while doing work"). Hence the agent decides for itself.
- **Fly shared CPUs** get 6.25% of a core per vCPU after a burst balance that starts at 5 s
  (docs.fly.io, 2026-09-25). A machine that just woke would throttle Chromium within one
  page, so the browser runs on `performance-1x`.
- Cloudflare Browser Run (checked 2026-09-25, not used): marks every request as bot traffic;
  free tier 10 browser-minutes a day.
- **Honesty is ours to keep on Fly:** nobody labels the traffic for us. No disguise, no
  stealth, no proxies, no CAPTCHA solving. Sites that refuse the cloud go to the extension.
- **What the cloud browser can reach (live, 2026-09-26, from Fly fra):** Reddit answers 403,
  and so do Redlib front-ends (redlib.perennialte.ch, red.artemislena.eu). DuckDuckGo (html
  and lite) shows a bot check, Mojeek answers 403, and Marginalia shows a bot interstitial. So
  **no search engine works from the cloud**, and the scout needs a search API. Readable:
  WordPress.org support forums, Hacker News (and hn.algolia.com), support.google.com
  community pages. Mastodon/Bluesky search wants a login.
- **Public APIs answer where pages don't (from Fly fra, 2026-09-26, honest `QuestBot` UA, no
  login):** Hacker News (hn.algolia.com), Stack Exchange (300 requests/day per address without a
  key), Bluesky `api.bsky.app/xrpc/app.bsky.feed.searchPosts` (but `public.api.bsky.app` answers
  403, and bsky.app's web search needs a login), Lemmy (lemmy.world), GitHub issue search (10/min
  without a token), Mastodon hashtag timelines (its full-text status search returns nothing
  without a login), DEV, Discourse `search.json`, and WordPress.org's forum search page. These
  are `apps/agent/src/sources/`; `scripts/try-sources.ts` checks them live.
- **Where the scout found real people (tally.so, 2026-09-26):** Mastodon hashtag timelines
  (#typeform, #formbuilder, #forms) and Bluesky search gave real asks for a Typeform or Google
  Forms alternative. The first run's finds were 8-9 months old; after two "too old" skips the
  next run brought posts from 1 and 10 days before.
- **Reddit's official API needs approval** under its Responsible Builder Policy (Nov 2025), and
  commercial use needs Reddit's written approval. Its `.json` answers a cloud address 403 even
  with an honest User-Agent.
- **Reddit blocks cloud IPs** (v1, again 2026-09-26). Reddit reads belong to the extension in the user's own
  Chrome. v1's measured Reddit page shapes are in theic/messaging-quest `skills/reddit/`.
- v1's reader took only the first screen of a feed (~25 posts). A feed loop (scroll, collect by
  post id, wait for growth, stop rules) is planned, not built.

## The extension (apps/extension)

- Chrome takes trusted input only in a drawn (visible) tab; a covered or minimised window
  holds reads (v1, 2026-09-04 / 09-19).
- MV3 service workers allow no top-level `await` and no dynamic `import()` (v1, 2026-09-08).
- Two Chrome profiles running the extension split one account's jobs (v1, 2026-09-07).
- A service worker sleeps after 30 s without an event or extension API call, and a `fetch`
  must answer within 30 s: the long poll waits 20 s, and a 30 s alarm restarts the loop.
- Content-script match patterns without a port match any port: `http://localhost/connect*`
  runs on `http://localhost:8790/connect` (Chrome for Testing 152, 2026-09-27).
- **What a customer's Chrome reaches (Chrome for Testing 152, home connection, 2026-09-27):**
  a page in 3 s; a four-page site read (tally.so) in 20 s; DuckDuckGo's HTML page with 10
  results in 2 s, no check (it refuses the cloud).
- **Reddit, logged out (2026-09-27):** old.reddit.com sends a logged-out visitor to a login
  page ("accounts are required to access old Reddit"). www.reddit.com search pages give 7
  `[data-testid=search-post-unit]` results (link, `post-title-text`, `<time datetime>`,
  `search-counter-row` "20 votes·44 comments"; no author, no body) and render in a
  minimised window. Threads are `<shreddit-post>` (author, `created-timestamp` like
  `2026-09-24T15:11:07.735000+0000`, post-title, body in `[slot=text-body]`) and
  `<shreddit-comment>`s. A new visitor's first page reloads through a JavaScript check
  (`js_challenge=1`) that the browser passes by itself. A tab that sends no cookies is a new
  visitor on every page, and after five or six pages in a few minutes Reddit showed
  "Prove your humanity", a CAPTCHA. So the extension reads in an Incognito window (its own
  cookie jar) when the customer allows it there, and Reddit pages are read 8-15 s apart.
- With "Allow in Incognito" on, `chrome.windows.create({ incognito: true })` opens Quest's
  window in the off-the-record profile, and `webRequest` and `scripting` work in it.
- **Since 0.3.0 (2026-10-02) Quest reads in the customer's own profile, logged in**, by their
  decision: no Incognito, no cookie stripping. Measured 2026-10-03 in their Chrome
  (u/redditor_a): logged-in Reddit search and thread pages carry the same markup (a
  scout run read r/expats, r/Thailand and others for four minutes, no bot check, and saved two
  finds with quotes); `/api/submit` through the modhash form posted a text post
  (r/test/comments/1wwl8m5), answering `json.data.url` on old.reddit.com.
- **Logged in, Reddit shows the author their own removed comment as if it were up (2026-10-03).**
  The comment AutoModerator removed in r/test on 2026-09-28 (pcnev83), which a visitor sees as
  `[deleted]`, read logged in as "up and intact", words and author in place, no marker. So
  whatever checks whether the customer's own post or comment shows to others reads it as a
  visitor: the job's `asVisitor`, a second tab in Quest's window whose session rule sends no
  cookies and keeps none (0.5.0). Read that way the same day, the comment's own address showed
  the thread with zero comments: no `[deleted]` placeholder any more, the comment simply absent. So
  the watch takes a reply as down when it is shown as deleted, or when its own address shows the
  post without it (a comment address waits for `shreddit-comment` first). Unmeasured: how a removed post (not a comment) shows to a
  visitor, and what `/api/compose` answers.
- **The first live run in a customer's own Chrome (2026-09-27, tally.so, Telegram):** paired
  from the connect page by itself; the researcher read the site in 1 min 41 s; two scout
  passes read about 70 Reddit pages in the Incognito window with no bot check (its cookie jar
  lasts the session). Reddit's search **sorted by `new` matches any one word**: "Typeform too
  expensive alternative" gave r/Mechwarrior5 and spam, and the first pass saved nothing.
  **Sorted by `relevance`** inside the time window, the second pass read real asks and saved
  two. Chrome reports its brands as "Chromium" and "Google Chrome" in no fixed order.
- **Reddit's ids on the page (logged out, 2026-09-28, r/test):** `<shreddit-post id="t3_…">`;
  `<shreddit-comment thingid="t1_…" parentid="t1_…" depth="1" permalink="/r/x/comments/<post>/comment/<id>/">`,
  with no `parentid` on a comment that answers the post. A comment's own address shows the
  whole thread to a visitor, not only that comment's replies. So a reply can go under the
  exact comment a find quotes, and answers to a posted reply are the comments whose
  `parentid` is its id.
- **Posting works (extension 0.2.0, live 2026-09-28, r/test).** Reddit's long-standing comment
  form (`GET /api/me.json` for the account's `modhash`, then `POST /api/comment` with
  `thing_id`, `text`, `uh`, `api_type=json`) from a background tab on old.reddit.com, in the
  customer's own signed-in Chrome, posted the card's reply as their account; the answer carried
  the new comment's id (the card linked `/r/test/comments/1wsot2s/comment/pcnev83/`).
- **Accepted is not visible.** r/test's AutoModerator removed that comment as it went up (a
  new, low-karma account; its other replies there say "Contributor Quality Score is low"). The
  API answered as for any comment. A visitor sees the comment in place as author `[deleted]`,
  no `[slot=comment]`, and the words "Comment removed by moderator". So the reply watch looks
  15 minutes after a post, and a reply the page shows as gone is told to the customer.
- **The first explorer run (Tally, live 2026-09-28)** filed 20 places in 16 minutes, all in the
  customer's Chrome: 9 to search and 11 to avoid, each with the place's own rule quoted (r/SaaS
  "No Vendor Spam", r/marketing "Self-Promotion ... (Permanent Ban)", r/smallbusiness "No links,
  product recommendations"), and a competitor's community (r/formsapp) kept out. An agent
  restart mid-run lost nothing: the task was picked up again as recovered. One waiting find
  was from a place it then filed as avoid, so filing an avoid now drops those finds.
- **After the agent starts, a connected Chrome takes up to 30 s to ask for work again**, and
  the broker only knows a Chrome that asked: a heartbeat turn 0.4 s after a restart told the
  customer their Chrome was closed (2026-09-28). The first heartbeat now waits 45 s.
- **A model call can stall a task for six minutes:** the client waits 120 s and retries twice,
  so one stuck OpenRouter request held the scout from 17:07 to 17:13 before the task retried
  (2026-09-27). The Chrome reads around it took seconds.
- **Keeping the computer awake (extension 0.3.0, Chrome for Testing 152, Windows 11, 2026-10-01).**
  The `power` permission shows no warning (the details page lists only "Read your browsing
  history" and "View and manage your tab groups"), so adding it asks nothing of people who
  already have the extension. Chromium's Windows code maps `requestKeepAwake("display")` to
  `PowerRequestDisplayRequired` and `"system"` to `PowerRequestExecutionRequired`, not
  `SystemRequired` (`power_save_blocker_win.cc`). Microsoft documents that ExecutionRequired
  implies SystemRequired only on S3 PCs. On Modern Standby (S0) laptops, the usual kind and the
  one this was measured on, it keeps the process from being suspended, and it ends 5 minutes
  after the sleep timeout on battery. Every request ends when the lid closes, at the power
  button, or at Start → Sleep. Measured without admin rights (`CallNtPowerInformation`,
  SystemExecutionState): "display" shows as `0x2`; "system" shows nothing. So whether Quest's
  polling survives a Modern Standby laptop's screen-off on "system" is **not measured yet**: it
  needs the laptop left to sleep with the extension connected. macOS maps "system" to a
  no-idle-sleep assertion.
- **The Chrome for Testing rig (2026-10-01).** `--load-extension` is ignored in 152; load
  over DevTools instead with `Extensions.loadUnpacked` (start Chrome with
  `--enable-unsafe-extension-debugging --remote-debugging-port=…`), turn developer mode on
  (`chrome.developerPrivate.updateProfileConfiguration` from chrome://extensions), then reload
  the extension. Extension service workers are not listed as DevTools targets, so drive the
  worker through `chrome.runtime.sendMessage` from the extension's own popup.html opened as a
  tab. A profile under a long path (the session scratchpad) breaks the extension's storage
  ("Failed to access storage", the worker never answers): keep `--user-data-dir` short.
  (2026-10-05, same Chrome for Testing 152, a short profile path: `--load-extension` did load the
  extension, disabled until `developerPrivate.updateProfileConfiguration({ inDeveloperMode: true })`
  and `management.setEnabled` from a chrome://extensions tab; and the extension's service worker
  was listed as a DevTools target, so `Runtime.evaluate` could drive it directly.)
- **`chrome.tabs.captureVisibleTab` on Quest's window (Chrome for Testing 152, Windows 11,
  2026-10-05, occlusion detection left on):** while Chrome draws the window, focused or not, it
  returns the page's viewport only (no tab strip, no other window): 24-44 KB at JPEG quality 50 for
  a 640x480 window. While other windows cover it, `document.visibilityState` is `hidden` and the
  capture fails with "Failed to capture tab: image readback failed". So there are no pictures
  while the customer's windows are on top of Quest's; the extension skips them without raising the
  window (`capture.js`), and a read that needs drawing (Reddit) brings it up, which gives one.

## Voice messages (OpenRouter speech to text, 2026-10-13)

- A Telegram voice message is `message.voice` (`file_id`, `duration`, `mime_type` "audio/ogg",
  `file_size`): OGG with Opus inside. An .mp3 or .m4a sent as music is `message.audio` (with
  `file_name`); sent as a file it is a `document` with an `audio/*` mime type. All three are `voice`.
- OpenRouter has its own speech-to-text endpoint: `POST /api/v1/audio/transcriptions`, JSON
  `{ model, input_audio: { data: <base64, no data: prefix>, format } }`, answered with `{ text,
  usage: { seconds, cost } }` (per-second models) or `usage` in tokens (GPT-4o transcribe). Errors are
  `{ error: { message, code } }`: random bytes as "ogg" were a 400 "Provider returned 400", an unknown
  model a 400 that names it. Its guide: providers stop at 60 s of work; base64 past 25 MB is refused
  by most providers. Models: `/api/v1/models?output_modalities=transcription` (25 listed).
- **Measured with the dev key, a 13 s English and a 14 s Russian clip (Windows TTS), as WAV and as
  OGG/Opus 32 kbps 48 kHz mono like Telegram's:** OGG/Opus is accepted as format "ogg" (and "opus").
  | model | price | 13 s clip | heard |
  |---|---|---|---|
  | openai/whisper-large-v3-turbo | $0.0002/min (DeepInfra; Groq $0.00067) | 1.2–2.1 s, $0.000044 | both right; "на Reddit" |
  | qwen/qwen3-asr-0.6b | $0.0002/min | 1.2–1.5 s | English best; Russian with no punctuation |
  | nvidia/nemotron-3.5-asr-…-0.6b | $0.0002/min | 1.5–2.1 s | Russian "на Реддите" heard as "народите" |
  | openai/whisper-large-v3 | $0.00045/min | 6–8 s | both right |
  | openai/gpt-4o-mini-transcribe | ~$0.0017/min (tokens) | 0.9–1.0 s, $0.00038 | both right, best punctuation |
  So Whisper Large v3 Turbo is the default and GPT-4o Mini Transcribe (OpenAI's own servers, another
  provider) the fallback. Whisper's text starts with a space and puts two between sentences.
- **Live on @TestPatrikBot (2026-10-13, local agent polling the dev database):** a voice message
  recorded in Telegram Web (5.9 s) was heard in 1.0 s for $0.0000195, kept in `mq.transcript` as
  "Hey Quest Did anyone reply to my posts this week?", queued as a plain `user_message`, and
  answered by the manager in its next turn ("Nobody's answered the posts…"). The dev founder
  customer (83c73c8a) sits in the `test` lane, so an agent on the `live` lane leaves its messages
  pending; flipping the lane for a test also wakes its heartbeat and any stale report, so put it
  back as soon as the reply is in.

## Reading through Tavily (apps/agent/src/web)

- From its documentation (2026-10-05). `POST /extract` takes 1 to 20 URLs and answers markdown
  or text per page, `failed_results` with an error string per address, and costs 1 credit per 5
  basic extractions (2 advanced). `POST /search` takes `time_range`, `include_domains`,
  `include_published_date`; basic is 1 credit a call. Errors: 401 key, 429 rate limit, 432 plan
  limit, 433 pay-as-you-go limit. Bearer key in `Authorization`.
- **Measured with a real key (`scripts/try-tavily.ts`, 2026-10-06):** the client's requests were all
  accepted (search with `time_range`, `include_domains`, `include_published_date`; extract as
  markdown). Of 7 pages, 4 were read in 0.2-1.2 s (a Hacker News thread with its comments, 79,000
  characters; indiehackers.com; tally.so/pricing; a Trustpilot review page) and 3 failed with
  "Failed to fetch url" (reddit.com, g2.com, alternativeto.net: sites that watch for bots). All 5
  searches returned 7-10 results in 1.3-3.4 s. Of the 20 results that carried a date, 15 were under
  14 days old; Reddit's results carry none, and a Hacker News search was the freshest (9 of 10).
  Credits by the price list: about 6.4 for the run.
- **Reddit through Tavily (2026-10-06): search lists Reddit posts (title and a snippet, no date),
  but extracting a Reddit page failed every time: the subreddit page and 3 of 3 real threads.** So
  Tavily cannot read a Reddit thread or its comments. Reddit stays in the customer's Chrome
  (`web/routed-reach.ts`), its search results from Tavily are previews to be read there, and nothing
  promises Reddit reading with Chrome closed.

## Production's database since 2026-11-09: lylzleitvyfavudwlqyu

- On 2026-11-09 the old project, buofxdsuxnklkdbzjlyj ("messaging quest" in Supabase, v1's, which production had used
  since the cutover), was deleted by mistake as v1's leftover, and the agent stopped at start on the pooler's "tenant/user
  ... not found". Nothing from it was kept (the founder: "We don't need the data"); the 2026-10-09 dumps below are all
  that is left of it.
- Rebuilt the same day as `messaging-quest-v2-production` (Free, eu-central-1, in the Messaging Quest org beside dev):
  every migration through the connector's `apply_migration` (v1's backfills had nothing to do), `mq_app` given
  production's existing `MQ_DB_PASSWORD` as a SCRAM verifier, and `scripts/db-probe.ts` with `MQ_ENV_FILE` on
  `.env.production.local` found the pooler (`aws-1-eu-central-1`) and wrote `DATABASE_URL`.
- Supabase refuses `grant postgres to <role>` from the connector ("Only roles with the ADMIN option on role postgres"),
  so migrations cannot run through a short-lived login of our own: the connector is the way.

## Production data (buofxdsuxnklkdbzjlyj, 2026-09-24/25, rechecked 2026-10-09)

- 372 accounts (366 email, 8 Google identities); 68 confirmed their email; the newest from
  2026-09-07, the last sign-in 2026-09-06. 11 of them ever gave a site address.
- One had opted out of product news (`broadcast_opt_out`); carried into
  `mq.accounts.news_opt_out` with all 372 unsubscribe tokens.
- The 4 active `founder` subscriptions were complimentary (`comp_…` ids, no Stripe behind them),
  on the founder's own accounts: nothing to cancel.

## The cutover (2026-10-09)

- **Backup without the postgres password:** a temporary role made with a SCRAM verifier computed
  locally (`login bypassrls valid until` six hours, `grant pg_read_all_data`), dumped through the
  session pooler (`user=mq_backup.<ref>`, port 5432) by `pg_dump` 17 from the `postgres:17-alpine`
  image, then dropped. Production was 8.9 MB custom format. Restored into a plain Postgres 17 it
  gave back 372 users, 374 identities, 372 profiles and 15,241 candidates; its 15 errors were all
  Supabase's own extensions and roles (pg_cron, pg_net, vault, `authenticated`). The dumps are in
  `Projects/mq-backups/` on the founder's laptop, outside every repository.
- **Fly's proxy starts a stopped, cordoned machine** on the next request (the extension polls all
  the time): `machine cordon` + `machine stop` held it for 23 s. To freeze a customer during a
  move, put them in the `test` lane: no agent claims their work.
- **A 401 from `/chrome/next` makes the extension forget its pairing**, so an agent on a database
  without the customer's `chrome_links` row would disconnect their Chrome. Copy first, deploy after.
- `scripts/copy-customer.ts` moved the founder's Quest (162 tasks, 584 events, 4,487 journal lines,
  the Chrome pairing) dev → production in about 2.5 minutes; the identity sequences were moved past
  the copied ids as the owner afterwards (`mq_app` may not `setval`). Their Chrome was polling
  production 15 s after the deploy, still paired.
- **OpenRouter's 402** "would exceed your available credits given your current in-flight requests"
  means the balance is gone (2026-10-09: $70.17 used of $70); every manager turn fails until it is
  topped up. `GET https://openrouter.ai/api/v1/credits` with the key shows it.
- The Vercel project behind messaging.quest is in team `serhiis-projects-ec767c03`, reached by the
  Vercel user **`theic`**. The Vercel connector here, and the founder's GitHub sign-in, are user
  `serhiilahutin-8958`, which gets 403 there ("scope does not exist" in the CLI). Publishing uses
  the Vercel CLI (`npx.cmd vercel`: PowerShell refuses `npx.ps1` on this laptop) after a device
  login approved in a browser signed in as `theic`. The landing went live on www 2026-10-09 as
  `messaging-quest-c215s0k43…`; the one before it was `messaging-quest-axhxqk93d…`.

## Platform-independent posting (2026-10-06)

- With this PR's local worker temporarily polling TestPatrikBot, a supervised bridge drove its actual broker jobs in the Codex internal browser. The manager produced a web.telegram.org draft; the generic posting executor selected the composer and Send control. The first test message went to the account's own Saved Messages on a card tap. A second distinct message was published without a tap, and its Postgres record was `posted`, `alone = true`. Both appeared as actual Telegram message bubbles with delivery checks.
- A Telegram sidebar can show the exact outgoing body as **Draft** before it is sent. That preview is not a receipt. Verification excludes editor text, refuses confirmation while the body is retained in an editor, and refuses manager verification while the posting executor is still active. The test bridge was corrected to read actual message bubbles.
- The live test also caught a draft addressed to the workspace host rather than the recipient. The executor refused to send because that target was not visible in the composer. Generic private drafts now reject a host as the recipient and ask for the person's/chat's exact name or email address.
- The current dev webhook, database wake URL and Fly machine were restored after testing. Other accounts/platforms were not contacted in this live test. The Chrome extension's DOM executor and forum/messenger fixtures are tested locally; this live test used the supervised internal-browser transport, not an installed extension in that browser.

## Visual platform execution (2026-10-07)

- `scripts/try-visual.ts` ran the actual generic publisher and configured `xiaomi/mimo-v2.6-pro` against a local canvas workspace. Its recipient, body, Send control and delivery receipt exist only as pixels; the DOM/accessibility view exposes the heading and a canvas. A supervised internal-browser bridge executed the broker jobs. The model located the composer, filled the exact draft, passed the separate pictured-recipient/body/Send preflight, published once and passed the separate before/after receipt check. The result was `verified` at `/opaque#sent`, with the complete body, Delivered checks and an empty composer visible.
- MiMo encoded some coordinates as decimal strings. Tool schemas now accept only bounded decimal pixel literals, normalize them to numbers and reject expressions, nulls and out-of-range values. Image dimensions must come from the actual image: the supervised bridge initially misread JPEG bytes as a PNG header. Production capture uses `createImageBitmap` dimensions, and HTTP validation bounds them.
- A canvas editor can require character keyboard events rather than text insertion. The visual executor supports both; its key mode refuses control characters so a draft body cannot type Enter to send. The internal browser could click the pictured canvas and supply native keys, but refused clicks inside the earlier closed-shadow fixture. No live claim is made for an installed extension or a closed-shadow workspace; trusted extension input mapping and cleanup are tested locally.
- Pictures are passed only in model requests. Automated tests verify that they are absent from graph output/checkpoints and tool JSON. OCR text is explicitly marked and cannot by itself mark a held draft/find as sent. An uncertain posting tab stays available for inspection while its cached picture is released.
- On 2026-10-07, the restored dev bot had its original Fly webhook (zero pending updates, no webhook error), original database wake URL with a one-hour heartbeat, and a healthy Fly worker. Four new migrations are applied to dev, and all 15 opt-in database integration tests pass.
- Chrome refuses `debugger` as an optional permission (developer.chrome.com, chrome.permissions: debugger, declarativeNetRequest, devtools, geolocation, mdns, proxy, tts, ttsEngine and wallpaper can't be optional). Extension 0.8.0 listed it under `optional_permissions` and asked for it from the popup's switch, so the switch looked on until the popup closed and no visual job ever ran (2026-10-13, the founder's Chrome 154). 0.8.1 requires it and keeps the switch as a setting.

## Screenshots in the chat, Habr's frames, their own names (2026-10-13, the founder's first install)

- Asked to show a screenshot, the manager answered "Here's the Google shot" and nothing arrived: a screenshot reached only the model, and the manager had no way to send it. `show_screenshot` now sends it, and the prompt forbids saying a picture was shown otherwise.
- Every Habr article page has four `about:blank` frames beside the page (Chrome for Testing 152, `Page.getFrameTree`). The extension counted any frame that wasn't http(s) as private, so it refused to picture any Habr page ("This page includes a private frame"), and the manager explained it as a browser privacy rule. Only http(s) frames at local or private addresses count now.
- Asked "Do you see the comment now?", the manager said no and called **theic**, the founder's own Habr account, someone else's. Quest knows no one's handles until they say; the prompt now has it ask ("is theic you?") and keep the answer as a fact.
- A non-Reddit draft whose target is the page address showed the address in the card's first line and again as its link, and labels read "your reply to https://… on habr.com". The target is left out when it is only an address.
- Superseded the same day (next section): Quest now reads their name from the site before it asks which one is theirs.

## The founder's second first run (2026-10-13, production, from its records)

- They wrote "I want to answer comments on my instagram." instead of tapping one of the three quests: the manager went on with no quest set (`quest` null), since none fit. A fourth button, Custom Quest, now takes anything else, and free text like that sets it.
- After "✅ Chrome connected" (14:24:31 UTC) they heard nothing until they wrote "So?" at 14:29. The manager's line about what it was starting (14:25:11) was held by `message_user`: the setup message, its reply and the connected notice made three unanswered messages, past `UNANSWERED_NUDGES` (2). The notice is now their move (`DONE_MARK`), and the count starts again from it.
- Told to find their Instagram by "searching the web for" the founder's name, the researcher made 23 web searches, 5 page reads and 6 browser opens from 14:25 to 14:38.
  - That is where "Voca Vela" came from. Its first search for it (14:29) followed reads of the founder's own site and GitHub, which the name search had turned up. `mq.memories` had 0 rows after the reset, so nothing was remembered from before.
  - It guessed four instagram.com profile addresses and opened the home page (14:29 to 14:33), and Instagram wanted a sign-in each time. It kept searching anyway.
  - The manager saw the wall with one snapshot at 14:39.
- Asked to post on X, the manager asked for their @handle twice before opening x.com (14:49, 14:50). Once it opened x.com (14:51) it read @theIcreator from the page.
- The post on X: four `prepare` steps, then `CustomerBrowser.act` threw "That picture is stale" (a picture id from before the page changed). The exception ended the poster's run ("Could not prepare this draft"), and the customer read it as "x.com didn't take your post: … That picture is stale". They typed "Try again." `send_draft` refused (ask first on x.com), so the turn could only point them back to the card.
- Signed-out pages in Chrome for Testing 152 (fresh profile), read with the extension's own `browserPage` snapshot:
  - Instagram's home and `/accounts/login/` keep their "Log in" button disabled until something is typed, so it is not in the snapshot. What is left is the password field ("Protected sign-in/payment control") and "Log in with Facebook".
  - These show a sign-in control: an Instagram profile ("Log In" link), Habr ("Войти"), GitHub ("Sign in") and HN ("login").
  - LinkedIn's `/feed/` redirects to `/login/`.
  - x.com did not load in headless Chrome for Testing (chrome-error), and Reddit served a JS challenge.
  - `pageLogin` catches every signed-out page that loaded. The signed-in "Profile" links of X and Instagram come from their markup, not from a measurement here.
- `scripts/try-first-run.ts`, with the real manager model (MiMo) in memory:
  - **Their words, then Chrome connecting.**
    - Their first message set the custom quest and sent the Chrome setup.
    - When Chrome connected, the line about what Quest was starting went out.
    - The researcher was told to open instagram.com in their Chrome and check sign-in, not to search the web.
    - Cost: 5 calls, $0.017.
  - **A tap on Custom Quest, with nothing said yet.**
    - Quest asked "What should I take off your plate first?" with four answers to tap.
    - Its next question (which comments to handle) came with answers to tap too.
    - Cost: 4 calls, $0.019.
- Later the same run (15:31 to 15:52 UTC, before the fixes were deployed), Quest tried to post on X itself. It clicked one spot in the composer four times, and its reply came in Portuguese, to a customer whose language is `en`, quoting X's Ukrainian button ("Опублікувати пост"). An earlier reply already had "para" and "em" in its English. Nothing checked a reply's language. `otherLanguage` in `lib/voice.ts` now does, so the reply is asked for again in their language.
  - Run over every message Quest has sent (217 on dev, 17 on production, all to English speakers), it flagged only the Portuguese one.

## The progress board on Telegram (2026-10-13/14, @TestPatrikBot, Telegram Web A)

- A bot can pin in a private chat, and `disable_notification` keeps both the message and the pin silent. Telegram still posts "Patrik pinned "…"" in the chat, counted as unread. The bot gets that note as a `message` update (`from.is_bot`, `pinned_message`), so it can delete it by its own id. Guessing the id as the board's + 1 would delete the person's message if they wrote in between.
- An edit of the pinned message shows in the bar at the top at once. On a 375 px phone the bar shows about 35 characters of the first line: the emoji, the ten segments, the percent and the start of the title.
- ▰▱ draw as filled and empty squares in Web A's font. █░ looked heavy. 🟩⬜ took the whole line. ━─ was too thin to read.
- Telegram Web A replaces the message box with START when the chat's last message is deleted (the pin note right after the board, or the board when nothing followed it). It came back after the next message or a reload. A tap sends /start, which an existing customer's Quest reads as "(opened the chat with /start)". The native apps were not checked.
- Two live runs on the dev bot. The researcher read through Tavily, since Chrome was offline.
  - "Competitor sites for messaging.quest": 0% at the start ("about 7 min left", from the researchers' p80 of 370 s on dev), then 16% "Searching Hacker News for …", 22% "Reading tryrunlo.com", 66%. It finished in 260 s, and the board came down 16 s later.
  - "Okara and Runlo pricing" (after the finished state was added): 7% "Searching the web for “Runlo SaaS pricing”", then ✅ 100% for the grace, then gone. It took 116 s.

## The founder's X ask, and what the morning cost (2026-10-14, production, from its records)

- The ask, 07:53 UTC: "Find someone looking to get customers on X and comment about messaging quest, without adding a link, just the name". MiMo (reasoning off) started two tasks at once: a scout told "Reddit, X, Indie Hackers, Hacker News, Bluesky, or forums", and an outreach run on X. The scout's search has no X, and its prompt starts it on Reddit: it read r/Twitter, r/ArtRanting and r/SocialMediaManagers, and the progress board said so. The outreach run searched x.com/search about 25 times in 24 minutes and drafted three replies; its last step planned another search, and that plan was its whole report.
- The manager called `best_people` with the same 10 twenty times (08:07 to 08:15), then wrote the same plan eighteen times (08:28 to 08:30). It browsed X itself for eight minutes to make a card three times shorter. Its drafts to Reddit threads it had not read (`/comments/PLACEHOLDER`, invented ids) were refused by `threadRead`, as built.
- What 75 minutes cost: $1.32. Outreach $0.46 (37 calls, 2.57 M input tokens), manager $0.37 (109 calls), browser-poster $0.23 (22 calls for the X posts), five scout runs $0.04 to $0.06 each. About $0.75 of it was calls whose prompt was not in the provider's cache: after MiMo stalled and a step went to DeepSeek, the next steps went back to MiMo on providers that had not seen the run, at 110,000 to 134,000 tokens: $0.04 to $0.057 a step, 35 to 85 s each.

## Choosing the decision model (2026-10-14, `scripts/try-decision.ts`)

- One manager turn on the X ask, in the in-memory world with the real prompt and tools. Before the fix, every model gave it to the scout (whose search does not reach X); MiMo started a scout task and a scout experiment. With `site`, the team's descriptions and the one-ask rule, all five started one outreach task on x.com: MiMo V2.6 Pro (5 tool calls, $0.010, 24 s), Claude Haiku 5.5 (1 call, $0.0045, 6 s), DeepSeek V4.1 Flash ($0.0008, 7 s), GPT-5.6 Luna ($0.006, 14 s), DeepSeek V4 Pro ($0.011, 12 s). Gemini 3.8 Flash made no call.
- On "Find me more people who could use Messaging Quest", MiMo still started a task and an experiment, in one step: both calls passed the one-ask check before either was recorded. The check now takes its place before anything is awaited.
- On the dev copy of the founder (18 memories, 6 routes), `try-conversation.ts` with Haiku as manager: one outreach task on x.com, 6 s, $0.0048.

## OpenRouter prices, discounts and caches (2026-10-14)

- `/api/v1/models/<id>/endpoints` gives each provider's price, its `discount` (the listed price already has it) and time-of-day `overrides`. DeepSeek V4.1 Flash: 32 providers, from $0.021 (OpenInference, fp4) and $0.023 (Relace) a million input tokens; StreamLake 51% off, Baidu 43%, GMICloud 40%, Novita 35%, DeepInfra and Phala 30%; DeepSeek's own is half price off-peak. MiMo V2.6 Pro: four providers at $0.43 to $0.435, none discounted. Gemini 3.8 Flash: 50% off ($0.375). Claude Haiku 5.5: $0.10 in, $0.01 cached, $0.125 cache write, $0.50 out, five times that past 100,000 prompt tokens.
- Claude Haiku 5.5 through OpenRouter caches nothing by itself (12,400 tokens, four calls, $0.00124 each). With `cache_control: {type: "ephemeral"}` on the system block, or at the top of the request (OpenRouter keeps that mark at the end of the prompt): 19,500 tokens written for $0.0024, then read for $0.0002.
- `provider: {sort: "price", quantizations: [fp8, fp16, bf16, fp32, unknown]}`: DeepSeek V4.1 Flash went to Relace, and its second call read 9,472 of 9,921 tokens from the cache ($0.00023, then $0.00009), with no `session_id` needed. MiMo went to DeepInfra and did not cache on the second call ($0.0043 both). A top-level `cache_control` is accepted by both.

## Recipient check without a picture, and long links (2026-10-07)

- The first generic publisher accepted a recipient that appeared anywhere in the page's text. With a scripted model and a messenger-like page (chat list: Alex Chen, Bob Li, Carla Ruiz; Bob's chat open), a draft for Alex Chen was submitted in Bob's chat. Now the recipient has to be in the page title, its address, or an editable field's label or value (a To box, a composer labelled "Message Alex Chen"); the chat list, links, search boxes and the draft's own words never count. Otherwise `publish` refuses and the picture route checks the recipient visually.
- Not measured: which web messengers (Telegram Web, WhatsApp Web, Slack) show the open conversation in the title, address or composer label. Those that show it only in a header now need the picture route (visual browser controls, on by default since 0.8.1).
- A control link longer than 4000 characters used to fail the whole `POST /chrome/jobs/:id` result (400 `unreadable result`), so one long tracking link in a mail workspace made the page unreadable. The route now cuts the link to 4000 characters.
- Telegram delivery of the refusal and the sent card ran through the real Messenger and Telegram channel (in-memory stores, scripted model, no workspace contacted): the wrong-chat draft stayed open with 0 messages submitted, the right-chat draft went to `posted` with 1, and three messages reached the dev chat.

## Landing liquid, PR 16 on latest main (2026-10-07)

- Visual experiments: the original high-frequency contour marbling competed with the Telegram demo. Lighting those same contours as a glossy surface made them look crumpled. The selected material uses three broad, seamless folds, dark olive depth and long lime/silver reflections. Its scale is fixed in CSS pixels across desktop and tall mobile layouts; the liquid clears the header and follows the page's river into the final pool.
- Physics corrections: a shared donor-outflow budget prevents dry-cell clamping from creating water; the speed cap is applied after pointer/press forces. Substeps include both axes and a fourfold depth margin, without the old ten-step ceiling. Full float targets are preferred, with half floats and a still material as fallbacks. Scroll acceleration acts opposite the page's screen acceleration; a stationary pointer does not paint a false stroke when the page moves under it. Pause freezes the current surface and resets input clocks on resume.
- `scripts/try-landing.cjs` exercises the actual WebGL programs in Chrome, reading GPU depths through a byte-packed probe that is injected only into the test response. At simulated 30/60/120 fps, a single tap had matching measured wave energy; after five more seconds it fell from 1.20463 to 0.000226 (over 99.98% dissipated). At rest, the surface stayed unchanged.
- An intentionally extreme 4.5-second test (50 ms frames, alternating acceleration, a very fast brush and repeated taps) stayed finite, below four times rest depth and within 32 cells/second. Measured volume drift was 0.0028% on full floats. The earlier half-float experiment measured 0.35%; these figures include readback quantization and are machine-specific, not an exact conservation claim.
- Actual mouse presses, mouse movement, wheel scrolling and native mobile touch events all produced nonzero wave energy. Pause held both wave energy and material time unchanged. Reduced motion stopped autoplay and the liquid, and a missing WebGL context kept the page and its CSS fallback usable. Seven widths (1920, 1440, 1280, 1024, 768, 390, 360) had no horizontal overflow and their chapters fitted inside the hero. During sustained movement, measured frame intervals were 16.7 ms median / 16.8 ms p95 on this machine. No page or GL errors were observed.
- This is a damped shallow-water surface in a designed basin, plus a decorative flow/relief field. It does not simulate volumetric splashes, droplets, free-falling water or full 3D Navier-Stokes. Background flow speed and studio lighting are art direction. The relevant physical quantities checked here are rest, force response, shared flux, bounded speeds and decay. For the shallow-water model's scope and stability background, see [Layton and van de Panne](https://www.cs.ubc.ca/~van/papers/2002-visualcomp-water.pdf) and [Bridson's shallow-water notes](https://www.cs.ubc.ca/~rbridson/courses/533d-fall-2005/nov17-cs533d-slides.pdf).

## Three atmosphere directions (2026-10-07)

- The liquid's changing view and weak scroll response did not make the product's concept clearer. Three background experiments were compared at `/experiments.html`, with the same working landing/demo at `/?experiment=weather`, `/?experiment=whispers`, and `/?experiment=pollen`. The user selected Signal weather (#1), which is now the default landing at `/`. Explicit experiment URLs retain the review controls and noindex metadata; the main landing keeps its product title and search metadata without the experiment dock or its extra spacing.
- Signal weather: layered green noise becomes an atmosphere with fine signal traces. Scroll moves through the mist, the pointer clears a patch, and a tap sends a travelling disturbance. Whisper archive: oversized fragments of greetings/questions become eroded, luminous typographic echoes; scroll reveals different fragments, the pointer illuminates them, and taps distort them. Magnetic pollen: green aurora and hundreds of drifting motes gather around moving nodes; scroll changes the field and connections, the pointer attracts the motes, and taps send them outward.
- These use procedural visual fields and damped particle steering, not a claim to simulate gas physics. The viewpoint is fixed throughout the page; there are no tanks, river boundaries, or changes between a side view and a top view. The copy has a quiet background, while open space carries the brighter atmosphere.
- The render budget is 480,000 pixels per full-screen atmosphere. Particle trails are drawn in batches of brightness rather than a separate stroke/fill per mote. The gallery stops canvases outside the viewport. Pause and reduced motion freeze autonomous motion; scroll still selects a new still composition. Hidden tabs stop drawing. The page starts rendering before remote fonts arrive, then refreshes its word texture once fonts are available. Missing WebGL leaves the readable page over a CSS glow.
- `scripts/try-atmospheres.cjs` checks actual wheel input with animation time frozen and compares rendered pixels, actual mouse clicks, native touchscreen taps, pause, reduced motion, a missing WebGL context, and desktop/tablet/mobile layouts. Readback instrumentation and preserved drawing buffers are injected only into the browser-test response. It also saves a comparison gallery and screenshots of each direction; start the web dev server and run it with Playwright installed or available through `NODE_PATH`.
- The selected landing was checked at `/` without a query parameter: Signal weather rendered, the product title and indexable metadata remained, and no experiment controls or their bottom padding appeared. Mouse, wheel, native touch, pause, reduced motion and the no-WebGL fallback passed. At 1440×1000 the measured frame interval was 16.7 ms median / 16.9 ms p95 on this machine; 390×844, 768×1024 and 1280×900 had no horizontal overflow. Append `--landing` to the browser script to reproduce just this check.

## Interactive gas with momentum (2026-10-08)

- The initial weather was animated noise with a local pointer mask and a radial tap distortion. It now carries its material through a persistent 2D flow: staggered face velocities, semi-Lagrangian advection, a pressure projection, vorticity confinement, damping, and gentle buoyancy for injected puffs. Pointer movement deposits momentum along its whole path, a tap lifts dye between counter-rotating eddies, and scrolling stirs broad opposing rolls. Momentum and material displacement persist after input stops. The numerical approach follows [Stam's Stable Fluids](https://graphics.stanford.edu/courses/cs448-01-spring/papers/stam.pdf) and the rolling-detail approach in [Fedkiw, Stam and Jensen's Visual Simulation of Smoke](https://physbam.stanford.edu/papers/stanford2001-01.pdf).
- `gas-model.js` advances at a fixed 60 Hz on a coarse grid, and skips pressure solves once the flow rests. Signal weather uses 40 rows (58 columns at 1440×1000) and a 360,000-pixel render budget. Its transported material coordinates use two 16-bit components packed into an ordinary RGBA8 texture; no floating-point texture extensions are required. The noise material and lighting remain art direction. This is a damped 2D incompressible-flow approximation, not a full volumetric or thermodynamic gas simulation, and the semi-Lagrangian tracer is not exactly mass-conserving.
- Seven numerical tests pass: undisturbed rest; reduced divergence while retaining curl; persistent advected wakes and dissipation; tap puffs with both circulation signs; reversed circulation on reversed scroll; matching states at 30/60/120 display fps; and finite bounded values under repeated large drags, taps, alternating scroll and 50 ms frames. The 40-row dragged-wake test reduced RMS divergence from 0.67824 to 0.14414 (about 79%). A dragged wake retained both signs of curl and its material kept moving after the pointer stopped, then its energy fell below 3% of the early measurement. All 64 web tests and TypeScript pass.
- The browser check now reads the actual fluid state in addition to pixels. In the final 1440×1000 run, a mouse wake's mean material displacement grew from 0.00782 to 0.01034 viewport heights over 0.8 seconds after the pointer left, while nonzero velocity and both curl signs remained. Real wheel input added momentum, and native touchscreen taps created dye and opposing vortices. Pause froze physical energy; reduced motion, hidden-tab/input clock resets and the WebGL-unavailable fallback are preserved. Desktop/tablet/mobile layouts stayed free of horizontal overflow. The final isolated run measured 16.7 ms median / 16.8 ms p95 frame intervals on this machine; earlier runs with a larger grid and simultaneous video recording were slower, so this is not a device-independent performance guarantee.
- `scripts/try-atmospheres.cjs [output-directory] --landing` reproduces the browser checks with a running preview and Playwright available. The task artifacts also include a recording of a circular cursor drag, its continuing wake, a tap and a scroll reversal. The cursor marker and explanatory labels were added only to that recording, not to the shipped page.

## Softer scroll and click response (2026-10-08)

- Wheel impulses are now released into the physical flow with a 160 ms time constant, and the weather's scroll composition follows with a roughly 182 ms time constant. Click puffs deliver momentum and dye over a 300 ms smooth bell-shaped envelope, with a slightly broader radius and gentler strength. Pointer wakes and the continuing vortex flow are preserved.
- A new numerical check verifies that click and wheel events do not instantly change physical energy and that their first-step speed is below 30% of the built-up response. Circulation, persistence, decay, frame-rate consistency and bounded-input checks still pass: 65 web tests and TypeScript pass. The landing browser checks passed for mouse, actual wheel input, native touch, pause, reduced motion, no-WebGL fallback and desktop/tablet/mobile layouts, with 16.7 ms median / 16.8 ms p95 frame intervals in the isolated run on this machine.

## Time, promises and results (2026-10-07)

- **How long the team takes** (dev database, runs that succeeded in the 14 days to 2026-10-07,
  started to finished): scout 103 runs, median 7.1 min, 8 in 10 within 10.0 min; researcher 17
  runs, 1.2 / 4.6 min; explorer 9 runs, 9.3 / 14.3 min. This is what `paces()` gives the manager
  for its estimates.
- **The live chat that started this** (the founder's account, 2026-10-07 17:51 to 18:07 UTC):
  asked what it had achieved, Quest led with "37 communities filed, two replies posted (both
  removed)" in three labelled paragraphs; asked for a route to five trials, it proposed the
  family-interpreter searches its own lessons had called exhausted the night before; asked to come
  back with a shortlist in two minutes, it sent it 13 seconds later and then said it could not
  schedule a message.
- **Lessons that pile up:** the account had 21 live memories, twelve of them lessons of the form
  "this wording is exhausted, next try that" about one route, kept side by side. By `overlap` (content
  words of four letters or more shared, over the shorter memory's) those pairs have a median of
  0.41, 36 of 66 pairs at 0.4 or more; every other pair of the same kind a median of 0.05, one pair at
  0.4 or more (two "Reddit took down a reply" lessons, duplicates too). Hence `SAME_MEMORY` 0.4.
- **What Reddit did with the account's posts**, as the routes backfill counted it from the reply
  watch's events: 6 taken down, 0 answered, so "Reddit posts and replies" starts spent.
- **Rehearsals with the real model** (`scripts/try-conversation.ts` on the founder's account, MiMo
  V2.6 Pro, in memory, 2026-10-07; each run 9 to 20 model calls, $0.019 to $0.032). The founder's
  four lines: "How's it going?", "Who should we try next?", a wait, "No Reddit today please."
  - With the prompt alone, "How's it going?" got cards and a new search, not results (runs 1 and 3),
    with the results line and the spent route in the briefing unread. Framing the answer in the
    turn (`ASKS_PROGRESS`) plus one rewrite when the reply has no result words: runs 4 to 6 opened
    with "No results yet: nobody's talked, tried or paid. Reddit kept taking down everything we
    posted, so I've stopped that."
  - Times given in passing came in many shapes: "give me 10 min", "about 10 min", "~7 min", "more in
    ~10 min", "Back in ~10 min", "shortly". All but "shortly" are now heard as promises.
  - At the early look before a 10-minute promise ran out (the search still queued, as nothing runs
    tasks in the rehearsal), Quest wrote "That search needs a few more minutes, it's still queued.
    I'll come back with what it finds by 23:10." and moved the promise.
  - "No Reddit today please": a 👍 and no message in runs 3 to 5; run 1 also forgot twelve lessons,
    and, through `replaces`, the unrelated "Saved Messages test is done" decision; runs 1 and 5
    filed it for good or until "he asks"; run 6 did not react and wrote "Got it. Reddit's on hold…".
    Hence `REPLACES_OVERLAP`, `FORGETS_A_TURN`, `set_place until` and the 👍 for a reply that
    only nods.

## The founder's conversation, live on Telegram (2026-10-08)

Fly v45 to v51 from the PR branch, the founder's account on @TestPatrikBot, typed in Telegram Web,
05:16 to 06:01 UTC (08:16 to 09:01 Kyiv). Model spend for the account over that time: $0.42 (manager
54 calls $0.30, scout, researcher and outreach runs $0.12).

- **"How's it going?"** (v45, 38 s): "No real outcomes yet: no conversations, trials or paying users
  on record. Reddit replies never landed, so I stopped going that way…": results first, the spent
  route named in plain words.
- **"Who should we try next?"** (v45, 25 s): three strong people with their communities and what to
  say, but no links, and "Cards are up." The note asking for links was given and the rewrite came
  back the same. Fixed in code: names are linked from what Quest found (v46, v47), and bare card talk
  is noted. Asked for the links on v46, the model named one person from the earlier reply that the
  turn's shortlist no longer had, and wrote another without "u/"; both are linked since v48.
- **"Can you check those three are still active and get back to me?"** (v47, 2 min): it read the
  three threads and profiles in the founder's Chrome inside the turn and came back with "All three
  are still up and active… r/AgingParents bans product plugs, so DM those two; teal_kite's thread is
  open for a reply." No promise was needed, as it answered in the turn.
- **A time Quest gave in passing** ("retrying it narrower… about 10 min", from a task update) was
  heard as promise #3 (`source = 'said'`, due 08:37 Kyiv) and settled kept at 08:32, when the run
  came back.
- **"No Reddit today please."** (v47): `setMessageReaction` worked (the 👍 shows on the message in
  Telegram, with the bot's avatar), but `set_place` "reddit.com" was refused (places were
  communities or hosts only), so the hold became a memory that nothing enforced or lifted, and
  "Reddit's off the list for today. I'll keep the finds warm…" went out beside the 👍. On v48,
  "Just to be clear, no Reddit at all today please." got a 👍 alone, `reddit.com` filed as avoid,
  and a next step to lift it at 09:00 Kyiv the next day with its wake pending; the new memory
  replaced the old one (#175).
- **One step, ~130 tool calls** (v48): "Get back to me in 5 min with which one I should DM first"
  got one MiMo step that asked for about 130 calls, most of them `browser_open` on the same
  r/AgingParents thread plus `read_visual`, which held the turn and the founder's Chrome for minutes,
  until the machine was restarted. The turn ran again after the restart, settled promise #5 as kept
  before its reply went out, and the reply came at 08:47 Kyiv on the second attempt. Hence
  `MAX_CALLS_A_STEP` (v49).
- **"Ping me in 3 min with the first line I should send them."** (v49): promised for 3 min (#6),
  then answered and settled 10 s later: the founder's complaint of 2026-10-07 again. Hence held
  answers (v50): "Good one. Ping me in 3 min with an opener for teal_kite too." (05:57:46 UTC) got a 👍
  at once, the answer held on promise #8, and sent at 06:01:20, 1 s after its time, with no model
  call (`manager.held_sent`, then `manager.commitment_skipped`). The 3 min were counted from the
  turn's clock, 33 s after the message; counted from the message since v51.
- **Meanwhile, unasked:** a scout run, a researcher run (conference travellers on HN, Bluesky,
  Mastodon, the web) and an outreach run that opened Telegram Web, Gmail, Bluesky and Mastodon in
  the founder's Chrome and searched them for "vocavela" replies. Nothing was drafted or sent.

## Seats chosen on the founder's own misreads (2026-10-14)

**Writer** (`scripts/try-writer.ts`, the real Writer, 17 jobs in two voices; five of them in Spanish,
German, Ukrainian and Brazilian and European Portuguese from an English draft, one a build-in-public X
post from a promo draft). A cent is $0.01; each line is the average per message.
- Claude Opus 5.5, low effort: 0.97¢, 16 of 17 on the first try. The best voice and the most native
  ("kkkk … Força aí!"); in European Portuguese it mixed "vos" and "teu".
- **Claude Sonnet 5.5, low effort: 0.28¢**, 14 of 17. Close to Opus in every language, invented
  nothing, consistent register. The default.
- GPT-6.1 Sol 0.42¢ and Gemini 4 Argon 0.38¢: correct, colder; Argon once wrote an odd conditional.
- GPT-6 Luna Pro 0.05¢, 16 of 17: honest and plain; once named the product without saying it was theirs.
- Gemini 3.8 Flash 0.14¢ (9.5 s): added advice nobody gave ("go with him to translate").
- Kimi K3 0.57¢: very human, but invented ("the hospital forms were the worst for me too") and ended
  with a call to action. Mistral Large 4: wrote "keep it up!" in English inside a Portuguese reply.
  Qwen 3.8 Max wrote 11 of 17, Grok 4.7 5 of 17 (2,664 thinking tokens a message).

**Manager** (`scripts/try-understanding.ts`, the real prompt and tools on five moments from the
founder's prod chat that day). Moments: a voice note heard as "…to fit the Mark Lou. ...", the same
ask typed, a screenshot of Marc Lou's X profile captioned "This is him", a voice note on a card
("say nothing about messaging question"), and "English please" after a Portuguese answer.
- Claude Haiku 5.5 ($0.0045 a turn): read the first two as a cut-off message, both times; gave the
  card note a 👍 and no change (the prod bug, reproduced).
- **DeepSeek V4.1 Flash ($0.0015 a turn)**: understood all five (a Marc Lou-style bio of products and
  monthly revenue, the real numbers asked for); one task on X for "find someone on X". Once claimed a
  refused draft was "written" (refusals now say nothing was made). The manager.
- GPT-6 Luna Pro ($0.009): understood four; answered the voice note with a 👍 only, and switched the
  quest to custom unasked on the screenshot.
- Sonnet 5.5, GPT-6.1 Sol and Gemini 4 Argon understood more but cost $0.05 to $0.09 a turn.
- "English please" failed on every model until `set_language`: the language briefing pointed them to
  /language, and the device's Portuguese kept winning.

**Vision** (the picture reader on the founder's phone screenshot): Haiku 5.5 read every line of Marc
Lou's bio ($0.0003, 3.5 s); DeepSeek V4.1 Flash missed the product list and misread his follower count.
Pictures, the posting browser and post checks sit on the vision seat (Haiku).

**Live on @TestPatrikBot** (local agent on dev): Edit sent "✏️ What should change?" under the card;
a reply to it, and later a reply to the card itself, each brought the rewritten card back under the
note with its buttons, the old copy without them. Telegram Web A does not open the reply box for
`force_reply`; the reply was chosen by hand there.

## X's composer and a DOM fill (2026-10-14)

Live on @messagingquestbot: the founder's reply to @makerfour went up on X with its link as
"…g.questmessaging.questmessaging.quest". The poster then held it as unknown (the exact body was not on the
page), and the follow-up with the fixed link failed to prepare twice.

Reproduced on Draft.js 0.11.7 with a link decorator (X's composer is Draft.js), in Chrome:
- The extension's DOM fill (select the editor's contents, `execCommand("insertText")`, a synthetic input
  event) crashed the editor at once: React's `removeChild` error, the editor gone. Without the synthetic
  event, the same.
- Select-all then CDP `Input.insertText` (a paste's path) filled it exactly four times in a row, refills,
  a link with a path and a two-paragraph body included, with no page error.

Since extension 0.9.2 a fill into a contenteditable goes that way (`trustedFill`). X shows long links
shortened, so a posted body is now known by its words around the links (`bodyShown`).

## An X reply beside other work in the same Chrome (2026-10-31, @TestPatrikBot, extension 0.12.0)

- A reply on an X post (`BrowserPoster`, Claude Haiku 5.5) gave up twice after 6 prepares in about a minute, nothing sent, while an outreach run sent three X searches at once into other tabs of the same Chrome (each read took 7 to 38 s). With nothing else running, the same draft went inspect, prepare, prepare, publish, confirm in one pass. Since then nothing else of theirs runs while a post is written (`ChromeBroker.posting`).

## X's profile bio and a field's limit (2026-10-15)

Live on @messagingquestbot: the founder asked Quest to update their X bio. Quest's card held 174 characters
(the writer kept X's 280 for a post); X's bio `textarea` (`name="description"`) has `maxlength="160"`. A
script's value skips `maxlength`, so the poster's fill never left X a bio it would save: the poster went
round `prepare` 26 times until its step budget ran out, and the card twice said only "try again".

Since extension 0.9.3 a snapshot gives each text field's `limit`, a fill longer than it types nothing, and
the poster stops at once with `TooLong` (one model call, not 27); the writer cuts the words to fit.

## Quest's tab group, in a real Chrome (2026-10-15)

Chrome for Testing 152 on Windows 11, extension 0.9.3 against a stand-in Quest server, the customer's
window holding two tabs of theirs (`scripts/try-tab-group.mjs`, 20 checks, all passing):
- Reads open a "Quest" group in their window, in the background; their tab stays in front.
- A page drawn only on screen brings Quest's tab to the front and their tab back after. A window under
  another app's is not drawn though Chrome still calls it focused: it has to be raised (`focused: true`).
- A browser session's tab is in front while it works (fill, screenshot); closing it gives their tab back.
- After 90 s with nothing to do (the 30 s alarm makes it ~120 s) Quest's tabs close and the group goes;
  disconnecting closes Quest's tabs only; an update closes 0.9.2's "Quest is reading" window.

How much a page shows in a background tab, against the same page drawn:

| Page | Background | Drawn |
|---|---|---|
| reddit.com/r/SaaS/new (logged out) | 3,391 chars | 29,901 chars |
| x.com/marclou (logged out) | 948 chars | 2,428 chars |
| x.com/marclou (logged in, founder's Chrome) | 3–4 posts, 2.2–2.6k chars | not measured |

Reddit already reads again drawn when a page comes back thin (`wantsDrawing`); other sites read what the
background tab shows, as they did from 0.9.2's window whenever it sat under another.

Rig gotcha: Chrome for Testing never starts an extension's service worker when the profile's path is
long (the scratchpad's ~190 characters; Windows' 260-character limit under `Service Worker/Database`):
no runtime error, `renderProcessId: -1`, messages unanswered. A profile in `~/.cache/mq-cft/` works.

## Likes, follows, a bio, and the work on the Quest button (2026-10-15)

Local agent on this branch, polling @TestPatrikBot on dev; extension 0.10.0 unpacked in Chrome for Testing 152
on Windows 11, paired through the bot's own `/connect`; a small social test site (a feed of `<article>`s with
X-shaped "12 Likes. Like" buttons, a Follow per person, an "Edit profile" form whose bio `textarea` has
`maxlength="160"` and a Save that posts, then goes to the profile) behind a Cloudflare quick tunnel; the
founder's own Telegram Web in the app's browser pane.

- **Why the X bio kept failing.** The agent's schema for the extension's answers (`http/chrome-outcome.ts`)
  named no `limit`, and zod drops what a schema does not name: the 160 the extension has sent since 0.9.3
  never reached the poster, so `TooLong` never fired. The extension refused the fill ("takes at most 160
  characters…"), the poster read it as "Not done" and went round again. The schema now names every field
  the agent reads, and the poster also stops on the refusal's own numbers.
- **A click that navigates hung the extension.** Save fetched, then sent the page to the profile. The
  injection that came next (a quiet wait, a "drawn?" probe) never answered, the job never finished, and
  the worker took no other work: the poster waited out 90 s as "uncertain" and every read after failed as
  "offline". Run by hand in the worker the same steps took milliseconds. Since then every injection is held
  to a time, a navigation is waited for, and no job holds the worker past 85 s. Then: Save at 15:50:21,
  saved on the site at :24, verified from the profile at :26.
- **Chrome kept an old service worker.** Relaunched with `--load-extension` and the same version (0.10.0),
  Chrome ran the worker it had from the first launch: `Debugger.getScriptSource` showed the old
  `background.js` while the file on disk was new. `chrome.runtime.reload()` loaded the new one.
- **Likes and follows went to the right one.** "Like Ari's post … and follow him" on a page holding Ari's
  post and Bob's reply (a Like each), and a profile listing @ari and @bob (a Follow each): the like went on
  Ari's post (verified when its control read "13 Likes. Liked"), the follow on @ari, 4 min apart as
  autopilot paces what it does alone (this dev founder has the `*` row). Before the fix that keeps their
  words, a bio given "exactly" came back from the writer with "and translator" added.
- **The manager said done too early.** Told "Publishing", its reply said "followed @ari, bio set" at 16:28;
  the follow went through at 16:31. The tool's answer now says it is on its way, not done.
- **The Quest button.** `setChatMenuButton` with `chat_id` changes one chat's button at once in Telegram Web;
  `{type:"default"}` gives it back the bot's. In the narrow layout Telegram Web cuts the label at about ten
  characters: "Quest · 2 working" showed "Quest · 2 …"; "2 working" shows whole. Opening the Mini App from a
  bot for the first time asks to confirm ("…access your IP address and basic device info").
- **The live page.** With a scout and an explorer on Reddit and an outreach task waiting on an answer for
  x.com, the Now tab drew Quest ("2 working"), the two runs with rings and minutes left wired to reddit.com,
  the outreach task dimmed and wired amber to x.com, and "Chrome · open · reading reddit.com · 2 waiting".
- **Translation.** `scripts/translate-i18n.mjs` (MiMo V2.6 Pro) answered one Russian batch of 13 in
  Portuguese, twice; the other eight languages came back right. Those 13 were written by hand.

## Onboarding that sets their voice, and limits per platform (2026-10-16)

- Before testing it, the founder's production Quest was cleared again (customer d32c9b78…, created 2026-10-15 13:52): its one running task (an outreach reply on X) was cancelled through `cancel_requested` with the customer moved to the `test` lane, everything was exported to `Projects/mq-backups/prod-2026-10-16-founder-quest.json` (648 MB: the checkpoints of 11 tasks are 4,889 rows, too big for one `JSON.stringify`, so the export streams row by row), then the customer row was deleted (every `mq` table cascades from it) with its tasks' checkpoints. Their Chrome pairing went with it: `/connect` again.
- The voice cards come from v1 (`messaging-quest/docs/onboarding-cards.md`, 2026-08-08): nine habit cards and "Which of these sounds like you?" with three drafts from the site read. v1 found them the fastest cards of its flow. v2 keeps six habits that hold in any language (contractions and em dashes are English; the writer bans dashes anyway).
- The day limits are judgement, not measurement: a person's pace on each site from its own published rules where it has them (LinkedIn's ~100 invitations a week, Gmail's 500 recipients a day against far lower spam thresholds for cold email, X's automation rules, Hacker News's ban on voting rings) and the founder's word that replies and comments have none.
- Live on the dev bot (2026-10-16, local agent, Telegram Web, a fresh customer): the quest choice, Chrome pairing, "messaging.quest", then 14 cards in about 4 minutes while the site was read. Typed answers were judged right ("honestly paying customers, that's the goal" became Paying customers; "mostly build in public updates and lessons I learned" ticked two kinds), the multi-pick ticks redrew in place, the samples card came once the brief was written (Claude Sonnet 5.5, 4.1 s), and the manager kept the goal, strategy, kinds and places as a fact and a decision. The scout's replies written after the habit cards came out lowercase, short, no emoji or exclamation marks. The Mini App's Settings tab showed the picked voice, the habits and every day limit.
- DeepSeek V4.1 Flash (manager seat, reasoning off) left an optional `text` out of every post it drafted: about 126 tokens out, the title and the flags, six refusals in a row ("needs the words in text"), however the field was described. Required again (`""` for a like or follow), the next drafts carried their body (about 350 tokens out). It also put "r/buildinpublic" in `target` rather than `community`; the draft tool takes either now. Refusals are logged (`manager.draft_refused`, the reason only).
- Telegram Web cuts a button in a two-to-a-row keyboard at about 27 characters in a 570 px pane ("Like, follow, comment to get k…"): a pick of several goes two to a row only when every label is 16 characters or less.

## What browsing costs, and old pages folded (2026-10-16)

- The founder's production Quest from 2026-10-15 14:37 to 2026-10-16 08:45 UTC: 999 model calls, $1.93. Outreach (MiMo V2.6 Pro) $0.80 (42%), the manager (DeepSeek V4.1 Flash, 698 calls, 50,516 input tokens a call, 77% cached) $0.53, scouts $0.30, the writer (Claude Sonnet 5.5) $0.13, the posting browser (Claude Haiku 5.5) $0.06.
- One outreach run on X, "Fresh founders on X to reply to": 40 steps, 22 `browser_open` and 15 `browser_act`, $0.64. Its prompt grew 5,000 to 7,000 tokens a step (each page stays in the run's history), from 9,000 to 170,000; the summarization set for 90,000 tokens condensed it only after step 38. Steps 33 to 38 (152,000 to 170,000 tokens) missed the cache and cost $0.064 to $0.071 each, $0.41 in all.
- MiMo's price as fitted from those 999 calls: $0.435 a million input tokens uncached, $0.004 cached, $0.867 out. A missed cache, not the size alone, is what costs: the same step is $0.003 cached and $0.07 not.
- Replayed with old pages folded (2 kept whole, 4 folded at a time): the run's input tokens come to 30% (step 38: 170,193 to about 27,900), about $0.22 instead of $0.64.
- `PLATFORM_MAP` in the standing browsing prompt is 6,393 characters (about 1,600 tokens), cached with the rest of it.

## A day's budget, and Senior through Stripe (2026-10-16)

- 200 credits is $2: the founder's busiest production stretch so far, before old pages were folded, came to $1.93 in 18 hours (999 calls, 14:37 to 08:45), just under it; with old pages folded, an outreach run on X is about $0.22 of it.
- Live on dev, a 40-credit day (`INTERN_CREDITS_A_DAY=40`, 40 credits spent that day): `/plan` answered in code; the next model call (a heartbeat turn, $0.0005) brought the rest 3.6 s later, until the next UTC midnight, with the sleep sticker and the offer of Senior; a message during the rest got "Resting for 10 h more" and the next one a 😴; a second rest, on another day (the offer's date moved back a day), brought 30% off with its countdown. The turn that was already running made four more calls ($0.002) after the rest began, as designed, and the three messages that came during it waited for the rest.
- `atTheirTime` reads their clock to the second, so a midnight counted from a `now` with milliseconds came out at 00:00:00.448; `theirDay` cuts them first.
- Telegram takes no `http://localhost` address in an inline button: on a laptop agent the plan's button comes as its address in the text (`TelegramChannel.sendLinks`); the deployed agent's https address is a button.
- v1's Stripe test key (messaging-quest's `.env.local`) is expired (`api_key_expired`); no live key is on this machine. The one other Stripe key here belongs to another business's sandbox, and was left alone.
- A real test payment, 2026-10-16, with the founder's new sandbox key (account "Messaging Quest sandbox"): `scripts/stripe-setup.ts` made the price (`mq_senior_monthly`, $420 a month) and the coupon; the portal already had a default setup. From `/plan` with a running 30% offer, Checkout showed "Subscribe to Quest Senior, $294.00, then $420.00 per month starting next month"; Stripe's test card 4242 paid it, and Stripe sent the browser back to the page's "Thank you!".
- Stripe sent `customer.subscription.created` one second before `checkout.session.completed`; delivered newest first, then all three again (`scripts/try-stripe-events.ts`), "✅ I'm Senior now" went out once (with the active sticker), the offer was marked paid, the rest ended and `mq.subscriptions` read active until 2026-11-16. The page then showed "You're on Senior" with Manage plan, which opened Stripe's portal (Quest Senior, $420 a month, next billing November 16, the card, Cancel). Cancelled through the API, `customer.subscription.deleted` brought "Your Senior plan has ended" once.
- The turn the upgrade woke (its `plan` event) failed three times on the dev OpenRouter key's daily limit ("403 Key limit exceeded"), after the day's testing: the manager picking the work up after a payment was not seen live.

## A post a deploy cut off (2026-10-17)

- Production, 08:20 UTC: the founder tapped Post it on an X reply at 08:20:04, a second try (the first, at 05:06, had ended with nothing sent), and the deploy's SIGINT reached the agent at 08:20:09. Fly sends `kill_signal` (SIGINT), then SIGTERM 25 s later (08:20:34), and kills the machine at `kill_timeout` (30 s, 08:20:39: "Virtual machine exited abruptly").
- The shutdown closed the server before it waited for the post, and from then on Fly's proxy answered every poll the extension made with "instance refused connection" (08:20:10 to 08:20:38). The post, still waiting on their Chrome, could never go on, and the machine was killed with the draft claimed as `posting`. No model call and no journal entry came after the tap, so that try sent nothing.
- Left claimed, the card would have answered a tap with "It may have gone up: look first" and had no way to post again: `beginPost` claims only an open draft, and the card had never been redrawn as held.
- The reply went up anyway: at 09:16 the manager found it live on the founder's X profile and marked it posted (`verify_sent_draft`). Quest's journal shows no send of it after 05:06, so it was most likely posted by hand from the card's words.
- The next deploy, with the fix (v70, 13:42): SIGINT to "Main child exited normally" took under a second with no post running, and the start logged `lostPosts: 0`.
- Since then a stopping agent keeps the server open while a post has 10 s to finish, then stops it (`ERRAND_TIMES`), and a start marks claims a stopped machine left as uncertain on their cards (`recoverPosts`).


## Sparring on the first day, the whole picture, People as one feed (2026-10-17; the sparring was replaced by the takes, below)

Local agent on this branch polling @TestPatrikBot on dev, the founder's own Telegram Web in the app's browser pane, three runs from a clean start (the dev customer deleted with its tasks' checkpoints each time); before them `scripts/try-onboarding.ts` and `scripts/try-first-run.ts` with the real models in memory.

- **The warm-up's cost and time.** The rounds are one writer-seat call (Claude Sonnet 5.5) for all four people, 4.7 s, $0.0066 to $0.0075; each answer back is one more, 2.1 to 2.8 s, about $0.0036; the last card is one writer call, about $0.006. In all about $0.025 a customer. In memory the founder's whole warm-up took 17 to 19 s of model time.
- **Run 1 (founder, quest tapped, a site):** the eight questions about them by taps and two typed answers ("launched, nobody pays yet tbh" became Launched, nobody pays yet), then three rounds: a typed answer, a tapped move, a typed answer. Every habit came from the typed answers, so no habit card was asked, and the last card was Quest writing as them, true to the brief ("Free to start, no card" is in it). The where card's answer woke the manager; once their Chrome connected it found their accounts on Reddit, X and LinkedIn in it and drafted an X bio, X's website field and a LinkedIn headline as profile cards (the plan kept "Reddit profile still to check").
- **Three bugs that run found:** taps on a round never reached the agent (the callback pattern took `[a-z_]` keys and `spar_2` has a digit); a Reddit profile draft failed its insert on `drafts_check`, which asked a title of every Reddit draft but a reply, and took a manager turn and the outreach profile task down with it (migration `20261017150000`, applied to dev); the People page's `site()` helper was shadowed by the live graph's own `site()` (function declarations hoist), so the tab drew nothing.
- **Run 2 (founder in their own words, Ludicrous):** "need first paying users for messaging.quest" set the quest; "customers who pay, obviously" and "reddit and x for now" were judged right (one pick, then two). Three typed rounds, lowercase; the last card ended with one plain ask ("want to try it on your product?") and its note ("too salesy, just say it's mine") was kept as voice by the code and again by the manager. Before the fix, a plain message on the last card was judged as an answer to the person in it, not as a note.
- **Run 3 (career, moves only):** a CV in text gives no site to read and the scout waits for Chrome, so no work ran and no card came until they sent their own site (the researcher reads it through Tavily with Chrome closed). With only moves tapped, the six habit cards came, then the three samples; one sample had an emoji right after "Emoji? Never" (the samples now keep the habits they named).
- **The people Quest plays.** On the same brief, three of four runs opened with the same skeptic, "u/skeptic_pm" ("this reads like an ad, what's the catch?"); the rounds are now asked for names of their own. Reactions were honest rather than kind: 🟡 for a dodge, 🟢 for a straight "not yet" with a free start.
- **What the writer still does.** With a brief that names no price, asked about "$420 a month", it denied the price ("any $420 price isn't mine") even with the rule to neither confirm nor deny what the brief does not have. Before the rule that it never copies their sentences, it reused a sparring line word for word ("fair, it's mine") where it did not fit.
- **Telegram Web, again.** It drew a card's edit seconds to minutes late, or not until a scroll; `mq.customers.profile` is the record. A click at a button's place from a screenshot taken before a new card arrived lands on the wrong row: take the screenshot right before the click, or answer by typing the option's id.
- The manager sent the Chrome setup message three or four times in the first five minutes of runs 1 and 2 (`connect_chrome` on several turns before Chrome was connected); fixed on 2026-10-18, below.

## The takes: Quest writes as them until they say it is them (2026-10-18)

The founder read the sparring above and replaced it: people Quest made up answering back "will be hit hard by the reality". The rounds and their scores are gone; what the sparring measured about the people and the writer still holds. Same setup: a local agent on this branch polling @TestPatrikBot on dev, the founder's own Telegram Web in the app's browser pane, two runs from a clean start answered by Claude in the founder's place, and before them `scripts/try-onboarding.ts` with the real models (founder and career).

- **Cost and time.** All writer seat (Claude Sonnet 5.5). The people for four takes: one call, 3.7 to 4.7 s, about $0.0068. A take: one writer call, 2.4 s on average and up to 3.1 s, about $0.0054 (a take that gave itself away is written twice, so 5 writer calls for 3 takes). A look back: 2.4 s on average and up to 3.4 s, about $0.0047. From a tap on a fix to the next take on the card: about 5 s live. Three takes with two looks back came to $0.043. The first take took 10.5 s in memory when nothing was written ahead; live, the people for it are written while they answer the push card.
- **Run 1 (founder, Sport).** Take 1 was the writer before any correction: two paragraphs, "I'm the founder of Quest". A typed note ("too long, and i never say "founder of". i'd just say i built a thing for this"), became five rules ("Never introduce yourself by title; say "i built a thing for this"", "one or two short sentences, under 25 words") and the line "🪞 Much shorter, and I say "I built a thing for this", never "founder of"". Take 2 followed them; a tap on Less salesy dropped its feature explanation; "That's me" on take 3 locked in eight rules, shown on the card and on their page under Settings. The agent was restarted between takes 2 and 3 (below): the take waiting in the profile came back as it was.
- **Run 2 (founder, Ludicrous, typed answers).** Take 1 closed with one plain ask, as the mode says ("Want to try it on your SaaS?"). More casual made the next take lowercase. "yeah almost, but drop the question at the end, i never ask like that" was judged a note, not a "that's me", and take 3 had no closing question even in Ludicrous. Skip ended the takes with "Got it. I'll keep learning from your edits on the cards."
- **In memory, career with a voice note.** A spoken "it sounds too eager. I'd never say thrilled or excited. I'd say something like, hey, saw the post…" became "Never use eager words like thrilled, excited, or passionate" and an opening "hey"; a typed "that's me" was taken as the tap. Two lines of the look back were wrong and are now asked against: one called the person in the take "her", and one ended a correction with "Locked in." An email take came back with a "Subject:" line, which the take now leaves off.
- **What the live runs changed.** "skip that", typed, was kept as their answer in quotes; a plain skip is now the Skip button. Three of the writer's answers to a skeptic opened with "fair question"; it is now a tell and a banned opener, like "great question".
- **The laptop agent died overnight.** The laptop slept with the agent running; on waking, an idle Postgres connection failed ("write ECONNABORTED") and, with no `error` listener on the pool, Node threw it and the process exited. Not changed here. The tap made while it was down reached it on restart too late for Telegram to take its acknowledgement ("query is too old"); the answer itself went through.
- The manager still sent the Chrome setup message again on most turns before Chrome was connected (four times in run 2, the last right after the takes ended). Fixed the same day, below.

## A dropped database connection, and the Chrome setup once (2026-10-18)

- **Node exits on a dropped connection with no listener.** On dev, a pool connection left idle and then ended from the server (`pg_terminate_backend`, as a pooler restart or a sleeping laptop would) crashed a bare `pg.Pool` at once: "Unhandled 'error' event" on the pool, "terminating connection due to administrator command" (57P01). With `createPool`'s listeners the same test logged `db.connection_lost` and the next query answered. The checkpointer checks clients out for its transactions (`pool.connect()`), and a client checked out reports its error on itself, so each client gets a listener too; its query in flight fails with the error, and the pool drops it when it is given back.
- **The Chrome setup.** It had a 3-minute guard (`RESEND_AFTER_MS`) and every turn's briefing said "send the setup with connect_chrome before the first reading task", so each turn a few minutes apart sent it again. It now goes out once in 12 hours like the reconnect link, and the briefing, `start_task`'s refusal and `connect_chrome` itself say when it went out and not to send it again or bring it up.

## The off switch, one reply per post, the product last, ideas and assets (2026-10-19/21)

The founder, 2026-10-19: be aware of spam filters and leave the product to the very last point, with simple engagements first and different kinds of them; stay in charge of the direction (assets, ideas for posts, Quest's own ideas); the same reply went up twice where one was deleted or hidden, and their own outbound DMs were taken for replies; an off switch so the desktop is theirs. Measured on production's records (the founder's backup, `mq-backups/prod-2026-10-19-founder-quest.json`), then live on @TestPatrikBot (a local agent on dev, the founder's own Telegram Web in the app's browser pane; no Chrome connected, so nothing could be posted).

- **The repeated replies.** Under @MakerOne's post a reply went up on 10-18 at 17:38, by itself; at 06:52 the next morning the manager opened the same post, did not see it there, drafted another in other words and it went up by itself 30 s later. Under @MakerTwo's post two went up at 13:58 and 14:57 the same day, also by themselves. The only duplicate check compared the words, so other words passed. On X a post's address was the reply's `sent_url` too (the poster knows no reply's own link), which is the key one-reply.ts now compares.
- **Their own DM taken for an answer.** At 08:56 on 10-19 the manager drafted "thanks for the reply" to Jordan Lee on LinkedIn, quoting a message in the thread that the founder had sent himself (no draft of Quest's had gone there: he wrote it by hand). LinkedIn's thread page names each message's sender on its own line ("Name", "Name 9:15 AM", "Name sent the following message at 9:15 AM"), which is what `whoseWords` reads.
- **"Stop the work for now" did not stop the posting.** The founder said it twice on 10-19; both @MakerTwo replies went up after it, by themselves. The off switch is the code for it; the manager's hold was only a memory.
- **The off switch, live.** `/off` answered with the button at once; the first message after it got "I'm switched off, so this waits…", the second nothing; `/on` and the button and the page's switch each worked, and the manager answered what had waited ("Good to have you back. Your onboarding post is saved as yours…"). The first run found a gap: a manager turn already running when `/off` came sent "where are you based?" 30 s after it, and the claim query still took events a turn had left processing. Since then `/off` stops the turn in flight (`manager.turn_stopped` live, 18 s after a question was sent, with no reply leaking) and its events wait with their try given back. Off from the page, two researcher runs stopped at once and went back to the queue.
- **Ideas, live.** An idea typed while off was kept by the manager on `/on` as theirs (`idea`, from them). Asked for one of its own, the manager sent a card ("💡 Idea for a post on x.com", Write it, Not this one); Write it edited it to "✅ Writing it" and the manager drafted the post at once (it stopped at reading x.com, with no Chrome). The manager also said the idea again in a message after the card ("Sent it as a card, so you can tap Write it…"): that is now card talk, asked once for a rewrite. The Memory tab listed both ideas as to do.
- **The writer kept plain, live.** `scripts/try-plain.ts` on the three find replies the dev bot showed on 10-21, all of which named Messaging Quest to strangers: with `plain`, Claude Sonnet 5.5 kept the advice and dropped the product in all three; without it, all three still named it.
- **Not tried live:** sending a picture from Telegram Web (its file dialog is not reachable from the browser pane); the asset path, the card's "📎 With your picture" and the poster's attach are covered by tests, and the extension's `attachFile` by a page test, not yet on X or LinkedIn. The extension needs 0.11 in the Web Store for it.

## Videos for posts (2026-10-22)

The founder, 2026-10-22: the agent makes montages, slideshows and motion graphics from the assets and the idea they give. Measured on this laptop (Windows) and in WSL Ubuntu with the Linux binary the image gets, then live on @TestPatrikBot (a local agent on dev, the founder's own Telegram Web in the app's browser pane).

- **ffmpeg-static 5.3.0 is two builds.** On Windows it installs gyan.dev's 6.1.1 "essentials", which has drawtext. On Linux it installs johnvansickle's 7.0.2 static, which has no drawtext: that build has freetype but not harfbuzz, which drawtext needs since 6.1. Both have libass (`ass`), xfade, zoompan, gradients, tpad, libx264 and aac. So the words go on as an ASS script. The image needs a font and fontconfig (`fonts-dejavu-core fontconfig`); the ffmpeg binary is about 80 MB.
- **Three things that cut a video short.**
  - ffmpeg 7 refuses to crossfade a clip whose `setpts` left its frame rate unknown ("frame rate (1/0)"). ffmpeg 6.1 did not mind.
  - zoompan with `d=60` on one picture gives 59 frames.
  - A one-frame cut whose offset was rounded up (3.467 for 3.4667) fell after the last frame of the scene before it. xfade then ended the whole video at that point, with no error: a 5.47 s plan came out at 104 frames. Each scene is now padded and trimmed to its exact frame count, and offsets are rounded down. The unit test counts the frames.
- **Time and size.** On the laptop, a 14 s square video (5 scenes, two of them clips) rendered in 8.4 s at 481 KB; the same plan in portrait took 12.3 s at 573 KB. Live, Quest's own 16 s plan (7 scenes) took 12.5 s and came to 651 KB, well under the 8 MB a post attaches. Not yet timed on Fly's shared-cpu-1x.
- **Live.**
  - **The assets.** The browser pane cannot open a file dialog, and a synthetic Ctrl+V pastes nothing. Telegram Web K takes a paste event that carries a File, so the landing's `og.png` and its 58 s `video.mp4` (both served with `access-control-allow-origin: *`) went in that way, as a photo and a video with captions. Quest kept both as assets and put a 🔥 on the banner.
  - **The ask.** Asked "Make a short video post for X from these two: open with a hook in big words, then the banner, then a few quick cuts from the demo, and end with a call to try messaging.quest. Square.", the manager called `make_video` with 7 scenes:
    - two lines of words on the gradient: "Marketing is a second job", "You already built the product";
    - the banner, zooming, captioned "Your brand on autopilot";
    - three cuts from the demo, captioned "It learns your work once", "Then posts every day" and "From your own accounts";
    - "Try it at messaging.quest", wiped in.
  - **The delivery.** The video was made 22 s after `make_video`: the demo's 7.5 MB download from Telegram, then 12.5 s of rendering. It went to the chat right after.
  - **No X post.** `video_ready` woke the manager to draft the X post, and `draft` refused twice: "read the destination first". With no Chrome connected, `browser_open` could not reach x.com, so it wrote the post into its plan for when Chrome is back. Its message saying so was held back by `holdBack`.
- **With Chrome connected (the founder's dev Chrome, 18:50).**
  - **The rules check, three times.** The manager opened x.com at once, then drafted the video post and was refused for its rules, three times over two turns ("Read the destination's posting rules first"). X's rules come only with the first page of a site in a run, and the turns that drafted had not opened x.com themselves. The refusal now gives a known site's rules (`platformOf(url).rules`) and asks for `rules_read` if they allow the post.
  - **A card that was not there.** The old agent said "The post is written and waiting on your tap … It's on your card now" (19:53), although every draft had been refused and no card existed.
  - **Handed to outreach.** Asked again, the manager gave the post to an outreach task, with the asset's id in its instructions. `outreach_draft` had no `assets`, so a post drafted there would have gone up without the video, and a picture the same way. It takes them now.
  - **The rules check still misread.** Given X's rules in the refusal, the manager (DeepSeek V4.1 Flash) told the founder "X refused the post twice: it won't take the link in the text". The refusal now says it is a check, not a verdict. Even so, the next turn never called `draft` again with `rules_read` true, and it said "no card yet" after the outreach card was up.
  - **The card.** The outreach task (MiMo) read X, then drafted the post as @theIcreator with the video (`3373174e…`, 19:17:47 UTC), two minutes after it started. It wrote its own line, with no link: "Posting always felt like a second job next to building. So I'm trying to do it in the open, one small thing a day. Still figuring out what's worth sharing." The card says "📎 With your picture", the same words for a video.
  - **The tap.** Post it showed "Posting it from your Chrome…". The poster opened X's composer and got to `attach` in 17 s. There it stopped as `outdated`, with nothing sent: the founder's dev Chrome ran extension 0.10.0 (the main checkout was on PR #58), which has no attach. The card came back with its buttons, and Quest said in the chat to reload the extension and tap Post it again.
  - **Three restarts, one task lost.** Each restart of the laptop agent here was a forced kill, which counts as a failed try for every run in flight. The "X replies to the three founders" outreach task used its three tries that way and failed ("gave up after 3 tries").
- **The video went up on X (19:44, extension 0.11.1).**
  - **Updating the dev Chrome.** Claude in Chrome cannot open `chrome://` pages, and Chrome ran with no debugging port. So `chrome.exe chrome://extensions/` opened the page in the running Chrome, and Windows UI Automation did the rest:
    - Chrome did not expose the page's contents to UI Automation, so a click on Load unpacked was placed from a screenshot of the screen.
    - The folder picker is a native dialog: its Folder field took the worktree's `apps\extension` (WM_SETTEXT), then Select Folder.
    - The 0.10.0 copy was switched off, not removed.
    - `/connect` paired the new one.
  - **The post.** The second tap on Post it ran from 19:44:17 UTC:
    - The poster opened the composer and attached the 16 s video at 19:44:35.
    - It waited three times while X processed the video, then published at 19:44:50.
    - The post went up at 19:44:51, video and words: `x.com/theIcreator/status/2113355924379168862`.
  - **No receipt.** The poster looked six more times and could not see the post, so the draft was held as `uncertain`. The card offered "Not there, post again", and a tap on it would have posted a second copy.
    - This was the first new post on X through the poster, on dev or production.
    - After Post, X goes back to Home, and Home ("For you") does not show your own new post. The profile does.
    - Where to look is now in X's `where` (`platforms.ts`).
  - **The manager saw it first.** The 19:45 promise woke the manager. It opened the profile, saw the post, and told the founder it was up. Its `verify_sent_draft` (19:45:12) was refused, because the send was still running ("its posting executor will verify it"). Four seconds later the poster gave up, and nothing looked again. Told the link in the chat, the manager verified it (19:49:39): the card says "Posted: see it".
  - **A promise its card did not keep.** In the same turn the manager drafted a reply under the post. It said "one tap and messaging.quest sits under the post", but the reply's words carry no link and no product name. Why was not looked into (the warm-up's `plain` is a likely cause). Not tapped.

## A like on X in Ukrainian (2026-10-23)

- **Refused twice, nothing pressed.** The founder tapped Like it on a card for @makerthree's post (draft `6ceede73…`, 06:02 UTC). The poster (Haiku 5.5) went inspect, prepare, publish, inspect, publish, and the card came back "I couldn't do your like…, and nothing changed". Their X is in Ukrainian (`<html lang="uk">`), and `publish` knows a like by its words, which were English only: the Like read "17 Уподобань. Уподобання" and was refused as not a like control.
- **X's words in Ukrainian**, read from the founder's X: Like "N Уподобань. Уподобання", liked "N Уподобують. Уподобали" (`aria-pressed` is not set, so only the words tell); Follow "Читати @name", Following "Підписки @name"; the left bar's "Follow" link is "Читати" too. "Читати" is also "read", so it counts as a Follow only alone or before a handle.
- **Other languages.** `actsAs`/`doneOn` know English and X's Ukrainian. In any other language, the refusal tells the poster to press by picture, where `BrowserVision.toggle` checks the point is that post's like and not already on, and `confirm_visual` checks the receipt.

## A checkpoint save that lost its connection (2026-10-23)

- **The laptop agent exited at 06:48 UTC.** A scout run was reading indiehackers.com when its database connection dropped. pg hands a connection's error to the query in flight, so the client's `error` listener got nothing and no `db.connection_lost` was logged. LangGraph's next save on that client (`PostgresSaver.putWrites`) failed with "Client has encountered a connection error and is not queryable". LangGraph keeps those saves in `checkpointerPromises` and waits for them only at the run's end, so the rejection had no handler yet, and Node 22 exits on an unhandled rejection.
- **Now.** `keepUpWhenSavesFail` logs a lost connection's unhandled rejection as `db.connection_lost` (`unhandled: true`). Checked in a real Node 22 process: with the handler, a save rejected that way left the process up, and the run still saw its save fail when it awaited it later. A `TypeError` rejected the same way still exited with code 1. Node also prints a `PromiseRejectionHandledWarning` when the run awaits the save. pg-pool drops a client that is no longer queryable when it is given back, so the next save gets a new connection.

## The dev stack in one command (2026-10-23)

- **The dev bot had no Mini App.** @TestPatrikBot's menu button was `{"type":"commands"}` (production's: the Quest web app at `mq-v2-agent.fly.dev/glass`): a laptop agent set one only when `MINI_APP_URL` named an https tunnel by hand, and cloudflared was not installed. Chrome loaded the dev extension from a worktree's `apps/extension` (Chrome's `Secure Preferences` keep an unpacked extension's path), so it ran that worktree's code, and would have lost its folder when the worktree went.
- **The tunnel.** `cloudflared-windows-amd64.exe` from `releases/latest` was 55 MB. A quick tunnel gave `https://<four words>.trycloudflare.com` and a registered connection within seconds, and the agent set the bot's button to it at start. Through it, `/glass` and `/i18n/browser.js` answered 200, and init data signed with the dev bot's token for the dev founder loaded `/glass/data` and `/glass/live` (200). `/chrome/next`, `/health`, `/telegram`, `/debug/chrome/read` and `/i18n/../chrome/next` answered 404 from the gate.
- **Chrome reads an unpacked extension's files from disk.** The worker's `fetch(chrome.runtime.getURL("dev-build.json"), { cache: "no-store" })` saw a stamp as soon as `npm run dev` wrote it. A changed `popup.js` was copied and stamped at 08:21:55.4. The extension reloaded itself, seen as the connect tab it reloads on `onInstalled` loading again, at 08:22:00.8. On a revert it reloaded again 4.5 s after the copy, and then not again: the tab stayed put for 32 s after. It stayed paired through both reloads, since `chrome.storage.local` keeps the token.
- **A new folder is a new extension.** An unpacked extension's ID comes from its path. Moving from the worktree's `apps/extension` to `.dev/extension` needed `/connect` once; the new link replaced the old one.

## What browsing costs, a background tab, and several tabs at once (2026-10-23)

- **A page costs about 16 to 25 s and $0.0025 while a model reads each one** (dev, `mq.model_calls` joined to the
  journal, 27 runs in the 6 days to 2026-10-23). Scout runs (MiMo) $0.035 to $0.15 for 22 to 45 pages, 7 to 16 min, $0.0013
  to $0.0047 a page; outreach $0.0022 to $0.0099 a page. A teammate's model call: 31,000 to 37,000 tokens in, 75% cached,
  about 700 out, 15 to 20 s, about $0.0045; a step reads 1 to 2 pages. The model is most of a page's time; the pause
  between pages is the rest. Six days of dev spend: outreach $0.89, manager $0.89 (1,126 calls), scout $0.86, writer $0.31,
  researcher $0.21, explorer $0.18, posting browser $0.14.
- **A background tab acts drawn under CDP focus emulation** (Chrome for Testing 152, raw CDP, the protocol
  `chrome.debugger` speaks; their own tab in front throughout). With `Emulation.setFocusEmulationEnabled`, a background
  tab reported `visibilityState: visible` and drew 61 frames a second (0 without); reddit.com/r/SaaS/new showed 27
  posts and 29,090 characters (3 posts, 4,452 without; a drawn tab 29,901, above); a trusted click
  (`Input.dispatchMouseEvent`) was delivered (not without), and a mouse wheel scrolled a lazy part into view (without, no
  answer in 8 s). `Input.insertText` typed in both. `Page.captureScreenshot` on a background tab answered every other call
  (0.3 to 1.3 s), the ones between hung, with or without emulation. Not measured: the "started debugging this browser"
  bar through the extension. Not used: the founder chose to keep raising the window (below).
- **Several tabs at once, live** (extension 0.12.0 as `npm run dev` copies it, the founder's dev Chrome, the agent's
  debug reader): 20 public pages on 4 sites (5 each of Wikipedia, Hacker News, Reddit community listings, DEV tags), all
  asked at once. With 3 tabs: 20 of 20 in 50.1 s, 23.9 pages a minute; Wikipedia, Hacker News and DEV 3 to 7 s apart,
  Reddit 8 to 13.5 s apart, and the other three sites done by 25 s, so Reddit's pace set the end. With 1 tab
  (`CHROME_TABS=1`, the old global pause): the same 20 in 117.0 s, 10.3 pages a minute.
- **Raising did not draw Chrome behind the Claude desktop app** (Windows 11, the same session): 4 of 4 Reddit reads asked
  drawn failed as "minimised or covered". Their Chrome was not minimised (`IsIconic` false) and the Claude app had the
  foreground: `chrome.windows.update({ focused: true })` did not bring it up. So on Windows a drawn read depends on
  Chrome being visible already. With the switch off (`chrome_front` false), the same three came back from the background,
  2,837 to 6,705 characters, with no attempt to raise.

## The outbox, live (2026-10-23)

Local agent on this branch polling @TestPatrikBot on dev, the founder's dev Chrome with extension 0.12.0, the dev
customer's rest cleared and `INTERN_CREDITS_A_DAY=2000` for the run.
- **A tap with Chrome closed waited, then went.** The founder quit Chrome and tapped Like it on a card for a post in
  r/buildinpublic (draft `0f8f3e61…`). 13:29:49.557 UTC `outbox.queued` (approved `tap`); the toast said it was queued
  and the card showed the waiting line with Skip only. They opened Chrome again, and once it asked for work the
  posting browser opened the thread: three Claude Haiku 5.5 calls (inspect, prepare, publish; 1.7 to 3.2 s each, $0.0073 in
  all), liked at 13:30:36.975 (`drafts.posted`, `alone: false`), `outbox.sent` at 13:30:37.6 and the row done. 48 s
  from the tap to the like, Chrome's restart included. Nothing was said in the chat while it waited.

## The big sites read by code, and judged cheaply (2026-10-23)

The founder's dev Chrome (extension 0.12.0, signed in to X and LinkedIn in Ukrainian and English, not to Threads), read
through the dev agent's debug reader; the dev founder's brief (Messaging Quest).
- **What a search page gives, cut by code**, in a background tab (`visible` false) unless it says drawn. X
  (`/search?q=…&f=live`): 5 posts a page as `article[data-testid=tweet]`, each with its status link around
  `time[datetime]`, `[data-testid=tweetText]`, and its counts in aria-labels in the account's language ("22 Відповіді.
  Відповідь"); 2,924 characters of page text. A drawn read was refused: Chrome was covered. LinkedIn content search: 3
  posts in the background, 6 drawn; its new layout scrambles class names, marks a post `componentkey="expanded<id>
  FeedType_FLAGSHIP_SEARCH"` with its words in `[data-testid=expandable-text-box]`, and gives 1 post in 6 a link of its
  own (`/feed/update/urn:li:share:…`, or a group's `highlightedUpdateUrn`). YouTube results: 19 videos
  (`ytd-video-renderer`). Indie Hackers: search answers 410, "Indie Hackers retired this feature in 2026"; `/newest`
  lists 23 posts (`.story`: title, who, comments, "25m"). Threads, logged out: "No results." Instagram keyword search: 3
  posts, pictures with no words.
- **A sweep from the brief** (`scripts/try-sweep.ts`): 6 searches from one DeepSeek V4.1 Flash call ($0.0001, 3.2 s) and
  4 subreddits; 32 pages in their Chrome (Reddit 14, X 6, LinkedIn 6, YouTube 6, all at once at each site's pace) and 12
  API searches (Hacker News, Bluesky) in 160 s: 223 posts, none already among the customer's finds. Reddit 73 posts,
  done by 160 s (its 8 to 15 s pace set the end); X 15 (2.5 a search) by 66 s; LinkedIn 16 by 96 s; YouTube 8 by 77 s;
  Hacker News 75 and Bluesky 43 by 4.5 s.
- **Judging them** (the 217 within the founder quest's year; 40 a call unless it says 20):
  - DeepSeek V4.1 Flash (the volume seat, cheapest provider): 6 calls, $0.0015 to $0.0019, 5.7 to 8.4 s; 9 to 15 strong
    and 13 to 18 maybe over four runs (two identical runs at 40 a call gave 12 and 13); 1 pick a run dropped for a quote
    that was not in the post.
  - MiMo V2.6 Pro (the scout's seat), 20 a call: $0.0133, 90 s, 2 of 11 calls timed out; 9 strong, 6 maybe.
  - Claude Haiku 5.5, 20 a call: $0.0072, 2.9 s; 7 strong, 20 maybe.
  - Overlap on the same posts: 14 of MiMo's 15 picks were among DeepSeek's 31, and 8 of MiMo's 9 strong among DeepSeek's
    15 strong; DeepSeek was looser (its strong picks included someone building a rival tool and someone asking for a
    feed filter). Haiku and DeepSeek shared 18 of 27 and 31 picks.
- **The writer** for a pick: 3 replies in 12.2 s; across dev's last 3 days a writer call is $0.0045 and 2.1 s.
- **The scout on the same brief**, as a baseline: the 9 runs on dev in the 30 hours before, $0.78 and 91 minutes for
  36 finds (24 strong): a run about $0.087 and 10 minutes, a find about $0.022. A scout model call is $0.0042 and 15.5 s
  on average (193 calls, 3 days). None of its 36 finds was among the sweep's 223 posts.
- **Reading the picks that were only titles** (`--confirm`): Reddit's search gives a post's title, never its words, so
  12 of the judge's picks (5 strong, 7 maybe) were read as threads in their Chrome and judged again on their words: 12
  pages in 216 s (one Reddit page every 8 to 15 s), $0.0002. 3 of the 5 strong held, with a quote from the post; 2 of
  the 7 maybe held; the other 7 were a poll, a discussion, someone building their own tool. So a title is a lead, not a
  find: the sweep reads before it quotes, and the read also drops the judge's loose picks.
- **Set beside the scout:** on this brief the sweep's model calls came to about $0.002 (words $0.0001, judging $0.0011 to
  $0.0019, confirming $0.0002) for 7 strong picks with their own words, plus $0.0045 a reply written; reading took 160 s
  for the searches and 216 s for the Reddit threads (which a sweep can start as picks come). A scout run was $0.087 and
  10 minutes for 2.7 strong finds. Not equal yet: of the sweep's 7 strong, one asked for a feed filter, not posting, and
  one was 10 months old; the scout's finds carry the customer's decisions, which the judge did not get here.

## The first sweep, live (2026-10-23)

The dev founder (brief, quest, Chrome connected), first-use state cleared, on `npm run dev` with step 4's code: the sweep
started on their Chrome's first poll after the agent came up (`broker.whenOnline`).
- **One sweep:** 8 searches from one call and 4 communities; 48 pages in their Chrome (Reddit 28: 16 searches and the 12
  picks that were titles, read as threads; X 8; LinkedIn 8; YouTube 4) and 16 API searches (Hacker News, Bluesky): 227
  posts in 406.7 s (6.8 min, set by Reddit's pace; a Reddit page took about 110 s from queued to read, waiting its turn).
  One Reddit search came back `unavailable`. Model calls $0.0036 in all: the words, 6 judge calls of 26 to 40 posts while
  it read (5 to 17 s each), and one on the 12 threads read (3 strong, 1 maybe held).
- **What it kept:** 11 finds, 6 strong: 3 Reddit (each with its thread's `t3_` id, quoted from the thread), 3 Hacker News;
  5 maybe (Reddit, Hacker News, Bluesky). None from X, LinkedIn or YouTube, though X and LinkedIn searches worked (so
  their Chrome is signed in there, kept as a fact). Some were old: the APIs' posts are not held to the month, only to the
  founder quest's year.
- **The chat:** one line, redrawn in place, ending "✅ Read Reddit, X, LinkedIn, YouTube, Hacker News, Bluesky in 7 min.
  Pages: 48, posts: 227, worth answering: 11. The best first:", and right under it Take 1 on the newest strong find (r/
  Solopreneur, two days old). The manager woke on `first_sweep`, started the scout and the explorer, and wrote nothing.
- **The take's words named the product:** told to stay plain (the warm-up: 3 of the first 5 things on Reddit, and a first
  word to them), the writer still opened "I'm Serhii, I make Messaging Quest", as the brief says their messages name them.
  The plain instruction now says it holds even then, and a take that still names the product is written once more with
  that said outright. Three takes on the same finds after: none named it (2.4 to 5.3 s each).
- **Again, with the fix** (the same founder, the 11 finds from before left out as known): 48 pages, 276 posts in 392.8 s,
  $0.0035; 13 new finds (7 strong). By source, posts found and finds kept: Hacker News 89 and 5, Reddit 79 and 5,
  Bluesky 59 and 3, LinkedIn 21 and 0, YouTube 17 and 0, X 16 and 0. Take 1 answered the r/Solopreneur post again, plain
  ("You don't need video to start. If text is what you're good at, stick with it…"), under "u/redditor_b".
- **The takes, tapped** (the founder, the same evening): Take 1 "🧊 Less salesy", Take 2 "🤙 More casual", Take 3
  "✂️ Shorter", each 7 to 23 s after the last; each fix moved to the next real post from the sweep (u/redditor_b,
  u/redditor_c, u/redditor_d, u/redditor_e). Take 4 waited since.

## Your move, live (2026-10-23 and 24)

The dev founder on `npm run dev` with step 5's code, Take 4 waiting on them.
- **Held for the first-day cards, a promise broke:** while Take 4 waited they wrote "New post on x, smth like: …"; the
  manager drafted it and said "Your X post is on a card, your words exactly as you wrote them. One tap and it's up", and
  nothing came, since the deck then waited for the first-day cards, and a draft no longer has a card of its own. Before
  the deck only finds waited for them (`FindService.show`), and that is again the only hold. (Their "Publish a promo video
  on my Instagram" in the same hour went up on their words, with no card: a Reel at instagram.com/p/De2KmqFOk8_/.)
- **The first deck:** 25 asks, all cards from before the deck: 10 replies (Reddit, X, Indie Hackers), 3 finds, their X
  post, 2 profile changes held as uncertain, 4 more profile changes, and 5 likes and follows on 3 platforms (one each,
  so no group). One message (Telegram took the HTML, the buttons and the button to their page at once), opening on the
  X post, 14 of 25, since it joined last; by rank the line starts with the 10 replies.
- **Noted twice:** the first draw noted all 25 in the transcript again, which would have filled the 16 lines of the chat
  the manager reads; an ask that had a card of its own is no longer noted (its card was), and the 25 rows were deleted.
- **The laptop asleep overnight:** the dev agent stayed up and logged its database and Telegram calls failing
  (`getaddrinfo ENOTFOUND`, `fetch failed`) at each wake of the network, about every two hours, and nothing else.

## The opening, live (2026-10-24)

The dev founder, from nothing (his account set aside, a new customer on the same Telegram), Telegram language Portuguese.
- **What he saw, in order:** /start, the choice of four quests (a card of four titles and pitches); a tap; then, at once,
  Chrome's install steps (English, only the two buttons in Portuguese: the long text matched no catalog key); then, last,
  "tell me what you work on" in Portuguese. The manager called `connect_chrome` on its very first turn, before asking, and
  `connect_chrome` sent at call time, ahead of the turn's own reply. The ask came 5 s after the setup text, and he typed
  "messaging.quest"; "Say again" at 09:03 brought the setup a second time. After the sweep and the takes, the questionnaire
  (goal, stage, ...) came as taps, eight of them, though everything it asked was in his first words and the brief.
- **His note:** "It chose my system language for the questions, but the chrome installation instructions are in English.
  I'd prefer English and selected that in the mini app, but it didn't change anything": the page's picker is the shared
  one (`packages/i18n/src/browser.js`: localStorage and `?lang=`), which says "language preferences never cross surfaces",
  so it never reached `mq.customers.language`.
- **The page, 2026-10-24:** its Log tab was 43,700 characters, 300 rows and 34,000 px tall for one evening's work; Memory
  8 sections, Settings 5, Now 5 and a graph. The Your move buttons answered an error for him: `/glass/act` was not on the
  tunnel's list (`MINI_APP_PATH`), so the tunnel answered 404 and the page said "Could not do that." The agent never saw it.
- **Pattern keys eat a whole message:** `systemMessage` turns a catalog key with a placeholder into a regular expression
  anchored at both ends, and `{name}` matches newlines. "Hi {name}." matched "Hi Dana.\n\nTell me what you're working on…"
  whole, so the greeting was translated and the question after it, taken for a name, was not. A message made of
  paragraphs where one is a pattern is translated paragraph by paragraph (`forLanguage(language)(…)`) before it is sent.
- **The first reply, with the real manager model** (`scripts/try-first-run.ts`, `lang:auto` then their words): told to
  call `connect_chrome` and say "the steps are below", DeepSeek V4.1 Flash answered "Sent. Waiting on the Chrome
  connection to start reading." until the tool's result said what the steps are and asked for the reply itself ("Queued:
  … go out right under your reply … Now write your reply: a line or two, like a person texting"); then "Got it: an
  agent that finds your first customers from your own Chrome, launching tomorrow, and you want to be seen on X, Instagram
  and YouTube. Reading messaging.quest now, and I'll need your Chrome connected to search where your people are." The
  event that carries their first words said "(Their quest, read from these words: Founder/CMO Quest ...)", and the reply
  began "Founder quest it is": it now says not to announce it.
- **A video he sent:** 36 s of voice (heard, Whisper 2.5 s, $0.0001), then a video: the manager was told "(They sent a
  video. Quest can't watch it ...)", said it "did not arrive as a file", asked for it as an attachment, then for a link;
  `make_video` answered "too big" for the clips (Telegram's cloud Bot API lets a bot download 20 MB and send 50 MB). He asked
  for any video up to 1 GB, cut with ffmpeg and Remotion. Not done here: it needs the file to reach the agent
  (a self-hosted Bot API server, `--local`, 2,000 MB, or an upload from the Mini App), the speech heard with timestamps for
  subtitles, and a render.

## Videos the founder gives Quest (2026-10-24)

The founder, 2026-10-24, after his first live run: "I sent a video to the bot and it said I have to send it as a file; after I did that, he said the file is too big to process and generated a simple text video instead ... The bot must be able to process any video I send below one GB; and be pro with ffmpeg and remotion." Measured on this laptop (Windows, 8+ cores), in WSL Ubuntu with the Linux ffmpeg 7.0.2 the image gets (pinned to one CPU with `taskset -c 0`, as a Fly shared-cpu-1x has one), and with OpenRouter's Whisper.

- **Why it failed.** Telegram's cloud Bot API lets a bot download 20 MB (`getFile` answers "file is too big" above that) and send 50 MB. A video sent as a video or as a file hit the same limit. `inbound-service.ts` told the manager "Quest can't watch it", so it asked for "a file", then for a link, and `make_video` refused clips over the 8 MB a post attaches.
- **How a big file gets to the agent: the Mini App's upload page** (the founder picked it over a local Bot API server, 2026-10-24). A local server (`--local`, files to 2,000 MB) needs an api_id and api_hash from my.telegram.org, the bot logged out of the cloud API first, a build with no Windows binary, and, in production, a separate always-on machine: the agent's own machine suspends when idle and gets its Telegram updates as webhooks that wake it, while a server inside that machine holds an MTProto connection nothing wakes, and its files would sit on that other machine. The page sends the file to the agent in 8 MB pieces (`PUT /glass/upload/<id>` with `x-offset`, signed `Authorization: tma <init data>`), so no proxy sees more than 8 MB a request (a free Cloudflare tunnel stops a request at 100 MB), and a dropped piece is asked about again: the answer is how many bytes the file has.
- **Whisper through OpenRouter gives word times.** `POST /audio/transcriptions` with `response_format: "verbose_json"` and `timestamp_granularities: ["word"]` on `openai/whisper-large-v3-turbo` answered a 40 s clip in 2.3 s for $0.00013: `text`, `language`, `duration`, `usage`, 92 `words` each with `start` and `end`, and `segments`. It kept "Um." and "Uh." in the text, which is what a filler cut needs. Some providers and models (gpt-4o-transcribe) refuse `verbose_json` with a 400; a request is capped at 25 MB multipart and providers stop at 60 s of work, so the sound goes in 5-minute pieces (mono, 16 kHz, 32 kbit/s MP3: 1.2 MB each).
- **A word's end runs past the sound.** Whisper ended "best." at 14.91 s where `silencedetect` (-32 dB, 0.35 s) heard the quiet start at 14.72 s, so a pause measured from the words was 0.49 s where it was 0.8 s. Pauses are cut from the sound; a word whose middle falls inside a quiet stretch splits it.
- **Reading a video.** ffmpeg-static has no ffprobe: `ffmpeg -i file` prints what is needed (length, size, rate, sound, and a phone's turn as `displaymatrix: rotation of -90.00 degrees` or the older `rotate` tag). One pass over the sound (`silencedetect` and `loudnorm print_format=json`) took 1.7 s for 40 s. Nine seeks (`-ss` before `-i`, one frame each) tiled into one JPEG took 2.1 s; the vision seat (Haiku 5.5) read it in one call, down to "a synthetic test pattern", and the question asks for the speaker's face as `FACE_X: 0..1`, which sets the crop. Whole reads: 40 s clip, 20 MB: 4.7 s; 200 s of 4K, 860 MB (460 words, 109 pauses): 15 s. Uploaded through the page in the browser pane, the 860 MB took 108 pieces and 11 s on loopback.
- **Cutting.** One graph: the source decoded once (`fps=30`, a 4K picture made 1080p first), `split` to one branch a kept part, each `trim`med on whole frames with 12 ms of fade on the sound, every other part zoomed 14% and cropped round the face, `concat`, the cutaways overlaid with a fade, the cards (gradients with words), the captions as one ASS script. A 40 s test talk with 3 fillers and 6 pauses came out 30.4 s; its sound measured -15.8 LUFS after the gain. Captions are one event a word (the whole phrase, the spoken word in yellow), the first of a phrase popping in at 86%.
- **Time.** 60 s of the 4K source, 45 s out, on one core of this laptop: 109 s (2.4 s of work per second out); the Linux binary on one CPU: 25 s out of 4K in 75 s (3 s a second), 40 s out of a 1080p vertical source in 40 s. A Fly shared CPU is slower than this laptop's, and throttles. The 5-minute run limit of a montage became 20 minutes for a clip.
- **Memory is the risk.** Linux ffmpeg 7.0.2 on one CPU, 40 s of a 1080p vertical source cut in 29 parts: 473 MB with `loudnorm`, 250 MB without; the same on the 4K source: 594 MB (437 MB without; 1,243 MB once, with the captions off, so it varies with how the threads run). Plain decode, scale and x264 `veryfast` is 129 MB. `loudnorm` held 150 to 250 MB, so the sound is brought to -16 LUFS by a gain from the loudness the reading measured, and a limiter (`volume`, `alimiter`); `loudnorm` only when the source was never measured. The agent is about 250 MB of a 1 GB machine, so a render starts only when 600 MB is free, and is otherwise told to ask again in a few minutes; production's machine has 2 GB (`fly.toml`'s `memory`; Fly suspends machines of up to 2 GB, and a volume does not stop a suspend) and a 10 GB volume `mq_uploads` at `/data` for the uploads (2026-10-24; about $1.50 a month, `fly volumes extend` grows it, never shrinks it). The `clip_readings` migration is on production too.
- **Fitting a post.** The poster attaches up to 8 MB (`ATTACH_MAX_BYTES`), which holds 76 s of portrait at 720x1280 (it needs 0.7 Mbit/s of picture or more), 120 s at 540x960 and 190 s at 360x640; past that the manager is told how many seconds fit. `size chat` allows 45 MB (Telegram takes 50) for a video they post by hand. A 73 s cut of the 4K source came to 7.4 MB.
- **Remotion, measured and not used.** Licence: free for an individual or a for-profit of up to 3 people, commercial use included; from 4 people a Company License: Automators (an app that renders videos) $0.01 a render with a $100 a month minimum, Creators $25 a seat, Enterprise from $500 a month; its licence "will change slightly in Remotion 5.0". Cost: Chrome Headless Shell is 113 MB to download and 270 MB on disk, bundling took 34 s, and a 5 s 720x1280 kinetic caption composition (spring pop, a moving gradient, 150 frames, one tab) rendered in 44 s on this laptop at about 3.4 frames a second, with a peak of 1,273 MB across the render's Node process (915 MB) and Chrome. That does not fit beside the agent on a 1 GB machine, and on a shared CPU it would take minutes for seconds of video. What ffmpeg and ASS do already (words rising in, the spoken word lit, cards on moving gradients, cutaways) covers the founder's use; Remotion would earn its place for charts, logo animation or per-letter effects, on a separate machine started for the render (Fly's Machines API), not as an errand.
- **A path too long for Windows.** Remotion's browser downloaded into a path of 240 characters and `chrome-headless-shell.exe` was never there (ENOENT) until it was installed in a short folder.

## Outreach by code (2026-10-31)

The dev founder (@theIcreator, his X in Ukrainian), this branch's agent on dev polling @TestPatrikBot, the founder's dev
Chrome with its window covered (so every read was a background one). The day's 400 pages were spent by 20:00; the count
was set back to 0 by hand (a patched copy of the dev extension's worker, loaded once and put back). The same play, run the
old way and the new way: the old runs are the five outreach runs on X the manager started earlier that day, and the
new runs are two of them queued again with the same instructions. Costs are each task's `mq.model_calls`
(the teammate, and for the new way the finder's words and the judge); the writer's calls carry no task id in either way,
and come to $0.0042 a reply (Claude Sonnet 5.5).
- **The old way**, five runs: 191 steps and $1.108 for 11 drafts (8 replies, 3 likes): $0.101 a draft, $0.139 a reply.
  A step was 39,000 to 50,000 tokens in, 65 to 77% cached, about $0.0058. 925296cd ("founders who just shipped, one
  question each"): 46 steps, $0.2311, 950 s; 14 `browser_open`, 19 `browser_act`, 3 `search_posts`, 2 `read_site`; 3
  replies drafted, and 3 Likes pressed with `browser_act` and no draft (`SOCIAL_ACTION` knew English words only). The
  others: 29 steps and 49 searches, 36 steps and 86 searches, 40 steps and 20 opens, 40 steps and 23 opens for 1 like.
- **The new way, 925296cd's play again** (3633218d): 8 steps, $0.0214, 500 s, for 6 drafts (3 replies, 3 likes): $0.0036
  a draft, $0.0071 a reply; 10.8 times less than its old run, 28 times less a draft than the day's old runs.
  - `find_people`: one call, 163 s and $0.0006 (search words $0.00007; 9 judge calls on DeepSeek V4.1 Flash, about
    1,200 tokens each, $0.00054). 7 X searches (4 to 6 posts each in a background tab), 9 picks' posts read before their
    quotes were used, 16 pages; 5 picks given, 4 dropped once read; stopped at enough.
  - Then the teammate read the 5 profiles in one step (one X page at a time at X's pace: 48 s) and 4 of their sites
    (`read_site`, 2 pages: 6 pages), and drafted. 27 pages in all, against 38 opens and acts plus searches the old way;
    no search page reached the model, and a profile came as about 1,000 characters (its header, then its pinned and
    newest posts) against a 1,670-character page.
  - A step was 26,090 tokens in on average, 73% cached. MiMo's 4 steps were 13,400 to 20,300 tokens (the first,
    uncached, 71 s with 2,292 reasoning tokens, was $0.0079 of the run's $0.0208). Its fifth call stalled at 90 s and the
    run went over to Claude Haiku 5.5 for good (`stickyFallback`): on its own tokenizer 34,000 to 36,400 tokens a step,
    the first writing 34,110 to the cache ($0.0055), the next three reading 97 to 99% of it.
- **Who it picked and what it wrote.** The check kept 3 of the 5: @maker6 (launched his first SaaS two weeks before,
  $0 MRR, building Exy; murmurs.im), @maker5 (building Oro, an AI fashion SMS agent, in public from day one) and
  @maker7 (day 9 of 100 on ListSprint, for Etsy digital sellers, $0 MRR), all posted in the day or two before. It
  skipped @maker8 (no site; his last posts a UGC creator ask and a joke) and @maker9 (a lead-gen agency's
  tools). The replies: "what made exy the one you can't stop thinking about, over murmurs?", "what do people text oro
  for most so far, the picks or the styling", "is the low activity mostly people never starting, or people starting
  and then dropping off?". Each asks about their own product, from their post and their site, lowercase, under 20
  words, no pitch or link, as the play asks; the old 925296cd's three were of the same kind ("does the mascot layout
  hold up on small screens? ..."), and the day's first old run's two were the congratulations the play rules out
  ("congrats on the launch. ..."). The founder posted the @maker5 reply with a tap 10 minutes later. Its report
  said "I ran one X search" where the tool had said 7.
- **The play told how to search** (4da59335's again, 16e0da6b): its instructions say "Search X (latest) ..." and "Check
  x.com/theIcreator/with_replies first", and the model did that and never called `find_people`: 3 `search_posts`, 2
  `browser_open`, 9 `read_page`, 5 `read_site`; 12 steps (5 MiMo, 7 Haiku after a stall), $0.0354, 672 s, for 4 drafts
  (2 likes, 2 replies; a second reply under @maker5 refused by one-reply). Its old run: 40 steps, $0.2383, 578 s, 1
  like. So the cut pages and the prompt alone were 6.7 times less a run. Hence `finderFirst`: with `find_people` there,
  `search_posts` on a source it covers and an X or LinkedIn search page in the browser are refused in code.
- **The same play with `finderFirst`** (2aed119e): 21 steps, $0.0692, 672 s, no drafts (its old run: 40 steps, $0.2383,
  1 like). It called `find_people`, twice in one step with two wordings, and both found nobody: 4 searches, 9 posts
  judged, no picks, $0.0002, the run's empty-search count spent between them. The route was already marked spent in the
  manager's plan, and its old run had found nobody to answer either. Its search for "from:theIcreator filter:replies" was
  refused. The steps went to the instructions' "Check x.com/theIcreator/with_replies first": 12 steps of opening and
  scrolling the customer's replies tab before `find_people` (20,000 to 33,000 tokens a step; folding a page broke the
  cached prefix twice), and 8 after it on whether his reply to @maker5 showed, one of them missing the cache
  ($0.0153). Since: `find_people` calls in a run go one at a time, and the prompt says one `read_page` of their replies
  page is enough and that after "nobody" it reports (neither run live yet).
- **Trust came during the test.** That tap was his third approved X reply, so replies on x.com went up by themselves
  from then on: the second run's reply to @maker10 went up on trust at 20:56. Its reply to @maker11 was queued on
  trust; it was dropped from the outbox by hand (row 37) before it went, so its card waits for his tap.
- **X in a background tab.** A thread showed its own post and not one reply in 10 s (one `cellInnerDiv`), with 12
  replies under it; drawn, the read failed as covered. So a pick's replies are not seen there: "already answered" comes
  from the drafts and finds on record. A profile showed its header and two posts. X draws a link in a bio as "http://"
  and its host apart.
- **What a page costs a model now.** An X page read with `read_page` is its posts as rows; an X search or profile opened
  in the browser keeps the text above its posts (at most 2,000 characters) and gives the posts once, as `items`, where
  the whole page was up to 24,000 characters before; `read_site` pages fold like the others past `KEEP_PAGES` (2,
  unchanged: with 1, a profile folded while the model was drafting to that person).

## Founder openers with ask links, live (2026-11-01)

The dev founder, this branch's agent on dev, the play: a founder who just shared what they built gets a short opener with
two threads where people ask for exactly that, and a question about their product; nothing of Messaging Quest.
- **What went up.** 10 openers with links: 3 on X (09:04 to 09:05, W0iIet, OddEggsStudio, savvie_app) and 7 on Reddit
  (10:27 to 10:47), with 7 X likes and follows and 8 Reddit upvotes and follows around them. A fourth X reply
  (saurabhkals) is held as uncertain.
- **Reddit took 5 of the 7 down within 15 to 35 minutes**: all 4 in r/SideProject and the one in r/iosapps. Read as a
  visitor, the r/iosapps thread shows "[deleted] · 21m ago · Comment removed by moderator" where the reply was. The ones in
  r/arcmoi and r/droidappshowcase were still up at their first look. Each carried 2 links to other Reddit threads.
- **YouTube.** The poster (Claude Haiku 5.5) stopped twice before typing an approved comment with two Reddit links, calling
  it promotional and the "i'm an ai agent" opener a misrepresentation, the second time with its prompt saying the words
  were approved and the checks passed.
- **Reddit's check.** After the day's reading (the 400 pages were spent by about 09:15 UTC), Reddit showed a reCAPTCHA in
  the customer's Chrome; replies still went up through its form.
- **A run's summary.** Counted with whole pages, a Reddit run passed `SUMMARIZE_AT_TOKENS` at 21 pages while its model
  saw 48,000 tokens; the summary that replaced its brief kept the ask links as ids ("r/SavingMoney 1xkky1y"), and the run
  drafted nothing. Pages now fold before the summarizer counts them, and its prompt keeps addresses whole.
- **A brief from memory.** With chat lines cut at 300 characters in the briefing, the manager rewrote a stalled run's
  brief with four founders on one post's address and seven ask threads nobody had sent. Their messages now go whole (up
  to 2,000), and a brief with an address the turn did not read is refused.
- **Cost.** The day's model calls for this customer, 06:00 to 10:50 UTC: $1.78 (outreach runs $1.16, manager $0.24,
  writer $0.18, poster $0.12, scout $0.07, finder and judge $0.01).
- **One template, one pair of links.** Five of the seven Reddit replies opened "not a human here, i'm the ai agent a
  founder runs. found two people asking for …", from the founder's ask for a bold, openly-AI opener that the writer
  followed (its rules allowed it then); the same two r/SavingMoney and r/PersonalFinanceCanada threads went to eight
  people across Reddit, X and YouTube, and the Reddit ones went up 3 to 4 s apart on their word. The founder: "that is
  awful and exactly what gets the account banned on reddit; by being blunt, I meant to be more authentic". Now the writer
  never says it is an AI or a bot (a sentence that does is cut), sees how its last 30 messages opened and which links
  went where, and every send on a site waits `SITE_GAP_MS` after the last, a tap's too. The real writer (Claude Sonnet
  5.5) on three such drafts, with the old ask still in their messages and a note "keep the ai agent opener": no AI line,
  three different openings, and the links already handed over left out.

## Dev on the Claude subscription: the local Whisper (2026-11-03)

`MODELS=claude-cli`'s voice, on the founder's laptop (Intel i5-8365U, 4 cores, 16 GB), transformers.js 4.3.2 on the CPU, two
synthesized voice notes as Telegram sends them (ogg/opus): English, 10.6 s, and Russian, 8.2 s.
- **transformers.js takes every recording for English** unless told ("No language specified - defaulting to English"):
  the Russian one came back translated, and its word-timed pass looped to 444 words. The language is now read first, from
  one step of the model (the likeliest language token after its start): en and ru, both right.
- **Whisper Large V3 Turbo is too heavy for it.** Every recording is read as a 30 s window, and its encoder takes about 20 s of
  this CPU per window whatever the build: fp16 encoder 48 s for the English clip, q8 41 s, plus 22 to 42 s to read the
  language; 4.4 GB resident. The words were all right.
- **Whisper Small** (`onnx-community/whisper-small_timestamped`, encoder fp32, decoder q8, 490 MB fetched once): the language
  in 5 to 6 s, the words in 7 s, each word's time in 10 to 12 s, both clips word for word, punctuation included. With the
  laptop 35% busy elsewhere: 17 s for a voice note, 22 s with each word's time, after a 13 s load at start.

## Dev on the Claude subscription: a whole first run (2026-11-03)

`MODELS=claude-cli npm run dev`, a fresh first run on @TestPatrikBot in Telegram Web (invite, language, what they build,
Chrome, the sweep, the takes with a note, "That's me", Your move, a progress question), on the founder's Claude Max login.
All 75 model calls in `mq.model_calls` were `claude-cli/…` at $0 (the sweep's own row names no model), none went to
OpenRouter. Median and 8-in-10 per call, the CLI's start (about a second) included:
- **manager** (Haiku 5.5): 11.1 s and 13.7 s; 47k tokens in, 34k of them read from the cache, so the standing prompt holds.
- **scout, explorer, outreach** (Haiku 5.5): 9 to 16 s, 14 to 21 s; 19k to 25k in, a third cached.
- **judge** (the sweep's batches, Haiku 5.5): 19.6 s and 22.2 s, 3k tokens out each. The sweep took 7 min (48 pages, 156
  posts, 13 finds).
- **writer** and the takes' reflection (Sonnet 5.5): 4.9 s and 5.5 s.
- **Claude 5 models think when told not to**: a manager step with `thinking: disabled` came back with thinking blocks, so a
  seat with reasoning off now runs at effort low.
- **An answer can come in two**: one manager step made two requests in its CLI turn (twice the tokens, 83k), the first with
  nothing said, and keeping that first one lost the reply to "how's it going so far?" (a 👀 alone). The first answer that
  says or calls something is now the one (`claude_cli.passed_over` when one is passed over).
- **Then on Opus and Sonnet** (dev's default since the same day, the founder: "sonnet and opus, no haiku"): the manager on
  Opus 5.5 took 9.9 s, 6.2 s and 7.1 s for a turn's three calls, and the scout and explorer on Sonnet 5.5 6 to 7 s a step,
  no slower than Haiku had been (a few calls only, at effort low). In `scripts/try-claude-cli.ts`: Opus writing 4.5 s, an Opus
  agent step 4 to 5 s, Sonnet's structured output 5.4 s.
- **A union at the top of a tool's parameters**: `browser_act` and the poster's `prepare` take one shape per kind of
  action (zod's `discriminatedUnion`, JSON Schema `oneOf` with no `type`). The CLI left them out of the tools it offered,
  so on Claude no run could click, fill or scroll, and the poster gave up five times on X and Instagram ("the fill/prepare
  tool isn't available"; one post went through when Sonnet called `prepare` unoffered, from its prompt). As structured
  output the same schema failed outright: `API Error: 400 tools.1.custom.input_schema.type: Field required`. Merged into
  one object (`oneObject`: every field, `kind` as an enum, each shape in the description) Sonnet filled the reply box
  first time, on both paths. OpenRouter's models never minded the union.

## Threads likes, in the founder's dev Chrome (2026-11-04)

Every like on Threads had ended held ("I can't tell if it went up"). Looked at with `/debug/chrome/browse` (a session's
view, drawn, as the poster sees it), extension 0.12.0 then 0.12.1:
- **A heart with likes is named by its count.** A post's like button holds the heart's picture (`svg aria-label="Like"`,
  "Unlike" once liked) and, once anyone liked it, the count as its text. The extension named a button by its text first,
  so the post's own heart read "2" and the replies' hearts (no count) read "Like": the poster, pressing what reads as a
  like, could press a reply's, and no "Unlike" ever showed for the post. From 0.12.1 a count alone is named after its
  picture: "Unlike 3", "Reply 3", "Like".
- **No post was an item.** Threads draws posts as `div[data-pressable-container]`, one per post and reply, none inside
  another (13 on a post page), not `article` or `listitem`: no control carried `item`, so a Like could not be told by its
  post. From 0.12.1 they are items: on simonweniger's post, #0 the post with "Unlike 3", #1 the founder's reply, #2 the next.
- **The 09:30 like had gone through**, on the right post (2 likes, then 3 with "Unlike"): only its receipt was missing.
- **A post address can open the profile.** threads.com/@a.webstudio/post/DfT3Nq0jQ1c, read by an outreach run at
  07:27 and drafted to (a like and a reply, quoting two of the profile's posts), opens the author's profile, logged in;
  logged out it asks for a login. `read_page` had filed the profile's words under the post's address, so the drafts passed
  the read check. From now on a post address that lands elsewhere is not filed (`elsewhere`, `tasks/researcher.ts`).
- **A tab closed under a post.** A model step of 132 s (Sonnet on the CLI) passed the extension's 90 s idle close
  (`IDLE_MS`): the next step met "The browser session expired" and the like was held. Since 0.12.1 an open session keeps
  Quest's tabs for 5 min (`SESSION_IDLE_MS`).
- Logged out, Threads' icons carry no names at all (`svg aria-label=""`).

## The dev Mini App's address across restarts (2026-11-04)

The founder: "Dev mini app is not accessible". Everything answered from the laptop (the tunnel's `/glass` 200, the bot's
button on the current address, the chat's own button `default`), and the Mini App opened in Telegram Web once that tab
had been reloaded: the stack had been restarted about 15 times that day, each start a new quick-tunnel address, and a
client that was not connected when a new one was pushed (`updateBotMenuButton` reaches only a connected client) kept an
address whose tunnel was gone.
- **A detached cloudflared ended with the stack.** Spawned with `detached: true` (Node's DETACHED_PROCESS, outside
  libuv's job), it still died when the background shell running `npm run dev` was stopped: that stop ends the whole tree
  of processes by their parents. One started through `cmd /d /s /c "start "" /b …"` outlived it (its parent, cmd, is
  gone at once). Node's own quoting of start's empty title (`"\"\""`) left a cmd waiting, so the line is written out
  with `windowsVerbatimArguments`.
- **Its output is lost through start**: stderr handed to cmd did not reach the file; cloudflared's own `--logfile` has the
  address and "Registered tunnel connection".
- Kept: a stop and a start later the address was the same (`cst-permissions-plan-locate`), Cloudflare answered 502
  while the agent was down (530 when the tunnel itself is gone), and the Quest button in Telegram Web opened it.

## Writing, LinkedIn, YouTube and the night, measured (2026-11-05)

- **The template, in numbers.** The dev founder's last 49 replies: 21 words on average, 92% with an emoji, 57% opening by rating
  the thing ("X is a Y"), 2% under 7 words. His voice rules already said one sentence, and two words and an emoji: a model
  told to vary settles on one shape. The same 30 real posts written again on Opus 5.5 with a shape drawn in code
  (`TRY_RECENT=30`): median 17 words down to 7, under 7 words 3% to 33%, two sentences or more 13% to 0%, rating it 47% to 0%. Emoji
  stayed at 63% on the model's word alone, so that is drawn too: 20 more, with the draw, 95% down to 20%, rating it 45% to 5%.
- **LinkedIn's "uncertain" likes were never pressed.** Opened and pressed at once, a Like answers in 1.9 s and reads
  "Reaction button state: Like". Pressed 9 s after a page opened, the extension answers "The page changed": LinkedIn redraws
  a page it just opened. Once settled, a ref holds past 9 s (probed with `scroll` on a ref, which goes through the same check and
  presses nothing). The poster marked the send attempted first, so a press that never happened was held.
- **A background tab's load event.** LinkedIn and YouTube reads took 40 to 55 s, and a session's opening 42 to 46 s, waiting for
  Chrome's "complete" with the page there long before. A YouTube video could also open with 12 characters of text and the last
  video's title, its page not yet drawn. With the page's words counted from 6 s on (extension 0.12.5), the same openings took 5 to 6 s.
- **A YouTube channel subscribed to** shows no "Subscribed" control to the extension, only its bell: "... your notification setting for ZazaG Dev".
- **YouTube's comment box** keeps "Test words with an emoji " for "Test words with an emoji 🔥": the emoji becomes a picture, and
  the box's value drops it.
- **Working at night.** The laptop here is Modern Standby only. Its log for the night of 4 to 5 November: lid closed 21:46 UTC, Modern
  Standby, hibernate 23:29, network gone; Quest had also been switched off from the page at 19:25, and the Claude limit hit at 19:20.
  No code held the work. Windows' timeouts: sleep after 2 h on power, 1 h on battery. Its lid action is the owner's to set
  (`powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0`, then `powercfg /setactive SCHEME_CURRENT`). Whether
  `keepAwake` holds a whole night is not measured yet.
- **A stall, not explained.** 20:52 to 20:57 UTC: Chrome answered nothing while vitest's 70 workers and a script's Opus calls ran on
  the same laptop, and a Threads post failed on its step. Nothing like it without that load. The extension's front lock had no limit, so one hung
  step could hold every drawn step; it now has one (`oneAtATime(45000)`).


## One browser task at a time (2026-11-11)

- **Why it idled.** Night of 10 to 11 November, dev: the Claude subscription's limit hit at 21:17 UTC and was over at 22:00. In those
  43 minutes `claude_cli.limit` was logged 283 times, 12 runs failed on their third try and 13 sends failed as "could not prepare".
  Every platform then had two failed runs, so the rotation rested each 12 hours: no run started from 21:46 to 05:38, with their
  Chrome open the whole time (the reply watch read on until 03:55).
- **Before, same night, 20:04 to 21:17:** 25 reads failed, 16 of them LinkedIn pages that waited 5 minutes for the site's turn
  behind a run's session; 7 likes already in place on Instagram and Bluesky ended as "could not prepare".
- **After** (the front held by one session, one run at a time, the outbox one site at a time), 06:17 to 06:34 UTC on the dev
  customer: work in every minute; 12 of 12 sends up on LinkedIn, X, TikTok and Bluesky (replies, likes, follows), no read failed,
  no post gave up. X's reply, two likes and a follow went 06:22:46 to 06:24:31, then LinkedIn's reply and four likes 06:26:41 to
  06:30:54. A like takes the poster 30 to 70 s.
- **Tabs.** `chrome.tabs_open` went 5, 4, 2, 1 as sends ended, and 0 at 06:24:31 between two sites (Chrome drops the group with
  its last tab), then 1 and 2 while a send and a run's reading were at work. Closing on `/off` is not tried live yet.
- **What works, read by a run in 3 minutes:** LinkedIn 213 impressions in 7 days (up 101%), Threads 2,192 views and 4 clicks to
  the site in 30 days, X's analytics behind its paid plan.
- **Two dev stacks.** A second `npm run dev` from the same worktree restarts its agent in a loop on the taken port, and each start
  takes Telegram's polls from the first (`telegram.poll_failed`, 409). Stopping its process tree also stopped the shared tunnel.
- **A sign-in wall, before and after.** The Mastodon reply (mastodon.example.net, invitation-only) took the poster about 2 minutes
  to give up as "could not prepare", four times over two days. With `signed_out` it ended in 17 s as `login`, and the chat said their
  Chrome isn't signed in there.
- **Instagram likes.** One already on (tidy_up_ltd) failed five times as "could not prepare" and now closes as done. One on a comment
  (tictactoe.squared): the poster pressed the comment's heart, the page then had two controls reading "Unlike", and the check, which
  kept each reading once, held it as never seen; counted each, it is seen.
- **vitest and Chrome.** The full suite (70 workers, about 2 minutes) run while dev works stalled their Chrome again: a page open
  timed out at 90 s and two sends failed as offline. While dev runs, run only the test files a change touches.
- **Mastodon from their own server.** With their account kept as a memory (mastodon.social), the same reply opened at
  `mastodon.social/authorize_interaction?uri=…`, which lands on `mastodon.social/@someone@mastodon.example.net/<id>` with a
  composer, and went up in about 90 s. The poster's own check that a send stays on the draft's site refused the first try; the site
  it holds to is now the one it opened.
- **Tabs they saw.** Four Instagram tabs and a second "Quest" group with one Indie Hackers tab: a reading tab per poller (three) and a
  session's, each kept 3 minutes, and a group the extension forgot when it reloaded. With one reading tab a site, 45 s, the poster
  always closing its tab and stray groups closed: 3 open at most over five minutes of sends, 0 after the last.
- **An hour of it** (07:23 to 08:23 UTC, dev): work in all 60 minutes, 30 of 36 sends up, 4 held as never seen landing, 4 Quest tabs
  open at most. Two faults of the change itself: a post of their own was drafted in words alone for Instagram and for TikTok, which
  take a picture or a video; and LinkedIn's likes, now seconds apart, used up its 12 pages of ten minutes, so 7 reads of a run waited
  5 minutes and failed. The rotation writes own posts only where words alone go up, and a page opened to post no longer counts as read.

## Widgets (2026-11-12)

Telegram's Bot API 10.4 (2026-11-09) lets a bot send a widget: https://core.telegram.org/bots/widgets, read in full.

- **What it is.** A message, not a home-screen widget: one HTML document (32768 bytes, 4096 after zlib level 9) drawn
  in the bubble by the app in a QuickJS sandbox with no network. The only control is `<button>`; nothing can be typed.
  200 to 600 px wide, 50 to 600 px high, nothing scrolls. Its code never changes after sending.
- **State.** `chat_data` and `public_data`, a text of 1024 bytes each (512 Cyrillic letters), written only by the bot
  (`editMessageWidgetData`, silent, counts as one sent message; pushed to open widgets at once).
- **Asking the bot.** `TelegramWidget.request(data)`, 1 to 64 bytes, on a tap, or by itself in the private chat while
  on screen (once as it appears, then one per 5 s). It arrives as a `widget_query` update, answered with
  `answerWidgetQuery` (1024 bytes, within 15 s). 5 requests per 5 s per user and bot. The widget must be sent with
  `allow_queries`, and `allowed_updates` must name `widget_query`.
- **Where.** In production only the private chat with the bot (groups, inline mode and forwards are test server only).
- **Measured on @TestPatrikBot, 2026-11-12.** `sendWidget` is taken by the production Bot API for an ordinary bot, with
  no setting in BotFather. Telegram Web A draws it (a shadow root on the message, the script run, the state read, the
  default button in the app's style, the caption above with `show_caption_above_media`, an inline keyboard under it).
  A tap with no agent answering shows the widget's own "Not sent" after 15 s. Web K was not tried (it was not signed in
  in the browser used), nor were the phone and desktop apps.
- **How the card looks and feels, measured in Telegram Web A, 2026-11-12.** The app's own button is 33 px high
  (`min-height:var(--tg-button-height,auto)`, 14 px medium, 8 px corners, a tint for its background); the caption sits
  8 px in and a widget's text 12 (`--tg-text-padding`). The app shows a grey box 160 px high named "Widget" for a
  second or two before a widget draws, then shrinks it: Telegram's own. A tap on the dev agent (polled, this laptop,
  the database in the cloud) took 1.3 s to its answer; the widget shows nothing of its own meanwhile unless its code
  does. `--tg-button-bg` inside a widget is the main button's colour, not a tint. Since then the deck's buttons are
  44 px, the pressed one pulses and the ask dims at once, and the phone ticks (`HapticFeedback`, nothing on desktop
  or web).
- **Sizes.** The deck's code is 2897 bytes, about 1377 compressed (2181 and 1065 before the restyle); the switch's 729 and 487. A reply's ask (quote,
  words, four buttons, the pager) is about 370 bytes of chat state.
- **An app without widgets** shows "unsupported media" and the caption, with no way for the bot to know. So the deck
  becomes a widget only in a chat where one of Quest's widgets has asked the bot, and the switch's button is an inline
  keyboard under the widget, not a button inside it.
- **Refused, 2026-11-13.** From 15:22 UTC every `sendWidget` of @TestPatrikBot to the founder's private chat answered
  400 `INPUT_MEDIA_WIDGET_NOT_ALLOWED`: the deck, the switch, and a bare `{"html":"<p>test</p>"}` with no options, while
  `sendMessage` to the same chat went through. Redraws of widgets already sent (`editMessageWidgetData`) had worked until
  then. Telegram's widget page and the Bot API name no such error for a private chat; third-party reports call it a
  server-side eligibility list. Nothing in the bot's settings (`getMe`) changed.
- **Not verified live:** a tap answered end to end by an agent (the dev stack ran from another worktree, which does not
  ask Telegram for `widget_query`), the pin, and the switch's pull every 15 s.

## Egress, storage and matching from the makers' side (2026-11-12)

- **Egress.** pg_stat_statements on dev: the rotation's three reads (400 task rows with instructions and results, about
  3.5 KB each; 300 drafts; 500 results) ran 21,700 times, every 30 s while a Chrome was open: about 1.4 MB a look, 4 GB a
  day. Production's rotation is off, so its egress was small. Fixed by asking first how many runs are at work and reading
  tasks without their instructions.
- **Storage.** Dev was about 520 MB, 450 MB of it LangGraph checkpoints: 316 `publish:` threads (the poster's runs) that
  nothing deleted. After `mq.forget_finished_tasks()` took them and a `vacuum full`: 88 MB. pg_cron's run log held 137,000
  rows (the wake job runs every 30 s).
- **Matching.** 122 asks against 400 launches in three calls: 3 pairs, one of them wrong by a line number. From the makers'
  side (phrases a first user would post, searched as exact phrases on Bluesky, judged per launch): 90 launches, 12 to 19
  planned, about 150 posts found, 12 to 30 pairs a look in about 40 s. In 45 minutes of dev: 73 pairs, 108 people, 19
  makers written to by code. The writer keeps a link only when it reads as someone's post: a fediverse address
  ("/@name/123") was not one, and two introductions went up without their link.
- **Shapes cut the help.** With a shape drawn, "ask one pastor already using it to introduce you to two others" went up as
  "Was the first paid user a church that started free?". `helps` on a draft keeps it.

## Both databases moved to another Supabase account (2026-11-14)

- The old org (Messaging Quest, `jgsysmirpowsnwkcspky`, Free) had used 20.5 GB of egress in a cycle that allows 5, its grace
  period ended 2026-11-14, and a project of an org in that state cannot be transferred to a Free org ("Project cannot be
  transferred"). So both were copied into new projects in the founder's own Supabase org (`dhqtsyqgaqorwwnojtrs`, Free,
  eu-central-1): production `atjukklkmfwhmbbzxaod` (was `lylzleitvyfavudwlqyu`), dev `bglbnziyilxkxgzortuf` (was
  `qqgzkuxbmudbprvhvynw`). Both new projects answer on `aws-1-eu-central-1.pooler.supabase.com`.
- **A copy without the postgres password, both ways.** Out: the cutover's `mq_backup` role, `pg_dump -Fc --schema=mq
  --schema=supabase_migrations` (production 0.3 MB, dev 46 MB). In: a role `mq_restore` made in the new project's SQL
  editor (SCRAM verifier, `grant create on database postgres`, `grant usage on schema extensions`, `grant mq_restore to
  postgres`), `pg_restore --no-owner` as it through the session pooler, then in the editor `reassign owned by mq_restore
  to postgres`. Four statements fail for such a role and are run in the editor after: the two foreign keys to
  `auth.users` (postgres cannot pass `references` on it along), the two `alter default privileges for role postgres`.
  Not in a dump of `mq` at all: the trigger `mq_account_for_user` on `auth.users`, the `pg_net` and `pg_cron`
  extensions, the cron jobs (`cron.schedule` again, from `select jobname, schedule, command from cron.job`), and
  `mq_app` itself with its password (`scripts/init-secrets.ts` prints the line).
- Checked by a schema-only dump of both sides (identical but for owners) and `count(*)` of every table.
- Dev's schema is not the repo's migrations (tables and a cron job, `mq-clean-setup`, from other branches), so it can only
  be copied, never rebuilt from `supabase/migrations`.
- **The SQL editor, driven from a browser tool.** A statement that holds `delete from`, even inside a cron job's
  quoted command, opens a "Potential issue detected" dialog that must be confirmed; and typing more than about 450
  characters at once froze the tab. Short statements, one run each.
- A Developer of an org cannot create projects in it. An Owner or Admin counts their own free projects against the org's
  limit of two.

## The funnel (2026-11-14)

Dev, the founder's accounts, the 7 days to 2026-11-14 20:20 UTC, before "want the link?":

- About 570 replies and 12 messages went up. None carried a link to messaging.quest; 3 named the product.
- 98 people answered (`mq.results`, stage conversation). 19 of them got words back after their answer (by handle, so a
  few read under a display name are missed); the rest a like or nothing. 3 were told anything about the product.
- Production in 14 days: 3 new customers, all trials, none with `came_from` (no visit came by a tagged link).

So the leak is before the landing: people who answer are not told. What to count after, weekly, with the same queries:
posted replies and messages that offer the link (`offersIt`), answers that say yes, replies with the link, and
production's customers by `came_from`. Nothing is proven until those move; each tactic is one form among six, so it can
be taken out the same way.

## The funnel, a week on (2026-11-18)

Dev, the founder's accounts, the 7 days to 2026-11-18, with "want the link?" in:

- 685 replies and messages went up; 149 people answered (about 22%).
- 10 of the 149 heard "want the link?" (3 of 98 the week before); 10 messages named the product; 2 carried a link to
  messaging.quest, 1 of them with a thread code (`?i=`); 1 maker's page went out, the day it went live. 3 people said no
  and are in `mq.said_no`.
- Thread codes: 4 minted on dev in the week, 2 used by tests, the 2 real ones (LinkedIn, Bluesky) unused. Dev's codes were
  unknown to production, which the published extension pairs with, so a visitor with one came in as a stranger. Since this
  day dev's codes carry a "t" and production reads their note through `public.invite_note`.
- Production, ever: 6 live customers (5 trials, 1 invite), none with `came_from`, 3 with a brief, 2 swept, none paid.
- Matchmaking: 1,772 pairs found in the week, 1,175 taken, 279 (16%) where the person asked for such a thing. Makers
  opened to so far: 99 on Bluesky (about 29 answered), about 60 on Mastodon servers (none answered), 6 on X, none on
  LinkedIn. Most Bluesky makers were hobby game developers.
- Posts of their own, 14 days (answers counted from `watch_seen`, rough on list sites): Threads 23 posts and 24 answers,
  X 18 and 23, LinkedIn 9 and 14, the other nine sites 37 posts and 2 answers.
- Replies, 14 days, sent and answers: X 119 and 124, Threads 100 and 109, LinkedIn 104 and 102, Bluesky 336 and 92,
  Mastodon.social 84 and 9, Instagram 73 and 14, TikTok 31 and 0.

What the others do (vendor and competitor sources, so directional): AI SDRs book a meeting and a person closes, with
positive replies near 1% and yearly churn of 50 to 70%; Gojiberry writes only to people who showed a signal and sells by a
self-serve trial; Boardy's free introductions are its way in; audit tools take a link and give a report before any signup.
None converts in the thread: the thread hands over a free result that is theirs, and the ask comes after it. So the
maker's page became the way in (CLAUDE.md, "The quality update"), with views and clicks counted on `mq.match_pages`.
To judge it weekly: pages made, views, clicks, and production's customers with `came_from = match`.

## The baseline before open source (2026-11-19)

`scripts/funnel.ts` (replaces the hand queries above). Dev, the 7 days to 2026-11-19 20:57 UTC: 625 replies, 40 messages,
82 posts, 558 likes, 235 follows; 140 people answered (Bluesky 80, X 33, LinkedIn 12). Offers of the link 5, links to
messaging.quest 4, 3 said no, 1,838 pairs, 3 makers' pages with 1 view and 0 clicks. Answers are counted by the result's
address, so a site whose answers are kept under another address (Threads, 4) reads low. Production, 30 days: 6 customers,
2 swept, 1 reply up, 3 conversations, none with `came_from`.

## The cut before open source (2026-11-19)

Phase 1 of docs/next-goal-open-source.md, in eight commits on `claude/open-source`: videos and clip reading, stickers,
live screen pictures, Telegram widgets and the pinned switch, the takes, experiments, the waitlist with the trial,
own OpenRouter key and Telegram Stars, and the Mini App's People, Live view, Memory, Coming up, Log pages with
`mq.journal`. About 7,000 lines out. The migration `20261119220000_open_source_cut.sql` dropped eleven tables
(`experiments`, `journal` with 62,959 rows on dev, `own_keys`, `subscriptions`, `offers`, and six of v1's unused
ones), the `waitlist` view, five `customers` columns and the `legacy` schema; anyone on a trial moved to $1 of
credits. `npm run check`: 690 tests passed, 21 skipped; the Postgres integration tests passed on dev after it.

Phase 2, the same day: the panel's card stack is a plain list above the box to write in, Quest's ideas and its offers to
go alone left the asks, the evening report is a page (`mq.reports`, a button in the chat), and the gear opens the
panel's settings with where Quest works, the model and the past reports (extension 0.16.0). `scripts/try-report.ts`
on the dev founder for the last 24 hours gave the same counts per platform as `scripts/funnel.ts 1`. The popup's long
poll had never waited since it was written: the route read `after` with `/^d{1,16}$/`, so every poll came back at once.

Phase 3, the same day. Production had 3 paired Chromes, not 5, and 2 swept. The third (the founder's own production
account, 14 Nov) saved its brief while Quest was off; its Chrome was already online, so no "Chrome back" came, and
switching on never asked for the sweep: start_task refused the team "until the sweep ends" for five days. Switching on
now starts it, and a refused start_task tries it once more. The sweep also waited for the researcher (about 10 minutes)
before any brief: the first turn now saves one from their words. `try-first-run.ts` on a made-up founder, in memory:
save_brief was the turn's first call, 23 s after their answer.

## The local edition (2026-11-19)

- **PGlite holds the whole schema.** PGlite 0.5.15 (Postgres 17 in WebAssembly, a folder on disk) runs all 60
  migrations once Supabase's roles, an `auth.users`, pgcrypto (PGlite's own extension) and pg_cron and pg_net as
  functions that do nothing are stood in first. Served on the Postgres wire by pglite-socket 0.2.18 (both 3 Nov
  releases, pinned), the agent's own `pg` pool and LangGraph's checkpointer use it unchanged: 40 queries at once in
  0.15 s, ten workers claiming 30 rows with `for update skip locked` in transactions took each once, and the 21
  Postgres integration tests passed (`scripts/local-db.ts`, then the test with `DATABASE_URL` on it). A fresh folder
  is ready in 8.4 s. The pool goes without TLS on a loopback address.
- **Codex runs Quest on a ChatGPT subscription.** The Codex app's own CLI (codex-cli 0.167, in
  `%LOCALAPPDATA%\OpenAI\Codex\bin\<build>\codex.exe`; `codexBin` finds it) with `exec --ephemeral --ignore-user-config
  -s read-only`: a structured answer in 10 s, two tool calls in 9 s, a picture read in 5 s, about 14,000 tokens of its
  own prompt each. Codex has no tool that ends its turn, so `MODELS=codex-cli` lists Quest's tools in the prompt and takes
  the answer as one JSON shape (`say`, `calls` with each call's arguments as a string the tool's schema checks).
  `scripts/try-codex-cli.ts` through LangChain: a reply in 4.2 s, `save_site` and `remember` called right in 4.9 s,
  `withStructuredOutput` in 7.9 s.
- **`npm start` runs the whole local edition on this laptop** (2026-11-19): stage `local`, no bot, PGlite in
  `~/.quest/db`, the Claude subscription, the agent on `127.0.0.1:8787` only. `scripts/try-panel.ts` plays the side
  panel by its own routes: "Start talking", the first question at once, and to "I make shipnote.app, changelogs from
  GitHub releases ... X and Bluesky" one line back in 13 s with `save_site`, `save_brief`, `remember`, `start_task` and
  `connect_chrome` called. It first asked "Where are you based, for the evening report?": the hello now carries the
  browser's time zone, and the prompt asks only when the briefing says it is unknown. The run also found a bug every
  newcomer on dev and production would have met: `startFree` named a column `trial` (now the string).
- **The shared database of people, both ways, on dev** (2026-11-19). The hosted agent serves `/people/seen`,
  `/people/known`, `/people/no` and `/people/recent` (http/people-routes.ts) on `mq.known_people`, to any install
  that sends an anonymous key (5,000 posts and 500 checks a key a day; public addresses only). `scripts/try-people.ts`
  against dev: 401 without a key, a week read back (1,000 posts, 500 asks and 500 launches) in 624 ms, the same 5
  posts sent again in 135 ms, a 192.168 address refused. The local edition's `SharedPeople` keeps everything locally,
  sends the public part in batches of 200, and reads everyone's week beside its own: 600 posts through it in 461 ms.
  A no takes the person out of `mq.known_people` everywhere (`forget`), and a local install's out of the shared list.
  Not yet: matching on the server (each install's own matcher reads the shared list), and filling each person in.
- **Production, 2026-11-19, 23:37 UTC.** PR #157 merged and deployed from an export of main (`edition: hosted`), then
  `open_source_cut` applied (the dump taken first is `mq-backups/prod-2026-11-19-before-open-source-cut.dump`, 388 KB,
  42 tables' data). No warning or error in its log after, its 2 paired Chromes polled the new code, nothing waited in
  the outbox, nobody was left on a trial. `scripts/load-people.ts --write` filled its shared list from dev: 15,905
  people (2 who said no on dev left out); `/people/recent` answers a week, 1,000 posts, in 0.45 s.
- **License: AGPL-3.0** (the founder, 2026-11-19), and the shared database is always on in the free edition.

## The end-to-end sitting, scripted part (2026-11-20)

Two installs from the one-commit public copy (`Projects/quest-public`), each with its own `QUEST_HOME`: A on Claude
(port 8787), B on ChatGPT through Codex (8797), both sharing people through dev's agent. No real Chrome was paired: the
side panel's own routes (`scripts/try-panel.ts`) stood in for it.
- **The copy alone.** `npm ci` 2 min, `npm run check` 690 passed. Its secret scan: three test placeholders, nothing real.
- **Every fresh install failed to start**: `QUEST_INSTALL_KEY`'s pattern had lost its backslash (`[w-]`), so a real key
  was refused; the platform switch's route had the same slip. Fixed; an install made before the key existed never hit it.
- **First run.** "What did you build" to Quest's plan in 15 s on Claude, 55 s on Codex. Without Chrome both say so and
  wait (the script's pretend Chrome never polls, so both also asked to reconnect it).
- **The shared list.** A's post read back by B at once; rows carry only the post's address, author, words and time. A
  no from A answered 500 on dev and production alike: `mq_app` could not delete from `mq.known_people`. Now a no is a
  key in `mq.people_no` (migration `people_no`, dev and production) and a trigger keeps it out: gone for B, and still
  gone after B sent the same post again. A short key 401, a private address 400.
- **The daily report**, asked for now on dev's customer: 26 words up and 9 answered in a day, the same as
  `scripts/funnel.ts 1`; it reads at 375 px wide.
- **Not run here** (need a person in a real Chrome): the install by Claude Code in a clean Windows account, the first
  people found, Telegram, half an hour alone, a restart mid-send.
- **Installed by Claude Code from one sentence** (the bundled CLI, `-p "install Quest and add the extension"`, in a
  fresh clone of the copy, `QUEST_HOME` and `APPDATA` moved to a scratch folder): it followed AGENTS.md, Quest answered
  on 8787 with Claude, and it told the person the one step left, the store extension. On the way `npm run setup` crashed
  on the fresh clone (it imported an agent module before installing the packages) and on a missing Startup folder; it
  fixed both, which are now the repository's. The lock file had not been regenerated since the license and the pinned
  PGlite versions. Not done: a clean Windows account, and Codex as the installer.
- **Installed by Codex too** (`codex exec "install Quest and add the extension"` in another fresh clone, after the setup
  fix): 140 s and 31k tokens, no change to the code, Quest answering on 8787 and its line in the (moved) Startup folder,
  then the same one step for the person. With the person's own Codex config it stopped at once: that config named a
  model a ChatGPT account cannot use, so it ran with `--ignore-user-config`, as Quest's own Codex source does.
- **The first run in a real Chrome** (the founder's, the dev extension paired with a local Quest from the public copy,
  2026-11-20). "Start talking" asked what they build; "messaging.quest" started the work. The first try ended at once:
  PGlite is one session behind its socket, which queues every connection's protocol messages into it, so two
  connections' prepared statements collided ("bind message supplies 4 parameters, but prepared statement requires 1")
  and the agent exited. With one connection for the local edition: the sweep started at 08:26:07, its first strong find
  at 08:27:40, done in 9 min 10 s (45 pages, 127 posts from Hacker News, Bluesky, Reddit, X, LinkedIn and YouTube, 4
  saved, 2 strong), signed in on X and LinkedIn. Its finds and two profile changes waited on the panel's list; nothing
  went out. The public people it saw went to production's shared list with no failed send.
- **Stopped in the middle of a send** (same Chrome, 10:04). The founder tapped one find's Like; the poster had prepared
  it (its last step 10:04:27, nothing pressed after in the log) when the agent was killed hard (`taskkill /F`, as a
  crash). Back up at 10:05:21 on the same data: `finds.post_lost`, the find held as maybe sent, and in the minutes after
  no send, poster step or error. Alone for about 100 minutes before that, the log had no error line.
- **Telegram as a remote control** (same install, a bot of the founder's own from BotFather, `telegramToken` in
  settings.json). Quest polled it at start and the token is in no log line. The panel's "Also talk to Quest in
  Telegram" link joined that chat to the same customer (`customers.telegram_joined`, 10:43:26), and their first message
  there was answered in 36 s, with a 👍 on it, while Quest was paused from the panel's bar (since 10:09): paused, the
  manager still answers and nothing browses; the held Like's look waited for on (`held.look_failed`, "switched off").
- **Brakes, a no and the model limit, fed by script** (`scripts/try-brakes.ts`: a fresh PGlite with every migration and
  the classes main.ts wires; 16:00). All 14 held: "are you a bot?" paused Bluesky's replies and only those, a reply taken
  down paused LinkedIn's, answers on X falling from 40% to 3% of what went up paused X's, and each said so once; the three
  brakes were rows that a restart loaded again, and a go-ahead on X lifted X alone. A no was kept for the person (found on
  another post of theirs, after a restart, and in a tag under someone else's post), left someone else free, and
  `/people/no` took them out of the shared list, where a new sighting did not bring them back. A usage limit rested
  the models until the time it named, three runs it ended left X open, and two real failures still rested it. Found on
  the way: a no sent with a platform's name ("bluesky") instead of its site (`contactSite`, "bsky.app") removes nobody;
  the agent always sends the site.
- **Hosted after the deploy** (main at 678975f, Fly v137, 15:57). Up at 15:57:35, health 200, `/people/recent` with no key
  401; two customers' Chromes back within 20 s; nothing sending or queued in the outbox and no run at work (read only:
  nothing sent as them). The public repository, github.com/theic/quest, is the same tree as the branch.
