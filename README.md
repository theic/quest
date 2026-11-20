# Quest

Quest finds the people online who want what you built, and hands you the words to reach them, sent from your own
accounts in your own Chrome. You tell it what you built; it reads where people ask for such a thing (X, LinkedIn,
Reddit, Bluesky, Threads, Hacker News and more), replies, likes and follows at a person's pace, and asks you only about
what is risky: words that name your product, private messages, changes to your profile. Every evening it sends one
report: who answered, what went up where, and what worked.

## Install

Ask your Claude Code or Codex: **"Install Quest from this repository and add the extension."** It follows
[AGENTS.md](AGENTS.md). By hand:

```bash
npm run setup
```

```bash
npm start
```

Then add Quest to Chrome from the [Chrome Web Store](https://chromewebstore.google.com/detail/messaging-quest/kojgkphccdbkkclgadbdheblpebmiapj),
open its side panel and press "Start talking".

What it needs: Node 22.12 or newer, Chrome, and a Claude or ChatGPT subscription signed in on your computer (Quest
thinks with it, so it costs nothing beyond what you already pay). Telegram is optional: your own bot's token in
`~/.quest/settings.json` lets you talk to Quest there too.

## What stays on your computer

Everything but the public people it finds: your chat, your drafts, who you talked with, your accounts and your pages
stay in `~/.quest` and your Chrome. The people Quest finds in public posts (their handle, what they made or asked for,
the post that said it) go to one shared database of people, which is what lets it match you with someone who asked
for your thing yesterday. Never your words, your drafts or who you are. Sharing is always on in the free edition: it is what makes it free to match, and someone who asks to be left alone is taken out of it for every install.

## Hosted

Quest also runs as a service at [messaging.quest](https://www.messaging.quest), on our models, for anyone who would
rather not keep a computer on. Same code: the hosted agent is this repository with its own database.

## Working on it

```bash
npm install
npm run check
```

`npm run dev` runs the dev stack against dev's database and bot (it needs `.env.local`; the details are in CLAUDE.md,
under "Production and dev"). How the pieces fit and the rules for working here: [CLAUDE.md](CLAUDE.md). What was
measured along the way: [FACTS.md](FACTS.md).

- `apps/agent`: the manager and its team, the task queue, the loops, the HTTP routes the extension calls.
- `apps/extension`: Quest for Chrome: the side panel (the chat) and where the team reads and works.
- `apps/web`: messaging.quest, the landing page.
- `packages/core`: the domain and its ports.
- `supabase/migrations`: the database, for Supabase and for the local edition's PGlite alike.

## License

[AGPL-3.0](LICENSE). Run it, change it and share it; if you host Quest for other people, publish your changes too.
