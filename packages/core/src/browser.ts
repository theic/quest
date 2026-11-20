import type { CustomerId } from "./ids.ts";

/** A control observed in a particular document. References expire after every action. */
export interface BrowserControl {
  readonly ref: string;
  readonly role: string;
  readonly label: string;
  readonly value: string | null;
  readonly href: string | null;
  /** The most characters a text field takes (its maxlength), when it has one: X's profile bio takes 160. */
  readonly limit?: number;
  readonly options?: readonly { readonly value: string; readonly label: string }[];
  /** A toggle's state (aria-pressed, aria-checked): a like that is on, a follow that is done. Extension 0.10 on. */
  readonly pressed?: boolean;
  /** Which of the page's posts (`items`) the control belongs to: a Like or a Reply in a feed acts on that one. */
  readonly item?: number;
}

/** Where the page is scrolled to, in CSS pixels, on whatever scrolls it. */
export interface BrowserScroll {
  readonly y: number;
  readonly height: number;
  readonly viewport: number;
}

/** Visible page content, including accessible frames and open shadow roots. Never cookies or passwords. */
export interface BrowserView {
  readonly url: string;
  readonly title: string;
  readonly text: string;
  readonly controls: readonly BrowserControl[];
  readonly frames?: readonly string[];
  /** The posts the page lists (a feed's, a thread's comments), the start of each: what a control's `item` is. */
  readonly items?: readonly string[];
  readonly scroll?: BrowserScroll;
  /** Still coming in: the document, or a spinner or busy region on screen. */
  readonly loading?: boolean;
  /** The field the keys go to now ("textbox: Write your reply"), when one has them. */
  readonly focus?: string;
  /** A dialog or menu on screen, with its name. */
  readonly dialog?: string;
  /** Current task-tab picture for visual controls. Kept in memory; never transcript/checkpoints. */
  readonly screen?: BrowserScreen;
  /** Text transcribed from pixels can include a draft; it is not a delivery receipt. */
  readonly visualText?: boolean;
}

export interface BrowserScreen {
  readonly id: string;
  readonly image: string;
  readonly width: number;
  readonly height: number;
}

export type BrowserAction =
  | { readonly kind: "snapshot" }
  | { readonly kind: "screenshot" }
  | { readonly kind: "click_point"; readonly screen: string; readonly x: number; readonly y: number }
  | { readonly kind: "move_point"; readonly screen: string; readonly x: number; readonly y: number }
  | { readonly kind: "type_text"; readonly screen: string; readonly text: string; readonly method?: "text" | "keys" }
  | { readonly kind: "press_focused"; readonly screen: string; readonly key: "Enter" | "Tab" | "Escape" }
  | { readonly kind: "scroll_point"; readonly screen: string; readonly x: number; readonly y: number; readonly direction: "up" | "down" }
  | { readonly kind: "click"; readonly ref: string }
  | { readonly kind: "fill"; readonly ref: string; readonly text: string }
  | { readonly kind: "press"; readonly ref: string; readonly key: "Enter" | "Tab" | "Escape" }
  | { readonly kind: "select"; readonly ref: string; readonly value: string }
  /** `pages`: screens to go, each waited on for what a feed draws as it is neared (the agent does them one by one). */
  | { readonly kind: "scroll"; readonly ref?: string; readonly direction: "up" | "down"; readonly pages?: number }
  /** Waits for the page: until `text` shows, or `seconds` pass (at most 15). The agent looks again; the extension never sees it. */
  | { readonly kind: "wait"; readonly text?: string; readonly seconds?: number }
  /** One of their own pictures (sent to Quest in their chat) into the composer's file field; `ref` its add-media control. Extension 0.11 on. */
  | { readonly kind: "attach"; readonly ref?: string; readonly name: string; readonly type: string; readonly data: string }
  | { readonly kind: "close" };

export interface BrowserJob {
  /** Isolated tab per task/post; never the customer's existing tabs. */
  readonly session: string;
  /** Navigate only when supplied. Otherwise act on the current document. */
  readonly url?: string;
  readonly action: BrowserAction;
  /**
   * The site shows its posts only while Chrome draws the page, so the tab comes to the front for this step. Without
   * it, a step comes to the front only for a picture or input by sight. An agent from before always sent none, and
   * every step came to the front.
   */
  readonly drawn?: boolean;
}

export interface BrowserTransport {
  browser(customerId: CustomerId, job: BrowserJob): Promise<BrowserView>;
}

/** Platform keys are hosts, except the existing Reddit adapter. No list of supported services. */
export function platformFor(raw: string): string {
  const host = new URL(raw).hostname.toLowerCase().replace(/^www\./, "");
  return /(^|\.)reddit\.com$/.test(host) ? "reddit" : host;
}

/** A sign-in page's address: /login, /signin, Instagram's /accounts/login, X's /i/flow/login, LinkedIn's /uas/login. */
const SIGN_IN_PATH = /\/(?:log-?in|sign-?in|sign_in|accounts\/login|i\/flow\/login|uas\/login)(?:[/?#]|$)/i;
/** "Log in" and "Sign in", in the languages Quest speaks. */
const SIGN_IN_WORDS = "log ?in|sign ?in|войти|увійти|entrar|iniciar sesión|se connecter|connexion|anmelden|einloggen|登录|登入|लॉग इन|تسجيل الدخول";
/** A control that offers to sign in ("Log in", "Sign in to X"). A signed-in page has none. */
const SIGN_IN = new RegExp(`^(?:${SIGN_IN_WORDS})(?: (?:to|в|до|na|en|à|bei) [\\p{L}\\p{N} .]{1,30})?$`, "iu");
/** A control that mentions signing in or a password ("Log in with Facebook", "Forgot password?"). */
const ABOUT_SIGN_IN = new RegExp(`${SIGN_IN_WORDS}|password|пароль|senha|contraseña|mot de passe|passwort|密码|पासवर्ड|كلمة المرور`, "iu");
/** How the extension labels a password (or payment) field, whose contents it never reads. */
export const PROTECTED_CONTROL = "Protected sign-in/payment control";
/** What a link to the signed-in person's own profile says: X's and Instagram's menus say "Profile". */
const PROFILE = /^(?:(?:my|your|view|view your|go to|go to your) )?(?:profile|профиль|профіль|perfil|profil|个人资料|個人資料|प्रोफ़ाइल|الملف الشخصي)$/iu;

const site = (raw: string): string | null => {
  try {
    return new URL(raw).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
};

/** What a page shows about the customer's own login on its site. */
export interface PageLogin {
  /** It asks them to sign in: a sign-in address, a "Log in" / "Sign in" control, or a password field beside talk of signing in. */
  readonly signedOut: boolean;
  /** Signed in, the link to their own profile there, when the page has one labelled so; null when it has none. */
  readonly profile: string | null;
}

/**
 * Reads, from a page Quest opened in their Chrome, whether they are signed in to the site and, when they are,
 * where their own profile is: so Quest learns their name there by looking, not by asking them for their handle
 * (live, 2026-10-13), and a sign-in wall is said at once, not after ten minutes of searching around it.
 */
export function pageLogin(view: Pick<BrowserView, "url" | "controls">): PageLogin {
  let path = "";
  try {
    const u = new URL(view.url);
    path = `${u.pathname}${u.search}`;
  } catch {
    return { signedOut: false, profile: null };
  }
  // Instagram's own sign-in page keeps its "Log in" button disabled (so unseen) until something is typed: what is left
  // is the password field and "Log in with Facebook" (measured in Chrome, 2026-10-13).
  const password = view.controls.some((c) => c.label === PROTECTED_CONTROL) && view.controls.some((c) => ABOUT_SIGN_IN.test(c.label));
  if (SIGN_IN_PATH.test(path) || password || view.controls.some((c) => SIGN_IN.test(c.label.trim()))) return { signedOut: true, profile: null };
  const host = site(view.url);
  // A bare "Profile" (or "My profile") is theirs; "View profile" may be the person the page is about (live, 2026-11-17:
  // a Bluesky profile's own "View profile" was taken for the customer's), so it counts only when nothing plainer is there.
  const links = view.controls.filter((c) => c.href && PROFILE.test(c.label.trim()) && site(c.href) === host);
  const own = links.find((c) => !/^view\b|^go to\b/i.test(c.label.trim())) ?? links[0];
  return { signedOut: false, profile: own?.href ?? null };
}
