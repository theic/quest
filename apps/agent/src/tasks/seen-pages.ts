import type { PageComment } from "@mq/core";
import { answerRow } from "../chrome/posted-body.ts";
import { replySpot } from "../drafts/one-reply.ts";
import { normalizeUrl } from "../lib/urls.ts";

/** What a search result or a read page said about a post, beyond its words. */
export interface SeenMeta {
  readonly source?: string;
  readonly author?: string | null;
  /** A search result's thread title; social posts have none. */
  readonly title?: string | null;
  readonly postedAt?: Date | null;
  /** The browser tab's title of a page read directly: noisy on social sites, fine on forums. */
  readonly pageTitle?: string | null;
  /** The comments under the post, each by its own person. */
  readonly comments?: readonly PageComment[];
  /** The platform's own id for the post, for a reply to go under it. */
  readonly ref?: string | null;
}

interface Seen {
  text: string;
  meta: SeenMeta;
}

const loose = (s: string): string =>
  s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u2018\u2019\u201a\u201b\u2032]/g, "'")
    .replace(/[\u201c\u201d\u201e\u201f\u2033]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** A page's site, with twitter.com as x.com and no www. */
const hostOf = (url: string): string | null => {
  try {
    const h = new URL(url).hostname.replace(/^(www|mobile)\./, "");
    return h === "twitter.com" ? "x.com" : h;
  } catch {
    return null;
  }
};

/** Shortest piece of a quote that counts as words someone wrote, rather than a phrase anyone might. */
const MIN_FRAGMENT = 12;

/**
 * True when every substantial piece of the quote (the parts between "…") appears
 * in the text, allowing for case, spacing and curly quotes. A quote is what the
 * person wrote, never a paraphrase.
 */
export function quoteAppears(quote: string, text: string): boolean {
  const haystack = loose(text);
  const pieces = loose(quote)
    .replace(/^["']+|["']+$/g, "")
    .split(/\s*(?:…|\.\.\.|\[…\]|\[\.\.\.\])\s*/)
    .map((p) => p.replace(/^[\s"'.,;:!?-]+|[\s"'.,;:!?-]+$/g, ""))
    .filter((p) => p.length > 0);
  const substantial = pieces.filter((p) => p.length >= MIN_FRAGMENT);
  if (!substantial.length) return false;
  return substantial.every((p) => haystack.includes(p));
}

/**
 * Every post and page a subagent has actually seen in this run, with its words.
 * The scout may only save a find it saw, quoting what was there: that is what
 * makes an invented person or an invented quote impossible, not a prompt.
 */
export class SeenPages {
  readonly #pages = new Map<string, Seen>();
  readonly #accounts = new Set<string>();
  /** The pages opened themselves (read_page, the browser), each with the posts it showed in order, by whom. */
  readonly #opened = new Map<string, readonly { readonly author: string | null; readonly text: string }[]>();

  /** Their own name on each site, by host, as the page read there showed it. */
  readonly #accountOn = new Map<string, string>();

  /** The customer's own name on a site, as a page read showed it (X's link to their profile); `url` is the page's. */
  account(name: string | null | undefined, url?: string): void {
    if (!name?.trim()) return;
    const bare = name.trim().replace(/^@/, "");
    this.#accounts.add(bare.toLowerCase());
    const host = url ? hostOf(url) : null;
    if (host) this.#accountOn.set(host, bare);
  }

  /** Their name on the site of this address, when a page read there in this run showed it. */
  accountOn(url: string): string | null {
    const host = hostOf(url);
    return host ? (this.#accountOn.get(host) ?? null) : null;
  }

  /** Whether this name is one of the customer's own, as pages read in this run showed them. */
  isOwn(name: string | null | undefined): boolean {
    return Boolean(name && this.#accounts.has(name.trim().replace(/^@/, "").toLowerCase()));
  }

  /**
   * Who wrote the post a quote is from, among the posts seen one by one (a page cut into posts records each): the
   * shortest seen text that holds the quote is its own post. Null when no single post holds it.
   */
  authorOf(quote: string): string | null {
    let best: Seen | null = null;
    for (const seen of this.#pages.values()) {
      if (!seen.meta.author || !quoteAppears(quote, seen.text)) continue;
      if (!best || seen.text.length < best.text.length) best = seen;
    }
    return best?.meta.author ?? null;
  }

  record(url: string, text: string, meta: SeenMeta = {}): void {
    const key = normalizeUrl(url);
    const had = this.#pages.get(key);
    if (!had) {
      this.#pages.set(key, { text, meta });
      return;
    }
    if (!had.text.includes(text)) had.text = `${had.text}\n${text}`;
    had.meta = {
      source: had.meta.source ?? meta.source,
      author: had.meta.author ?? meta.author ?? null,
      title: had.meta.title ?? meta.title ?? null,
      postedAt: had.meta.postedAt ?? meta.postedAt ?? null,
      pageTitle: had.meta.pageTitle ?? meta.pageTitle ?? null,
      ref: had.meta.ref ?? meta.ref ?? null,
      ...(had.meta.comments ?? meta.comments ? { comments: had.meta.comments ?? meta.comments } : {}),
    };
  }

  /**
   * A page opened itself, not seen as a row of a list (a search, their notifications), with its posts in order: a thread
   * is its post, then the replies under it. Only there does it show what is under a post already.
   */
  opened(url: string, posts: readonly { readonly author: string | null; readonly text: string }[] = []): void {
    this.#opened.set(normalizeUrl(url), posts);
  }

  /** The posts of the page this post was opened on, by its address or the same post's other one; undefined when it never was. */
  openedPosts(url: string): readonly { readonly author: string | null; readonly text: string }[] | undefined {
    const exact = this.#opened.get(normalizeUrl(url));
    if (exact) return exact;
    const spot = replySpot(url);
    if (!spot) return undefined;
    for (const [key, posts] of this.#opened) if (replySpot(key) === spot) return posts;
    return undefined;
  }

  /** Their own answer under the post a quote is from, on the page that post was opened on: the first one after it by their account. */
  answeredUnder(url: string, quote: string): string | null {
    const posts = this.openedPosts(url) ?? [];
    const at = posts.findIndex((p) => quoteAppears(quote, p.text));
    return at < 0 ? null : (posts.slice(at + 1).find((p) => answerRow(p.text, url) && this.isOwn(p.author))?.text ?? null);
  }

  /**
   * Whether these words are a comment under one of the customer's own posts: on a page opened in this run, a post of theirs
   * comes before them in the thread (their post's own page, or a comment's page that shows the thread above it). Live,
   * 2026-11-16: thank-yous to comments under their Product Hunt launch post on X were refused as small talk, since the
   * comment's own page starts with the comment.
   */
  underOwnPost(url: string, quote: string | null | undefined): boolean {
    const pages = [this.openedPosts(url) ?? [], ...(quote ? [...this.#opened.values()] : [])];
    return pages.some((posts) => {
      const at = quote ? posts.findIndex((p) => quoteAppears(quote, p.text)) : -1;
      if (at < 0) return quote ? false : this.isOwn(posts[0]?.author);
      return posts.slice(0, at).some((p) => this.isOwn(p.author));
    });
  }

  get(url: string): Seen | undefined {
    return this.#pages.get(normalizeUrl(url));
  }

  /**
   * The page at this address, or the same post seen under another one: a Reddit thread with or without its title in the
   * path, an X post on twitter.com. Live, 2026-11-01: a run opened three Reddit threads at their full addresses, drafted
   * at the short ones it was given, and every reply was refused as unread.
   */
  post(url: string): Seen | undefined {
    const exact = this.get(url);
    if (exact) return exact;
    const spot = replySpot(url);
    if (!spot) return undefined;
    for (const [key, seen] of this.#pages) if (replySpot(key) === spot) return seen;
    return undefined;
  }

  /** Every page seen, oldest first, with its words. */
  all(): { readonly url: string; readonly text: string }[] {
    return [...this.#pages].map(([url, seen]) => ({ url, text: seen.text }));
  }
}
