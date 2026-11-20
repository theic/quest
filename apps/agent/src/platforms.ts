import type { DraftKind } from "@mq/core";

/**
 * What Quest's team knows about a site before it opens it: where each part is, the site's own rules and what
 * gets an account limited, how words read there, and how much Quest does there in a day. The founder,
 * 2026-10-16: "the amount of exploration must be minimized - the agent must understand out of the box the rules
 * and structure of the most popular platforms". Standing text, the same for every customer, so the prompts that
 * carry it stay cached. A page that differs from it wins: sites change, and this is what they were.
 *
 * The day limits are for what a person starts there: new posts of their own, private messages and emails, likes
 * and follows, profile changes. Replies and comments have none (the founder: "replies/comments should have no
 * specific limit"); they still go up a person's pace apart (the outbox's `SITE_GAP_MS`).
 */

/** The most Quest does on a site in a day, for each kind of thing that has a limit. 0: not on this site. */
export interface DayLimits {
  /** New posts of their own: a post, a thread, a story, a Note. */
  readonly posts: number;
  /** Private messages and emails. */
  readonly messages: number;
  /** Likes, follows and connection requests, together. */
  readonly actions: number;
  /** Changes to their own profile, a field each: enough for one profile check (name, bio, link, ...) in a day. */
  readonly profile: number;
}

export type LimitKind = keyof DayLimits;

/**
 * How fast Quest opens pages on a site, as one reader would: a pause between two of its pages, drawn from the range,
 * and at most so many in any ten minutes. Each site keeps its own clock, so Quest reads several sites side by side
 * and none sees a burst (the founder, 2026-10-23: "it switches between different websites to make it feel more
 * organic for a single one out of the sequence").
 */
export interface ReadPace {
  readonly gapMs: readonly [number, number];
  readonly per10Min: number;
}

export interface Platform {
  /** Stable and short, for counting and for the page: "x", "email". */
  readonly key: string;
  readonly name: string;
  /** The hosts it answers on, without www: a subdomain of one counts too. */
  readonly hosts: readonly string[];
  readonly limits: DayLimits;
  /** Follows a day, apart from the likes they share `actions` with: LinkedIn's are connection requests, about 100 a week. */
  readonly follows?: number;
  /** Its pace, when it is not `READ_PACE`'s. */
  readonly pace?: ReadPace;
  /**
   * Its pages show their posts only while Chrome draws them (measured on Reddit and X, 2026-10-15: a background tab
   * had a ninth and a third of the words), so a browser session there comes to the front to read them.
   */
  readonly drawn?: boolean;
  /** Where each part is, as addresses to open straight away. */
  readonly where: string;
  /** Its rules, and what gets a post removed or an account limited. */
  readonly rules: string;
  /** How words read there: lengths, format, links, tags. */
  readonly writing: string;
}

export const PLATFORMS: readonly Platform[] = [
  {
    key: "reddit",
    name: "Reddit",
    hosts: ["reddit.com", "redd.it"],
    pace: { gapMs: [8_000, 15_000], per10Min: 30 },
    drawn: true,
    limits: { posts: 2, messages: 5, actions: 30, profile: 2 },
    where: [
      "A community: reddit.com/r/<name>/, newest first /r/<name>/new/, its rules /r/<name>/about/rules/ (the sidebar shows them too).",
      "Search: search_posts with source reddit (site r/<name> for one community), or reddit.com/r/<name>/search/?q=<words>&restrict_sr=1&sort=new.",
      "A post: reddit.com/r/<name>/comments/<id>/; a person: reddit.com/user/<name>/. Their own profile: the avatar menu, View Profile.",
      "A new post: reddit.com/r/<name>/submit (Text, Link or Images; many communities want a flair picked). A private message: reddit.com/message/compose/?to=<name>, or Chat.",
      "Their profile settings: reddit.com/settings/profile (display name 30 characters, about 200).",
      "Answers to their comments and posts: reddit.com/message/inbox/ (or the bell, reddit.com/notifications); read it before opening threads one by one.",
    ].join("\n"),
    rules: [
      "Every community has its own rules: read /about/rules/ before posting there. Many ban self-promotion or links, or allow them only in a weekly thread; some want a minimum account age or karma.",
      "AutoModerator removes posts from new or low-karma accounts without a word; the author still sees them, so a removal shows only to a visitor.",
      "Be a member, not a marketer: talk about what they made in a small share of what they post, and say it is theirs. Never ask for upvotes, never post the same words in several communities, one post a week per community.",
    ].join("\n"),
    writing: "Titles up to 300 characters, a post up to 40,000, a comment up to 10,000. Plain conversational text; no hashtags; a link only where asked for, since links from new accounts get filtered. Marketing tone gets downvoted.",
  },
  {
    key: "x",
    name: "X",
    hosts: ["x.com", "twitter.com"],
    pace: { gapMs: [6_000, 12_000], per10Min: 30 },
    drawn: true,
    limits: { posts: 10, messages: 20, actions: 100, profile: 4 },
    where: [
      "Search: search_posts with source x, or x.com/search?q=<words>&f=live (newest; f=top for top). In the words: from:<handle>, since:YYYY-MM-DD, lang:en, min_faves:5, -filter:replies.",
      "A profile: x.com/<handle>; a post: x.com/<handle>/status/<id>. Their own: the Profile link in the sidebar.",
      "A new post: x.com/compose/post (the composer opens; Post sends). Once sent it shows on their own profile (the Profile link), not on Home. A reply: the reply box under the post.",
      "Their profile: x.com/settings/profile (name 50 characters, bio 160, location 30, website 100); Save is at the top right of the dialog.",
      "Messages: x.com/messages (on newer accounts Chat, x.com/i/chat). Notifications: x.com/notifications; mentions: x.com/notifications/mentions.",
    ].join("\n"),
    rules: [
      "X's automation rules: no bulk or fast following, liking or unfollowing; no duplicate or near-duplicate posts; no replies or mentions to people who did not ask, sent in numbers. Each reply is about that post.",
      "Unverified and new accounts are limited sooner: a message to someone who does not follow them can be blocked or land in requests.",
      "A link in a post cuts its reach: the usual way is a reply to the post with the link.",
      "A new or labelled account's replies are folded out of other people's threads, where nobody reads them (measured by hand, 2026-11-02: 0 answers to 18 replies on posts hours old). Likes and follows still reach people, and a reply to a post under an hour old with few replies is seen: two were answered within 3 minutes.",
    ].join("\n"),
    writing: "280 characters a post (25,000 with Premium; a link counts as 23). Longer: a thread of replies to their own post. Short and direct, casual; one or two hashtags at most, usually none; emoji sparingly.",
  },
  {
    key: "linkedin",
    name: "LinkedIn",
    hosts: ["linkedin.com", "lnkd.in"],
    pace: { gapMs: [12_000, 25_000], per10Min: 12 },
    drawn: true,
    limits: { posts: 2, messages: 30, actions: 60, profile: 4 },
    follows: 15,
    where: [
      "The feed: linkedin.com/feed/; a new post: the Start a post box at the top of the feed.",
      "Search posts: search_posts with source linkedin, or linkedin.com/search/results/content/?keywords=<words>&datePosted=%22past-week%22; people: linkedin.com/search/results/people/?keywords=<words>.",
      "Their own profile: linkedin.com/in/me/ (it opens theirs); someone's: linkedin.com/in/<slug>/; a post: linkedin.com/feed/update/urn:li:activity:<id>/.",
      "Headline: the pencil on the intro card of their profile (220 characters); About: the pencil on the About section (2,600).",
      "Messages: linkedin.com/messaging/. Notifications: linkedin.com/notifications/.",
      "A follow here is a connection request: the Connect button on their profile (under More when it is not shown, \"Invite <name> to connect\"), and the invitation goes without a note. Their Follow only where the profile has no Connect (a creator's, or already connected).",
    ].join("\n"),
    rules: [
      "Messages go only to their 1st-degree connections; anyone else needs a connection request first (a note of 200 characters; free accounts get only a few notes a month) or InMail, which is paid.",
      "LinkedIn caps invitations at about 100 a week and restricts accounts whose requests go unanswered or that act fast and alike, as automation does.",
      "One post a day at most. A post with an outside link reaches fewer people: the link goes in the first comment.",
    ].join("\n"),
    writing: "A post up to 3,000 characters, but only the first two or three lines (about 210 characters) show before \"see more\", so the first line carries it. A comment up to 1,250. Short paragraphs with line breaks; professional but personal, first person; three hashtags at most, at the end; no \"Excited to announce\".",
  },
  {
    key: "instagram",
    name: "Instagram",
    hosts: ["instagram.com", "instagr.am"],
    pace: { gapMs: [8_000, 15_000], per10Min: 20 },
    drawn: true,
    limits: { posts: 2, messages: 20, actions: 80, profile: 4 },
    where: [
      "A profile: instagram.com/<handle>/; a post: instagram.com/p/<code>/; a reel: instagram.com/reel/<code>/. Their own: the Profile link in the sidebar.",
      "Their profile: instagram.com/accounts/edit/ (name, bio 150 characters). Its website and links change only in the Instagram app (the page says \"Editing your links is only available on mobile\", live 2026-11-03): never draft a website or link change there, they make it in the app.",
      "Messages: instagram.com/direct/inbox/. Comments on their posts: open the post. Notifications: the heart in the sidebar. Search: the Search panel in the sidebar; a tag: instagram.com/explore/tags/<tag>/.",
      "Finding people (measured by hand, 2026-11-02): tag and post searches bring up posts days or weeks old and \"comment X to get\" bait. The small builders posting fresh work are in instagram.com/explore/people/ (suggested, once they follow a few) and among the people commenting under a small builder's fresh post. A post page shows Follow beside its author: follow from there (a profile page can freeze the tab).",
      "A new post: Create in the sidebar. It needs a photo or a video, which Quest cannot make: an Instagram post waits for them to add the picture.",
    ].join("\n"),
    rules: [
      "Instagram blocks actions for a while (\"Try again later\") after bursts of follows, likes, comments or messages, sooner on new accounts: spread them out.",
      "A message to someone who does not follow them lands in Requests; the same message sent to many gets flagged.",
      "Links in captions and comments are not clickable; the bio's link is the one link.",
    ].join("\n"),
    writing: "A caption up to 2,200 characters, its first line shows before \"more\"; 30 hashtags at most, three to five read better. A comment up to 2,200, usually a line: a short reaction to what they made works, and small builders answer within minutes (2 of 3 first comments, 2026-11-01). A reply to a comment starts with their @handle. A message short and personal.",
  },
  {
    key: "facebook",
    name: "Facebook",
    hosts: ["facebook.com", "fb.com", "messenger.com"],
    pace: { gapMs: [8_000, 15_000], per10Min: 20 },
    drawn: true,
    limits: { posts: 2, messages: 10, actions: 30, profile: 4 },
    where: [
      "Their own profile: facebook.com/me/; someone's: facebook.com/<username> or facebook.com/profile.php?id=<id>.",
      "Groups: facebook.com/groups/<name or id>/, its rules under About; the groups they are in: facebook.com/groups/feed/.",
      "Search posts: facebook.com/search/posts/?q=<words>; groups: facebook.com/search/groups/?q=<words>.",
      "Messages: facebook.com/messages/ (or messenger.com). Their profile: facebook.com/me/, Edit profile (bio 101 characters). A Page they run: switch to it from the avatar menu.",
    ].join("\n"),
    rules: [
      "Every group has its own rules: many ban promotion or links, or allow them on one day of the week; admins remove posts and members.",
      "The same words posted in many groups get the account restricted. A message to someone who is not a friend lands in Message requests.",
    ].join("\n"),
    writing: "A post can run long, but short ones read; a link shows a preview card; hashtags are rare. Groups answer questions and stories, not announcements.",
  },
  {
    key: "threads",
    name: "Threads",
    hosts: ["threads.net", "threads.com"],
    pace: { gapMs: [6_000, 12_000], per10Min: 30 },
    drawn: true,
    limits: { posts: 6, messages: 20, actions: 80, profile: 4 },
    where: [
      "Home: threads.com/; search: threads.com/search?q=<words>&serp_type=default&filter=recent (newest first; without filter=recent it shows top posts of any age); a profile: threads.com/@<handle>; a post: threads.com/@<handle>/post/<id>.",
      "A reply: the \"Reply to …\" box under the post, sent with the arrow beside it. Answers and new followers: threads.com/activity.",
      "A new post: the What's new? box at the top of the home feed. Their profile: their profile page, Edit profile (bio 150 characters). An account goes with their Instagram.",
    ].join("\n"),
    rules: "Meta's limits apply as on Instagram: bursts of follows, likes or replies get the account blocked for a while. A new account starts small: about 15 things a day, mostly likes and follows of builders, and a reply or two to posts under an hour old.",
    writing: "500 characters a post, one link, one topic tag. Casual and conversational; something longer is a thread of several posts.",
  },
  {
    key: "tiktok",
    name: "TikTok",
    hosts: ["tiktok.com"],
    pace: { gapMs: [8_000, 15_000], per10Min: 20 },
    drawn: true,
    limits: { posts: 2, messages: 10, actions: 80, profile: 4 },
    where: [
      "Search: tiktok.com/search?q=<words>; a profile: tiktok.com/@<handle>; a video: tiktok.com/@<handle>/video/<id>, its comments beside or under it.",
      "Messages: tiktok.com/messages. Their profile: their profile page, Edit profile (bio 80 characters).",
      "A new video: tiktok.com/tiktokstudio/upload. It needs a video, which Quest cannot make: it waits for them.",
    ].join("\n"),
    rules: "Messages go only between people who follow each other, unless their settings allow more. Comments like \"check my profile\" get hidden, and repeated ones get the account restricted. A new account's follows can be undone without a word (2026-11-03: every follow showed Following, then was gone by the next visit, the profile's Following at 0): that is an action block, so check a follow on their own profile's Following count, and when they were undone, follow nobody more there.",
    writing: "A comment up to 150 characters; a caption up to 4,000, short ones work, three to five hashtags are normal.",
  },
  {
    key: "youtube",
    name: "YouTube",
    hosts: ["youtube.com", "youtu.be"],
    pace: { gapMs: [4_000, 8_000], per10Min: 40 },
    drawn: true,
    limits: { posts: 2, messages: 0, actions: 80, profile: 4 },
    where: [
      "Search: search_posts with source youtube, or youtube.com/results?search_query=<words> (Filters sorts by upload date); a channel: youtube.com/@<handle>; a video: youtube.com/watch?v=<id>; a short: youtube.com/shorts/<id>.",
      "Comments are under the video and load as the page scrolls.",
      "Their channel: studio.youtube.com (the comments on their videos under Comments; name and description, 1,000 characters, under Customization). Community posts: youtube.com/@<handle>/posts. YouTube has no private messages.",
    ].join("\n"),
    rules: [
      "Comments with links are often held for review or hidden; promotional or repeated comments get an account's comments hidden everywhere.",
      "Their Google account may hold several channels (theirs, their product's brand channel): the account menu (their avatar) names the one active. Act as the one active: it is the one they chose, a brand channel named for their product included. Switch, or stop, only when what Quest knows of them names another channel of theirs for YouTube.",
      "Google answers too many reads with an \"unusual traffic\" check (google.com/sorry, a reCAPTCHA; 2026-11-02, after a day of reads): stop YouTube there for the day and tell them. Never touch the check.",
    ].join("\n"),
    writing: "A comment up to 10,000 characters, but short ones read. Plain text; a time like 1:23 links to that moment. A new comment shows under Newest, not Top. A plain question about a fresh launch video is often answered within the hour.",
  },
  {
    key: "email",
    name: "Email",
    hosts: ["mail.google.com", "gmail.com", "outlook.live.com", "outlook.office.com", "outlook.office365.com"],
    limits: { posts: 0, messages: 20, actions: 0, profile: 0 },
    where: [
      "Gmail: a new email to someone: mail.google.com/mail/u/0/?view=cm&fs=1&to=<address>&su=<subject> (the compose window opens with them filled in); the inbox: mail.google.com/mail/u/0/#inbox; search: mail.google.com/mail/u/0/#search/<words>; sent: #sent.",
      "Outlook: outlook.live.com/mail/0/deeplink/compose?to=<address>&subject=<subject> (work accounts: outlook.office.com).",
    ].join("\n"),
    rules: [
      "Cold email from their own Gmail: about 20 new people a day keeps it out of spam (Gmail allows 500, but spam filters judge far sooner). Plain text, one link at most, no attachments, images or tracking.",
      "Every cold email says who they are and why this person; one follow-up at most when nobody answers; anyone who asks not to be emailed never is again (CAN-SPAM, GDPR).",
      "An address only from where the person published it to be reached (their site, their profile), never guessed.",
    ].join("\n"),
    writing: "A subject of a few plain words, no clickbait. A body of 50 to 120 words with one ask. Their signature is the one Gmail adds.",
  },
  {
    key: "bluesky",
    name: "Bluesky",
    hosts: ["bsky.app", "bsky.social"],
    limits: { posts: 5, messages: 10, actions: 50, profile: 3 },
    where: "Search: bsky.app/search?q=<words>; a profile: bsky.app/profile/<handle>; a post: bsky.app/profile/<handle>/post/<id>; messages: bsky.app/messages; a message to someone: open their profile and press its Message button (the New chat box at bsky.app/messages does not take typed names); their profile: their profile page, Edit profile (bio 256 characters).",
    rules: "People there dislike marketing and mass replies; follow and reply as a person would.",
    writing: "300 characters a post; casual; a link shows a card.",
  },
  {
    key: "hackernews",
    name: "Hacker News",
    hosts: ["news.ycombinator.com", "hn.algolia.com"],
    limits: { posts: 1, messages: 0, actions: 0, profile: 1 },
    where: "Newest: news.ycombinator.com/newest; Ask HN: /ask; Show HN: /show; a new post: news.ycombinator.com/submit (title 80 characters, a link or text); a thread: news.ycombinator.com/item?id=<id>; a person: news.ycombinator.com/user?id=<name>. Search: search_posts with source hackernews.",
    rules: "No promotion beyond a Show HN of something people can try now. Never ask for upvotes or comments: voting rings get accounts banned, so Quest never upvotes there. Comments substantive and kind (news.ycombinator.com/newsguidelines.html); posts and links from new accounts may be hidden.",
    writing: "Plain text, no emoji, no marketing words; titles plain, no exclamation marks. Say plainly they made it.",
  },
  {
    key: "producthunt",
    name: "Product Hunt",
    hosts: ["producthunt.com"],
    limits: { posts: 1, messages: 5, actions: 10, profile: 2 },
    where: "A product: producthunt.com/products/<slug>; a launch: producthunt.com/posts/<slug>; discussions: producthunt.com/discussions; search: producthunt.com/search?q=<words>; a launch is prepared at producthunt.com/launch, one per product.",
    rules: "Never ask for upvotes; comments genuine and specific. On launch day the makers answer every comment.",
    writing: "Comments short and specific; the tagline 60 characters.",
  },
  {
    key: "indiehackers",
    name: "Indie Hackers",
    hosts: ["indiehackers.com"],
    limits: { posts: 1, messages: 5, actions: 20, profile: 2 },
    where: "Posts: indiehackers.com/posts; newest first: indiehackers.com/newest; groups: indiehackers.com/group/<name>. Its search was retired in 2026 (HTTP 410).",
    rules: "Talk about what they built through what they learned (numbers, mistakes); a bare launch post gets ignored.",
    writing: "Plain and honest, numbers welcome; a title that says the lesson.",
  },
  {
    key: "telegram",
    name: "Telegram",
    hosts: ["web.telegram.org", "t.me", "telegram.org"],
    pace: { gapMs: [6_000, 12_000], per10Min: 30 },
    limits: { posts: 6, messages: 40, actions: 0, profile: 1 },
    where: [
      "Chats: web.telegram.org/a/ (signed in as them); a group or channel there: web.telegram.org/a/#@<name>. A public channel or group: t.me/<name>.",
      "A public channel's last posts, with no sign-in: t.me/s/<name> (newest at the bottom; a post: t.me/<name>/<id>).",
      "Finding builders: their channels and groups (indie hackers, build in public, startups, SaaS, the customer's niche) by a web search with site:t.me and the words; then t.me/s/<name> for what was posted this week, and in a group the members' own posts about what they built or how to get first users.",
      "Telegram has no likes or follows Quest does. A reply in a group, a comment under a channel's post or a message is a draft. A chat in the list opens on a click of its row, or by its address (web.telegram.org/a/#<id>). To answer one message in a group, press its Reply where the page shows one (the box then shows the message it answers); with no Reply control on screen, do not hunt for one: write in the group's message box with their name first, which reads the same in a chat. Joining a group is theirs unless they said Quest may: then its Join button is pressed in the browser.",
    ].join("\n"),
    rules: "Accounts that message many strangers get reported and lose the right to message anyone outside their contacts. Every group has its own rules about promotion, often in its pinned message: read it first; many ban links from new members.",
    writing: "Short messages, one thought each.",
  },
  {
    key: "whatsapp",
    name: "WhatsApp",
    hosts: ["web.whatsapp.com", "whatsapp.com", "wa.me"],
    limits: { posts: 0, messages: 20, actions: 0, profile: 1 },
    where: "Chats: web.whatsapp.com; a chat with a number: wa.me/<number>.",
    rules: "Messages only to people who expect them: a few reports get the number banned.",
    writing: "Short and personal, like a text to someone they know.",
  },
  {
    key: "discord",
    name: "Discord",
    hosts: ["discord.com", "discord.gg"],
    pace: { gapMs: [6_000, 12_000], per10Min: 30 },
    limits: { posts: 6, messages: 10, actions: 40, profile: 2 },
    where: [
      "A server's channel: discord.com/channels/<server>/<channel>; their servers and messages: discord.com/channels/@me; an invite: discord.gg/<code>.",
      "Finding builders: the servers they are in first (discord.com/channels/@me, the list on the left); public servers of builders (indie hackers, build in public, SaaS, the customer's niche) on Discover, discord.com/servers, or by a web search with site:discord.com and the words. Builders share in channels like #showcase, #launches, #introductions and #feedback: read the last day there.",
      "A server they are not in shows nothing until they join, which is theirs unless they said Quest may join: then its invite is opened and Join pressed. A reply in a channel is a draft; a message to a member only when they talked first.",
      "A message here has no Like and a member no Follow: draft neither (live, 2026-11-11, a like ended as nothing to press). Its emoji reactions are not drafted.",
    ].join("\n"),
    rules: "Every server has a rules channel, and most keep promotion to one channel. Unasked messages to a server's members get accounts banned.",
    writing: "Chat-length messages, casual.",
  },
  {
    key: "medium",
    name: "Medium",
    hosts: ["medium.com"],
    limits: { posts: 1, messages: 0, actions: 20, profile: 2 },
    where: [
      "Search stories: medium.com/search?q=<words> (it shows the newest under the Stories tab); a tag's newest: medium.com/tag/<tag>/recommended or medium.com/tag/<tag>/archive (startup, saas, indie-hackers, side-project, entrepreneurship, build-in-public).",
      "A story: medium.com/@<handle>/<slug> or <publication>/<slug>; its responses (comments) open from the speech bubble under it, written in the \"What are your thoughts?\" box. A like is the clap (one is enough); a follow is Follow on the author's page.",
      "A new story: medium.com/new-story; their stories: medium.com/me/stories; a person: medium.com/@<handle>; their profile: medium.com/me/settings (bio 160 characters). Medium has no private messages.",
    ].join("\n"),
    rules: "Stories that only promote get no distribution, and a response that only links out is hidden as spam. Founders write there about launching and first users: a response that answers what the story asks is read by its author.",
    writing: "A real article with a plain title; a response reads like a comment, two or three sentences on what the story said.",
  },
  {
    key: "substack",
    name: "Substack",
    hosts: ["substack.com"],
    limits: { posts: 3, messages: 5, actions: 30, profile: 2 },
    where: [
      "Notes, their short posts: substack.com/notes (the feed; a new Note from its box at the top). Search: substack.com/search/<words>?searching=all_types (posts, Notes and people).",
      "A Note: substack.com/@<handle>/note/<id>; a reply under it, a like (the heart) and a restack. A post: <name>.substack.com/p/<slug>, its comments under it (substack.com/@<handle> is the person).",
      "Messages: substack.com/chat (a direct message to someone who follows back or allows it). Their profile: substack.com/settings.",
    ].join("\n"),
    rules: "Notes reward conversation; a Note that only links out gets little. Writers and founders answer replies to their Notes.",
    writing: "Notes short, like a post on X; restacks with a line of their own; comments under a post a few sentences.",
  },
  {
    key: "tumblr",
    name: "Tumblr",
    hosts: ["tumblr.com"],
    pace: { gapMs: [6_000, 12_000], per10Min: 30 },
    limits: { posts: 4, messages: 5, actions: 50, profile: 2 },
    where: [
      "Search: tumblr.com/search/<words>?src=typed_query&post_view=list (Latest under the filter, newest first); a tag: tumblr.com/tagged/<tag> (indie dev, gamedev, startup, side project, devlog, small business).",
      "A post: tumblr.com/<blog>/<id>; a reply is its speech bubble (Reply), a like the heart, a reblog the arrows; a follow is Follow on the blog. A message: tumblr.com/messaging, to a blog that takes them.",
      "A new post: tumblr.com/new/text. Their blog: tumblr.com/<their blog>; its description under Edit appearance.",
    ].join("\n"),
    rules: "People there dislike being sold to; a reply that only promotes gets the blog blocked or reported. Makers post devlogs and their art and shops there and answer replies.",
    writing: "Casual, lower case reads fine, tags at the bottom of a post (#indiedev). A reply up to 475 characters.",
  },
  {
    key: "peerlist",
    name: "Peerlist",
    hosts: ["peerlist.io"],
    pace: { gapMs: [6_000, 12_000], per10Min: 30 },
    limits: { posts: 3, messages: 10, actions: 40, profile: 3 },
    where: [
      "The feed of builders: peerlist.io/scroll (newest posts; a post: peerlist.io/scroll/post/<id>); Launchpad, this week's launches with their makers: peerlist.io/launchpad. A person: peerlist.io/<handle>; a project: peerlist.io/<handle>/project/<slug>.",
      "A reply is the comment under a post or a launch; a like is its upvote or the heart; a follow is Follow on their profile. Messages: peerlist.io/messages.",
      "A new post: Write in the feed. Their profile: peerlist.io/<their handle>, Edit profile (headline, about, links).",
    ].join("\n"),
    rules: "A network of developers and makers, most of them shipping side projects: launches on Launchpad want comments and first users. Promotion in comments is frowned on; help and specific feedback are welcome.",
    writing: "Like LinkedIn but more casual and technical; short comments with something specific.",
  },
  {
    key: "quora",
    name: "Quora",
    hosts: ["quora.com"],
    limits: { posts: 2, messages: 5, actions: 20, profile: 2 },
    where: "Search: quora.com/search?q=<words>; a question: quora.com/<Question-Words>; answers are under it.",
    rules: "An answer has to answer: self-promotion with no answer, or links without context, get collapsed; say plainly it is theirs.",
    writing: "Answers in plain paragraphs; the first lines show in the feed.",
  },
  {
    key: "pinterest",
    name: "Pinterest",
    hosts: ["pinterest.com", "pin.it"],
    limits: { posts: 5, messages: 5, actions: 30, profile: 2 },
    where: "Search: pinterest.com/search/pins/?q=<words>; a new pin: pinterest.com/pin-creation-tool/. A pin needs a picture, which Quest cannot make.",
    rules: "Many identical pins or links to the same page read as spam.",
    writing: "A pin title up to 100 characters, a description up to 500, with the words people search for.",
  },
];

/** A site Quest has nothing written about: what it does there in a day. */
export const OTHER_SITE: Platform = {
  key: "other",
  name: "Other sites",
  hosts: [],
  limits: { posts: 2, messages: 10, actions: 30, profile: 2 },
  where: "",
  rules: "",
  writing: "",
};

const hostIn = (host: string, hosts: readonly string[]): boolean => hosts.some((h) => host === h || host.endsWith(`.${h}`));

/** The platform a draft's platform ("reddit", "x.com"), a host or an address is on; null for a site with nothing written. */
export function platformOf(where: string): Platform | null {
  const raw = where.trim().toLowerCase();
  if (!raw) return null;
  const byKey = PLATFORMS.find((p) => p.key === raw);
  if (byKey) return byKey;
  let host = raw;
  try {
    host = new URL(/^[a-z]+:\/\//.test(raw) ? raw : `https://${raw}`).hostname;
  } catch {
    return null;
  }
  host = host.replace(/^www\./, "");
  return PLATFORMS.find((p) => hostIn(host, p.hosts)) ?? null;
}

/** A site's pace when Quest knows nothing else about it: a few seconds between pages, as a reader skims. */
export const READ_PACE: ReadPace = { gapMs: [3_000, 6_000], per10Min: 40 };

/** How fast Quest opens pages on this host. */
export const paceOf = (host: string): ReadPace => platformOf(host)?.pace ?? READ_PACE;

/** Whether this address's pages show their posts only while Chrome draws them. */
export const drawnOn = (url: string): boolean => Boolean(platformOf(url)?.drawn);

/** Which day limit a kind of draft counts against; null for replies and comments, which have none. */
export function limitKind(kind: DraftKind): LimitKind | null {
  if (kind === "post") return "posts";
  if (kind === "message") return "messages";
  if (kind === "like" || kind === "follow") return "actions";
  if (kind === "profile") return "profile";
  return null;
}

/** The limit's words, for a refusal and the page. */
export const LIMIT_WORDS: Readonly<Record<LimitKind, { one: string; many: string }>> = {
  posts: { one: "post", many: "posts" },
  messages: { one: "message", many: "messages" },
  actions: { one: "like or follow", many: "likes and follows" },
  profile: { one: "profile change", many: "profile changes" },
};

/** What Quest knows about a platform, as its prompts carry it: where things are, its rules, how words read. */
export function platformGuide(p: Platform, parts: readonly ("where" | "rules" | "writing")[] = ["where", "rules", "writing"]): string {
  const words = { where: "Where things are", rules: "Its rules", writing: "How words read there" } as const;
  return [`ABOUT ${p.name.toUpperCase()} (what Quest knows; a page that differs wins):`, ...parts.filter((k) => p[k]).map((k) => `${words[k]}:\n${p[k]}`)].join("\n");
}

/**
 * Where things are on every platform Quest knows, for the standing prompt of everyone with a browser: open the
 * page that does the job straight away rather than looking for it. The rules come with a platform's first page.
 */
export const PLATFORM_MAP = `Where things are on the sites Quest knows (open the page that does the job at once; a page that differs wins):\n${PLATFORMS.map((p) => `${p.name}:\n${p.where}`).join("\n")}`;
