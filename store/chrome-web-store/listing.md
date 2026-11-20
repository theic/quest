# The Chrome Web Store listing

Every field the developer dashboard asks for, in the order it asks. Copy them as they are: a
reviewer checks the listing against the code and the privacy policy, so nothing here says more
than the extension does. The images are beside this file (README.md says where each one goes).

---

## Package

`npm run extension:pack` → `.artifacts/extension/messaging-quest-<version>.zip`. Upload that zip.

## Store listing

**Name** (from the manifest): `Messaging Quest`

**Summary** (from the manifest's `description`, translated in `_locales/`; 132 characters at most):

```
Find the right people with Quest.
```

**Description**:

```
Quest finds the people online who want what you built, and writes to them with you, from your own accounts. Tell it what you built in its side panel; it reads where people ask for such a thing (X, LinkedIn, Reddit, Bluesky, Threads, Hacker News and more), replies, likes and follows at a person's pace, and every evening sends one report: who answered, what went up where, what worked.

Quest is open source. Run it yourself on your computer, on the Claude or ChatGPT subscription you already have (github.com/theic/quest), or use the one we host, with nothing to install.

HOW IT WORKS
1. Install this extension and click its icon: the side panel is your chat with Quest.
2. Press "Start talking" and tell it what you built. If Quest runs on this computer, the extension pairs with it by itself; otherwise it pairs with our hosted Quest. There is no password to share.
3. Quest opens pages in a tab group of its own, at a reader's pace, and finds the people asking for what you built.
4. Words that name your product, private messages and profile changes always wait for your tap. Other kinds go on their own once you have approved a few. The bar at the top of the panel pauses everything.

WHAT THE EXTENSION DOES
• Reads public web pages for Quest in its own tabs, a few seconds apart.
• Posts the replies, posts and messages you approve, or let Quest send, from your own accounts, through each site's own forms and buttons.
• On sites that hide their controls, it can look at a picture of Quest's own work tab and click or type there. This is "Visual browser controls": on by default, off with one switch in the extension.
• Keeps the computer awake while it is connected, so Quest keeps working while you are away. One switch turns that off.

WHAT IT NEVER DOES
• It never asks for your password, and never fills in or sends one. You handle signing in.
• It never reads your other tabs or windows.
• It never opens addresses on your local network for reading; the only local address it talks to is Quest itself, when you run Quest on this computer.
• It never works around a site's refusal, a CAPTCHA or a bot check.

YOUR DATA
What Quest reads goes to the Quest it is paired with (on your computer, or ours) and to the AI models that do the work. The public people it finds go to one shared list every Quest reads. Your passwords and cookies stay in Chrome. The details are at https://www.messaging.quest/privacy

Free to use. Questions: hello@messaging.quest
```

**Category**: Productivity › Communication. (Quest finds people and writes to them. If the
reviewers move it, Productivity › Workflow & Planning is the next best fit.)

**Language**: English. The extension itself already speaks ten languages; the listing can be
translated later in the dashboard's language menu.

**Graphic assets**:

| Field | File |
| --- | --- |
| Store icon | `icon-128.png` (the same file as the extension's `icons/icon-128.png`) |
| Screenshots (in this order) | `screenshot-1-hire.png`, `screenshot-2-your-chrome.png`, `screenshot-3-connect.png`, `screenshot-4-your-call.png`, `screenshot-5-nothing-hidden.png` |
| Small promo tile (required) | `promo-small-440x280.png` |
| Marquee promo tile (optional) | `promo-marquee-1400x560.png` |
| Promo video | none yet |

**Additional fields**:

- Official URL: `https://www.messaging.quest` (needs the domain verified in Google Search Console first; leave "None" until then).
- Homepage URL: `https://www.messaging.quest/`
- Support URL: `https://github.com/theic/quest/issues`
- Mature content: No.

## Privacy practices

**Single purpose**:

```
Messaging Quest is the interface of Quest, an assistant that finds the people who want what the user built: its side panel is the user's chat with Quest, and in the user's own Chrome it reads public pages to find those people and posts or sends the messages the user approves, or allows Quest to send, from the user's own accounts.
```

**Permission justifications**:

| Permission | Justification |
| --- | --- |
| `storage` | Keeps the connection to the user's Quest (server address and token), the user's two switches (keep awake, visual controls) and today's page counts. |
| `alarms` | Wakes the service worker every 30 seconds to ask the user's Quest for the next page to read. A Manifest V3 worker sleeps after 30 seconds, so without it Quest's work would stop. |
| `power` | Keeps the computer from sleeping while this Chrome is connected, so Quest keeps working while the user is away. It asks for "system" only (the screen may still turn off), ends on disconnect, and the popup has a switch to turn it off. |
| `tabs` | Opens Quest's own reading window and tabs, checks the address each one ended on (to refuse a page that redirected to a local address), opens the posting tab in the user's window, and closes them when done. Also finds an open Connect page when the extension is installed. |
| `tabGroups` | Labels Quest's tab "Quest is reading", so the user can tell Quest's window from their own. |
| `scripting` | Runs the extension's own functions in the pages Quest opened: reading their text, links and posts, filling and clicking a site's own controls in Quest's work tab, and covering password and payment fields before a picture is taken. Only code packaged in the extension runs; nothing is fetched. |
| `webRequest` | Reads the status code and server IP of the pages Quest opens (observe only, no blocking), so it can refuse a page that resolves to a private network and report why a page failed. |
| `declarativeNetRequestWithHostAccess` | One session rule for one tab: Quest's "visitor" tab, which drops cookies and authorization headers so Quest can check, as a logged-out visitor would, whether the user's own post is still visible to others. |
| `debugger` | Visual browser controls. Attaches to Quest's own work tab only, for one action at a time, to take a screenshot of that tab and to send a click or typed text to it, when a site draws its controls on a canvas that page scripts cannot reach. It never attaches to the user's other tabs, and the popup has a switch to turn it off. |
| `sidePanel` | The extension's whole interface is a side panel: the user's chat with Quest, the drafts waiting for their approval, and the switch that pauses Quest. It opens beside the current page only when the user clicks Quest's toolbar icon, a second click hides it, and it never opens by itself or draws anything over web pages. It shows only the extension's own page and reads nothing from the page beside it. |
| `contextMenus` | Adds one item, "Open the chat", to the right-click menu of Quest's own toolbar icon. No menu is added to web pages. |
| Host permission `<all_urls>` | Quest reads whichever public site the user's request leads to (forums, communities, company and job sites), so the list cannot be known in advance. Only public http and https addresses are opened; local and private-network addresses are refused before and after loading. |
| Content script on `mq-v2-agent.fly.dev/connect` | The Connect page Quest sends the user: it hands the one-time code in the page's address to the extension, which pairs this Chrome. |
| `http://localhost:8787` | Quest run on the user's own computer (the open-source edition). The extension asks it whether it is there, and pairs with it instead of our server when it is. |

**Remote code**: `No, I am not using remote code.` (The extension runs only its own packaged
files. What the agent sends are addresses, CSS selectors and actions as data.)

**Data usage**: what to tick, and why.

| Category | Tick? | Why |
| --- | --- | --- |
| Personally identifiable information | Yes | The account name a post was sent from goes back to Quest, and the pages Quest reads name people (authors of public posts). |
| Health information | No | |
| Financial and payment information | No | Card number and security code fields are never read, card fields are covered before any picture, and checkout, billing and payment pages are not pictured. |
| Authentication information | No | Passwords, one-time codes and cookies are never read or sent; password fields are covered before any picture. |
| Personal communications | Yes | When the user lets Quest work in a web messenger or mailbox, the page text it reads there, and the messages it sends, go to Quest. |
| Location | No | |
| Web history | No | The extension does not read the user's browsing history; it reports only the pages Quest itself opened. |
| User activity | No | It does not watch the user's clicks, keys or scrolling. |
| Website content | Yes | The text, links and posts of the pages Quest opens, and pictures of Quest's own tab. |

Tick all three certifications (no selling or transferring outside the approved uses, no use
unrelated to the single purpose, no creditworthiness or lending use).

**Privacy policy URL**: `https://www.messaging.quest/privacy`

## Distribution

- Payments: free.
- Visibility: Public once the landing links to it; Unlisted if you want a quiet first week (the
  link still works for anyone who has it).
- Regions: all.

## Test instructions (for the reviewer)

```
No account or Telegram is needed.

1. Install the extension and click its toolbar icon. The side panel opens.
2. Press "Start talking" and write what you built, for example "I make tally.so, a form builder".
3. Quest answers in the panel and starts looking: it opens pages in a tab group of its own. The bar at the top of the panel says "Quest is working in this Chrome"; Pause stops everything at once.
4. People it found and the words it drafted for them show in the panel as a list above the box to write in; "Post it" posts one from the account you are signed in to in this Chrome, "Skip" drops it.
5. The gear opens settings: where Quest works (a switch per site), the model it thinks with, and past reports.
```
