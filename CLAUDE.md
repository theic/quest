# Messaging Quest v2: working here

Quest is an agent founders and builders hire in their messenger (the founder, 2026-10-29: "we only serve founders /
builders, no other modes available"). A team of agents finds the places and the people online who want what the
customer built, and hands over a message the customer sends themselves, or posts with one tap from their own
account. It lives outside every app, listens, and speaks first only when it matters: ultra short, human, a reaction
where a reaction says it, silence elsewhere. Telegram is the main surface; the web is for the landing page, top-ups
and reports.

## Shape

```
packages/core   domain types and ports (interfaces). No I/O, no dependencies.
apps/agent      the manager and its team (Fly app, Node). Telegram webhook, task queue, loops.
apps/extension  Messaging Quest for Chrome (MV3, plain JS, no build). Where the team reads the web.
apps/web        messaging.quest: the landing page (static files, no build; `npm run dev -w @mq/web`).
supabase/       migrations. The `mq` schema is server-only; auth.users stays Supabase's.
scripts/        secrets and setup. They print names, never values.
```

- **Ports and adapters.** Services depend on interfaces in `packages/core/src/ports.ts`.
  Postgres, Telegram, OpenRouter and the customer's Chrome are adapters. `apps/agent/src/main.ts`
  is the only place that wires concrete classes together. Tests use the in-memory fakes in
  `apps/agent/test/fakes.ts`, which keep the Postgres semantics (leases, claims, idempotency).
- **One responsibility per class.** New channel: a `ChatChannel` in the registry. New subagent:
  a `SubagentSpec` in the catalog. Neither changes the runner, the queue or the manager.
- **A try is a failure, not a claim.** A task's `attempts` counts the runs that failed or
  died; a stop that was not its fault (new instructions, a shutdown or deploy, a question)
  gives its claim back (`release(..., clean)`, `park`).
- **The manager never blocks.** Background work is a row in `mq.tasks` run by `TaskRunner` on
  its own LangGraph thread (`task:<id>`). A subagent's `ask_human` is a LangGraph interrupt:
  the run parks, the question joins the queue the manager manages, and an answer resumes the
  run at that exact call. Everything that should wake the manager is a row in `mq.events`.
- **A manager turn starts fresh.** Nothing carries over in a model's context: each turn runs on
  a thread that lives only for the turn (`MemorySaver`), briefed from the database by
  `manager/turn-input.ts`: the brief, the plan (`mq.customers.plan`, `write_plan`), what Quest keeps
  for good (`mq.memories`), the chat's last 16 messages and the board. So a turn
  costs the same on day 100 as on day 1 (the old thread had reached 160 KB by day two), and
  nothing learned lives only in a model's context. A turn is stopped at 10 minutes and retried;
  a reply the model left empty gets one more step, then the turn fails and the queue retries it.
- **What Quest keeps for good.** `mq.memories`: decisions (what the customer decided or wants),
  lessons (what went wrong or worked) and facts about them, one sentence each, retired rather
  than deleted. The manager keeps them with `remember`/`forget`; the code adds lessons it notices
  (a reply taken down). Every turn shows them all, and every task's opening carries the
  decisions and lessons, so the team follows them too.
- **Time, and keeping its word.** Every turn shows their local time and part of day, how long ago
  each thing happened, how long each teammate's runs take (`TaskRepository.paces`: median and 8-in-10
  over the last 14 days, read every 15 minutes) and which open run is running late. What Quest owes
  is a row in `mq.commitments` (`manager/commitments.ts`): a `promise` to the customer ("give me 5
  min", or what they asked to have at a time, `on_time`) or a `next_step` in a conversation with
  someone it found. Each has one pending `commitment_due` event (`CommitmentSchedule`, like a
  follow-up), so `mq.next_work_at()` wakes a sleeping agent for it: a promise a fifth of its window
  early (1 to 20 min; at its time when `on_time`), so Quest can say it needs longer before the time
  passes. A turn woken for a due promise that is still open gets one more step to deliver it or give
  a new time, sent by the turn (`PROMISE_NOW`); an early look on track is woken again at the time; a
  next step nobody did waits a day, three times, then is dropped. A time Quest gives in its own words
  and keeps with no tool ("I'll get back to you within the hour") is heard (`lib/their-time.ts`
  `promisedTimes`: "give me 5 min", "I'm running the search, about 10 min", "more in ~10 min") and kept
  as a promise too (`source = 'said'`), tied to the task the turn started; the same work said again in
  other words is one promise. `promise` on a task's work is held to that teammate's pace, and refuses
  a second promise for what is already owed. A wake for a promise already settled costs no model call.
  A hold they put a time on ("no Reddit today") is `set_place` with `until`, which plans its lifting
  as a next step. When their message asks to hear back at a time (`askedFor`: "get back to me in 5
  min", "ping me at 15:30"; not "within" or "by", where sooner is fine) and the turn wrote the answer
  at once, the answer is held on a promise (`source = 'asked'`, `mq.commitments.held`) and sent at
  that time, counted from their message, with no model call (`#sendHeld`); they get a 👍 now (👀 on
  a question). A question back, an "on it", or a reply with a time of its own goes out at once.
- **Results, not activity.** `mq.results`: conversations, trials, active users and paying customers,
  a person once per stage with its evidence, or a count the customer gave (0 is a real zero). A stage
  with neither is shown as unknown. The reply watch records everyone who answers as a conversation.
  When they ask how it's going (`ASKS_PROGRESS`), the turn frames the answer around the results on
  record and the spent routes, and a reply with no result words in it is asked for once more.
- **Routes, and changing course.** `mq.routes`: the ways Quest goes after results. `log_try` counts tries; two in a row that did not work
  (`SPENT_AFTER`) spend a route, and `start_task` refuses a spent route unless given
  `retry_because`. The reply watch logs "Reddit posts and replies" itself: taken down is a miss, an
  answer a win. The migration backfilled it from the watch's old events.
- **Memories replace each other.** `remember` takes `replaces` (ids retired in the same step, only
  of the same kind and sharing `REPLACES_OVERLAP` 0.2 of their words: a wrong id retires nothing) and
  names live memories that overlap the new one (`lib/overlap.ts`, `SAME_MEMORY` 0.4, both measured on
  the live memories); the briefing marks a memory a newer one says again. `forget` retires at most
  `FORGETS_A_TURN` (4) a turn: more is a merge, done with `remember` and `replaces`.
- **Shortlists.** `best_people` gives the best finds so far with their links. Any person Quest
  found that a message names ("u/name", or a bare handle like "Quiet-Lake-1234") gets the link on
  their name in code (`withLinks`), from the turn's shortlists and then from the customer's finds;
  ordinary words are never taken for a name, and a link the model already gave (even shortened) counts.
- **Reactions.** `react` (only in a turn where they wrote) puts one emoji on their message
  (`setMessageReaction`; `conversation/reactions.ts` holds the emoji Quest uses and the rules: one a
  turn, no nod on a question, not three of their messages in a row). It is noted on the transcript
  (`mq.transcript.reaction`) and shown in the chat lines. A reply that only nods beside a reaction is
  not sent (`onlyANod`); any other reply beside a nod (👍 👌 🫡 ✍ 🤝) that is not a question is
  asked once for only what is new, and dropped when nothing is; a reply that only nods with no
  reaction becomes a 👍 on their message (same rules).
- **Old pages go as a line.** Every model call sees a run's last pages whole and each older one (`browser_open`,
  `browser_act`, `read_visual`, `read_page`, `read_site`, the poster's `inspect`/`prepare`) as its address and title
  (`agents/page-aging.ts`, in the harness's `wrapModelCall`; the run's own history keeps them whole). They are folded
  `BATCH` (4) at a time past `KEEP_PAGES` (2), so the prompt's start stays the same for several steps and stays in the
  provider's cache. Live, 2026-10-15: an outreach run on X grew to 170,000 tokens a step, and six late steps that
  missed the cache were $0.41 of its $0.64; folded, the same run comes to about $0.22.
- **One model step, few calls.** The harness keeps each tool call of a step once and at most
  `MAX_CALLS_A_STEP` (8) of them (`agents/tool-calls.ts`), logging `*.calls_trimmed`. Across a run,
  the same call (same tool, same arguments) a third time is refused with a note to use the answer it has
  or finish (`RepeatGuard`, `SAME_CALL_LIMIT` 2; `*.repeat_refused`); page tools that look again
  (`browser_act`, `read_visual`, the poster's `inspect`/`prepare`) are exempt.
- **Work stays where they asked for it.** When the customer names a site for the work ("on X"), the
  manager starts the task with `site` (`mq.tasks.site`; `tasks/site-pin.ts` `siteOf`: "X" and
  twitter.com are x.com). The runner wraps that task's tools (`pinToSite`): `search_posts` runs only
  on a source that reads the site (`SOURCE_SITES`, or `web` with `site:` on it), `read_page`,
  `browser_open`, `save_find`, `outreach_draft` and `save_place` refuse an address elsewhere, and a
  click that leaves the site says so instead of showing the other page. Its opening starts
  `THIS TASK WORKS ON x.com ONLY` with how to search it (`SITE_SEARCH`). `start_task` refuses the
  scout on a site its search does not reach (to outreach instead), and a second start of the same
  teammate on the same site in one turn (one ask, one task; taken before anything is awaited, since
  a step's calls run at once).
- **One at a time where it matters.** Teammates run side by side (`TASKS_PER_CUSTOMER`, 2), but a
  task kept to a site waits while another of theirs works there (the claim in `infra/pg-tasks.ts`
  and its fake), and the page shows it as next in line. Whatever acts as the customer (a
  post, a reply, a like, a follow, a profile change) goes one at a time across all their sites, in the order it asked
  (`chrome/site-lanes.ts`, `SiteLanes.run`, used by `BrowserPoster.post`; live, 2026-11-05: two posts on two sites took
  the front from each other, and the broker, which follows one post a customer, held one's own steps); reading needs no turn. While a post is written in their Chrome, nothing else of theirs runs on its site or in front (a drawn page, another run's browser steps): its steps go once that work is done, and the rest waits; reading other sites in background tabs goes on (`ChromeBroker.posting`; live, 2026-10-31, an X reply failed twice beside three X searches drawn in front, and went up alone at once; 2026-11-04, a LinkedIn reply held every read for 8 minutes and an X search failed after waiting 5).
- **Several tabs, each site at a person's pace** (the founder, 2026-10-23: "it switches between different websites
  to make it feel more organic for a single one out of the sequence"). Their Chrome takes `CHROME_TABS` (3) jobs at
  once, one per poller (`slot`; every `/chrome/next` answer says how many in `x-mq-tabs`, and an extension from
  before polls alone), each in a tab of its own (`apps/extension/src/lanes.js`). The broker keeps each site's clock
  for each customer: one page of a site at a time, a pause between two of its pages and at most so many in ten
  minutes (`platforms.ts` `pace`: Reddit 8 to 15 s and 30, LinkedIn 12 to 25 s and 12, X 6 to 12 s and 30, other
  sites `READ_PACE`), so a job whose site is not ready lets the next one go. Posts first, then browser sessions'
  steps, then reading, each in the order asked (`rank`); a post waits on no pause, a step in a page already open on
  none at all. A job's two minutes to be taken count from the last job the Chrome took; while their Chrome asks for
  work and the job waits its site's turn (or the hold below), it keeps its place up to `turnTimeoutMs` (5 min), then
  fails as `rate_limited`, never as "offline". The extension keeps a floor under each host (`HOST_FLOOR_MS`, Reddit
  8 s) and, alone, its old pause from the last page anywhere.
- **Nothing browses while they answer.** While a first-day card waits on them and they moved (an answer, a tick, a
  message) or got it in the last 3 minutes, and for 30 s after an answer while the next card comes, their Chrome
  takes no work at all (`conversation/answering.ts`, `Answering`, told by `IntakeService`; the broker's
  `BrowsingHold`). The founder, 2026-10-23: "not raising/browsing while I'm still answering an onboarding question",
  and "Hold all browsing". In memory: after a restart nothing holds until they answer again.
- **What searches came to.** `tasks/search-trail.ts` follows a run that finds people (its tools save
  finds or draft messages): each search (`search_posts`, or a search page opened in the browser and
  its scrolls) keeps the addresses it turned up, and each find saved or message drafted is credited to
  the search that turned it up, else the last one. When the run ends they go to `mq.searches`
  (`infra/pg-searches.ts`, best effort, kept 90 days), and the next run's opening lists the last 30
  days' searches on its site (all sites when it has none): the ones that found people, best first, and
  the ones that found nobody, never to repeat (`searchesBlock`). The outreach teammate keeps to that in code
  (`tasks/search-streak.ts`, `SearchStreak`, in `search_posts` and `find_people`): a search `mq.searches` says found
  nobody is not run again, and after `EMPTY_IN_A_ROW` (3) searches in a row that turned up nobody new, its searching
  ends for the run.
- **Outreach finds people by code** (2026-10-31: on dev, $1.13 of $1.52 a day was outreach, 29 to 46 MiMo steps a run
  on X; `finds/play-finder.ts`, `tasks/find-people.ts`). `find_people` takes the play and a site: the search words in one
  call (`searchWords` with the play, the customer's decisions and lessons, and the searches already run), the site's
  search cut by code, each batch judged on the volume seat against the play (`PLAY_JUDGE_SYSTEM`, with an age limit),
  and each pick's post read before its quote is used (a quote not on their own post, or the customer among the
  replies, drops it). Skipped: posts already drafted to (`replySpot`), people written to in 14 days, known finds.
  It answers with the people, their words and a quote; the teammate then checks each one (`read_page` their profile,
  `read_site` with `pages` 2) and drafts with `outreach_draft`, so the background check and the writer stay where
  quality lives. Looking for people by hand is refused while it is there (`finderFirst`: `search_posts` on a source it
  covers, an X or LinkedIn search page in the browser): live, a play that spelled out "Search X (latest)" was searched
  by hand and `find_people` never called. A run's `find_people` calls go one at a time, sharing its empty-search count. The own-words check holds on cut pages: `SeenPages` keeps who wrote each post and whom the page is
  read as (`account`, from X's own nav link or the browser's `handleFrom`). Searches go to `mq.searches` through the
  run's trail (`SearchTrail.add`). Measured in FACTS.md ("Outreach by code").
- **Getting to know people, and remembering them** (the founder, 2026-11-04: "remembering people is the most important.
  And get to know them slowly: connect first, warm them up, offer help or provide some feedback immediately if possible";
  `contacts/`, `mq.contacts`). Everyone Quest meets for a customer is a record, keyed `<site>:<handle>` (`contactKey`, the
  handle bare and in lower case): who they are and what they build, as their profile and their site say, what they are
  after, what the customer could give them, what was given, and what passed, a line each (the last `CONTACT_NOTES`, 12).
  The outreach teammate keeps it with `note_person`, which takes it only when this run read their profile (and their
  site, when it names one): the check is code, not a promise (live, 2026-11-04: `read_site` ran 18 times on Oct 31 and
  none on Nov 3 and 4, while 27 replies went up). How close Quest is with them is read, never kept (`Acquaintances`): met
  (checked), connected (a like or a follow went up), warm (a word went up), helped (something given), talking (they
  answered, `mq.results`). `outreach_draft` refuses a first reply or message to someone unchecked ("Check them first") or
  not yet connected with ("Connect first": a like or a follow of theirs drafted in this run or before). Reddit, whose
  replies answer a thread, is exempt; someone already talking is checked too (live, 2026-11-04: a run answering 13 X
  replies read @SamBuilds16's profile before its answer) but needs no like first. The writer is told what Quest knows of them (`about`:
  "write so it could only be for them; never say how you know it"), and a rotation run's opening names up to 5 people on
  its site to come back to (`comeBack`: connected a day ago and never spoken to, or spoken to two days ago and not yet
  helped), each with the next step.
  On LinkedIn a follow is a connection request (live, 2026-11-07: an outreach run pressed Connect itself, was stopped at the
  invitation, and none ever went): the card says "Ask to connect", the poster presses Connect (under More where it is not
  shown) and code sends the invitation without a note (`invitationSend`), and `follows` (15) caps them a day apart from likes,
  since LinkedIn holds an account to about 100 a week.
  Private messages are the next step for the best fits (the founder, 2026-11-05: "in addition to likes, follows, replies
  and posts we have to introduce DMs to connect with highly relevant prospects"): the outreach teammate sends one to the
  one or two of a run who fit best, once connected, to their profile (the poster opens its Message button), giving
  something and asking for nothing. `Acquaintances.dm` holds it in code: someone already talking may get one; anyone else
  only when their record keeps what they are after and what the customer could give them (`needs`, `can_give`), and
  never a second before they answer the first. A message always waits for a tap, and each platform's day limit for
  messages holds (YouTube and Hacker News have none).
- **Posting stays theirs.** The `posting` tool works only in a turn where the customer spoke (wrote,
  or answered a question card).
- **Quest in the extension, Telegram optional** (the founder, 2026-11-15: "Telegram is no longer a requirement, but an
  optional remote control! And Quest should mostly be reached through a conversation, not a page"). The extension's popup is
  the chat (`conversation/web-channel.ts`, `extension-chat.ts`; routes in `http/chrome-routes.ts`): `GET /chrome/chat`
  (the transcript, Your move from `Deck.view` drawn with Telegram's own `deckHtml`/`deckButtons`, a long poll with
  `after`), `POST /chrome/chat` (their words, a text inbound on the `web` channel, which makes the popup where Quest
  answers) and `/chrome/chat/press` (a button's Telegram data, read by `parseUpdate`). `WebChannel` keeps in memory only
  what the transcript does not: buttons, the sweep's line, the ask under Edit, typing. Someone new presses "Start talking":
  `POST /chrome/hello` makes them a customer whose chat is the popup (an invite's code, else the trial), answers the language
  with their browser's, and pairs this Chrome at once (`ChromeLinkService.pairNew`, nothing said). Every message Quest
  writes and every deck draw moves `ChatNews`; `/chrome/next` says it (`x-mq-news`), and the icon's badge says how many asks wait.
  Nothing opens or is drawn over their pages by itself (below). The landing has one button, Add Quest to Chrome; Telegram is a quiet link.
- **The icon shows and hides the panel, and the switch is a bar** (extension 0.15.0; the founder, 2026-11-18: "Make the
  turnoff switch in the sidepanel of the extension more clear to understand and see. The extension own button only function
  now is to open and close the sidepanel, not stop the browser running ... there should be an optional portal to telegram").
  The icon was the stop button for two days (2026-11-16); now a click on it only shows the panel and a second hides it
  (`iconShowsChat` in `background.js`, Chrome's own `openPanelOnActionClick`, always on), and its tooltip says so. The
  switch is a bar across the top of the panel: "Quest is working in this Chrome" with Pause, or, tinted amber, "Quest is
  paused. Nothing browses or posts." with Resume (`drawPower` in `popup.js`, the same `/chrome/power`). The box to write in is a
  bar at the panel's foot, as in Telegram (0.15.1): no frame, the mic while empty and the send once there are words, growing
  to six lines before it scrolls; the card or the conversation fills the room above it. Settings has "Also talk to Quest in Telegram": `POST /chrome/chat/telegram`
  gives a start link (`tg_<code>`, one use, an hour, in memory) and `/start` with it joins that Telegram to the same customer
  (`InboundService` `portal`, `bindChannel`); a Telegram that already has a chat with Quest is told so and left as it is.
  What Quest does now is still a label beside its cursor in its own tab (`say` in `cursor.js`).
- **The chat is Chrome's side panel, and nothing pops up** (extension 0.14.0; the founder, 2026-11-17: "The UI inside Chrome
  feels unnatural and unintuitive. I don't like this small pop-up floating on my screen ... and the chat in the pop-up I
  don't like as well. Don't make it popup"). The same page (`popup.html`) is the extension's `side_panel`: beside the page,
  as wide as they drag it, open until they close it, and opened only by their click on Quest's icon (Chrome's own
  `openPanelOnActionClick`, taken off while the icon is the stop button, when the click comes to `action.onClicked`). The
  dock on their pages is gone (`dock.js` deleted), and so are the popup and its hold on Quest's tab (`popupHold`): a panel
  stays when another tab comes to the front. The only sign of news in Chrome is the badge's count (`restBadge`:
  OFF, else the count, else DEV): Quest's messages since the last one the open panel showed (`unreadIn`, `seen` with its
  time) and the asks on Your move. Until 0.15.1 it read `chat.deck`, which the chat never had, so it always said nothing. Email is to be a channel beside Telegram later (not built).
- **Your move as a plain list** (2026-11-19, the open-source plan; the card stack and its swipes, 2026-11-16, were cut). In the
  panel what waits on them is a list above the box to write in (`drawAsks` in `popup.js`, `ChatView.asks` from `Deck.list`, up
  to 30): each ask with its link, its words and its own buttons, folded under a line that says how many. What goes alone
  never gets there (approve by exception, below), so it holds what waits for a tap: words naming their product, private
  messages, profile changes, a reply to someone who asks them something, kinds not yet trusted, and the team's questions.
  Quest's own ideas and its offers to go alone are not asks any more. Words typed are a message (a reply to the deck in the chat, as before), and the mic records a voice message
  (`POST /chrome/chat/voice`, held by `WebChannel.keep` until heard like Telegram's). A panel cannot show Chrome's microphone
  prompt, so the first time `mic.html` asks once in a tab.
- **Never blocked on Your move** (the founder, 2026-11-15: "If I hit a limit for posts, it should schedule it instead of
  blocking it"). A tap past a platform's day limit joins the outbox due when the day has room (`limitFreesAt`,
  `Outbox.schedule`): "Scheduled: it goes up by itself in about 9 h"; at its turn it is checked again on what went up only, and
  waits again (`SendOutcome` `{at}`). Any other tap a rule holds turns the deck to the next ask (`Deck.past`), the
  reason on top.
- **The onboarding starts in the thread** (the founder, 2026-11-15). On Quest's own account (its site is messaging.quest), a
  link to messaging.quest in a reply or a message gets a code of its own (`?i=`, `DraftService` hand-off, `mq.invites` with
  a note of who they are, what they wrote and what Quest said; the agent may insert only that). The landing keeps the code,
  the extension takes it (`landing.js`), and their first turn picks up from that conversation (`WayIn` `met` event; no
  first question).
- **The off switch** (the founder, 2026-10-19: "so I could use my desktop without the agent intervening";
  `lifecycle/power.ts`). Off stops the heavy work and leaves the manager answering (the founder, 2026-11-12: "the manager
  should always be there to answer, both switches should only turn off the heavy stuff, like browsing, the queue"). Off
  (`mq.customers.off_at`): the task queue claims none of theirs, their runs in flight stop and go back to the queue with
  their try given back (`TaskRunner.pause`), their Chrome gets nothing (`ChromeBroker.switchOff`: what waits fails with
  nothing sent, and Quest's tabs close), nothing goes up by itself or on a tap (`Autopilot.switchedOff`), no heartbeat or
  report is queued, and `mq.next_work_at()` wakes nobody for them. What they do themselves still gets a turn
  (`pg-events.ts` `THEIRS`: a message, an answer to a question), and that turn is told `BROWSING IS OFF`
  (`turn-input.ts` `offLine`): answer from what it knows, open nothing, promise nothing. Every other event waits for
  on, when the manager gets `switched_on`. A trial that ended is the one off that stops the manager too (`Power.quiet`).
  Known in memory too (loaded at start) for the broker and autopilot.
  - **One state everywhere** (the founder, 2026-11-20: "The turn off switch in Telegram is not synced with the browser,
    mini app's and current state"). Telegram's switch message is redrawn on every change, wherever it was made
    (`Messenger.redrawSwitch`: the last 8 switch messages in the transcript, the chat's pin, one pinned for themselves alone, and a message with no text by its caption or button), and a press there turns
    it in place instead of sending another. The Mini App asks `/glass/power` with no `on` every 5 s while in view (from
    memory), and the panel follows every poll's `x-mq-off`.
  - **In the extension** (0.12.11): the first switch of its popup, "Quest is on", one click on Quest's icon in the Chrome
    it works in (`POST /chrome/power`, the extension's token; the same `Power.set`). Off, Quest's tabs close at once
    and the icon's badge says "OFF" (`switched` in `background.js`, also told by every poll's `x-mq-off`). The header
    is set as a poll is answered, and a switch answers every waiting poll at once (`ChromeBroker.switchOff`): set as
    the poll began, a poll that waited through the switch told the extension the old state, so with three pollers the
    popup and the chat's switch disagreed for up to half a minute (live, 2026-11-12).
- **One outbox** (the founder, 2026-10-23: "a single common outbound queue for when chrome is inactive or something
  else is happening, it picks it up when it gets back to work"; `drafts/outbox.ts`, `mq.outbox`). Everything that goes
  out as them, a draft's or a find's reply, by tap (`tap`), on trust (`trust`) or on their words in a turn (`words`),
  joins one line, one row per draft or find at a time, and goes at once when it may (the errand starts before the tap is
  answered). While their Chrome is closed it waits: the tap's answer is "Queued: it goes up when your Chrome is back",
  the card says "⏳ Waiting for your Chrome" with only Edit and Skip (`Draft.waiting`, `Find.waiting`), and nothing is
  said in the chat; a Chrome that went away while sending is not a failure either, it waits again. When their Chrome is
  back (`ChromeBroker.whenOnline`, now a list of listeners) and every 15 s, what is due goes, in the order it came. Each
  sender (`DraftService.send`, `FindService.send`, errands `draft:<id>` and `post:<id>` as before) checks again what
  can change while it waited: still open, Quest still trusted there, no reply already under that post; the day limits,
  the avoid list and one post a week are checked at the tap, as before. Everything keeps a gap on a site, drawn from the send it
  follows between `SITE_GAP_MS` and `SITE_GAP_MAX_MS` (4 to 11 min; `lib/pause.ts` `pauseFor`, so every look sees the same one), a tap
  or their words too (live, 2026-11-01: seven Reddit replies on their word went up 3 s apart, and five were taken
  down), and what goes up on trust `ACROSS_GAP_MS` to `ACROSS_GAP_MAX_MS` (1 to 3 min) across sites, from the table (`sentSince`); a like or a follow (`mq.outbox.light`) keeps `LIGHT_GAP_MS` (10 to 45 s) on a site and `LIGHT_ACROSS_MS` (1 to 2 min) across, and anything for another site, a tap too, waits `SWITCH_SITE_MS` (1 min) after the last send, so a site's likes go one after another before the next site ("One browser task at a time"), and words are not paced from it, so a restart or a deploy
  starts nothing over; at start, rows left `sending` are done (their
  cards are held by `recoverPosts`), and queued ones wait on. Editing, skipping or "I replied" takes one out of line; one
  that waited `STALE_MS` (3 days) is dropped and its card comes back. It holds the agent up for nothing and is not in
  `mq.next_work_at()`: what waits needs their Chrome, and their Chrome's asking wakes the agent. Their page says how
  many wait to go up ("2 to send", `/glass/live` `chrome.sends`).
- **One reply per post** (`drafts/one-reply.ts`). Live, 2026-10-19: X hid a reply, the manager opened the
  post the next morning, did not see it, and a second one in other words went up by itself; the same day
  two went up under one post within an hour. A reply goes where `replySpot` says (a Reddit thing's id, X's
  status id on x.com or twitter.com, else the address without its query), and a draft or a find's reply
  that went up there, may have (uncertain) or is going up ends it: `offer` refuses a second, whatever the
  words, unless they are the customer's own (`theirs`); a second open card for the same spot is refused
  (edit the first); posting one closes the others; autopilot never sends one where one went up. Nor where they answered
  themselves, by hand (`AlreadyAnswered`; live, 2026-11-04: Theo's answer on X, which they had answered two days
  before, was read off their notifications and drafted again): `outreach_draft` takes a reply only for a post whose own
  page the run opened (`SeenPages.opened`: a row of their notifications or a search shows nothing under it), and refuses
  one where that page shows a post of their account after it (`answeredUnder`); the poster, whose tab is drawn, stops at
  the same sight on its page (`answeredBelow`, `itemAuthor`), sends nothing, and the card goes (a find counts as replied).
  On X only a row that opens "@handle · 2h" is an answer (`answerRow`): its post page lists "Relevant people" cards after
  the replies, the customer's own among them (live, 2026-11-04: their card stopped a reply they had tapped). X draws no
  replies in a background tab, so a reply on X is also asked of X's own search, `from:<them> to:<person>` (`tasks/
  answered-since.ts`): a post of theirs to that person after the one answered (by the time its id carries) means they
  took the conversation up themselves, and the reply is refused (live, 2026-11-04: the run had searched exactly that for
  Theo, and drafted anyway).
  A reply or a like goes on the post's own address, never a list it showed in (`listPage`: notifications, a search, a feed;
  live, 2026-11-05: a reply the poster had stopped, since they had answered by hand, was drafted again on X's mentions and went
  up from its row, where nothing under the post shows). A reply stopped so keeps `mq.drafts.answered_at`: no reply is offered there again.
  **Held five ways** (the founder, 2026-11-19, on three replies under one LinkedIn comment: "not the first time, take
  serious measures"; the record had six more doubles in two weeks, four of them Bluesky follow-ups on Nov 18). The cause
  each time: the check read their newest 100 drafts (300 at the send), and 421 drafts in two days, likes mostly, had
  pushed the first reply out. (1) What went up at a spot is asked of the database whatever its age (`repliesTo`). (2) A
  person is one key however named (`whoKey`: "Dana Reed", "dana-reed", a profile's "dana-reed-449a2216b"), and a
  LinkedIn post is its long number whatever its address. (3) A second word to someone who has not answered the first in
  a week waits for a tap (`#unanswered`, `answeredSince` from `mq.results`; `drafts.second_word`); code's own steps of a
  plan (`helps`, `ask`) and their dictated words are not that. (4) The poster is handed what already went up to that
  person (`ChromePost.before`) and stops when the page shows it right under the words being answered (`saidUnder`, by the
  page's order, since LinkedIn's rows give no handle; not on X). (5) If two replies to the same words still go up in one
  place, replies stop there for a day and they are told (`drafts.duplicate`, `Autopilot.brake`). A message to a LinkedIn
  post's address and a reply to a profile's are refused at drafting, and a private message never goes on trust
  (`Autopilot.alone` asks `mayGoAlone`: a "go ahead" for everything had granted every site's messages, and 27 went with no tap).
- **Their own words are not an answer** (`drafts/own-words.ts`). Live, 2026-10-19: Quest read a LinkedIn
  thread whose last message was the founder's and drafted "thanks for the reply". A reply or message whose
  quote sits under the customer's own name on the page read (a header line with their name and a time,
  or a list's "You: …"; `whoseWords`, their display name and their handle from the page's profile link) is
  refused, and so is one quoting a message Quest sent for them.
- **The product comes last** (the founder, 2026-10-19: "no promotion to the very last point; more simple
  engagements to warm up, do different kinds of interactions"; `drafts/warm-up.ts`, `WarmUp`). What names
  their product (their site's names, `productNames`) or carries a link promotes. On each platform the first
  `WARM_UP` (5) things that go up are plain; after that at most one in `PLAIN_PER_PROMO` + 1 (5) of the last
  14 days promotes; and never in the first word to a person, only once they talk with them (a `conversation`
  in `mq.results`). A draft or a find's reply that may not promote yet is written with `plain` (the writer
  drops what sells); a draft that still promotes is refused with the reason, and a find that does waits on
  its card (never up by itself). A post of their own counts only the platform; their dictated words and
  their profile are theirs. The board shows each platform's mix of the week (`mixLines`) so the manager
  likes, follows and posts, not only replies. Measured: `scripts/try-plain.ts`.
- **Replies change shape** (the founder, 2026-11-02, reading the outreach he had Claude run by hand: "each reply is the
  same-template question and feels really robotic"; 2026-11-05: "I see the 2-sentence approach with an ending advise or a
  question too often, also people mostly speak in shorter forms and bad grammar"). Each reply and message draws its shape in
  code (`drafts/tells.ts` `SHAPES`, `drawShape`: a word or two, a reaction, one detail, a question; `Writer`'s `roll`, wired
  in `main.ts`), since a model asked to vary settles on one, and whether it may keep an emoji (`EMOJI_SHARE`, 0.3); Reddit,
  posts and profiles draw none. One that runs past its shape, rates their thing after one that did ("X is a Y": `ratesAgain`)
  or has an emoji after two that did goes back once, and a one-sentence reply goes without its period (`loose`). About one in eight replies and messages gets one everyday slip from a list, drawn in code after the writer ("dont",
  "realy"; `drafts/slips.ts`, the founder, 2026-11-06: "small typos here and there ... must not feel intentional"), never a
  name, and never one its recent messages have. Measured
  with `TRY_RECENT=30` on `scripts/try-voice.ts` (FACTS.md). The writer's rules, the outreach teammate and the manager mix what
  a person gets: often a like alone (always on a post that asks about the reader's own life, which nobody may make up),
  a word or two, something about what they built, a question only sometimes; a thread that ran its course ends with a
  like on their answer. In code (`drafts/tells.ts`, `questionAgain`): a reply or message that asks after their last two
  did, or an either/or after one, goes back to the writer once; "makes sense" is a stock opener; their word against
  exclamation marks holds (`exclaim`). What the hand run measured on each site is in `platforms.ts`: Instagram's fresh
  builders are in its suggested people and under small builders' fresh posts, Threads' newest search, X folding a new or
  labelled account's replies (a post under an hour old is seen), TikTok undoing a new account's follows, YouTube's brand
  channel (acted as when active: the founder's is their product's, and a like and a subscribe stopped on it, 2026-11-05)
and its reCAPTCHA. A page whose own document answers 429 is `rate_limited` (wait, tap again), not a refusal. Instagram's links change only in its app, so a website draft there is refused.
- **Adults only** (`drafts/adults.ts`; live, 2026-11-03: a Threads run drafted a like, a follow and a reply for a builder
  whose post opened "I’m 17"). Someone who says they are under 18 gets nothing: `saysUnder18` on the quote refuses a
  draft (`DraftService.offer`), on the quote and the top of the page read refuses `outreach_draft` (a follow has no
  quote) and `save_find`, and both judges leave them out. A like goes on one post by its own address, never a
  profile's (`profileAddress`): live, a Threads like card pointed at a profile.
- **They steer: ideas and assets** (the founder, 2026-10-19: "I still want to be in charge of the direction";
  `ideas/idea-service.ts`, `mq.ideas`, `mq.assets`). Every picture or video they send is kept as an asset
  with what it shows (the file stays with Telegram, read again for a post), and the manager is told its id;
  a link for posts it keeps with `keep_asset`, and drops what is not for posts with `drop_asset`. Their
  ideas for posts are kept with `idea` as theirs to do. Quest's own ideas are not offered any more (the founder,
  2026-10-29: hidden): `IdeaService.propose` and its card stay in the code, the manager has no tool for them. The
  board and the Memory tab list them. A post or reply can go up with their pictures (`draft` with `assets`):
  its card says so, and the poster attaches each in the composer (`attach`; extension 0.11: the file into the
  composer's file field, `attachFile`) before it may publish; an older extension stops it as `outdated`.
- **An evening report.** At the customer's report hour (20:00 in `mq.customers.timezone`, UTC until Quest learns it
  with `set_timezone`) the heartbeat loop queues a `day_report` event; the turn gets the day's record counted from the
  database (`DayLedger`) and sends the report. The report is a page too (`manager/day-report.ts`, `reportHtml`), charts first
  (the founder, 2026-11-20: "charts, not just text ... interactive infographics first"): tiles (answered today against a
  usual day, what went up, the week's answer rate), the last 14 days (7 at a tap), where people answer, today by the hour,
  today on each site by kind, and how far people got, each with a tooltip on hover or tap (`PgReports.charts`); then who
  answered, what needs them and a sample, kept in `mq.reports` for 60 days and sent as one button,
  "Open the report" (`GET /report/<token>/<day>`, signed like the credits page; `scripts/try-report.ts` makes one now).
  `mq.next_report_at()` is the one clock for it, used by both the queue and
  `mq.next_work_at()`, so a sleeping agent is woken for it. Experiments as a table of their own were cut (2026-11-19).
- **Deep Agents, composed explicitly.** `agents/harness.ts` builds every agent from
  `createAgent` plus Deep Agents' middleware. We do not use `createDeepAgent` (it forces the
  blocking `task` tool) or `AsyncSubAgentMiddleware` (it needs an Agent Protocol server and
  cannot resume human answers). The task queue gives the same start/check/update/cancel/list.
- **Machines sleep when idle.** The agent suspends itself (`lifecycle/idle-sleeper.ts`) when
  nothing runs, no request came for `SLEEP_AFTER_MINUTES` and `mq.next_work_at()` is not
  near. Telegram wakes it through Fly's proxy; the pg_cron job `mq-wake-agent` calls `/wake`
  when queued work falls due. The browser sleeps on Fly's own `auto_stop_machines = "suspend"`.
  Anything new that the agent must do later has to be visible to `mq.next_work_at()`, or
  nothing will wake the agent for it. Work a tap starts that outlives its request (a post)
  runs in `lifecycle/errands.ts`, one of the sleeper's loops, so the agent stays up for it.
  A shutdown (a deploy) starts no new errand (`Errands.close`; the outbox keeps what waits for after the restart) and
  gives a post `ERRAND_TIMES` (10 s) to finish with the server still open for their Chrome, then stops it: not yet sent, its card is open again and they hear nothing
  went out; maybe sent, it is held as uncertain. A start turns any claim a stopped machine left
  (`leftPosting`: Fly kills the machine 30 s after the signal) uncertain, redraws its card with
  "Not there, post again" and says nothing (`recoverPosts`); nothing is ever sent again by itself.
- **Held sends are Quest's to check** (the founder, 2026-11-04: "I don't get 'I can't tell if it went up' ... I would
  rather ignore those and the agent can check on itself later"; `drafts/held-check.ts`, `HeldCheck`). A send it clicked
  and never saw land (`uncertain`) is not on Your move and nothing is said, after a tap, by itself or after a restart.
  While their Chrome is open, code opens its page, drawn, three times after it was first held (10 to 25 min, 3 to 5 h,
  20 to 28 h, `LOOKS`) and records it posted when the page shows it (`verifySent`, never sent again; a reply's watch then
  starts). One never seen stays held quietly, which counts as maybe up, so no second reply goes there; its old card
  keeps "Not there, post again". In memory: a restart looks again.
- **The customer's Chrome reads the web.** Pages, Reddit and web search (DuckDuckGo) are read
  in the customer's own Chrome by the extension; the public APIs (`sources/`) still answer from
  the agent. The customer connects it with a one-time code from the chat (`/connect`, or the
  manager's `connect_chrome`); `mq.chrome_links` keeps hashes only, one Chrome per customer.
  An install from the Chrome Web Store pairs only with Quest's own address (`DEFAULT_SERVER` in
  `apps/extension/src/quest-server.js`), so the agent moving to another address needs a new extension
  version; an unpacked build, the dev extension, pairs with any address but that one ("Production and dev"
  below). What the extension answers must fit
  `http/chrome-outcome.ts` (one field over a limit and the whole read is refused); its tests hold it to that.
  The extension long-polls `GET /chrome/next` and answers `POST /chrome/jobs/:id`; the
  `ChromeBroker` holding those jobs is in memory, so one agent machine serves every Chrome.
  A task whose spec `needsChrome` does not start while the customer's Chrome is offline.
  Quest's tabs sit in a "Quest" tab group of their own in the customer's window, not a window of
  their own (their word, 2026-10-15: "a tab group instead of a new chrome window ... delete the group
  after using"; `apps/extension/src/quest-tabs.js`). They read in the background; one at a time
  comes to the front, only for a page drawn on screen, a picture, input by sight, a fill, or a browser session's step
  on a site whose pages show their posts only while drawn (`platforms.ts` `drawn`, sent as the job's `drawn`), or of a
  session that acts as the customer on any site (the poster's, and `HeldCheck`'s look: `CustomerBrowser.open` with
  `drawn`; the founder, 2026-11-04: "more sites require to be rendering on top for us to press like, comment"), and
  the customer's tab goes back after. Their switch keeps it in the background always: "Bring Quest's tab to the
  front" in the popup (`{ front: false }`) and in Settings on their page (`mq.customers.chrome_front`,
  `POST /glass/front`, told to the extension as `x-mq-front: off`); then a drawn page reads as the background shows
  it, and a picture or input by sight is refused. After 90 s with nothing to do (5 min while a browser session is open, `SESSION_IDLE_MS`: a slow model step closed a post's tab under it), every tab Quest opened closes, and Chrome drops the
  group with the last; a tab of theirs dragged into the group is never closed. They read in the
  customer's own Chrome profile, with their
  logins (their word, 2026-10-02: "it must use the profile where the extension is installed";
  never Incognito, no cookie stripping), only public
  addresses (checked by the agent's `HostGuard` and again by the extension), at a reader's
  pace, 800 pages a day (or what the agent says, `x-mq-pages`). Platform knowledge (Reddit's and DuckDuckGo's page shapes) lives in
  `apps/agent/src/chrome/` as specs; the extension only executes them. While connected, the
  extension keeps the computer awake (`chrome.power`, "system"; `apps/extension/src/awake.js`),
  on by default, off with the switch in its popup; disconnecting lets it sleep. What that
  does and does not hold on a Modern Standby laptop is in FACTS.md.
- **The big sites, read by code** (the founder, 2026-10-23: browsing "cheaper and faster"; `chrome/sites.ts`). X's,
  LinkedIn's and YouTube's searches and Indie Hackers' lists are cut into posts by specs the extension runs (who, when,
  their words, the post's own address, how many answered), never read whole by a model. `search_posts` takes `x`,
  `linkedin` and `youtube` (in their Chrome, each at its site's pace), so the scout reaches X and LinkedIn now, and
  `read_page` on such a page gives its posts, each seen with its own address, so it can be saved from there. A LinkedIn
  post with no address of its own (most, in its new layout) points at its author's recent activity. An X thread and an
  X profile are cut too (`X_PROFILE`: name, bio, site, details, counts, above its posts; `X_ME`: whom it is read as);
  in the browser tools an X page's text keeps only what is above its posts, which come once, as `items`
  (`postsOnce`). In a background tab a thread shows its post but not its replies (X draws them only on screen). A page whose rows
  make no posts is read as it is and logged (`site.cut_empty`), so the spec gets fixed. Not cut: Threads (logged out,
  its search says "No results"), Instagram (pictures with no words); Indie Hackers retired its search in 2026.
  `finds/search-words.ts` makes the searches from the brief in one call, and `finds/batch-judge.ts` judges posts 40 at a
  time on the volume seat against the brief, keeping only picks whose quote is in the post, each with a
  first draft of the reply. The first sweep runs on both; `scripts/try-sweep.ts` measures them against the scout (FACTS.md).
- **The way in (hosted)** (`conversation/way-in.ts`, `WayIn`; 2026-11-19, the open-source plan: nobody waits).
  Someone new is in with their first message: free on an invite's code they bring (a start link, the extension's hello,
  a code Quest handed them in a thread, whose note their first turn starts from), else on `FREE_START_USD` ($1) of
  credits, once ever (`BillingRepository.startFree`, `invite = 'pack'`, quiet for `mq.let_in`), then packs. Invites
  are made in Supabase (`insert into mq.invites (note) values ('Anna') returning code;`). The waitlist, the trial,
  their own OpenRouter key and Telegram Stars were cut the same day.
- **Someone stuck reaches a person** (the founder, 2026-11-06: "Add link to support in the bot"; `conversation/support.ts`).
  Nobody uses commands in a bot (the founder, 2026-11-06), so it is a button: "Stuck? Write to Serhii" under the first ask, the
  Chrome setup and every way to pay, a Help tab on their page, a link on the credits and Chrome pages, and their handle in the
  short description. `/support` and `/paysupport` say the same, for anyone: waiting, off or resting.
- **The first use** (the founder, 2026-10-23: "We have to provide a real value first, making the first use of it
  unforgettable"). The opening has three steps and no form (the founder, 2026-10-24: "We can do more, by doing less"; live,
  he was asked the quest, shown Chrome's install steps in English, and only then asked what he works on). `/start` shows
  the language, their Telegram's first to keep and the rest each in its own name (`sendLanguageChoice`, `lang:` taps; the
  Mini App's picker sets the same `mq.customers.language`, `POST /glass/language`); a tap sends the one question by code, with
  no model call, in that language (`FIRST_ASK`: what they work on, a link if they have one, where they would like to be
  seen; a voice message is fine). Nobody chooses a quest: there is one (the founder, 2026-10-29). Then the manager saves the site, starts the researcher
  and answers in a line or two like a person; `connect_chrome` goes out right under that reply, never before it (the tool
  queues it, `ManagerToolDeps.later`, and the turn sends it after the reply), short and in their language, with the reason.
  It carries one button, Connect Chrome: `/connect` offers the install when the extension is missing, the install reloads
  that tab (`onInstalled`) and it connects by itself; on a phone the page says to open it on their computer. `/chrome` stays
  for setting up another Chrome.
  The researcher reads their site meanwhile (with Tavily, before Chrome). Once the brief and their Chrome are both there,
  the first sweep (`finds/sweep.ts`, `FirstSweep`; once, `mq.customers.swept_at`; started by `save_brief` and by their
  Chrome coming online) reads by code: the search words in one call, then Reddit and the communities the words name, X,
  LinkedIn and YouTube in their Chrome, each at its site's pace, and Hacker News and Bluesky, all at once; the posts
  judged 40 at a time as they come; the picks that were only a title read in full and judged again; the best 15 saved as
  finds (no task). One line in the chat says how far it is, edited in place (`Messenger.startLine`/`line`,
  `ChatChannel.editText`; in the transcript once, as it ended), and it is a run on the Now graph. Their Chrome gone
  halfway: the line says it stopped, and it starts over when their Chrome is back; no search words, or a failure no retry
  fixes soon: they are past it, and the team looks the usual way. It keeps a fact of where their Chrome is signed in (a
  search on X or LinkedIn works only signed in). Until it is over, `start_task` refuses the scout, explorer and outreach.
  Then its finds go to Your move (`FindService.show`, then `IntakeService.begin`, which tells the manager the setup is
  over); the takes are retired (below). There is no questionnaire after the sweep (goal, stage, who pays, ...
  were asked as taps; the founder, 2026-10-24: "I already shared info about my project ... Only specific clarifying
  questions make sense here"): where they show up is read from what they said (`IntakeService.#settleWhere`, the guesser
  on that one question, once there is a brief and after each of their turns until it is known: not only when the takes end,
  which someone who never connects Chrome never reaches; the profile-check nudge comes when the takes end), and the manager does one profile check per platform ("The whole picture").
  When the takes end it may ask the one specific thing the work needs and they did not say, in a line, or nothing.
  How hard to push is balanced.
  While a first-day card waits on them, no find is shown (`FindService.show`)
  and what is due in the outbox waits with the rest of their Chrome's work; a draft, a question or an idea is not held.
- **Your move** (the founder, 2026-10-23: "one deck message in the chat (top ask, "1 of N", turns to the next); "do all" only for likes and follows"; `asks/`; a Your move tab on
  the Mini App, tried the same day, was taken out: the deck is where asks are answered). Everything that waits on them is one ranked line of asks,
  built from the records that already wait (`Deck.asks`): a find on a card (shown in the last 3 days), an open draft (a
  reply only while its post is fresh, 3 days), a team question asked, Quest's idea (a send that may have gone up is
  Quest's to check, never an ask). Likes, or
  follows, on one platform, two or more, are one ask ("Do all 3", One by one, Skip all; nothing else goes all at once).
  Ranked (`rank.ts`): someone talking with them (a private message, a reply to a `conversation` in `mq.results`), the
  team's questions, replies (freshest post first), posts of their own, profile checks (one ask a platform), likes and follows,
  ideas. In the chat it is one message, the deck (`mq.customers.deck`, `ChatChannel.showDeck`): "🎯 Your move · 2 of 6",
  what their last tap did ("✅ Posted: your reply to u/maya", a line from `findLine`/`draftLine`), the ask as its card
  showed it, its own buttons (the cards' callback data, so the services' `act` does the work), ‹ and › to move without
  deciding. A reply's ask (a find's reply, an open reply or message draft) is only the quote and the words, with the post
  as a button ("Maya on X", `openButton`) and nothing else (the founder, 2026-11-04: "there should only be a quote and the
  reply text, no distractions. Links can be added as buttons"; `replyOnly` in `telegram/deck-card.ts`). A tap answers it and the same message turns to the ask after it; a
  send turns it as soon as it joins the outbox. A reply to the deck, typed or said, is a note on the ask it shows
  (`noteOnAsk`), or the answer to its question; Edit asks under the deck, and the note brings the deck back under it,
  silently. A new deck is sent at the bottom (the old one deleted, or its buttons taken off past 48 h) when there is none,
  when it said nothing waits, when asks joined while it is no longer the last message (by the chat's message numbers in
  the transcript), or when someone waits on them; it opens on the ask that joined last, which is what Quest just said is
  there. Otherwise it is redrawn in place, which notifies nobody. At most `DECK_NOTICES_A_DAY` (3) new decks notify a day,
  a person waiting always. Each ask that joins with no card of its own is noted in the transcript as its card was (🔎, ❓),
  so the manager and the follow-ups see it. Cards from before the deck join it and keep working where they are.
  `scripts/try-deck.ts` prints a dev customer's line, and draws their deck. Not moved onto it: the first-day cards (already one at a time), and the manager's own
  questions in its messages. Live, 2026-10-23: held for the first-day cards as well, the X post they dictated during a
  take never showed after Quest said "Your X post is on a card", so the deck holds for nothing.
- **Two ways to read, one seam.** With a `TAVILY_API_KEY`, `main.ts` wires `web/RoutedReach`: the
  customer's Chrome first, and Tavily (`web/tavily-*.ts`: `/extract` for pages, `/search` for
  the web) where Chrome could not try a page (`offline`, `limit`, `hidden`), so public pages and
  web search run with Chrome closed. Reddit, `asVisitor` and `check` reads stay Chrome-only, and a
  site's refusal (`blocked`) is never carried to the other reader. Tavily's failures come out as
  the same `ReadError` and `SearchError` reasons, so no tool changes; the host (never the path)
  is logged, addresses pass `HostGuard` first, and each customer has `TAVILY_CREDITS_PER_DAY`
  (in memory). `researcherSpec({ needsChrome: false })` then starts with Chrome closed; the
  scout and explorer still wait for it. No key: nothing changes. `scripts/try-tavily.ts` is the spike.
- **The work going on, on the Quest button and the live page** (`tasks/task-board.ts`). Nothing is
  pinned or posted in the chat any more (the founder, 2026-10-15: bars drawn in the chat "look
  unpretty"). While a customer's runs are at work, their chat's own Quest button says how many,
  "2 working" in their language (`ChatChannel.showWork`: `setChatMenuButton` with their `chat_id`),
  and goes back to the bot's "Quest" 15 s after the last one stops (a run that restarts inside the
  grace keeps it). Telegram Web cuts a longer label ("Quest · 2 working" showed "Quest · 2 …"). The
  button needs an https Mini App address (`MINI_APP_URL`, else `PUBLIC_URL/glass`); without one the
  page still shows the work. A chat whose button says work runs is kept in `mq.task_boards` (ref
  `menu`), so a restart puts it back unless its work starts again within 90 s; a progress board an
  older version pinned there is unpinned and deleted at start. The board keeps every run in memory:
  the runner tells it `started`, every model call (`step`), every tool call (`tool`) and
  `stopped(finished)`; the poster tells it the same for each card it puts up (agent `poster`, id
  `post:…`) and `waiting(site)` while it waits its turn on a site; the manager's turn tells it
  `turnStarted`/`turnTool`/`turnEnded` (never counted on the button). How far a run is comes from
  the time left: the teammate's p80 over 14 days (`TaskRepository.paces`, timed once it has 3 runs),
  or the pace of its own steps over its budget, whichever ends sooner; it stops at 95% and never goes
  back. `POST /glass/live` (`http/glass-routes.ts`, signed like `/glass/data`) answers from memory:
  Quest's turn, each run (agent, title, share, minutes left, what it does now, the site it is on,
  the site it waits for), the tasks waiting to start (from the database), their Chrome
  (`ChromeBroker.view`: open, what it does, jobs waiting) and the site lanes. The Now tab polls it
  every 2 s while work runs (5 s idle) and draws a graph: Quest on top, a node per run with a
  progress ring, wires to the sites they are on (flowing while active, dashed amber while waiting),
  their Chrome in a line under it, and each run's words and bar below. Nodes and wires are kept by
  id and moved, never redrawn, so the flow and the rings run on smoothly.
- **Quest's face: the Visor.** It is the logo on messaging.quest (`quest.svg`, `favicon.svg`; `node brand/visor/render/render.cjs mark`)
  and the bot's photo. Stickers and moods were cut (2026-11-19); reactions on their messages stay.
- **Honest reach.** Quest says who it is (`QuestBot` User-Agent), takes a refusal as final,
  and never disguises its browser, uses residential proxies or solves CAPTCHAs. Where pages
  meet bot checks, communities' own public APIs (`sources/`) answer.
- **Quest asks before it posts, until it has earned trust.** Every find reaches the customer as
  a card with a drafted message (on Your move, above); they post or send it themselves and tap "I replied", or, on a
  Reddit thread, tap "Post it". A reply to a card, typed or said, is a note on its words: the writer
  puts it in and the card comes back under the note, the older copy without buttons (`applyNote`);
  Edit asks "✏️ What should change?" under the card with a force-reply, and a reply to that counts
  as a reply to the card (`other_refs`). A note that asks for no change, or a card that cannot take
  one, goes to the manager with the card's id and words for `edit_card`. Trust is per platform and
  kind (`mq.trust`, `trustKey`, `drafts/autopilot.ts`): after `TRUST_AFTER` (3) of a kind they approved there, Quest
  offers to do that kind there by itself, an ask on Your move ("You've okayed a few replies on X. Want me to post replies
  there myself from now on?", Yes, go ahead / Keep asking me; `trust` asks, `trustOffer`; the founder, 2026-11-04: "The
  transition to autopilot approve per platform should start with the agent's suggestion"). Only their yes, or their "go
  ahead" (`posting`), sets `mq.trust.granted`; `posting` with `kinds` changes only those kinds, on one platform or each
  one (live, 2026-11-05: "do all likes and follows automatically, ask me for replies, dms and posts" could not be said, and
  "*" went on and back off). A kind on every platform is one row, "* likes" (`everywhere`), read by any site with no row
  of its own and setting the rows that are there (live, 2026-11-11: it was written for the sites Quest knew by name, so each
  Mastodon server still asked for its likes); replies everywhere still go site by site, since "*" is everything. A no starts the count over; a profile change or a private message is never
  offered (`mayGoAlone`). Kinds that went alone before 2026-11-04 kept going (the migration's backfill).
  Words that name their own product or link to their own site always wait for a tap, trusted or not (`namesTheirs` in
  `DraftService.offer`; the founder, 2026-11-13: come back to me only for more input, an ambiguity, or a risky step "like
  share a link to the product"); another maker's link in an introduction does not count. A send written by the poster on a
  page a run read in the last 3 minutes is written in that run's tab (`CustomerBrowser.showing`, `borrow`, `giveBack`;
  `poster.same_tab`), not in a new tab on the same page, and the run's browser steps wait meanwhile (`free`), since the
  broker lets the send's session through. Then the
  manager's drafted replies and posts, and the replies of strong finds as they are shown, go
  up by themselves, 4 to 11 min apart on a site and 1 to 3 min across sites (the outbox
  keeps it), and the card says "Quest posted it". What goes up by itself wakes no manager turn: the reply watch brings its
  answers (live, 2026-11-16: a turn for every send, 220 in two days, and 63 runs started from them, 46M tokens). A reply
  taken down, or "ask me first" (the `posting` tool), sets it back to 0; private messages
  always wait for a tap. A post going up by itself that fails says nothing: its card keeps
  its buttons; a like or a follow that fails so is let go (live, 2026-11-12: with likes on trust everywhere, the failed
  ones came back as asks on Your move). Every post, by tap or not, is one post job: the agent sends the extension
  one post job (`ChromeBroker.post`, ahead of any reading), and the extension posts it from
  the customer's own account in a background tab of Quest's group (never its reading
  tab), through Reddit's own forms (`/api/comment`, `/api/submit`, `/api/compose`), then
  closes the tab. A find's reply goes under the comment whose words it quotes (`Find.replyTo`,
  `t1_…`), else under the post (`t3_…`).
  The manager writes drafts too (`drafts/draft-service.ts`, `mq.drafts`, the `draft` tool): a
  reply (with a short quote that must be in what the turn read, `wasRead`), a new post in a
  community (never one filed as avoid), or a private message, each a card with Post it (Send it),
  Edit and Skip. It also does social actions as drafts of their own kinds: `like` (the post's
  address and a quote of it; a card with Like it and Skip), `follow` (the person's profile and
  handle; Follow and Skip) and `profile` (new words for a field of their own profile, target the
  field, `limit` its characters; Update it, Edit and Skip). A like and a follow have no words
  (`WORDLESS`, an empty body) and never go through the writer; all three go through the page on
  every site, Reddit included (`BROWSER_ONLY`), with no title (`drafts_check` asks one only of a
  Reddit post or message). Each kind earns trust apart ("x.com likes"). Words
  the customer dictated in the turn ("set my bio to exactly: …") go on as written (`theirs`), never
  through the writer. When their message asks for the thing ("update my bio", "like his post"),
  the manager drafts it and `send_draft`s it with their words in the same turn: their ask is the tap.
  Each platform has day limits for what starts there (`platforms.ts`, `drafts/day-limits.ts`):
  new posts, messages and emails, likes and follows together, and profile changes, counted over
  the last 24 hours (Reddit 2 posts, LinkedIn 2, X 10, cold email 20 messages; posts, messages, likes and follows doubled on the eight platforms Quest explores, 2026-11-05; any other site 2
  posts and 10 messages); replies and comments have none (the founder, 2026-10-16), and finds'
  cards are replies. Their page lists them under Settings with what went up today. A double tap
  posts once; what stops a tapped post is said in the chat. Nothing posts in bulk or before the
  customer has approved a few by hand: platforms treat automated promotional replies as spam,
  and the accounts they ban would be the customers'. Quest never signs in, and never asks for
  a login. `apps/extension/src/post-reply.js` is the one piece of
  platform code in the extension.
- **Settings and status.** The Quest button by the chat's message box (`setChatMenuButton`, set at start when there is
  an https Mini App address) opens one page (`public/glass.html`, `http/glass-routes.ts`, `infra/pg-glass.ts`): on or
  off, their Chrome and what runs now, the team's questions, credits, Quest's tab to the front, what goes up alone where,
  and each platform's day limits. People, Live view, Memory, Coming up, Posting's voice and Log were cut (2026-11-19),
  and with them `mq.journal`. `/glass/data` answers only to init data signed with the bot's token (`telegramUser`). A
  route the page calls must be on the tunnel's list (`MINI_APP_PATH`, `scripts/dev-tunnel.ts`).
  The panel's second view (the gear, extension 0.16.0) is the same in Chrome: language, their Chrome, its switches, where
  Quest works (each platform of "Where they show up", on or off as `set_place` files it, and whether its replies go up alone),
  the model it thinks with and the past reports (`conversation/panel-settings.ts`, `GET /chrome/settings`,
  `POST /chrome/settings/platform`).
- **Answers to a posted reply.** `finds/reply-watch.ts` looks at each thread where a reply (a
  find's, or a drafted reply or post) went up with Post it 15 minutes, six hours, a day, three
  days and a week later (`mq.finds.watch_*`, `mq.drafts.watch_*`; a private message is not
  watched), reading it in the customer's Chrome while it is open (then the agent is awake
  anyway, so `mq.next_work_at()` does not need to know), as a visitor (`asVisitor`): logged in,
  the customer sees their own removed comment as if it were up. Comments whose parent is the
  posted reply (for a post, the comments on it), by
  anyone but the customer or AutoModerator, go to the manager once each as an `answers` event;
  the manager tells the customer who answered, what they said, and what it would say back. A
  reply the page shows as deleted or removed (a community's filter on new accounts, often)
  ends the watch with a `removed` event, and the customer hears that nobody else can see it. Reddit's watch is code, no model call.
  Every other site is watched too (until 2026-11-04 only Reddit was: a Threads reply was never looked at again, and
  outreach runs went to the notifications by hand). There one page of their own account shows the answers
  (`answersPage`: X's mentions, Threads' activity, LinkedIn's notifications, else the post the reply went under), read
  once for all of a customer's sends due there, logged in, drawn where the site shows its words only on screen, on the
  looks' own allowance (`check`). A look their minimised or covered window could not draw is not spent: it is tried
  again in `HIDDEN_RETRY_MS` (15 min) unless the next is due by then (live, 2026-11-04: X's mentions spent a reply's
  15-minute look so, and the next came 6 h later). One call on the volume seat reads the answers off it (`finds/answer-reader.ts`,
  `AnswerReader`), each kept only when its words are on the page and are not the customer's (any of their sends, not only those due in
that look: live, 2026-11-05, their own Threads replies on their activity page were told as answers); each is told once
  (`watch_seen`, by its words: the model names one person by handle one look and by name the next, and 13 answers on X
  were told twice; across all their sends on the site, `toldAnswers`, since a list shows the same answers look after look:
  live, 2026-11-05, one question was told ten times in a day; and never when a conversation on record quotes it, or a reply of
  theirs, up or on its card, answers it), recorded as a conversation, and reaches the manager as the same `answers` event, with
  the answer's own address where the page is cut into posts (X's mentions). A like, a follow or a
  message has no watch. Where a model looks for answers (the manager), it opens the platform's notifications first
  (Reddit: reddit.com/message/inbox/, in `platforms.ts` `where`) and reads every answer on one page, instead of opening
  each thread.
- **Places and their rules.** The explorer subagent finds the communities and forums where a
  customer's people ask, opens each one's rules, and files it in `mq.places` (`search`,
  `avoid` or `login`, keyed `reddit:r/<name>` or by host, `placeKey`; all of Reddit is `reddit.com`,
  and `placeKeys` makes every avoid check see a community's platform too). A place is filed only
  after the explorer opened a page in it in that task. A place the customer rules out (or in)
  the manager files with `set_place`, so it is enforced like the explorer's; a place closed by
  its own rules reopens only in a turn where the customer wrote, or by the explorer. The scout's opening lists the places
  to search first and to avoid, and `save_find` refuses a find from an avoided place; filing a
  place as `avoid` drops the finds from it not shown yet and skips its cards still open (`dropWaitingFrom`). The
  manager sees the list on its board and explores about weekly or when scout runs come back thin.
- **Founders and builders only** (the founder, 2026-10-29). `src/quests.ts` holds the one playbook, `PLAYBOOK`: the
  manager's mission, role and first steps, and the scout's idea of a find (people for what they
  built), its age limit, where to look first and what the message is for. Customers carry no quest: no guess from their
  first words, no `/quest`, no `set_quest`, and a start link's argument is only an invite code. Career, Recruiting and
  Custom are gone from the code, the prompt and the Telegram menu (the `customers.quest` column stays in the schema,
  unused). Everything else (cards, decisions, heartbeats) is as it was.
- **The whole picture: where they show up, and one profile check per platform.** The founder, 2026-10-17: "the agent must
  be able to see the picture as a whole, help setup social profiles with the correct description, links etc."; then,
  2026-10-29: profile edits become one ask per platform, "where replies turn into clicks, so it stays, but as a single
  ask instead of a stream of field cards". Where they show up is read from their words (no card): the work happens on
  those platforms first, and nowhere new without asking. Every turn shows "Where they show up" (`presenceLines` in
  `manager/turn-input.ts`): each platform, their account there when a fact names it, and "profile check: ..." or "no
  profile check yet". Once the brief is written the manager opens their own profile on each platform and drafts what needs
  changing, all of a platform's fields at once (kind profile, each within its limit, the link to their site where the
  profile has a field for it, every line true); a profile that already says it right is kept as a fact. On Your move
  they are one ask per platform ("Profile check on X": a line per field; Do all, One by one, Skip all;
  `groupOf`, group kind `profile`), ranked as profile changes. A profile check always waits for a tap
  (`ALWAYS_ASKS` in `drafts/autopilot.ts`: nothing earns trust there). Day limits (`platforms.ts`): 4 profile changes on
  X, LinkedIn, Instagram, Facebook, Threads, TikTok and YouTube, so a whole check fits; Bluesky 3, Reddit 2.
- **Files.** A CV or job post sent as a PDF or plain text is read (`conversation/file-text.ts`,
  unpdf) and handed to the manager as text, up to 15,000 characters; other files get an ask for
  a PDF or the text pasted in.
- **Voice messages.** A voice message, an audio file, or an audio file sent as a file (`voice`
  inbound) is heard as it comes in (`Transcriber` port; `infra/openrouter-transcriber.ts`:
  OpenRouter's `/audio/transcriptions`, `TRANSCRIBE_MODEL` Whisper Large v3 Turbo, then
  `TRANSCRIBE_FALLBACKS`), and from then on it is the text message they would have typed:
  the transcript keeps the words, a reply to a question answers it, it is never a quest
  choice. Nothing is said back about it. One that cannot be heard (no words, a kind of audio
  Quest cannot send, over `MAX_VOICE_SECONDS`, or no model answered) is "🎤" in the transcript
  and a note to the manager to ask for the words typed. Each call is a `transcriber` row in
  `mq.model_calls`; the words are never logged.
- **The voice.** The manager's prompt describes a capable friend helping run their business (a
  sharp, driven 25-year-old who owns the work): warm, informal, honest, contractions and everyday
  shorteners ("5 min", "DM", "btw"), no canned reassurance or forced slang. It decides, works, and
  tells them what came of it, results first, briefly, mostly in the evening report; it asks only for
  what it cannot get or decide without the customer, and then chases the answer. An emoji now and
  then. What is code:
  - `lib/voice.ts` `stockPhrases` refuses a `message_user` (and restates a reply) that says "heads
    up", "happy to help", "friendly reminder" and the like; dashes used as punctuation become
    commas everywhere, and marks of emphasis round a word go (`unstyled`; the founder, 2026-11-06).
  - Every sentence starts with a capital, and "i" is "I" (`capitalized`, in the messenger and on everything the writer
    returns, whatever a voice rule or the model says; the founder, 2026-11-03: "I don't like lowercase, start with a
    capital always"). A handle, a link, a community or a word with its own case (iOS, x.com) stays as it is; words they
    dictate go on as they wrote them.
  - `voiceNotes` asks once for a rewrite of a message over `MESSAGE_WORDS` (25; the report
    `REPORT_WORDS`, 45), one that describes the machinery (search words, pages, error codes,
    experiment numbers), talks about their cards, says when the report comes, opens with a
    title or labels, repeats what they read in the last day, has more than one emoji, a
    launch-post one (🚀 ✨ 💡 …), or an emoji when the last two messages had one too, or that
    reassures with a stock line ("no worries") or dresses up in slang ("bestie", "slay", "it's giving"; slang that lands is the voice). First of
    all, one that is plainly not in their language (`otherLanguage`): another script, Russian for
    Ukrainian, or another Latin-script language's common words, with quotes, links and handles left out.
  - `manager/follow-up.ts`: a message that asks (a sentence ending "?", or an open question
    card) and gets no word back is followed up about an hour later, again 4 h after that, then
    daily at 10:00 their time, never between 21:00 and 09:00 their time, for a week. The turn
    sets the wake as a pending `follow_up` event due then (`FollowUpSchedule`, one per
    customer); a turn woken for it that wrote nothing gets one more step to write the follow-up.
  - `manager/tools.ts` `holdBack`: Quest writes first at most `FIRST_WORDS_A_DAY` (2) times a day,
    `FIRST_WORD_GAP_MS` (3 h) apart and once a turn; while they are in the conversation (wrote
    within the hour) it follows up, but not past `UNANSWERED_NUDGES` (2) unanswered. A due
    follow-up, the evening report and news about a reply they posted always go out. The silence check after finished
    work runs only while they are in the conversation. A notice of something they did (`DONE_MARK`, "✅ Chrome
    connected") is their move in `chatPulse`: the count starts again from it, so the line saying what Quest starts
    goes out.
  - Tasks the manager starts on its own are capped at `UNATTENDED_STARTS_A_DAY` (8) a day, and the
    Chrome setup, or a reconnect link for a silent Chrome, goes out once in 12 hours unless they ask
    (`OFFER_AGAIN_AFTER_MS`); until then every turn sees when it went out (`ChromeStatus.offeredAt`) and
    is told not to send it again or bring it up.
  Each turn shows the chat's pulse: when they last wrote, what Quest said since (and today), their hours.
- **Models.** The decisions (the manager seat) run `deepseek/deepseek-v4.1-flash` through OpenRouter, with
  Claude Haiku 5.5 and GPT-6 Luna Pro as fallbacks; the vision seat (pictures they send, the posting browser,
  post checks) runs Claude Haiku 5.5; the writer seat (every word that goes out as them) runs Claude Sonnet
  5.5; the teammates (researcher seat) run `xiaomi/mimo-v2.6-pro`, with Claude Haiku 5.5 (it reads
  pictures too) and DeepSeek V4.1 Flash as fallbacks (`config.ts`; the measurements are in FACTS.md). On a dev laptop every seat
  runs on the Claude subscription instead, on Opus and Sonnet (`MODELS=claude-cli`, "Production and dev").
  The manager runs with reasoning off (`MANAGER_REASONING`). The
  `volume` seat (DeepSeek V4.1 Flash, reasoning off) condenses a run once its prompt passes
  `SUMMARIZE_AT_TOKENS` (90,000; Claude's price is five times higher past 100,000) (`summarizer()`);
  a teammate moves to another seat with `AGENT_SEATS` ("explorer=volume"), no
  code change. A call that stalls fails at 60 s (90 s for a teammate) and goes to the seat's next
  model at once, and so does the rest of the run (`stickyFallback`, `*.model_fallback`): going back
  to a provider that never saw the run paid its whole prompt each step; only then does the step retry.
  `CHEAPEST_SEATS` (manager, volume) send each call to the model's cheapest provider first, discounts
  counted, at 8 bits or more (`provider.sort: "price"`, `SERVED_AT`): DeepSeek V4.1 Flash then costs
  about $0.02 a million input tokens, cached. Not MiMo's seat: its cheapest provider did not cache. A
  request with a Claude model in its list carries `cache_control` at the top, which OpenRouter keeps at
  the end of the prompt as a run grows: Claude caches only where it is told to. Every model call and
  tool call is logged (`manager.model`, `tasks.tool`, …) with its time, the model that answered,
  and, for a model call, what it used (`tokensIn`, `cached`, `tokensOut`, `cost`).
- **Cache-friendly prompts.** A provider's cache bills a prompt it has already seen at about a
  hundredth of the input price (FACTS.md, 2026-10-07), so each agent's system prompt is standing
  text, the same for every customer and turn (`managerPrompt` changes only with the team it describes; a
  teammate's is its spec's), and everything that changes (the briefing, a task's opening) comes
  after it. Each run sends OpenRouter a `session_id` (`ModelRun`: the manager turn's or the task's
  thread id), so all its calls go to the provider that took the first one, and read what the run
  already sent from that cache. Never set `provider.order`: it overrides that routing. A price sort
  (`CHEAPEST_SEATS`) is the one exception: the cheapest provider is the same for every call, so the
  run stays with it anyway.
- **What it costs.** Each model call is a row in `mq.model_calls` (`infra/pg-spend.ts`, best effort,
  kept 30 days): customer, task, agent, model, tokens in, cached and out, and OpenRouter's cost.
  `mq.model_spend` sums them by day, customer, agent and model, with `cache_share`. The browser
  poster and the picture checks (`browser-vision`, no customer) are in it too.
- **Pay as you go, and a day's limit** (the founder, 2026-11-03: "we are switching back to pay as you go ... a common $5
  per day limit without exceptions, for everyone ... only pay as you go packs for now, no subscriptions"; `billing/`).
  Two ways in: an invite, free, or credits (a free start, then packs). Credits are dollars of what their model calls cost (`mq.model_calls`), always shown as money ("$1.00",
  `money`). How they use Quest is `access` in `Energy.view`: `credits` (`invite = 'pack'`), else `invite`.
  - **The day's limit.** `DAY_LIMIT_USD` ($5) for everyone, invite included, counted from their midnight
    (UTC until Quest knows their time zone); the founder raises it once people pay, so it is shown nowhere (the founder, 2026-11-06: "We don't need to show daily limit at all"). A
    model call made for them brings a look at their day a moment later (`billing/energy.ts`, one read for the calls in
    between); past 80% the manager hears it is tired and starts only what matters most; at the limit they rest until
    their next midnight (`mq.customers.rest_until`): their runs in flight stop and go back to the queue
    (`TaskRunner.rest`, their try given back), the queues claim nothing of theirs but the evening report
    (`pg-events.ts`, `pg-tasks.ts`), `mq.next_work_at()` wakes nobody for their work before the rest ends, and a turn
    already running finishes. They hear it once, in code, with no number (`billing/credit-words.ts`: "That's a full
    day's work for me"). A message while Quest rests gets "resting for 7 h more" once a rest, then a 😴.
  - **Credits.** `mq.wallets` (paid, bonuses included, and spent) and `mq.topups` (one row per Stripe Checkout session).
    Each look draws their calls from the wallet (`draw`: each call once, past `counted_to`, ten seconds settled, never
    below zero; passed over while their own key pays); an invitee who bought some spends them first, then is free.
    Someone in by credits who runs out stops until a top-up (a rest of 30 days, "I'm out of credits", a Top up button).
  - **Packs.** `PACKS`: $20 and $100; their very first top-up adds a bonus ($5, $40). Their credits page
    (`/plan/<token>`, signed with a key made from the bot's token: the link is the key; `http/plan-routes.ts`,
    `plan-page.ts`) shows what they have and the packs (none for an invitee); a pack is a Checkout in payment mode, cards
    only, its price in `price_data` (`billing/checkout.ts`). Stripe's webhook (`POST /stripe/webhook`, signed with
    `STRIPE_WEBHOOK_SECRET`) credits what `amount_total` says, once (`topUp`). A stop for credits ends at once and the
    manager hears it (`system`, `credits`); a rest for the day holds.
- **Heartbeats look only when something can move.** The hourly heartbeat was a model turn every
  hour for every customer. Now a turn woken only by heartbeats first asks
  `manager/heartbeat-gate.ts`, in code: the model runs when
  finds wait with no card open in their daytime, or when nothing runs and work could start (starts
  left today, and their Chrome open or a teammate that needs none). Otherwise the turn ends with
  `manager.heartbeat_skipped` and its reason. A look that told them nothing and only looked rests
  the heartbeats for `QUIET_HEARTBEAT_BACKOFF_MS` (3 h, in memory); any other turn ends the rest.
- **Working at night** (the founder, 2026-11-05: "I'd like the bot to work at nights as well doing the actions I approved").
  Nothing that goes out waits for morning: the outbox, the rotation and what goes alone run at any hour, and a find waits for
  their day only when it would wait on a tap (`daytime` in `heartbeat-gate.ts`). All of it needs their Chrome, so it stops
  when their computer sleeps or they switch Quest off. `npm run dev` holds the laptop up while it runs (`keepAwake` in
  `scripts/dev-agent.ts`, `KEEP_AWAKE=0` lets it sleep), but a closed lid is Windows' own setting (FACTS.md, "Working at night").
- **Always exploring** (the founder, 2026-11-04: "I want the bot to be much more active than it is, exploring all the
  time. All socials, except Reddit for now"; `tasks/rotation.ts`, `Rotation`; overnight a heartbeat look chose to wait,
  rested 3 h, and nothing ran from 00:38 to 07:23). `ALWAYS_EXPLORING` ("1" or "0"; unset, on for dev and off for
  production, where every run is paid for). Every 30 seconds, for each customer whose Chrome is open
  (`ChromeBroker.onlineCustomers`), let in, on, past the first sweep and not resting, code starts the outreach teammate
  when fewer of their runs are at work than `TASKS_PER_CUSTOMER`, with no model call: kept to the platform of theirs
  ("Where they show up", `pickedPlatforms`, email aside) whose last run is oldest (weighed by how it went, below), never worked first, titled
  "<Platform>: builders who just shared their work" (`rotationBrief`), day and night. It doubles down where people answer
  (live, 2026-11-04: 13 answered on X, nobody elsewhere, and every site still got an equal turn): the time since a
  platform's last run counts `ANSWERED_WEIGHT` (3) times over where someone answered this week, and `QUIET_WEIGHT` (0.5)
  where `QUIET_AFTER` (5) of their words went up to nobody (`howItWent`), and the run's opening says how its site went
  and what to do about it (`wentLine`). A platform is passed over while a
  run is at work there, for `SITE_REST_MS` (8 to 25 min, drawn from that run) after its last run started, while its day's likes and follows are
  spent, while `CARDS_WAITING` (6) of its cards wait on their tap, for `WALL_REST_MS` (12 h) after a run there met a
  sign-in wall or two failed, for `EMPTY_REST_MS` (3 h) after two that found nobody (each as a run says it: Discord's
  "isn't signed in", Telegram's "I reached nobody", `SIGNED_OUT` and `NOBODY`) or three in a row that put nothing up, and when they ruled it out (an avoid place: "reddit.com"). It reads their last `LOOK_BACK` (400) runs: the last 30, about 3 hours of them, let a sign-in wall's 12 hours fall out of view, and Discord met its wall every 3 hours. The manager's day of starts is
  then `EXPLORING_STARTS_A_DAY` (400, the rotation's runs count in it), its prompt says the routine runs are code's, and
  their Chrome reads `CHROME_PAGES_A_DAY` (5,000, the most the extension takes, since 2026-11-14, when 3,000 were spent by the evening; 800 otherwise; doubled 2026-11-05, the founder: "increase the amount of posts and reads allowed up to 2 times"), told to the extension as `x-mq-pages`. A task kept to
  a platform opens any of its addresses (`onSite`: t.me as well as web.telegram.org, discord.gg as well as discord.com).
  Organic, with no cap on a day beyond the platforms' own limits (the founder, 2026-11-04: "let it do the browsing
  organically with random pauses between actions, no specific cap per day"): after any run of theirs starts or ends, the
  next waits a breather drawn from it (`BREATHER_MS`, 10 s to 1 min; the founder, 2026-11-06: "It should be working every minute between the organic pauses"), and every click, keystroke and scroll in their Chrome
  comes after a moment drawn afresh (`BrowserPauses` in `chrome/browser.ts`, wired in `main.ts`: 1.2 to 4.5 s before an
  act, 0.7 to 2.5 s before a scroll; none in tests). Likes and follows are nearly free, so a run gives them widely (up to 15 and 8; the founder, 2026-11-06: "I don't think we are doing enough follows and likes"): `find_people` also gives a "Worth a like" list, posts its searches turned up that a wider play (`LIKE_PLAY`) passes, with no check needed. A pause a loop looks at again (the outbox every 15 s, the rotation
  every 30 s) is drawn from what it follows (`pauseFor`), else the shortest would win at once.
- **One browser task at a time** (the founder, 2026-11-11: "reduce the work in parallel to a single browser task at once ...
  many websites have to be on foreground to render properly and allow you to click a button ... no idle is allowed when the
  agent is active"). Live, 2026-11-10: the Claude subscription's limit failed every run for 43 minutes, the rotation read each
  site as "its last two runs failed", rested them 12 hours, and nothing ran for 7.5 hours after the limit was over.
  - **One thing in front** (`ChromeBroker`, `#front`). A browser session (a run's, a post's) and a read drawn on screen need
    the front of their window. Whoever took it keeps it between its steps for `frontHoldMs` (40 s; `FRONT_MAX_MS`, 4 min,
    with others waiting), until it closes its session; a post being written takes it as soon as the step in flight ends; a
    drawn read holds it for its one page. Plain reading (people's sites, searches, pages that render in the background) goes
    on beside it in the other tabs: that is what several tabs are for now.
  - **One run at a time.** The rotation starts a run only when none of theirs is at work (`perCustomer: 1` in `main.ts`;
    the manager may still start its own), and not while something of theirs is going up or due in the outbox (`sending`).
  - **Never idle** (`tasks/rotation.ts`, `EXTRAS`, `nextExtra`). Besides each platform's turn, runs known by their
    title and due by a clock: a post of their own per platform (`ownPost`, every 6 h while its day has posts left and none
    waits on their tap; the founder: "more of actual posts"), "What works" (every 12 h: their numbers on each platform's own
    analytics and their site's, PostHog when their Chrome is signed in, ending in three lessons the manager keeps), "New
    places" (daily, the explorer: where else founders gather or a product is listed, with the three worth starting on), and
    "The wider web" (every 3 h, and whenever no platform is open, at most every 25 min: Hacker News, Indie Hackers, Product
    Hunt, Bluesky, Mastodon, dev.to, web search, an email where their site gives one). Never two extras in a row while a
    platform is open. Nothing to start is logged once with why (`rotation.idle`). A run's check before a word is deeper
    (up to 5 people: their site tried as a visitor would, `read_site` pages 3, their listing, what they posted before).
  - **The models' limit is a rest, not a failure** (`lib/model-rest.ts`, `modelRest`). A call the subscription turned
    away notes when it is over; until then no CLI is started, the rotation starts nothing, the outbox holds what is due, a
    run that met it goes back to the queue with its try given back (`tasks.models_rest`), and `passedOver` does not count
    a run it ended. The reply watch opens no page of a site whose answers a model reads (live, 2026-11-14: 63 looks read
    their notifications during a two-hour rest, each for nothing).
  - **Tabs** (extension 0.12.8). A site has one reading tab, whichever poller reads it (`siteSlot`: the agent hands out
    one page of a site at a time; live, 2026-11-11, four Instagram tabs stood open, one per poller and one for a session).
    Each tab a job used is stamped (`used:<tab>`), and one no job used for `STALE_TAB_MS` (45 s; a session's 5 min, which
    the agent closes itself when its run or post ends) closes while the others work on (`tidy`), so the group holds only
    what is in use and goes with its last tab. The poster closes its tab whatever came of the send (one never seen landing
    is looked at later in `HeldCheck`'s own tab). A group titled Quest that is not the extension's own now (it was reloaded
    or updated and forgot its tabs) is closed on the next look (`closeStrayGroups`). Switched off, the agent says so (`x-mq-off`) and Quest's tabs close at once. Each poll says how many of
    Quest's tabs are open (`x-mq-open`), logged when it changes (`chrome.tabs_open`).
  - **Two Quest extensions in one Chrome** (extension 0.12.12; live, 2026-11-12: the founder's Chrome has the published
    one for production and the dev one). Each closed the other's "Quest" group every 30 s as a stray of its own
    (`closeStrayGroups`), so reads met "No tab with id", a send's session "expired" between its steps, and the tab count
    ran to 15. The dev extension's group is "Quest DEV" now (`nameGroup`). A tab of Quest's that is closed leaves its
    list (`forgetTab`, `tabs.onRemoved`), so `x-mq-open` is true. Quest's tabs are never discarded by Chrome's Memory
    Saver (`autoDiscardable: false`), and it keeps at most `MAX_READING_TABS` (4) reading tabs: past them the one
    longest unused is read in again (`spareTab`), where each site had its own until it went stale. A new dev build
    stops new jobs, waits for the jobs in flight and open sessions (`RELOAD_WAIT_MS`), then closes and reloads once:
    before, it closed Quest's tabs at every idle instant and reloaded only if still idle after, which under constant
    work was never. Measured after: tabs 0 to 3 and back to 0, no tab lost.
  - A like already on counts as done: on the post's own page, when its first Like reads as on (`alreadyOn`; the model sees
    it on and will not press it). A like that turns a second control reading the same ("Unlike" on a comment beside the
    post's own) is seen too (`doneControls` counts each).
  - **A sign-in wall ends a send at once** (the poster's `signed_out`, `ChromeError("login")`; live, 2026-11-11: a reply
    on a Mastodon server they have no account on tried for two minutes and said "tap Post it to try again", four times). They
    hear their Chrome isn't signed in there, and nothing more is drafted for that site for 12 hours (`DraftService`
    `#signedOut`, in memory).
  - **Mastodon goes through their own server** (`chrome/fediverse.ts`). A post lives on its author's server; the poster
    opens it from the server their account is on (`https://<home>/authorize_interaction?uri=<post>`), which is then the
    site the send belongs to. Their server is read from a memory that names Mastodon with their profile's address
    (`fediverseHome`): none kept, and a post on a server they are not signed in to ends as signed out.
  - **Quest's cursor and glow** (extension 0.12.9, `apps/extension/src/cursor.js`; the founder, 2026-11-11: "a smooth
    green-glowing cursor that shows what the agent is doing; maybe some edge glow as well"). A browser session's page has a
    glow round its edge, in the logo's accent (#ceff32), while Quest works in it and a cursor that glides to each control it uses, with a ring on
    a press. Drawn in a closed shadow root with no pointer events, so Quest's own reading and clicks never meet it; hidden
    while a picture is taken, so no model sees it; gone 90 s after the last step. A click by sight waits 300 ms for it to
    arrive; a click by control waits for nothing. Reading tabs have none.
  - On LinkedIn the Connect that counts is the profile's own (`connectFor`: "Invite <name> to connect" only when the
    page's title has that name; live, 2026-11-11, a follow was pointed at a suggested person's button three times), and an
    invitation already open is sent by its "Send without a note".
    A request that went leaves a profile whose own button is Follow as it was, so the invitation gone, with no word of a
    limit, is the receipt (`browser.invited`).
  Measured live in FACTS.md ("One browser task at a time").
- **Where people come from, and the gift** (the founder, 2026-11-11; over two weeks on dev 270 replies brought 128 people
  who answered, nothing said whether one came, and of 366 people kept none had been given more than a like or a word).
  - **Tagged links** (`drafts/tagged-link.ts`). Every link to their own site in what Quest writes (a post, a reply, a
    message, a profile field, where it still fits) carries `utm_source=<platform>` (`tagLinks`, in
    `DraftService.offer`; words they dictated go as written). Their analytics then says which platform sends people,
    and the "What works" run is told to read it. For Quest's own landing, `analytics.js` passes a visit's
    `utm_source` on to the start buttons as `?start=from_<platform>`, and the bot keeps it once for someone new
    (`mq.customers.came_from`, `customers.came_from` in the log).
  - **A customer of their own** (`customers_for` in `tasks/find-people.ts`; "act as a middle man connecting
    people and get them real customers"). For someone kept with `note_person` who answered or is due help, the
    outreach teammate asks the finder for people asking for what that person built (`PlayAsk.about`: their product
    in place of the customer's brief, no decisions, no past searches, no likes, its own search count, nothing in
    `mq.searches`), only the ones the judge calls strong ("the gift must be really relevant, a few potential people
    who are ready and warm"), up to 2, two people a run (`GIFTS_A_RUN`). It brings them together from both sides
    ("maybe Quest can even talk from both sides as a middleman"): to the builder, what the person is looking for with the
    link to their post; to the person asking, after the usual check and a like, that this builder makes just that, by
    handle or profile address (other people's posts and profiles are not promotion, `othersLinks`; a site's link
    would be). Nothing about the product.
  - **Who the words go to** (`rotationBrief`; the title is now "<Platform>: people who need what they built"). A: the
    people the product is for, saying in their own post that they have the problem it solves or asking for such a thing;
    words go to them. B: fellow builders sharing their work; likes and follows. Whoever plainly uses what the product
    runs on (for one that lives in Telegram, a t.me link in their bio or site) is preferred among A. Every platform still
    gets its turn (the founder: "I want to cover as many and gather more statistic before focusing on few"). Held in
    code (the first retargeted run found nobody in pain on LinkedIn and wrote to three builders): `find_people` adds
    `NEED_ONLY` to every play, so only someone with the problem, asking for such a thing or for feedback is a pick, and
    a reply to a post from its "Worth a like" list is refused unless the post asks for feedback (`likeOnly`).
  - **Searches read deeper, with fewer words** (extension 0.12.10). A LinkedIn search read gave its first screen, about
    3 posts, so that run looked at 33 posts in 17 minutes: LinkedIn shows a few and then a "Load more" button. A reading
    job may ask for more (`ChromeJob.more`; `deeper` in the extension scrolls and presses a list's own Load more,
    `loadMore`, the one thing a read presses: LinkedIn 4, measured 2 posts before and 11 after). LinkedIn is searched
    by closeness inside the time asked for, not by newest, which matched anything from the last minutes ("first users"
    gave an outage notice; by closeness, "My first five software products made $0"). The search words are told that a
    site wants every word in the post, so half are two words ("first users", "zero signups"). The finder writes 12
    searches and stops after 6 in a row with no pick (`FINDER_EMPTY`; a model's own searching still stops at 3): an X run
    had stopped a minute in, after 3 searches with 7 new posts between them. A pick whose post has no address of its own
    (LinkedIn: its author's activity page) is checked against the post there that holds its quote, not the first one:
    all 3 picks of a LinkedIn run were dropped so. `finder.done` logs why picks were dropped (`drops`).
  - **Telegram itself** (`TELEGRAM_STEPS`; live, 51 runs in a week reached nobody: the teammate was never told how to
    search there, the one builders' group was not joined, and their Russian-language founders' chat was passed over as
    not English). A Telegram run works the chats they are in, in any language their chats are in, with each chat's own
    search for the words people in A use; finds public channels and groups with a web search kept to t.me
    (`SITE_SEARCH` now says so) and reads a channel at t.me/s/<name> and its comments; and ends its report with up to
    3 groups worth joining, since joining is theirs.
  - **Introductions: two people who need each other** (the founder, 2026-11-12: "to get at least one paying customer it
    must connect at least 100 people per day ... Focus on people using Telegram already"; `finds/pair-finder.ts`,
    `PairFinder`, the outreach teammate's `find_pairs`, the rotation's "Introductions" run every 40 min,
    `scripts/try-pairs.ts`). Searching for one builder's customers (`customers_for`) found nobody; matching two lists
    does: a week of people asking and a week of people launching, read side by side in one call on the volume seat
    (`PAIRS_SYSTEM`, up to `MAX_PAIRS` 8). The lists come from Hacker News' Ask and Show (Algolia, no browser), the
    shared cache (below), and a few searches a run on X, Reddit, LinkedIn and Bluesky (the exact phrase there), Telegram
    by a web search kept to t.me, and Mastodon's hashtags: each run asks the next stretch of the phrases (`stretch`,
    `TURN_MS`), so the lists grow from run to run instead of one run asking everything. What launched also says whom to
    look for (`#wanted`, `WANTED_SYSTEM`): the kinds of people several launches are for, each with the words such a
    person types, searched as asks. The teammate reads both posts and writes one reply under each that points to the
    other (`intro`: no like first; an introduction by email skips the check by handle, `introMail`), in the voice
    `INTRO_VOICE` holds (like passing a friend's name along; never "check out"). Hacker News and Reddit are read and
    never written to (`CLOSED`; Reddit is read only for the founder, 2026-11-12): that person is reached where else
    they are, and half of each list is kept for people who can be answered where they posted. An introduction is never
    cut to a few words (`handedOver` draws no shape in the writer).
  - **Introductions by code, from the makers' side** (the founder, 2026-11-12: "both much more targeted and selective and at
    the same time process much more people", "Don't stop ... until Quest will be able to find a match for 100 people";
    `finds/introducer.ts`, `Introducer`, `mq.pairs`). Matching 122 asks against 400 launches gave 3 pairs: few people ask
    for a tool in so many words, while a launch's users say the need every day. So the matcher also starts from the makers
    (`#needs`): for the freshest launches (90 a look, each again after 6 h) one call writes what a first user would post
    before knowing the thing exists (three exact phrases), Bluesky is searched for each, and a second call keeps up to three
    people per launch who plainly are who it is for (`NEED_JUDGE_SYSTEM`; `asked` says whether they asked for such a thing).
    One look gave 30 pairs. Every pair is kept in `mq.pairs` (shared, like the cache), and a loop (every 12 min the matcher,
    every minute up to two makers) writes the introduction through `DraftService.offer`, so one reply per post, trust, the day
    limits and the outbox's pace hold: the maker gets one reply with the people found for them (two links on Bluesky, three
    elsewhere), and the other person is written to only when they asked. Whoever is on Hacker News or Reddit is left to the
    Introductions run (`find_pairs` with `closedOnly`, `pairsForRun`), which finds where else they are. The matcher's model
    answers "L3" and "P17" as well as numbers, and a pair whose reason shares no word with both posts is dropped (`saysBoth`:
    a number that pointed one line off paired an ask with a Russian essay).
  - **What a night of watching it changed** (2026-11-13; in twelve hours 474 pairs of 706 people, 90 introductions up, 17 answers on record, some of them misread). An
    introduction's starting words are drawn from several forms (`askerDraft`, `makerDraft`; the founder: "don't use a
    single message template for each person"). A launch's link goes to one person (`askerTold`: the writer never hands a
    link to a second, and the words lost their point). Never matched: the customer's own posts (`theirs`), a post in
    another language (`ENGLISH`), a fundraiser. A founder who says they need customers (`needsCustomers`) is not pointed at
    another tool: the Introductions run checks them and finds them people. With Bluesky's line full, makers elsewhere are
    still written to (`WAITING_ELSEWHERE`).
  - **Words first, the link once they answer** (the founder, 2026-11-13; over a day 111 introductions carrying a stranger's
    link brought about 5 answers, 3 of 40 plain words did). `WORDS_FIRST` in `finds/introducer.ts`: the maker hears that
    people are asking for what they built and is asked if they want the posts; whoever asked hears someone made it and is
    asked if they want it. Both are kept with a plan whose `Links:` holds what was offered, and the watch's next step
    (`nextStep` in `main.ts`, `linksOf`, `linkStep`) hands the links over on their first answer. The Introductions run's
    `INTRO_VOICE` says the same. The makers' side searches X every other time and LinkedIn one in six
    (`NEEDS_ON_X` 20, `NEEDS_ON_LINKEDIN` 4), not Bluesky alone.
  - **Everyone who answered hears back** (live, 2026-11-13: of about 60 answers in three days some 45 got nothing, questions
    among them). In the watch, an answer that asks nothing gets a like on its own address by code (`likeAnswer`); a question
    is named in the `answers` event as OWED AN ANSWER, for the turn to answer from what it knows. A post of their own draws
    its kind in code (`POST_FORMS`: finding a kind of person, a fun question, a "what are you building" thread, a moment
    of their week, an honest take; the founder: "This wall of similar posts is a bit concerning, need some fun ones too").
  - **Step two is code's** (`stepTwoDraft`, `ReplyWatch` `plan` and `nextStep`, `Acquaintances.planFor`). Of ten people
    who answered overnight the manager replied to one, with a joke. When someone with a plan on their record answers
    (found by a name inside their handle: an answer is read under a display name), the watch drafts the plan's next step
    as a reply to the answer's own address: what the customer does, in passing, no name, no link, and an offer of more.
    Words sent as help may say that (`helps` counts as `gentle`). On an answer's page X lists the customer's older reply
    after it: `answeredBelow` no longer takes a post older than the one answered for an answer (`rowAge`, which reads
    "· Nov 13" as well as "· 5h"; the answered post's own age from its status id when its row shows none). With the reply
    box open X lists a copy of the post being answered first, so the quote is looked for from the end (live, 2026-11-14:
    three answers to people waiting were stopped twice each as already answered).
  - **Groups: Telegram and Discord** (the founder, 2026-11-13: "Why are we not commenting inside discord and telegram
    groups? You can join any relevant"). In a week no word went up in either, for three reasons. A chat in Telegram Web's
    list opens on mousedown, and Quest's click was `el.click()` alone, so no run ever read a group: a click is now the
    whole press (extension 0.12.13, `browser-page.js`). A first word needed a like or a follow first, and neither site
    has one: a group chat is exempt like Reddit (`Acquaintances.firstWord`). Every reply in a chat shared one spot (the
    address without its #), so the first would have been the last: the spot is the person in that chat (`replySpot`,
    `who`). Their runs have steps of their own (`TELEGRAM_STEPS`, `DISCORD_STEPS`, `IN_A_GROUP`: any builder who can be
    helped today, up to 6 replies a run), and Quest joins a group itself only when their decisions say it may
    (`JOINING`), else it names up to 3 in its report.
  - **A maker is asked before they are introduced** (the founder, 2026-11-14: "Want their post ... feels a bit unnatural
    ... ask for permission to write introduction for this person instead, under the post found and then share the
    result"). `makerDraft` asks if Quest may introduce them; the plan keeps an `Introduce:` line per person
    (`introduceLine`, `introsOf`), and their yes (`nextStep`) writes `introductionDraft` under each person's post (their
    handle on the same site, else the launch's link), then `doneDraft` to the maker with the posts. Someone already told
    counts as done.
  - **The opener says who is on the other side** (the founder, 2026-11-14, later: "Quest must already know who is on the
    other side ... share some information from the posts it found in the opener ... like Boardy"). `makerDraft` is a
    frame drawn in code: a first sentence with one everyday shortener ("found 2 ppl looking for THING rn", "theres"),
    a detail from each person's post, one in three opening on their project, and a drawn ask to send them the maker's
    link. Whom was found and what each said run on in one sentence, in the voice of someone glad to connect people
    ("Hey, just ran into two people looking for THING, one DETAIL1 and the other DETAIL2. Happy to connect you, ok if I
    send them your link?"; the founder, later that day: "The first two sentences feel like glued together ... I just
    naturally happy to help"). The writer fills only the words in capitals (`FRAMED`; a frame left unfilled is refused). Whoever asked hears
    nothing until the maker says yes. Then the link goes under each post, `doneDraft` gives the posts and who is writing
    ("I'm Serhii btw. I use my automation to find users on socials"), and their next answer, whatever it says, gets the
    product's name and the ask for feedback (`nameDraft`, offered with `ask`, so it goes alone).
  - **A Chrome that takes a page and never answers** (live, 2026-11-14: 45 minutes, five replies back on cards): a send
    that timed out opening its destination waits in the outbox like one whose Chrome is gone.
  - **Sends that did not go up** (live, 2026-11-14: ten taps in a minute, one went up in 35 minutes). Three causes. The
    extension's tab steps go one at a time (`tabbing`) with no time limit, and one that never ended left every job, a
    plain page too, to run out its 85 s until the extension was reloaded: a step now lets the next in after 20 s. The
    outbox claimed everything due at once and the sends waited their turn in memory, so a restart held all that had not
    begun as "maybe sent" and two replies on one site were due with no pause: it now claims one send a customer at a time
    (`#going`), and the rest stay queued. And a page slow to answer a step before anything went out ended the send: the
    poster looks again, up to `SLOW_STEPS` (3) times. In the poster's line a reply, a message or a like goes before a post
    of their own (`SiteLanes.run` `long`). The same day: a Bluesky post in a thread whose first post limits replies shows
    a Reply button that does nothing, so the poster asks Bluesky's public API first and ends such a send as gone
    (`chrome/bluesky-gate.ts`); `cannot` for a control not found is refused until the run scrolled (a maker's answer on
    Mastodon sat below the fold); the makers' side of the matcher gives each search 25 s (`NEED_SEARCH_MS`: searches
    waiting in their Chrome made it miss the look's deadline, and no pair was made for five hours); and a frame is
    checked only for keeping its own sentences (`keepsFrame`), since the free-reply checks sent it back and it was rewritten.
  - **Who is waiting for an answer** (the founder, 2026-11-14: "you sometimes are more aware of which people are waiting
    for replies than the Quest itself ... Don't miss the unread counters"; `tasks/rotation.ts`, `waitingOn`, `whoWaits`).
    An answer reached the manager once, as an event, and nothing looked again; a private message's answer was never
    watched; an answer read off a list is kept under a display name, so step two found no plan (a yes to "want the link?"
    on X, a builder who answered their own LinkedIn post with his product and two questions about Quest sat one to two
    days). Each platform now has a run, "<Platform>: who is waiting for an answer", every 2 h while the records name
    someone (answered in 4 days, nothing of theirs to that person since) and every 6 h otherwise: it opens the
    notifications and the messages, goes by the unread counters first, and answers each. Telegram gets the most turns
    (`TELEGRAM_WEIGHT` 4: "more focus on Telegram groups"). No site's line of openers passes `SITE_WAITING` (3). No
    stories are drafted for Medium for now: its editor is one box, and a fill puts every line into the title.
    Comments under their own posts have a run of their own, "<Platform>: comments under their posts", every 3 h at
    priority 0 (`underPosts`; the founder, 2026-11-16: "you have to answer all comments under your posts, it fires up the
    algorithm and we get multiple times more exposure", on the Product Hunt post on X and the LinkedIn downtime post). Every
    comment gets words, praise too (a like alone only for spam); live, the day before, praise got a like ("a like is enough"),
    thank-yous were refused as small talk, and 3 of 30 comments under the LinkedIn post were answered before the run ran out
    of steps. A reply under their own post is no first word to a stranger (`underOwn` in `outreach_draft`, and
    `SeenPages.underOwnPost`: a post of theirs above the comment on any page opened, since a comment's own page starts with
    the comment), and words the watch already recorded
    as an answer need neither the quote on a page read whole nor a check (`Acquaintances.answeredWith`, `onRecord`: a
    LinkedIn catch-up run was refused 22 replies to one builder). Email never went out: the writer changed the subject
    after the compose link was made, so the poster now puts the card's title into the link's `su=`, and is told the
    recipient is already decided.
  - **What works is kept by code** (the founder, 2026-11-14, on a LinkedIn post that drew more than the others: "teach
    Quest to write down such patterns during reflection phase"; `tasks/kept-lessons.ts`). The "What works" run ended in
    three lessons for the manager to keep, and in five days none was kept. Its report's numbered lessons are now kept as
    lessons when it ends ("What works (14 Nov): ..."), the ones the report before left are retired, and the run is told
    to name each platform's best post by its opening words and say what made it, so every later run's opening has it.
  - **A reflection on three days** (2026-11-14: about 470 words up, 55 people answered, nobody had heard what Quest is;
    LinkedIn 36% answered, X 20%, Bluesky and Mastodon under 10%). The name goes with "done" (`nextStep`: `doneDraft` plus
    `nameDraft`, offered with `ask`), and anyone with a plan who answers a second time gets the name once (`toldName`).
    The makers' side searches LinkedIn one time in three (`NEEDS_ON_LINKEDIN` 6). A post of their own may ask about the
    reader's own risk (`POST_FORMS`, the shape that drew three builders on LinkedIn). The rotation no longer waits for an
    empty outbox (no "who is waiting" run had ever started); a run gets the front for `RUN_SLICE_MS` (150 s) after a send
    while it has a step waiting (`ChromeBroker.stepWaiting`); a run that needs Chrome waits for it to reconnect
    (`tasks.waits_for_chrome`); on LinkedIn one reply per person under a post (`replySpot`); a message quoting their last
    words on a page read is an answer, not a second cold message (`answeredHere`). Medium is filed as avoid.
  - **The queue, in order and out of each other's way** (the founder, 2026-11-14: "The outbox must be really tight as
    possible, while the tasks themselves must not interfere and conflict with each other").
    - Tasks have a place in line (`mq.tasks.priority`): 0 answers someone waiting, 1 asked-for work and introductions,
      2 routine browsing; the claim goes by it, then by time. Unsaid, it is read off the title (`priorityOf` in core);
      the rotation says it, and starts a "who is waiting" run that names someone before anything else.
    - One run in their Chrome at a time (`TaskRunnerOptions.solo`: every teammate that needs Chrome but the researcher).
      Two took the front from each other between every step: a run that takes 10 minutes alone took 25 to 30.
    - The matcher's searches are background reading (`QUIET` in `chrome/broker.ts`, an AsyncLocalStorage round the
      introducer's `posts.search`): they go after any run's or watch's pages. Live, an X run waited six minutes for three
      pages behind twenty of them.
    - The outbox orders what is due: their taps and words, then an answer to someone waiting (drafted by a priority-0
      run, or under an answer on record), then openers. A run gets `RUN_SLICE_MS` (60 s) after a send, and the line is
      looked at the moment that ends. A send that pressed nothing in `SEND_BUDGET_MS` (4 min; a like 100 s; with a file
      9 min) is let go with nothing sent (`browser.too_slow`): one Bluesky reply held six others for eight minutes.
    - A busy line does not starve the browsing that likes and follows (the same day: 18 platform runs against 128 two
      days before, likes from 215 to 43, since the rotation started nothing while anything was queued). When no
      platform run started for `STARVED_MS` (45 min), one joins the line at priority 0 (`rotation.started` `starved`).
    - The popup's switches show what the extension says unless their own change is in flight (`changing` in
      `popup.js`, extension 0.12.15): Chrome focuses a popup's first control as it opens, and a focused switch was
      never redrawn, so the on/off switch never showed a change made in the chat.
    - A draft whose words are the writer's doubt about the job ("I'd hold this one", "Not sending this one") is refused
      in `DraftService.offer`; two were queued as replies in a day.
  - **Spread, warm-ups and languages** (the founder, 2026-11-14). The introducer writes to makers elsewhere once 5 wait on
    Bluesky (`BLUESKY_WAITING`); Telegram and YouTube get rotation turns twice as often (`WARMING`); a post in any of the ten
    languages Quest speaks may be introduced (`spoken`), and half the makers' needs looks search in one of the other nine
    (`OTHER_TONGUES`). The writer answers each person in their language.
  - **Unasked replies are what gets an account suspended** (live, 2026-11-15: mastodon.social suspended the dev account
    for spam after 33 and 39 introducer openers a day; on Bluesky, at 101 and 132 a day, a maker answered "What is your end
    game, bot?", and about thirty who had said yes heard nothing, since the watch read each post's page and missed them;
    the founder: "our strategy starts to feel like a template again"). So:
    - The introducer writes no opener on Bluesky or Mastodon (`closed` in `#one`), and a first word written by code
      (`cold` on a draft request: the introducer's opener, an introduction under a stranger's post) is refused once a
      site took `COLD_REPLIES_A_DAY` (12) replies in a day, and always on a Mastodon server (`DraftService`).
    - Bluesky's answers come from its public API (`finds/bluesky-answers.ts`, `getPostThread`): who replied under their
      words, with each answer's own address, no page in their Chrome and no model call.
    - Only a plain yes writes the introductions (`agrees` in `nextStep`): "What is your end game, bot?" and "Never
      released a game on steam" would each have sent the maker's link to strangers.
    - Two openers in three go without "Hey,".
    - A short post or a launch's title needs one everyday word of a language Quest speaks, a longer one two (`spoken`):
      with two always, 69 of 117 pairs in a day were dropped as another language, nearly all English.
    - A maker's yes is acted on once, so the introductions it asks for are not `cold` (live, the same night: ten makers
      said "go ahead" on Bluesky while the site's 40 replies of the day had spent the cap, and none was introduced). A
      plain short yes ("Yeah, sure") is matched to its own address by its exact words (`addressOf`; `quoteAppears` wants
      12 characters), and "would love to", "that would be great" count as yes (`agrees`). A plan keeps up to 3,000
      characters (`PgContacts.keep`): cut at 300, every one of 158 makers' plans since Nov 14 ended mid-JSON and no yes
      found anyone to introduce (149 were rebuilt from `mq.pairs`). The step runs until "done" with the posts went to
      them (`doneSent`), not while one message has: a maker with an older opener too got nothing. What passed with
      the maker is read past the 400 newest drafts too (`withPerson`): likes and follows had pushed two-day-old openers
      out of that window, so a yes found no offer of ours. A step not taken logs why (`intro.not_stepped`).
    Checked by hand the same day: no label on the Bluesky account, LinkedIn, Threads and Peerlist with no restriction,
    X replies at 1 to 2 views each. LinkedIn's and Peerlist's posts that look for a kind of person drew the most.
  - **Bluesky goes slower** (the founder, 2026-11-14: "Slow down with the Bluesky, do it more evenly across platforms.
    Reflect on the reply rate and reply quality"). Over three days it took 208 of 410 words and 9% of its people answered,
    mostly players; LinkedIn 40%, Threads 31%, X 20%, mostly founders. Its gap is the usual 4 to 11 minutes again
    (`QUICK_SITES` is empty), two waiting there is its line (`BLUESKY_WAITING`), every other look of the introducer passes
    it over and a look writes to one maker there. The opener's first sentence has one light touch at most (rn, btw, theres),
    half the forms none ("Don't overuse the slang").
  - **No pause between sites** (the founder, 2026-11-13: "pauses make sense while working on a single site, not
    switching between them"): `ACROSS_GAP_MS`, `LIGHT_ACROSS_MS` and `SWITCH_SITE_MS` are 0; a site's own gap stays.
  - **Answers on a post's own page** (`answersThem`). There the watch took the post itself, their own reply and
    someone else's reply to the post's author for answers (10 of 60 on record in three days). An answer comes after
    their reply on the page and does not open by naming the post's author; a week of their sent words and quotes is
    known (`sentWords`), not the last 300 drafts.
  - **A warm conversation is planned ahead** (the founder, 2026-11-13: "after 2 days of a successful interaction or
    connection write another message (what gojiberry does for linkedin). And this should be illustrated on the people's
    tab"; `finds/follow-ups.ts`, `FollowUps`). When the watch records an answer, a next step is kept for two days on
    (`mq.commitments`, `words = 'follow-up'`, no wake event, so no manager turn), one at a time for a person. Their feed
    shows it at its day as "Planned" (`peopleFrom`), then "Next step" once due. Every 5 minutes code writes the due ones
    for whoever's Chrome is open (`followUpDraft`, five forms, through `DraftService.offer` with `helps`): a private
    message where the site has them and the profile is known (it waits for a tap), else a reply under their answer; a
    refusal drops it with the reason. A Telegram or Discord run may also search Google for groups (`groupSearch`).
  - **Every opener has a purpose** (the founder, 2026-11-12: "stop playing games, Quest must plan each conversation three
    steps ahead ... it is our CMO and it has to sell in the first place, and growing followers is as second job"). A
    platform's run (`rotationBrief`) writes only to a founder who says they need customers, and the first word is help they
    can use today (people who want what they built, from `customers_for`, or the one thing on their site that loses a
    visitor); `note_person` takes `plan`, the three steps: what the opener gives, what is said when they answer (what the
    customer does, described, no name), what is asked in the end. Everyone a run's searches turn up goes to the shared
    cache by code, picked or not (`PlayFinder`, `known.saw`), so the matcher reads them later.
  - **Posts that find a kind of person** (the founder, 2026-11-12: "the actual posts must be about finding specific
    types of people, not random. Like, if there are three new language learning apps, post a question to find people
    learning a language rn (and the other way around); something like Boardy does"). `who_is_wanted`
    (`PairFinder.wanted`, from Hacker News' week and the cache, no browser, about 14 s) names the kinds of people several
    builders look for and the kinds of maker several people ask for, each with a question; a platform's "a post of their
    own" run (`ownPost`) asks it, names nobody and links nothing, and whoever answers gets the introduction as a reply.
  - **One cache of people for every customer** (the founder, 2026-11-12: "Quest must have a central database, so every
    person it finds, from any of its users, it puts into so-called cache with public background information";
    `mq.known_people`, `infra/pg-known.ts`). Keyed like a contact (`<site>:<handle>`), with no customer on it and only
    what is public: who they are and their site as a check found them (`note_person` writes it, with `reach`: every
    public contact seen), and what they last made and last asked for with the post that said it (every post the
    matcher's searches turn up, `saw`). The matcher reads the last week of both from it (`recent`), so a pair is found
    across runs and customers, and `find_pairs` shows what is already known of each person so nobody looks twice.
    What passed between a customer and someone stays in `mq.contacts`.
  - **The product is described before it is named** (the founder, 2026-11-11: "we should probably don't name it, just
    describe it gently; a link is ok if the person specifically asks where to find it or the name"). To someone who
    already talks with them on a warm platform and did not ask, a reply may say in passing what they build, with no name
    and no link (`WarmCheck.gentle`, the writer's `gentle`); the name and the link still go only to someone who
    asks (`asksForIt`), and a draft that names it is refused as before.
  - **Help for help** (the founder, 2026-11-13, after 100 conversations in a week and nobody told what Quest is: "ask for a
    feedback for Quest in the warm conversations, if it fits the context ... landing review, look in my bio, share a link or
    just the name"). To someone who talks with them, on a platform past its warm-up and its one-in-five, never asked before
    (`WarmCheck.ask`, `askForm`, `ASK_FORMS` drawn in code), the writer may end a reply or message with one light ask back,
    only when they got something and it fits; it names the product or links it and still goes alone (no tap).
  - **Want the link?** (the founder, 2026-11-14: "we kinda wait for people to get into the profile where the landing link
    is or ask for a link ... teach the Quest some simple yet known effective tactics of selling"; over the week before, 98
    people answered on dev, 3 were told anything about the product, no reply carried a link, and production got 3 trials
    with no `came_from`). Two of the six `ASK_FORMS` are the permission close: a line on what the thing does, the first run
    free, "want the link?", with no name and no link. A yes to it (`saysYes` after words of theirs that `offersIt`) counts as
    asking in `WarmUp.check`, so the link and the name may go; the watch names such a yes as owed an answer instead of
    liking it, and the "who is waiting" run is told what the answer is. An offer is made once to a person
    (`askedBefore`). The show-and-tell post promises each maker who replies a person asking for what they built. To
    judge it: replies that offer, yeses, links sent, and production's `came_from` (FACTS.md, "The funnel").
    Step two offers it as well (live, 2026-11-15: about 120 answered in a week and 5 heard of the product): three of
    `stepTwoDraft`'s five forms end on "want the link?".
  - **Their number is not said back** (the founder, 2026-11-15, on "326 from search is solid, curious where those last 8
    even came from": "people don't respond by quoting the exact number, mostly they simply express their emotion over the
    number or give their own example. Patterns like this will get us banned"; 56 of a week's 647 replies and messages did).
    `numberBack` in `drafts/tells.ts`: a reply or message with a figure that is in the words it answers (and not in their
    own note on it) goes back to the writer once, and the writer's rules say so. It sees only the quote, not the rest of
    the post.
  - **One hand showing** (the founder, 2026-11-17: "check the replies log and measure the cringe levels"; of five days' 566
    replies and messages 190 had an emoji, 124 of them the same smile, 62 went "clause, emoji, a second sentence", and on the
    last day 5 of 16 opened Glad, Curious or Thanks, 4 gave a tip nobody asked for and 4 closed on a saying). The emoji draw
    (`EMOJI_SHARE`) now holds for every reply and message, not only one with a shape (most have none: an opener, an ask, an
    introduction). Back to the writer once (`drafts/tells.ts`): a stock first word one of their last six opened with
    (`startsAgain`), an emoji with words after it (`EMOJI_MID`), a tip after one of their last three gave one when nobody
    asked (`tipAgain`; never an opener whose point is the tip), a saying or a stranger's sympathy (`SAYINGS`). An invite's
    code on a link already tagged keeps the tag as a second field ("/?i=E1AEE5C5?utm_source=bluesky" went up).
  - **A yes brings several people, on a page** (the founder, 2026-11-17: "we have to make all those saas that find you
    posts online irrelevant ... if person agrees, let Quest do match with multiple people at once. It can then generate a
    very simple web page where you can see the list of people reached to and share it with the person. This way we don't
    have to mention messaging quest, because there will be a branded link on the page"). On a maker's yes (`nextStep`)
    `everyoneFor` adds to the people their opener named whoever else `mq.pairs` holds for the launch and one more search
    for it alone (`PairFinder.moreFor`: six phrases, 30 posts read, the same judge), up to `MATCH_MAX` (6), each checked as
    an opener's people are and never someone written to in two weeks. Their link goes under each post as before. Then the
    maker gets one address, `www.messaging.quest/m/<code>` (`pageDraft`, as written, no writer; `mq.match_pages`, a row a
    yes): who got their link, a few of each one's words and their post, and Quest's mark at the foot. It replaces the list
    of posts and the product's name (`nameDraft` is not sent after it). The page is a static file of the landing
    (`apps/web/public/m.html`) that reads its row through Supabase's Data API from `public.match_page(code)`, a
    security-definer function open to anon (the table is not); a code that starts with "t" is dev's project. Until the
    landing serves `/m/` (`matchPageLive`, asked every 10 min), the old "done" with the posts goes instead.
  - **A look at a night of sends** (the founder, 2026-11-18: "ensure relevancy and context accuracy; spread the attention
    evenly across platforms; use extra short reactions when appropriate, even an emoji counts"). In 90 minutes 21 sends: 16
    up, 2 too slow (Discord), 3 held. Five of six Bluesky replies came from one Introductions run, to people who had asked
    for nothing ("I gotta do my math homework" was offered a math tool): `pairsText` now says of a pair whose person only
    showed the need (`tell` false) that only the maker is written to. 23 Bluesky messages waited on cards, most to people
    who take none from them: `DraftService.offer` asks `messagesClosed` first (their own profile learned by the poster,
    `noteBlueskyAccount`, in memory), so a follow-up there falls back to a reply. `SHAPES` has "an emoji" (only one
    emoji, kept by the emoji limit) and "a word or two" weighs more.
  - **A maker's link goes only to whoever asked** (the founder, 2026-11-18: "Yes, only those"; over a week 114
    introductions went up under strangers' posts, eight of those people answered, and three were cold: "What", "lemme
    guess it's vibe coded?", "please don't tag me"; one maker's page listed a tutor's joke as someone wanting a template).
    `Introduce.asked` (the judge's `tell`; a plan from before asks `mq.pairs`): on a yes the link goes under the posts
    of people who asked for such a thing, and whoever only showed the need is on the maker's page under "Might fit too",
    never written to (`fit` in `mq.match_pages.people`, `m.html`). An opener whose people only showed the need offers
    their posts, not the maker's link under them. The page counts as live only once the landing's copy has the list
    (`matchPageLive` looks for it).
  - **A no is the end of it** (the founder, 2026-11-18: "The agent must be very precise about opt outs: if someone asks not to
    do it, don't"; live, someone on Bluesky answered an introduction "please don't tag me under anything using generative
    AI", was kept as a warm conversation, and a reply and a private message to them were drafted after it).
    `contacts/said-no.ts`: an answer that `saysNo` (don't tag, message or reply to me; stop; not interested; no thanks;
    called a bot to their face) is kept for good in `mq.said_no` by the watch, which then plans no follow-up, takes no
    next step, puts no like on it and tells the manager to draft nothing, not an apology either. `DraftService.leaveAlone`
    skips what waits for them, `offer` refuses every kind to them and any words that name their handle under someone
    else's post (`tagged`), and `send` drops one tapped before the no. Only the customer's own dictated words go. They are
    known by the address's handle or a name inside it (an answer read off a list keeps a display name).
  - **A feed post has no title** (live, 2026-11-18: a LinkedIn post was written out and its Post button refused, since the
    draft carried a title and the composer has no field for one). The poster drops a post's title on LinkedIn, X, Threads,
    Bluesky, Facebook, Instagram and Mastodon (`UNTITLED` in `chrome/browser-poster.ts`).
  - **The watch reads notifications, on one clock a site** (the founder, 2026-11-18: "would it be more efficient to behave like
    humans and only open the notification bar to see the replies?"; over a night the watch was 42 looks, X's mentions 14 of
    them reading the same 17 answers, 17 on single posts' pages, and 26 of 53 runs were "who is waiting" and "comments"
    runs opening the same lists). A page of their notifications is read at most every `SITE_LOOK_MS` (30 min), whatever is
    due there; Instagram, Tumblr and Substack have theirs in `answersPage` now (Facebook's hides the words, Peerlist's draws
    nothing in the background, TikTok and YouTube have none). A look whose page shows no line it did not show at the last
    reading asks no model (`shownOn`: a list cut into posts by its ten newest, else its lines with numbers taken out, which holds on LinkedIn and not on Threads or Instagram, whose lists draw other rows each time; `watch.nothing_new`; in memory). With nobody named a "who is
    waiting" run is a look at their messages, every two days (`INBOX_EVERY_MS`), and a comments run every three days where
    Quest put no post up in a week (`UNDER_OLD_POSTS_EVERY_MS`). A manager turn woken only by routine runs finishing
    (`isRoutine`: the rotation's titles) asks no model (`manager.routine_skipped`; live, 2026-11-19: 158 such wakes a day,
    about 20M tokens, a message in four).
  - **The quality update** (the founder, 2026-11-18, after the numbers of FACTS.md, "The funnel, a week on": 685 words up,
    149 people answered, 10 heard any offer, and 279 of 1,772 pairs were ones where the person asked).
    - **The page is the way in.** A maker's page (`m.html`) ends in one button, "Find more people like these", in place of
      Quest's mark; it opens the landing with `?m=<code>`, which the landing keeps like an invite (`questInvite = m_<code>`),
      so any extension hands it to `/chrome/hello`. `conversation/met-notes.ts` reads the page by its code from the database
      that keeps it ("t" first: dev's, through the same public function the page reads) and the first turn starts from what
      they made and who was found (`WayIn.metBy`, `customers.met`, `came_from = match`). A hand-off link minted on dev
      carries "t" before its code and is read the same way (`public.invite_note`): before, production knew none of dev's
      codes and the conversation was lost. Views and clicks are counted on the row (`public.match_page_seen`).
    - **A page for anyone who built something** (`page_for`, `makePage` in `main.ts`, `pagePeople`): one search for
      their thing alone (`PairFinder.moreFor`), two people at least, and a page that says "found", not "got your link"
      (`mq.match_pages.sent` false). The outreach teammate gives it to whoever left a project link under their post, and
      step two of a plan offers it ("want a page of them for yours?") in place of two of the three "want the link?".
    - **Targeting.** An opener goes only to a maker for whom somebody asked (`tell`), never to a hobby project (`hobby`),
      sellers first (`sells`: a price, a waitlist, customers in their words); the matcher's phrases are mostly how someone
      asks. Fit over size, in every platform run's brief. Bluesky and Mastodon take first words again, a few a day
      (`coldCap`: 6 and 3 replies in a day, 12 elsewhere; `DraftService.coldRoom`, asked by the introducer before it writes).
    - **Casual words.** Up to `CASUAL_A_RUN` (3) replies a run are a passer-by's (`outreach_draft` `casual`): eight words
      at most, no question, no link, no check, drawn only from the three shortest shapes.
    - **Posts.** Four more forms (`POST_FORMS`): the link thread (reply with your project's link, each gets people for
      it), a win, one feature, the week's numbers. The numbers are counted by code (`weekNumbers` in `main.ts`) and given
      to the run; a post that names the product still waits for a tap. Every post ends in two or three tags, never the same set.
    - **Approve by exception.** No offer to go alone any more: after the first `TRUST_AFTER` by hand, a kind on a platform
      goes alone once nine in ten of their last ten decisions went up as written (`Autopilot.approved`, `PgDraftMarks.record`,
      `mq.drafts.edited`). Words going up alone wait `SKIM_MS` (3 min) and show first under "Here's what I'm sending"
      (`drafts/out-list.ts`): one message a day in Telegram, edited in place, a button a line that strikes it (the draft's
      own Skip), and a list in the panel (`ChatView.out`). A reply to someone who talks with them and asks them something
      waits for a tap (`personal` in `DraftService.offer`), as words naming the product, messages and profile changes do.
    - **Brakes** (`drafts/brakes.ts`, `mq.brakes`): someone asks if this is a bot (`asksBot`, every answer the watch
      reads), a reply taken down, or a platform's answers falling under a third of the week before (`checkRates`, every
      3 h) stops replies there for a day: nothing goes alone, no first word is drafted, an answer to someone talking waits
      for a tap, and they are told once. Their "go ahead" lifts it.
    - **The evening.** After the manager's report code sends what needs them (`needsYou`), what is paused, and a sample
      (`manager/day-sample.ts`): five of the day's messages at random, the longest, ones naming the product, ones the checks
      sent back (`mq.drafts.sent_back`).
  - **One post a week is Reddit's, at the send too** (live, 2026-11-15: their launch news went up on four sites, and the
    tries again on Bluesky and Peerlist were refused as copies of Facebook's): `DraftService.send` checks it only there.

## Commands

```bash
npm install
npm run check                 # typecheck + unit tests
npm run dev                   # the dev stack on this laptop: the agent (@TestPatrikBot, dev's database, http://localhost:8080), its Mini App by a tunnel, and the dev extension, kept up to date
node --experimental-strip-types scripts/fresh-start.ts [telegram chat id]   # a fresh first run on the dev bot: sets aside their dev customer (off, chat detached, nothing deleted) and prints the dev invite's start link; then, with npm run dev up, /start <code> in @TestPatrikBot and go through it (language, what they build, Chrome, the sweep, the takes, Your move)
npm run env:check             # what .env.local and .env.production.local point at, and anything in the wrong one
MQ_INTEGRATION=1 npx vitest run apps/agent/test/pg.integration.test.ts   # against the dev DB
node --experimental-strip-types scripts/try-chrome.ts 8790   # the extension against a scratch API: prints a connect link
npm run extension:pack        # the Chrome Web Store zip in .artifacts/extension; store/chrome-web-store has the listing, its images and how to redraw them
node --experimental-strip-types scripts/try-tavily.ts        # the Tavily spike (needs TAVILY_API_KEY): what it reads, how fresh, what it costs
node --experimental-strip-types scripts/try-cache.ts         # does the cache hold the manager's standing prompt? input, cached and cost per call
node --experimental-strip-types scripts/try-conversation.ts <customer id> ["line" | wait ...]   # a chat with the real manager model on a customer's state, in memory: nothing is sent or written
node --experimental-strip-types scripts/try-first-run.ts ["line" | lang:<locale> | connect | tap:<card>:<choice> | brief:<words> ...]   # someone new's first run with the real manager model, in memory: /start, their language, their words (the quest read from them), Chrome connecting
node --experimental-strip-types scripts/try-deck.ts <customer id> [draw]   # a dev customer's Your move as it ranks; draw: their deck in their chat now, as the next change would (dev only)
node --experimental-strip-types scripts/try-voice.ts <customer id> ["their words" ...]   # the writer writing as a customer from what the database keeps (read only)
node --experimental-strip-types scripts/try-plain.ts         # the writer on three live find replies, as before and with plain: does it drop the product?
node --experimental-strip-types scripts/try-claude-cli.ts [models] [picture:<file>] [voice:<file>]   # MODELS=claude-cli, live: a reply, an agent's tool calls, structured output on a picture, the local Whisper (nothing written, nothing on OpenRouter)
node --experimental-strip-types scripts/stripe-setup.ts [https://mq-v2-agent.fly.dev]   # checks dev's test key, or (given production's address) makes production's webhook, or brings it up to the events Quest reads
node --experimental-strip-types scripts/try-stripe-events.ts [minutes] [newest|oldest]   # Stripe's recent test events, signed and delivered to a laptop agent's webhook (Stripe cannot reach it)
```

## Production and dev

Two environments, never crossed (the founder, 2026-10-22: "@messagingquestbot - production only, connected to
the remote server and published chrome extension. @TestPatrikBot - local always; uses local server and the latest
dev mode extension"). `apps/agent/src/environments.ts` holds who is who.

|              | Production                                                | Dev                                                    |
| ------------ | --------------------------------------------------------- | ------------------------------------------------------ |
| Runs         | the Fly app `mq-v2-agent` (`MQ_ENV=production`, fly.toml) | this laptop, `npm run dev` (`MQ_ENV=dev`)              |
| Bot          | **@messagingquestbot**, by its webhook                    | **@TestPatrikBot**, polled (it has no webhook)         |
| Database     | Supabase `atjukklkmfwhmbbzxaod`                           | Supabase `bglbnziyilxkxgzortuf` (or a local Postgres)  |
| Address      | `https://mq-v2-agent.fly.dev`, the wake job's             | `http://localhost:8080`; no wake address               |
| Mini App     | `https://mq-v2-agent.fly.dev/glass`                       | a quick tunnel's `https://….trycloudflare.com/glass`   |
| Extension    | the published one: Web Store, or its release zip          | `.dev/extension` loaded unpacked, a "DEV" badge        |
| Secrets      | `.env.production.local`, copied to Fly's secrets          | `.env.local`                                           |
| Stripe       | the live key                                              | test keys only                                         |

What holds it, in code, not by care:
- **The agent** refuses to start on the other's database, bot or address (`stageProblems`, then `botProblem` on
  Telegram's `getMe`, before anything touches the bot or the database). Production must run on its Fly app with
  its webhook, and takes no `CHROME_DEBUG` or `MQ_TEST_CUSTOMER`. Dev refuses production's database, bot, address and a
  live Stripe key, polls by default, and never registers a wake address (a laptop does not sleep; one on
  production's database would have pointed production's wake job at itself).
- **The extension.** A release (the store's, or the zip messaging.quest offers) pairs only with production. An
  unpacked build is the dev extension: it pairs with any address but production's (`http://localhost:8080`
  unless its popup says another), and shows "DEV" on its icon. With both in one Chrome, each answers a connect
  page and only the one that may pair there does. To try a build against production, load its release zip
  (`npm run extension:pack`) unpacked; it pairs as the published one does.
- **The scripts.** The env files are git-ignored, so a worktree has none: `scripts/env-file.ts` reads the main
  checkout's (`MQ_ENV_FILE` names another). Whatever goes to production (`fly-secrets.ts`, `telegram-webhook.ts`,
  `stripe-setup.ts` with production's address) reads `.env.production.local` and stops unless its database and
  bot are production's. `npm run env:check` says what each file points at, where each bot's updates go, and any
  secret of one environment kept in the other's file.

Working on dev, the whole stack is one command, `npm run dev` (`scripts/dev-agent.ts`), from the main checkout or any
worktree; it prints what runs where once the agent answers ("dev stack up"):
1. **The agent**, from this checkout, on `.env.local`: `DATABASE_URL` (mq_app on dev's project), `TELEGRAM_BOT_TOKEN`
   (@TestPatrikBot), `TELEGRAM_WEBHOOK_SECRET`, `OPENROUTER_API_KEY` (only with `MODELS=openrouter`, 4. below), and optionally `TAVILY_API_KEY` and Stripe's
   test keys (`.env.example`). What the shell sets wins over the file: `CHROME_DEBUG=1 npm run dev` adds
   `POST /debug/chrome/read` and `POST /debug/chrome/browse` (a page as a browser session sees it, drawn: its controls, items and login, for measuring a site's buttons), outside `/chrome`, whose routes all want the extension's token.
2. **The Mini App** (`scripts/dev-tunnel.ts`). Telegram opens one only at https, so a Cloudflare quick tunnel (no
   account; a `*.trycloudflare.com` address of its own) goes in front of the agent, and the agent sets
   @TestPatrikBot's Quest button to it (`MINI_APP_URL`), as production's bot has, and then each chat's own button, put
   back on the bot's at once (`TelegramChannel.pushButton`): a new address on the bot's button alone reaches no chat that
   had one (live, 2026-11-03: Telegram Web opened a tunnel three starts old). The tunnel outlives `npm run dev`, and the
   next start takes it up again (`keptTunnel`, noted in `.dev/tunnel.json` of the main checkout; the gate is on the
   agent's port + 1), so the address stays the same across restarts and the button is left as it is on stop (Cloudflare's
   502 while the agent is down). Telegram tells a client of a new button only while that client is connected, so every
   new address left someone behind (live, 2026-11-04: after a day of restarts the Mini App "is not accessible"). It is
   started through `cmd /c start` (Windows) or `sh -c '… &'`, so it is nobody's child: a stop that ends the stack's whole
   tree of processes leaves it too. A new one comes only when it is gone or no longer reaches the gate (a dropped network
   can end its address), and one that still runs to the gate's address then is stopped. While the stack runs it looks every minute, and a tunnel that misses three looks in a row with the network up is replaced and the agent restarted on the new address (`watchTunnel`; live, 2026-11-07: cloudflared retried "Tunnel not found" until someone restarted the stack). The tunnel carries the Mini App only: a gate on the laptop passes `/glass`, its
   four signed routes, the upload page and its routes, and `/i18n/*`, and answers 404 to the rest (the extension's routes, CHROME_DEBUG's unsigned
   reader). Telegram takes no localhost address on a button, so the dev bot's buttons to the agent's pages (the Chrome
   setup's `/chrome` and `/connect`, the credits page) name the tunnel's address (`TelegramChannel`, `pagesUrl`), and
   the gate only sends the browser back to the same page on localhost (`LOCAL_PAGE`), where the extension's connect
   script runs. cloudflared is the one on PATH, else `.dev/bin` in the main checkout, fetched from Cloudflare's GitHub
   releases the first time. A `MINI_APP_URL` of your own is used instead; a tunnel that cannot start leaves the rest
   running without the button.
3. **The dev extension** (`scripts/dev-extension.ts`, `apps/extension/src/dev-reload.js`). Chrome loads one folder
   unpacked, once: `.dev/extension` in the main checkout (chrome://extensions, Developer mode, Load unpacked), then
   `/connect` in the dev bot. `npm run dev` copies its own checkout's `apps/extension` there (what the release zip
   takes), again on every change while it runs, and writes the folder's stamp (`dev-build.json`) last; the extension
   reads its stamp every 2 s and reloads itself between jobs, so Chrome runs the extension beside the agent, whichever
   worktree that is. Its ID comes from the folder, so a Chrome that loaded another folder before pairs again once.
   (`apps/extension` loaded as it is still works, with no stamp and no reloading: Chrome then keeps running an old
   service worker until its reload button.) `DEV_EXTENSION=0 npm run dev` leaves the folder as it is, for a checkout
   that must not swap the extension Chrome runs (one older than the build it has, or one that does not touch it).
4. **Free on the Claude subscription** (the founder, 2026-11-03: "it must replace all costs we have, so dev testing
   becomes free of Open Router"; dev's default since). `MODELS=claude-cli`, unset on dev, sends every model call to the Claude
   logged in on this laptop, through the Claude Code CLI the Agent SDK ships (`agents/claude-cli-models.ts`), and voice
   to a Whisper on this machine (`infra/local-whisper.ts`: transformers.js on the CPU, `LOCAL_WHISPER_MODEL`, fetched
   once into `~/.cache/mq-whisper`); `model-source.ts` picks, for the agent and the try-scripts that read `config`.
   `MODELS=openrouter` (in `.env.local` or the shell) puts dev on production's models. Both are dev dependencies, so
   production installs neither; unset there means OpenRouter, and `stageProblems` refuses claude-cli.
   - **One call, one turn of a fresh CLI.** None of Claude Code's prompt, tools, settings, hooks or saved sessions;
     Quest's system prompt as it is; the run's history written out in one message, a block a message. Quest's tools are
     offered by an MCP server in the agent whose every tool ends the turn (`claude/endTurn`), so the calls come back to
     LangGraph and nothing runs in the CLI. A call bound to one tool with no options (`withStructuredOutput`) is answered
     with the CLI's own structured output. Claude takes a tool's parameters only as one object: a union at the top
     (`browser_act`, the poster's `prepare`) is offered merged, each shape named in its description (`oneObject`), and the
     tool's own schema still checks the call. Live, 2026-11-03: unmerged, the CLI left both out, and the poster gave up on
     X and Instagram with "the fill tool isn't available".
   - **Which Claude** (the founder, 2026-11-05: "switch dev to sonnet and haiku, the usage grows too fast. But the
     writing and decision quality should not drop"; then "let's switch back to opus for writing", Fable 5.2 in its place from 2026-11-17, and Opus 5.5 again since 2026-11-19; `CLAUDE_SEATS`). Opus 5.5
     for the writer; Sonnet 5.5 for the manager and the
     teammates; Haiku 5.5 for vision (the poster's clicks) and the volume seat (the judges, the watch, the summarizer).
     Over a day on Opus, its manager and the Sonnet poster were 36M of 49M tokens in. `CLAUDE_CLI_SEATS`
     ("writer=claude-opus-5-5") moves one. So dev runs Claude where production runs DeepSeek and MiMo.
   - **What it holds to.** At most `CLAUDE_CLI_CALLS` (4) CLIs at once. The CLI gets only what it needs of the
     environment: never the agent's secrets, nor an API key, which would bill the API instead. `mq.model_calls` rows say
     `claude-cli/<model>` at no cost, so the day's limit never bites; the subscription's own limit fails the call
     (`claude_cli.limit`).
   - **Log in once**: `npm run claude:login` (`scripts/claude-login.ts`, the CLI's `auth login --claudeai`)
     opens the browser; the login is kept in `~/.claude` for every checkout. `scripts/try-claude-cli.ts`
     checks it live.

The integration tests put the dev founder in the `test` lane; a laptop agent serving them needs it `live` meanwhile.

Production deploys from a clean checkout of main:
`flyctl deploy . --config apps/agent/fly.toml --dockerfile apps/agent/Dockerfile --remote-only`. Its secrets go with
`node --experimental-strip-types scripts/fly-secrets.ts agent` (Stripe's two keys when they are in the file: run
`scripts/stripe-setup.ts https://mq-v2-agent.fly.dev` with the live key first, which writes the webhook's secret),
and the bot's webhook with `node --experimental-strip-types scripts/telegram-webhook.ts`. A new extension goes to the
Chrome Web Store as `npm run extension:pack` makes it. The landing is published as `apps/web/DEPLOY.md` says.

The integration tests run in the `test` lane (`mq.customers.lane`): the deployed agent claims
only `live` work and the wake job looks only at `live`, so both can run at once. A new query
that claims or schedules work must filter by lane too.

TypeScript runs without a build step: Node's type stripping (`--experimental-strip-types` on
Node 22, default on 24). So: `.ts` extensions in imports, no enums, no parameter properties,
no namespaces (`erasableSyntaxOnly` enforces it).

## Rules

- **What leaves the database.** Supabase counts every byte a query returns. Live, 2026-11-12: the rotation read 400 whole
  task rows, 300 drafts and 500 results every 30 s for each open Chrome, about 4 GB a day on dev. It now asks first how many
  runs are at work (`atWork`), reads tasks without their instructions (`listFor` `light`), and with nothing to start looks
  again after `IDLE_LOOK_MS`. A loop that looks often must ask a small question first. Live, 2026-11-15
  (`pg_stat_statements`, 41 hours): a customer's 250 latest drafts with their words were read 6,573 times (756 MB of
  about 1.3 GB), results and contacts next; production read almost nothing. Those three lists are kept 5 min in memory
  (`infra/read-cache.ts`, `LISTS_KEPT_MS`), read once at their longest size, since only this process writes them: each
  write of a draft returns its row and patches the kept list (forgetting on every write and keeping 30 s missed nearly
  every read), results and contacts are forgotten on a write. Measured after, 10 busy minutes: 2 reads of drafts, 800
  rows, against 25 and 10,000 before. Then (2026-11-16, 3.6 GB in two and a half days): a customer's row is kept a minute
  (`customerChanged` from every store that writes one, 52,000 reads of 6.7 KB), results and contacts are patched in place
  instead of forgotten, the watch's told answers too, a light task list carries a report only from the last 12 hours,
  the matcher's "in a pair" keys are kept two hours and added to by its own writes, and their page reads its data when
  shown and every 5 min, not every 30 s. Measured after, 30 busy minutes: about 10 MB, from about 30 MB. Storage: a post's LangGraph thread
  (`publish:<session>`) was never deleted and held most of dev's 450 MB; `mq.forget_finished_tasks()` takes them an hour
  after their last step, and pg_cron's own log of runs is kept a day (`mq-forget-cron-runs`).
- A dropped database connection is logged (`db.connection_lost`), never thrown: `createPool` listens for
  `error` on the pool (idle connections) and on each client (one the checkpointer holds). Without them
  Node exits on the first connection a sleeping laptop or a pooler restart drops. LangGraph saves a step's
  checkpoint in the background and waits for it only at the run's end, so a save that lost its connection
  rejects with nothing listening: `keepUpWhenSavesFail` (wired in `main.ts`) logs it when it is a lost
  connection (`connectionLost`) or a save stopped at the statement timeout (`db.save_timed_out`; live, 2026-11-16,
  an insert into checkpoint_writes ended the laptop agent), the run fails when it waits and the queue runs it again; any other
  unhandled rejection still ends the process.
- Secrets live in `.env.local` (dev's) and `.env.production.local` (production's), both git-ignored in the
  main checkout, and in Fly/Supabase secrets. Never print or paste one, and never keep one environment's
  secret in the other's file. `scripts/env-file.ts` reads and writes them without showing values.
- **Production and dev** are kept apart as "Production and dev" above says, since the cutover (2026-10-09).
  Never point a test at production users, and never run a laptop agent on production's bot or database:
  it would take production's Telegram updates (polling deletes the webhook) and claim its customers' work.
- Migrations go in `supabase/migrations/` and are applied to dev first, then to production,
  through the Supabase connector's `apply_migration` (the agent's own role cannot alter
  tables). Production is on the Free plan, with no backups: take a `pg_dump` before anything
  destructive (FACTS.md, "The cutover", has the way that works here).
- Every table goes in `mq`, never `public`, and the migration that makes it says what `mq_app` may do with it
  (`grant ... to mq_app`, or a `revoke`); `apps/agent/test/migrations.test.ts` holds them to it. The agent talks
  to Postgres as `mq_app`, not through Supabase's Data API, and `mq` is closed to `anon` and `authenticated`.
  Supabase stops granting new `public` tables to the Data API on 2026-10-30 (that changes nothing here, since no
  table is in `public`); a table that ever needs the Data API needs its own grant and RLS policies.
- Before deleting or overwriting anything in production, ask.
- The people the earlier web app (v1) signed up are `mq.accounts` (372, with their opt-out
  from product news); v1's own tables and functions are kept, unused, in the `legacy` schema.
  Nobody is emailed without the founder's word.
- `FACTS.md` holds measured facts. Read it before changing the browser, Telegram, models or
  the database setup, and add to it when you measure something new.

## Browser work across platforms

The founder's standing goal is product success, not a feed of draft cards, but Quest earns posting alone (2026-10-14: "before switching to autopilot on a specific thing, platform or action, the agent must first ask the user a few times"). A settled brief no longer grants the `*` default; each platform and kind earns it with `TRUST_AFTER` approvals, and their "go ahead" sets it at once (`posting`: on one platform its replies, posts, likes and follows, each its own `trustKey`; its private messages still wait for a tap). Specific platform-host rows override `*`; an explicit global ask-first choice updates the specific rows too. The ask_first flag persists that choice across manual approvals. Founders onboarded before 2026-10-14 still have the `*` row from the founder_autonomy migration.

`chrome/browser.ts` exposes `browser_open`, `browser_act` and `browser_close` to the manager and all teammates. General browsing fills/submits searches only, and never presses a Like, Follow, Repost or the like (`SOCIAL_ACTION`, and whatever the poster's `actsAs` reads as a like or
a follow, in Ukrainian too: live, 2026-10-31, the founder's X in Ukrainian let an outreach run press three Likes with no
draft): those are drafts of kind like/follow. Outgoing work uses `draft` or the outreach teammate's `outreach_draft`; `send_draft` reuses an existing open record.

How a page is worked, for the models (`BROWSING`, appended to every prompt with browser tools, standing text): a page's words run from a screen above where it is scrolled to, down (24k characters), its controls are those on screen, and each result says where it is scrolled to (`position`: "top of the page, more below", "37% down", "end of the page") and whether it is still `loading` (looked at again twice, 1.2 s apart). `browser_act` takes `{"kind":"scroll","pages":3}` (several screens, each waited on for what the feed draws, every new word returned, `newWords`) and `{"kind":"wait","text":…}` or `seconds` (agent-side snapshots, the extension never sees it). A control inside one of the page's posts carries `item`, the index in `items` (each post's first 200 characters: `article`, `[role=article]`, `[role=listitem]`, Reddit's post and comment elements), so a Like or Reply in a feed is known by its post; toggles carry `pressed`; an icon button is named by the picture inside it, and a count beside its picture by both (Threads' heart with likes, "Unlike 3"; extension 0.12.1). Threads' posts are items too (`[data-pressable-container]`). A post's address that opens another page (Threads sends one to its author's profile) is not filed as that post (`elsewhere`), so nothing is liked or answered there (FACTS.md, "Threads likes"). An action that left the page as it was says so (`unchanged`: "Nothing on the page changed after that"), a stale ref brings the page back with fresh refs, and a scroll at the end says it is the end. In the extension (0.10), every wait is a `domQuiet` (no DOM change for 400 ms once loaded, at most a few seconds; resolved by `pagehide`), every injection is held to a time (`inject`, `inPage`), a page a click navigated is waited for to load, a link that opens a new tab is followed in the session's tab and the new tab closed, and no job holds the worker past `JOB_MS` (85 s): live, 2026-10-15, an injection into a page a Save had just sent elsewhere was never answered, and the worker took no other work until Chrome restarted it. Non-Reddit drafts carry a platform host, exact destination URL and exact recipient/community target; chat need not have a subject. The `outreach` teammate owns publishing and conversation follow-up in arbitrary browser-accessible workspaces.

What Quest knows about a platform before it opens it is `apps/agent/src/platforms.ts` (the founder, 2026-10-16: "the amount of exploration must be minimized"): for Reddit, X, LinkedIn, Instagram, Facebook, Threads, TikTok, YouTube, email (Gmail, Outlook), Bluesky, Hacker News, Product Hunt and a few more, where each part is (the address that opens a search, a profile's edit form, the inbox, a new post), its rules and what gets an account limited, how words read there, and its day limits. Standing text: where things are goes into `BROWSING` (`PLATFORM_MAP`) for everyone with a browser; a site's rules and writing come with its first page in a run (`site` on the page result), in a pinned task's opening, in the poster's run (where and rules) and in the writer's prompt (writing). A page that differs wins.

`BrowserPoster` keeps Reddit's measured adapter and uses an observed UI executor everywhere else. `ChromeBroker` carries browser sessions; the extension inspects visible controls, open shadow roots and accessible frames, and acts only through expiring document references. No platform allowlist, arbitrary JavaScript tool, login handling or CAPTCHA bypass. Site refusals and public-address checks still apply.

Extension 0.8 adds visual browser controls; since 0.8.1 they are on by default and the customer can turn them off in the popup (`{ visual: false }` in `chrome.storage.local`). The `debugger` permission they use is required: Chrome refuses `debugger` as an optional permission, so 0.8.0's switch, which asked for it at run time, never turned on. A screenshot carries an expiring id and pixel dimensions; trusted input scales to the current CSS viewport and targets only that session's tab. A `fill` into a rich editor (contenteditable: Draft.js on X, Lexical, ProseMirror) is typed with trusted input too, select-all then `Input.insertText` (`trustedFill`), whenever visual controls are on: a DOM edit under Draft.js crashed it or tripled the link X posted (2026-10-14, extension 0.9.2). `BrowserVision` separately checks read/search navigation, exact draft preparation, the final Send target and before/after delivery evidence. General agents also have `read_visual` for pictured content. The harness appends pictures only to model requests; tool output and graph checkpoints contain metadata, never image bytes. Finish releases cached pictures even when an uncertain tab stays open. The manager shows the customer a picture only through `show_screenshot` (at most `PICTURES_A_TURN` a turn, noted "📷 …" on the transcript); a screenshot alone reaches the model, never the chat. The extension refuses to picture a page only for a frame at an address its window could not open (`privateFrame` in `guard.js`); empty and inline frames (about:blank, srcdoc, data:, blob:) are the page's own content.

Every page a browser tool returns starts with what it says about the customer's login there (`pageLogin` in `packages/core/src/browser.ts`, `loginFields`): `signedIn: false` for a sign-in address, a "Log in"/"Sign in" control, or a password field beside talk of signing in; `yourProfile` for a same-site link labelled "Profile". Quest learns their name on a site by opening it, never by asking for their handle, and never searches the web for the customer or their accounts. A sign-in wall on work that needs their account is said at once.

`BrowserPoster` does every kind (its prompt has the rules for each): for a like or a follow there is nothing to type, `publish` takes only a control that reads as one (`actsAs`), refuses a Like whose `item` is another post than the one quoted (`quotedItem`: in an item's 200-character start, else placed in the page's words under the last start before it, since a LinkedIn post's start is mostly its author's header; live, 2026-11-05, five LinkedIn likes refused on the right post; on the post's own page a quote in a reply with no Like of its own means the post's Like, `likeTarget`) or a Follow naming someone else, and never presses one already on (`doneOn`: "Liked", "Unlike", "Following", or pressed), which it counts as done, and so
  does a run whose model stopped short of `publish` with it already on (`alreadyOn`; live, 2026-11-04: two X likes made by
  hand ended as "could not prepare"); code presses a like or a follow itself, with no model call, when the page leaves one choice (`codeToggle`: the
  one Like in the quoted post, or the one Follow naming them or alone on their profile; not on LinkedIn or a sign-in page),
  and hands the run to the model, which may then only look, when it is not seen turning; it is done when a like or follow control on the page turned (`doneControls` before and after) or a picture shows it (`BrowserVision.toggle`, `receipt`). A profile change is filled and saved like a post and known saved when the profile shows the words. After a click the page is looked at once more, and once more after the model stops, since the page, not the model, is the receipt. Words too long for their field stop it at once, from the control's `limit` or from the extension's own refusal ("takes at most 160 characters"): the agent's schema for the extension's answers (`http/chrome-outcome.ts`) had dropped `limit`, so from 0.9.3 to 2026-10-15 a too-long bio still went round prepare.

In `BrowserPoster`, a refusal before anything went out (a stale picture or control) goes back to the model as "Not done, nothing was sent" instead of ending the post; `publish` checks its ref is current before the send is marked attempted, and a press the page refused as changed is not an attempt either (`NOT_PRESSED`: the fresh page goes back to the model; live, 2026-11-05, LinkedIn redraws a page it just opened, and five likes were held as uncertain with nothing pressed). What the page says can never go up (comments off, the post deleted, a like's post not on their page) ends the run with `cannot`: `ChromeError("gone")`, the card goes and a tap hears why, so it does not come back on every try. A limit the site says passes by itself ("You can't send any more message requests today", Threads, 2026-11-06) ends it with `later`: `SiteLimit`, the send stays in the outbox for `LIMIT_WAIT_MS` (a day) and goes with no tap, and until then no new draft of that kind is offered there (in memory). An editor's words are compared without emoji (`inEditor`): YouTube's comment box turns one into a picture. A post that gives up without sending fails as `unavailable` ("I couldn't post …, and nothing was sent. Tap Post it on the card to try again"), never as the site's refusal. `send_draft` with `their_words`, quoted from their message in this turn ("Try again"), sends an open draft the way a tap on Post it does.

A press, a key and a plain field's words are the browser's own input (extension 0.12.14; the founder, 2026-11-13: "as smooth as Claude's extension"): on a tab drawn in front with visual controls on, a click on a control is a real mouse press at a spot of it nothing covers (`pressPoint` in `browser-page.js`, `holdInput` in `browser-visual.js`, attached before the spot is measured), Enter, Tab and Escape real keys, and an input or textarea typed with real keys and read back (`typedCheck`), keeping the "@name " a reply box opens with. A script's events (`isTrusted` false) left Bluesky's Reply closed five times in a day and Mastodon's box holding only its mention. Covered, in a background tab or with visual controls off, the old script's press is used. Every page result says `focus` (the field the keys go to) and `dialog` (a dialog or menu on screen), and `unchanged` counts them. A message's chat opened by the Message button on the recipient's own profile counts as showing who it goes to (`chatWith`: X's chat names them only in its text).

MiMo sometimes returns decimal coordinates as strings; accept only bounded pixel literals and normalize them before transport. `type_text` supports text insertion and a single-line character-key mode for canvas editors. Never type submission/control keys as part of a body. OCR text is marked `visualText`: it is useful for reading/quotes but cannot itself resolve a held send as posted.

Drafts and find cards acquire a durable posting claim before execution. Every find card can post through the same generic publisher, with Reddit retaining its native adapter. Exact body/title and recipient are checked before the one outgoing action. Without a picture, a message's recipient must be shown by the page's title, address or an editable field (a To box, a composer labelled with their name), never by page text, a link or a search box, since a chat list holds every contact (`recipientShown` in `chrome/browser-poster.ts`); otherwise `publish` refuses and the picture route checks it visually. The conversation the draft itself names (its own chat or thread address, X's `/i/chat/…`) counts too when its page names them, a handle's start included (`sameChat`, `namedOnPage`; live, 2026-11-17: X's chat with Boardy was refused four times). A Bluesky message to someone who takes messages only from people they follow (its default) or from nobody ends at once as gone, asked of Bluesky's public API (`messagesClosed` in `chrome/bluesky-gate.ts`; the same day, 21 waited on cards and each try typed for four minutes into a New chat box that never lists them). Success requires the new body outside an empty composer (`bodyShown`: a body's links may show the site's way, as X shortens them, but its other words must show in order, close together); the model claiming success is insufficient. Lost send outcomes become `uncertain`; `HeldCheck` (and the manager's `verify_sent_draft`) resolves them from the observed destination without resending. A human's "Not there, post again" button explicitly reopens them. Equivalent open/posted drafts do not generate duplicate sends. The Quest page shows real platform and sending/unknown status. Task/manager reading tabs are closed when their runs finish; ambiguous posting tabs stay open until Quest's tabs close for idleness. Words longer than the field they go in (its `maxlength`, which the extension reports as a control's `limit` since 0.9.3, and enforces on `fill`) stop the poster at once with `TooLong`; the draft service then has the writer cut them to fit (`WritingJob.chars`) and brings the card back for a tap, or says how long the field is. The `draft` tool takes the `limit` the manager read, so the words fit from the start (2026-10-15: a 174-character bio for X's 160 went round prepare 26 times).

For supervised testing, `CHROME_DEBUG=1` binds the agent to loopback and exposes the broker's next/result routes for an internal-browser bridge. Debug jobs allow five minutes for manual execution; production retains its normal timeouts. `MQ_TEST_CUSTOMER` scopes task and manager claims to one customer. The deployed agent is production, with its own bot and database; supervised tests run a local agent polling @TestPatrikBot on the dev database. Never test against production users.
