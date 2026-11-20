import en from "./locales/en.json" with { type: "json" };
import ru from "./locales/ru.json" with { type: "json" };
import uk from "./locales/uk.json" with { type: "json" };
import pt from "./locales/pt.json" with { type: "json" };
import es from "./locales/es.json" with { type: "json" };
import fr from "./locales/fr.json" with { type: "json" };
import de from "./locales/de.json" with { type: "json" };
import zh from "./locales/zh.json" with { type: "json" };
import hi from "./locales/hi.json" with { type: "json" };
import ar from "./locales/ar.json" with { type: "json" };
import { customerLocale, translator, messageTranslator } from "./language.js";
export * from "./language.js";

export const catalogs = { en, ru, uk, pt, es, fr, de, zh, hi, ar };
export const forLanguage = (language) => translator(catalogs[customerLocale(language)]);

const messages = new Map();
export function systemMessage(language, text) {
  const locale = customerLocale(language);
  if (!messages.has(locale)) messages.set(locale, messageTranslator(catalogs[locale]));
  return messages.get(locale)(text);
}
