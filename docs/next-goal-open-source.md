# Next goal: Quest, open source and self-hosted, with nothing extra

Written 2026-11-19 from five weeks of live use on dev and production. The numbers in it come from the databases on that
day (dev `bglbnziyilxkxgzortuf` and production `atjukklkmfwhmbbzxaod`) and from FACTS.md, "The funnel, a week on".

## The goal, in one paragraph (paste into /goal)

Follow docs/next-goal-open-source.md, the whole plan: its cuts, phases and end-to-end checks are the definition of done.
Make Quest an open source repository that a founder installs by asking their own Claude Code or Codex to "install Quest
and add the extension", running on their own Claude or ChatGPT subscription, with everything kept on their machine
except the public people it finds, which always go to one shared database of people that makes matching almost free.
The hosted Quest (our server, credits) becomes the upgrade, built from the same code. On the way, cut everything that does
not get a user more clients or that adds a step before the first result: the onboarding is three steps, the side
panel is the chat, a switch and the few things that need them, the Mini App is a settings and status page, and
everything else they need to know comes as one daily report in the chat. Prove every part end to end on Windows (the
only machine there is), in one run of checks of 1 to 2 hours, before the old version is turned off.

## What we learned (keep these, they work)

Measured on dev, the founder's own accounts, the 7 days to 2026-11-19:

| What | Number | What it tells us |
| --- | --- | --- |
| Replies up, a week | 625, plus 40 messages, 82 posts | Quest can do volume without a person tapping |
| Likes and follows, a week | 558 and 235 | cheap, and they make a first word land |
| People who answered, a week | 140 conversations | about 1 in 5 replies gets an answer |
| Replies and answers, 14 days | X 119 and 124, Threads 100 and 109, LinkedIn 104 and 102 | these three answer about 1 to 1 |
| Same | Bluesky 336 and 92, Instagram 73 and 14, Mastodon 84 and 9, TikTok 31 and 0 | volume without answers; Mastodon suspended us once |
| Posts of their own, 14 days | Threads 23 posts and 24 answers, X 18 and 23, LinkedIn 9 and 14, nine other sites 37 and 2 | posts work on three sites only |
| Shared people database | 15,907 people in 7 days (63% Bluesky), 1,818 in a pair; production: 0 | the list grows by itself, but only dev feeds it |
| Pairs, a week | 1,838 found, 16% where the person asked for such a thing | matching works; most pairs are weak |
| Maker's pages | 3 made, 1 view, 0 clicks | the lead magnet has not been tried yet, not failed |
| Production, ever | 6 customers, 5 trials, 5 Chromes paired, 2 first sweeps, 0 paid | people get lost between pairing Chrome and the first result |

What holds up and stays:

- Finding people by code (`find_people`, the batch judge, the site specs) and checking each one before a word.
- The person record (`mq.contacts`): remembering who someone is and what passed. Connect first, then a word.
- One outbox with a site's pace, one reply per post (the five holds), a no is final (`said_no`), adults only.
- The voice: shapes drawn in code, the tells, the occasional slip, no number said back, the product last.
- Approve by exception, brakes, the daily sample (the quality update, 2026-11-18): this is the control model.
- The reply watch from notifications, on one clock per site, and the next step planned two days on.
- Likes and follows pressed by code where the page leaves one choice (Instagram, X, Threads, YouTube on 2026-11-19).
- One browser task in front, reading in background tabs, a person's pace per site.
- The off switch that stops the heavy work and leaves the manager answering.
- Dev on the Claude subscription (`MODELS=claude-cli`): five weeks of daily use, nothing paid to OpenRouter.

## What we cut (first principles: does it get them a client, or add a step?)

Each line is cut in code, not just hidden. A feature that comes back later comes back from git history.

| Cut | Why |
| --- | --- |
| People tab, Live view graph, Memory, Coming up, Posting and Log pages | the founder does not use them at hundreds of conversations; the daily report says what matters |
| The card stack in the side panel (swipe, ✕ ✎ ✓, the stack behind) | a game for one card; at volume the user approves by exception. What needs them is a short plain list in the chat |
| Your move as a ranked deck of everything | replaced by the "Here's what I'm sending" list plus a card only for what is risky or personal |
| Telegram widgets (the deck card, the switch widget) | Telegram refused them in the chat that drew them a day before (2026-11-13) |
| The pinned switch message (`SwitchBoard`) | the side panel's bar is the switch; in Telegram, `/off` and `/on` |
| Videos: `make_video`, `edit_video`, clip reading, the 1 GB upload page, ffmpeg | hidden since 2026-10-29; nobody missed it |
| Quest's own post ideas (`IdeaService.propose`), the takes, the reflection | retired already; the code stays only as weight |
| Stickers and moods, the Visor sticker pack | decoration; reactions on their messages stay |
| Live screen pictures (`LiveScreen`, `capture.js`, `/chrome/shots`) | unwired since 2026-11-05 |
| Experiments as their own table and tools, and the separate evening report | folded into the daily report: what worked, what we change tomorrow |
| Invite-only waitlist, invites, the trial, own OpenRouter key | self-hosted needs none; hosted keeps one way in (below) |
| Telegram Stars, the credits page's five packs and first-top-up bonuses | hosted keeps Stripe and two packs; the entry is Chrome now, not Telegram |
| The Senior plan's `mq.subscriptions`, `mq.offers`, the `legacy` schema | unused for weeks |
| The quick tunnel, the Mini App inside Telegram for self-hosters | a self-hosted settings page is a local page in the side panel |

## Platforms: all of them stay, the weak ones change approach

The answer rates above say what works now, not which sites are worth it. Every platform stays on, in reasonable
amounts, as now. Where words get no answers, try another way of being there instead of more of the same:

- X, Threads, LinkedIn (about one answer per reply, and posts that draw answers): keep the mix as it is.
- Bluesky (a quarter answered, mostly players, not founders): fewer cold replies, more likes, follows and the thread
  post; aim at founders only.
- Mastodon (9 of 84, one suspension): no cold replies; likes, boosts, follows, and answers under their own posts and
  hashtags they follow.
- Instagram, TikTok (14 of 73, 0 of 31): likes and follows, comments only under posts that ask the reader something.
- The rest (Facebook groups, Telegram and Discord groups, Peerlist, YouTube): one run a day each; groups answer when
  the words help in the thread, so help first, no openers.

Each change is one line of the rotation's brief or a site's entry in `platforms.ts`, judged by its answers a week
later in `scripts/funnel.ts`.

## What the user sees after

1. **Install.** "Install Quest from github.com/... and add the extension" to Claude Code or Codex. The repo's
   `AGENTS.md` (read by both) tells their agent every step; `npm run setup` does the rest and opens Chrome's extensions
   page with the folder to load. No account, no key, no bot to make.
2. **The side panel.** A bar on top (on or paused), the chat, the box at the foot. Quest asks one thing: what they
   built, a link if they have one. That starts the first sweep.
3. **The first result.** Within minutes, the people it found, in the chat, and the first words going out (the first few
   of each kind wait for a tap, as now).

After that:

- **In the chat, each day:** one report, an HTML file (and the same as a page on their machine): who answered, who is
  waiting for them, what went up and where, what worked, the sample to skim, what is paused and why, and the few
  things that need them. A PDF only if HTML in Telegram reads badly on a phone; check that first.
- **Asks, only these:** words naming their product or linking it, private messages, profile changes, someone waiting
  for them specifically, a brake that fired. Everything else goes, after the "Here's what I'm sending" list's three
  minutes.
- **Settings and status** (the side panel's second view, and the Mini App for hosted): on or paused, Chrome connected,
  platforms on and off, what goes alone where, language, the model in use, "Also talk to Quest in Telegram", and the
  past reports. Nothing else.
- **Telegram, optional:** for self-hosters, their own bot (BotFather's token pasted in settings; the setup explains it in
  four lines). Polling, so no address is needed.

## The shape of the code

One codebase, two editions, by one setting (`EDITION=local` or `hosted`), read in `main.ts` and nowhere else.

| | Local (free) | Hosted (upgrade) |
| --- | --- | --- |
| Runs | their computer, `npm start`, starts with the OS | our Fly app, as now |
| Models | their Claude (`claude-cli`) or ChatGPT (`codex-cli`) subscription; OpenRouter key optional | OpenRouter, as now |
| Storage | a local database in `~/.quest` | Supabase, as now |
| Customers | one | many, lanes, billing |
| Telegram | their own bot, optional | our bot, optional |
| Extension | the store extension, paired with localhost | the store extension, paired with us |
| People database | writes and reads the shared one | the shared one lives here |

Decisions, with the recommendation to take unless the spike says otherwise:

- **Local storage: PGlite** (Postgres compiled to WebAssembly, a folder on disk). It keeps the `mq` schema, the
  migrations and the SQL of `infra/pg-*.ts`, and LangGraph's Postgres checkpointer, so nothing is written twice.
  Spike first: `for update skip locked`, the lease queries, and the checkpointer on PGlite. If it fails, embedded
  Postgres (a binary download) is the fallback, then SQLite with a second set of stores, last.
  What does not exist locally: pg_cron (a laptop does not sleep; the loops already run in process), `mq.let_in`,
  `next_work_at` waking, the idle sleeper, Fly.
- **Codex subscription:** a `codex-cli` model source beside `claude-cli` (`agents/claude-cli-models.ts` is the pattern:
  one call, one fresh CLI turn, Quest's tools offered by the in-process MCP server whose tools end the turn). Spike
  `codex exec` with an MCP server, structured output and a picture, as `scripts/try-claude-cli.ts` does for Claude.
  Seats map to their plan: the writer on the best model, the rest on the fast one.
- **Voice:** the local Whisper (`infra/local-whisper.ts`) is already there.
- **Web reading without Chrome:** the user's Chrome only; Tavily is hosted only.
- **The extension pairs with localhost.** A release pairs only with production today. It must also pair with
  `http://localhost:<port>`, on the connect page the local agent serves, so self-hosters use the store extension and
  never Developer mode. Unpacked stays the dev extension.
- **License:** AGPL-3.0, so a fork that hosts Quest for others publishes its changes, and our hosted upgrade stays ours
  to sell. The founder decides; this is the one thing to ask before publishing.

## The shared people database

Matching is almost free when every install feeds one list. Today only dev's agent writes `mq.known_people`.

- **What goes up:** only what is public, as now: site, handle, name, profile address, what they made or asked for and the
  post that said it, their public site and public ways to reach them. Never the user's own words, drafts, contacts'
  notes, conversations, or who the user is. Each install sends with an anonymous install key.
- **How:** a small HTTP API on the hosted agent (`POST /people/seen`, `GET /people/match?for=<product words>`), backed by
  `mq.known_people` and `mq.pairs` in production. Batched, rate-limited per install key, addresses checked as public,
  a post's quote checked to be in the post it names, so one install cannot fill it with junk.
- **Always on:** this is the price of the free version, said plainly in the README, the setup and the privacy page.
  Remove a person who asks (`said_no` reaches the shared list too).
- **Matching moves to the server:** the matcher runs there over everyone's finds, on its own clock, not inside one
  user's Chrome. A local install asks it for people for their product and gets pairs back with the posts.
- **Fill each person in:** a cheap public lookup (their profile, their site, how to reach them) for the people paired,
  so a report can say who someone is. Today 342 of 15,907 have a checked profile.
- **Move dev's 15,907 people into production's table** as the first load (public data, same schema; ask before writing
  to production).

## Targeting, and the lead magnet (ours only)

- Fit over size: an opener goes only to a maker for whom somebody asked, sellers first (already in code). This is for
  every user.
- The lead magnet is Quest's own growth, run on dev from the founder's accounts, never a user feature: the maker's
  page, the thread post ("drop your project's link, I'll reply with people asking for it"), the introductions and
  "want the link?". In code it runs only for Quest's own account (its site is messaging.quest), so a user's Quest never
  sends a stranger to messaging.quest. The shared database answers the thread post in seconds.
- Count it weekly (one script, `scripts/funnel.ts`, replacing the hand queries in FACTS.md): replies up, answers, offers
  made, yeses, links sent, pages made, views, clicks, installs by `came_from`.

## Phases

Each phase ends with its check passing, a commit, and a line in FACTS.md for what was measured.

0. **Baseline.** Commit the pending like fixes (Instagram, X scroll, YouTube) and deploy them. Write
   `scripts/funnel.ts` and record this week's numbers, so the change can be judged.
1. **Cut.** Delete the table above in one branch: code, tools, prompts, migrations that drop the dead tables (dev
   first, production after a `pg_dump`), CLAUDE.md sections, tests. `npm run check` green, and a dev day runs as before
   (replies, likes, answers watched, the outbox). Expect the agent to lose a fifth to a third of its code.
2. **Asks and the daily report.** The asks narrowed to the risky list; the side panel's stack becomes a plain list in
   the chat; one daily report (HTML) built from `DayLedger`, the sample and the brakes, sent in the chat and kept as a
   page. Settings and status as the Mini App and the panel's second view.
3. **Onboarding in three steps.** Find why 5 paired Chromes gave 2 sweeps on production (read their transcripts and
   `mq.journal`), fix it, then cut anything between "what did you build" and the first people found.
4. **Local edition.** PGlite store, `codex-cli` model source, `EDITION=local` in `main.ts`, Telegram by the user's own
   bot, the extension pairing with localhost, `npm run setup`, `AGENTS.md` and a short README.
5. **Shared people database.** The API, the install key, matching on the server, the first load from dev.
6. **Hosted as the upgrade.** The same code with `EDITION=hosted`: Stripe with two packs, the landing saying free and
   self-hosted first, hosted second. Existing production customers keep working through the change.
7. **Publish.** A new public repository with a fresh history (the old one names real people in FACTS.md and CLAUDE.md,
   and the founder's accounts): a secret scan (gitleaks) on what goes, names scrubbed from FACTS.md, the license, the
   store listing and privacy page updated (local mode, the shared database).

## End-to-end checks before the switch

Windows only, on this laptop, in one sitting of 1 to 2 hours: by hand in the real apps where a person would act, by
script where only the result matters. What cannot happen in that time is made to happen: a brake is fired by a made-up
answer, the report by asking for it now, a "day" by the rotation's own logs over the sitting. Each check writes what it
saw to FACTS.md.

| Check | Minutes | Done when |
| --- | --- | --- |
| Install in a second, clean Windows user account by asking Claude Code (then Codex, if its spike passed) | 20 | Quest answers in the side panel; no step needed a person beyond the extension install and their subscription login |
| First run, local | 15 | "what did you build" to the first people found in under 10 minutes; first words wait for a tap |
| First run, hosted (dev bot, the release extension against a local hosted-mode agent) | 15 | same, with no Telegram |
| Telegram as remote control | 5 | the link from settings joins the same chat; `/off` and `/on` work; the report arrives |
| Running alone, 30 minutes of the sitting | 30 | replies, likes and follows across platforms at their pace; the "sending" list; asks only for the risky kinds; nothing stuck in `sending` |
| Brakes and a no (fed by script) | 5 | "are you a bot?", a taken-down reply and a rate drop each pause that platform and say so; a no gets nothing again, here and in the shared list |
| Restart and model limit (by script) | 5 | killing the agent mid-send leaves it held, never sent twice; a limit is a rest, no site rested 12 h |
| Shared database | 5 | the two installs of the first check: one's finds show in the other's matches; nothing private in the rows |
| Daily report, asked for now | 5 | reads on a phone; numbers match `scripts/funnel.ts` |
| Hosted unchanged | 5 | production's customers: a chat message, Chrome status, the outbox, the billing page (read only, nothing sent as them) |

Run the same table again on the release build before publishing; the second pass reuses the installs, so it is
shorter.

## Guardrails that do not change

Never a laptop agent on production's bot or database; migrations dev first; ask before deleting or overwriting in
production; no secret printed or kept in the other environment's file; nobody among the 372 earlier sign-ups emailed
without the founder's word; the on/off switch is the user's.

## Open questions for the founder, before phase 7

Answered 2026-11-19: AGPL-3.0; the shared database is always on in the free version, with no opt-out. 3 was left
open; the landing (2026-11-20) says what hosted gives today: our models, nothing to install, free to start. Running
with the laptop closed would need their Chrome somewhere else, so it is not offered.

Done 2026-11-20: phase 6's landing, privacy page and store listing text; phase 7's secret scan (a pattern scan of
every tracked file: three test placeholders, nothing real; gitleaks itself not installed here), real people's names
and handles swapped for made-up ones, and a one-commit copy at `Projects/quest-public` (committed as
hello@messaging.quest). Not done: pushing it to a public GitHub repository (`theic/quest`, which the landing links),
publishing extension 0.16.0, the end-to-end sitting.

1. The license (recommended AGPL-3.0).
2. Whether the shared database may be on with no opt-out in the free version, as written above.
3. What the hosted upgrade gives that local does not: our models with no subscription needed, running while the laptop
   is closed, or both. Running while closed needs their Chrome somewhere, which hosted does not have today.
