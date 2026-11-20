/** Shared by Telegram and the browser. Language preferences never cross surfaces. */
/** @type {Readonly<Record<string, string>>} */
export const LANGUAGES = Object.freeze({
  en: "English", ru: "Русский", uk: "Українська", pt: "Português", es: "Español",
  fr: "Français", de: "Deutsch", zh: "中文", hi: "हिन्दी", ar: "العربية",
});
export const LOCALES = Object.freeze(Object.keys(LANGUAGES));

/** BCP 47 base-language matching, including Telegram's regional language codes. */
export function supportedLocale(value) {
  if (typeof value !== "string") return null;
  const base = value.trim().toLowerCase().replace(/_/g, "-").split("-")[0];
  return Object.hasOwn(LANGUAGES, base) ? base : null;
}

export function detectLocale(preferences = []) {
  for (const preference of preferences) {
    const locale = supportedLocale(preference);
    if (locale) return locale;
  }
  return "en";
}

// Existing bare language codes remain automatic. A manual choice is tagged in the existing
// nullable language field so it survives new Telegram updates and process restarts.
export function isManualLanguage(value) { return typeof value === "string" && value.startsWith("manual:"); }
export function customerLocale(value) {
  return supportedLocale(isManualLanguage(value) ? value.slice(7) : value) ?? "en";
}
// Telegram sends the language of the device each message came from: a phone set to Portuguese turned an
// English chat Portuguese (2026-10-14). The first one sets it; after that it changes only when they ask.
export function nextLanguage(current, telegramLanguage) {
  if (current) return current;
  return supportedLocale(telegramLanguage) ?? "en";
}
export function direction(locale) { return locale === "ar" ? "rtl" : "ltr"; }

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
/** Telegram limits count UTF-16 units. Keep whole visible characters within that limit. */
export function textPrefix(text, limit) {
  if (text.length <= limit) return text;
  let end = 0;
  for (const { index, segment } of graphemes.segment(text)) {
    if (index + segment.length > limit) break;
    end = index + segment.length;
  }
  return text.slice(0, end);
}

/** Named placeholders let a translator reorder a sentence without touching the values. */
export function interpolate(text, values = {}) {
  return text.replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (match, key) =>
    Object.hasOwn(values, key) ? String(values[key]) : match);
}

export function translator(catalog = {}) {
  return (source, values = {}) => interpolate(Object.hasOwn(catalog, source) ? catalog[source] : source, values);
}

/** A value of a pattern open at both ends ("{used} of {limit}") is a word or a few, never a sentence. */
const SHORT_VALUE = 40;

/** Match only complete, known system strings. Values are kept verbatim. */
export function messageTranslator(catalog = {}) {
  const t = translator(catalog);
  const patterns = Object.keys(catalog).filter((s) => /\{[a-zA-Z]\w*\}/.test(s) && !s.includes("<")).sort((a, b) => b.length - a.length).map((source) => {
    const names = [];
    // A value never runs across lines: no pattern does, and a message of several lines is translated line by line.
    const escaped = source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\{([a-zA-Z]\w*)\\\}/g, (_, name) => {
      names.push(name); return "([^\\n]*?)";
    });
    // Live, 2026-11-05: "{used} of {limit}" took the whole Chrome setup line ("... a tab group of my own ...") and
    // turned only its "of", so the setup went out in English.
    const open = /^\{[a-zA-Z]\w*\}/.test(source) && /\{[a-zA-Z]\w*\}$/.test(source);
    return { source, names, pattern: new RegExp(`^${escaped}$`), open };
  });
  const message = (text) => {
    if (Object.hasOwn(catalog, text)) return t(text);
    for (const { source, names, pattern, open } of patterns) {
      const match = pattern.exec(text);
      if (match && open && match.slice(1).some((value) => value.length > SHORT_VALUE)) continue;
      if (match) return t(source, Object.fromEntries(names.map((name, i) => [name,
        ["which", "label", "button"].includes(name) ? message(match[i + 1]) : match[i + 1]])));
    }
    return text.includes("\n") ? text.split("\n").map(message).join("\n") : text;
  };
  return message;
}

export function languageBriefing(preference) {
  const locale = customerLocale(preference);
  return `Customer language: ${LANGUAGES[locale]} (${locale}). ${isManualLanguage(preference) ? "They chose this language." : "Taken from their Telegram when they first wrote."} It stays the same whatever device they write from. When they ask for another language, or keep writing to you in one, call set_language and write in it from that message on; never point them to a command for it. For every promise or timed request in any language, record the deadline with promise/next_step tools before stating it; do not rely on automatic parsing of prose. Write natural everyday language, as a capable friend would, not literal translations, formal corporate copy or forced slang. All replies, questions and choices, reports, task titles, briefs, plans, memories and explanations for this customer use that language. Quotes remain in the source language. Pages, screenshots and accounts you read may be in other languages (their X may be set to Ukrainian): that never changes the language you write to them in. Drafts sent to other people use the recipient's language and the customer's instructions, not automatically the interface language. Preserve names, handles, URLs and commands exactly.`;
}
