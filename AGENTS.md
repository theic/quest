# Installing Quest (for Claude Code, Codex, or any coding agent)

The person asked you to "install Quest and add the extension". Quest finds the people online who want what they
built and hands them the words to reach them, from their own accounts, in their own Chrome. The local edition runs on
their computer, thinks with their own Claude or ChatGPT subscription, and keeps everything on their computer except the
public people it finds, which go to one shared database of people (that is what makes matching almost free).

Do this, in order, in this folder:

1. `npm run setup`. It checks Node (22.12 or newer), installs the packages, sees which subscription is signed in on
   this computer, makes `~/.quest`, and on Windows makes Quest start with the computer. Read what it prints: each `todo`
   line is a step for them, not for you.
2. If it says no subscription is signed in: Claude is `npm run claude:login`, which opens their browser to sign in.
   ChatGPT is the Codex CLI or app, signed in with `codex login`. Never ask for a password or an API key: the sign-in is
   theirs, in their browser.
3. Tell them to add Quest to Chrome from the Chrome Web Store (the link setup printed). It is one click for them, and
   nothing you can do for them.
4. `npm start`, in the background. It prints the address it runs on (`http://localhost:8787`). Leave it running.
5. Tell them to open Quest's side panel (its icon in Chrome's toolbar) and press "Start talking". The panel finds Quest
   on this computer by itself. Quest asks one thing, what they built, and starts.

That is all. Settings are in `~/.quest/settings.json`: `models` ("claude-cli" or "codex-cli"), and `telegramToken` if
they want to talk to Quest in Telegram too (their own bot: BotFather's `/newbot` gives the token; paste it there and run
`npm start` again). Do not change `port`: the store extension pairs with 8787 only.

If something fails: `~/.quest/quest.log` (when it started with Windows) or the output of `npm start`. The database is
the folder `~/.quest/db`; moving it aside starts Quest fresh.

Working on Quest's code itself rather than installing it: CLAUDE.md. A scratch install for trying a change shares its
people with production unless told otherwise: start it with `PEOPLE_SERVER=http://localhost:8080` and the dev stack up
(`npm run dev`), and `QUEST_HOME` set to a folder of its own.
