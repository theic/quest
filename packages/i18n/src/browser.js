import { LANGUAGES, detectLocale, supportedLocale, direction, translator, messageTranslator } from "./language.js";

const key = "quest-language";
let locale = "en";
let translate = translator();
let translateMessage = messageTranslator();
const urlLanguage = new URLSearchParams(location.search).get("lang");
let override = supportedLocale(urlLanguage);
try { if (!override && urlLanguage !== "auto") override = supportedLocale(localStorage.getItem(key)); } catch { /* Storage is optional. */ }
const automatic = () => detectLocale([
  window.Telegram?.WebApp?.initDataUnsafe?.user?.language_code,
  ...(navigator.languages || [navigator.language]),
]);

/** Text only. Never used on customer content or drafts. */
export const t = (source, values = {}) => translate(source, values);
export const currentLocale = () => locale;
export const systemMessage = (source) => translateMessage(source);

async function select(value) {
  const wanted = supportedLocale(value) || automatic();
  let catalog = {};
  try {
    // English is the source catalog, where every text is its own translation: nothing to fetch.
    if (wanted !== "en") {
      const response = await fetch(new URL(`./locales/${wanted}.json`, import.meta.url));
      if (!response.ok) throw new Error("catalog unavailable");
      catalog = await response.json();
    }
    locale = wanted;
  } catch { locale = "en"; }
  translate = translator(catalog);
  translateMessage = messageTranslator(catalog);
  document.documentElement.lang = locale;
  document.documentElement.dir = direction(locale);
  apply(document);
  document.dispatchEvent(new CustomEvent("languagechange", { detail: { locale } }));
}

/**
 * Only explicitly marked, repository-owned HTML is translated. No observer of user data. Text that already reads
 * right (a page written in English, shown in English) is left alone, so the browser doesn't lay the page out again.
 */
export function apply(root) {
  root.querySelectorAll("[data-i18n]").forEach((element) => {
    const html = t(element.getAttribute("data-i18n"));
    if (element.innerHTML !== html) element.innerHTML = html;
  });
  for (const attribute of ["aria-label", "title", "placeholder", "content", "data-idle"]) {
    root.querySelectorAll(`[data-i18n-${attribute}]`).forEach((element) => {
      const value = t(element.getAttribute(`data-i18n-${attribute}`));
      if (element.getAttribute(attribute) !== value) element.setAttribute(attribute, value);
    });
  }
}

// Each language's flag, drawn here (30×20) because Windows shows flag emoji as two letters.
// Simplified where the real flag carries an emblem.
const stripes = (colors, vertical = false) => colors.map((color, i) => vertical
  ? `<rect x="${(30 / colors.length) * i}" width="${30 / colors.length + .1}" height="20" fill="${color}"/>`
  : `<rect y="${(20 / colors.length) * i}" width="30" height="${20 / colors.length + .1}" fill="${color}"/>`).join("");
const star = (x, y, r, turn = 0) => {
  const points = Array.from({ length: 10 }, (_, i) => {
    const a = turn + (Math.PI / 5) * i - Math.PI / 2, d = i % 2 ? r * .4 : r;
    return `${(x + d * Math.cos(a)).toFixed(2)},${(y + d * Math.sin(a)).toFixed(2)}`;
  });
  return `<polygon points="${points.join(" ")}" fill="#ffde00"/>`;
};
const FLAGS = {
  en: `<rect width="30" height="20" fill="#012169"/><path d="M0 0l30 20M30 0L0 20" stroke="#fff" stroke-width="4"/><path d="M0 0l30 20M30 0L0 20" stroke="#c8102e" stroke-width="1.5"/><path d="M15 0v20M0 10h30" stroke="#fff" stroke-width="6.5"/><path d="M15 0v20M0 10h30" stroke="#c8102e" stroke-width="3.8"/>`,
  ru: stripes(["#fff", "#0039a6", "#d52b1e"]),
  uk: stripes(["#0057b7", "#ffd700"]),
  pt: `<rect width="30" height="20" fill="#009c3b"/><path d="M15 2.5 27.5 10 15 17.5 2.5 10z" fill="#ffdf00"/><circle cx="15" cy="10" r="4.4" fill="#002776"/><path d="M10.8 9.2q4.2-1.4 8.4 1.2" stroke="#fff" stroke-width=".8" fill="none"/>`,
  es: stripes(["#aa151b", "#f1bf00", "#f1bf00", "#aa151b"]),
  fr: stripes(["#002654", "#fff", "#ce1126"], true),
  de: stripes(["#000", "#dd0000", "#ffce00"]),
  zh: `<rect width="30" height="20" fill="#ee1c25"/>${star(5.5, 5.5, 3.4)}${star(10.5, 2.2, 1.1, .6)}${star(12.6, 4.4, 1.1, .9)}${star(12.6, 7.4, 1.1, 0)}${star(10.5, 9.4, 1.1, .4)}`,
  hi: `${stripes(["#ff9933", "#fff", "#138808"])}<circle cx="15" cy="10" r="2.6" fill="none" stroke="#000080" stroke-width=".7"/><circle cx="15" cy="10" r=".6" fill="#000080"/>`,
  ar: `<rect width="30" height="20" fill="#006c35"/><path d="M8 8.2q1.6-2 3.2 0t3.2 0 3.2 0 3.2 0" stroke="#fff" stroke-width="1.1" fill="none"/><path d="M8.5 13.2h12.5l1.5-.9" stroke="#fff" stroke-width="1" fill="none"/>`,
};
// "Automatic", in a list of flags: a globe in the flag's place.
const GLOBE = `<g fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="15" cy="10" r="8.3"/><ellipse cx="15" cy="10" rx="3.6" ry="8.3"/><path d="M6.7 10h16.6"/></g>`;
// What the button says beside the flag. "UK" would read as Britain, so Ukrainian is UA.
const SHORT = { uk: "UA" };

function picker() {
  // A small button with the flag and code of the language in use. The real control is a native
  // select laid invisibly over it: it opens the system's own list (a sheet on a phone), works in
  // the extension's popup and the Mini App, and keeps #quest-language for the browser check.
  const label = document.createElement("label");
  label.className = "language-picker";
  label.title = t("Language");
  const face = document.createElement("span");
  face.className = "language-face";
  face.setAttribute("aria-hidden", "true");
  face.innerHTML = `<svg class="language-flag" viewBox="0 0 30 20">${FLAGS[locale] ?? FLAGS.en}</svg><span class="language-code">${SHORT[locale] ?? locale.toUpperCase()}</span><svg class="language-caret" viewBox="0 0 10 6"><path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  label.append(face);
  const select = document.createElement("select");
  select.setAttribute("aria-label", t("Language"));
  select.id = "quest-language";
  // Each option carries its flag. A system list shows the name alone; a page that styles the list itself
  // (appearance: base-select, as the landing does in Chrome) shows the flag beside it.
  const auto = document.createElement("option");
  auto.value = "auto";
  auto.innerHTML = `<svg class="language-flag language-globe" viewBox="0 0 30 20" aria-hidden="true">${GLOBE}</svg><span></span>`;
  auto.lastChild.textContent = t("Automatic");
  select.append(auto);
  for (const [code, name] of Object.entries(LANGUAGES)) {
    const option = document.createElement("option");
    option.value = code; option.lang = code;
    option.innerHTML = `<svg class="language-flag" viewBox="0 0 30 20" aria-hidden="true">${FLAGS[code]}</svg><span></span>`;
    option.lastChild.textContent = name;
    select.append(option);
  }
  select.value = override || "auto";
  label.append(select);
  (document.querySelector("[data-language-picker]") || document.querySelector("header, nav, main") || document.body).append(label);
  select.addEventListener("change", () => {
    override = supportedLocale(select.value);
    try { if (override) localStorage.setItem(key, override); else localStorage.removeItem(key); } catch { /* Optional. */ }
    // Reload so animated demos and dynamic pages never retain text in the old language.
    const url = new URL(location.href);
    // A URL choice also works when storage is blocked (private/embedded browsers).
    url.searchParams.set("lang", override || "auto");
    // A page that has a customer behind it (the Mini App) hears the choice first, and keeps it for them everywhere.
    const heard = typeof window.questLanguageChanged === "function" ? Promise.resolve(window.questLanguageChanged(override || "auto")).catch(() => undefined) : Promise.resolve();
    heard.then(() => window.location.assign(url));
  });
}

export const ready = (async () => { await select(override); picker(); })();
