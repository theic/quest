# Languages

Quest ships English, Russian, Ukrainian, Brazilian Portuguese, Spanish, French,
German, Simplified Chinese, Hindi and Arabic. Regional language codes match their
base language; unsupported preferences fall through to the next preference, then English.

The landing and extension detect browser preferences on each visit. The Telegram
Mini App prefers Telegram's language when available. The language picker is a
fallback: it saves a local preference and a `?lang=` URL, so it also works with
storage blocked. Choosing Automatic clears that preference. Arabic sets `dir=rtl`.
The landing never passes a language to the bot.

The bot reads Telegram's `language_code` on each inbound update. `/language ru`
(or any supported code) saves an explicit preference; `/language auto` follows
Telegram again. `customers.language` stores automatic values as bare codes and
manual values as `manual:<code>`. Existing bare values continue to work. No schema
migration is needed. Manager and task prompts use the customer's current language
for generated replies, questions, explanations and reports. Source quotations and
outgoing drafts keep the source/recipient language.

`src/locales/en.json` is the source catalog. Catalogs contain only repository-owned
interface copy. Named placeholders preserve customer values and let translations
reorder sentences. `systemMessage` matches complete known messages/templates;
unknown model/customer text is left alone. Marked HTML translations retain the exact
trusted source tags and attributes. Never mark customer content with `data-i18n`.

After changing a catalog or browser runtime, run:

```sh
node scripts/sync-i18n.mjs
npm run check
node scripts/check-i18n-browser.cjs
```

The sync script ships identical static assets with the no-build landing and the
unpacked Chrome extension, plus Chrome manifest translations. The browser check
needs Playwright and Chrome (`MQ_PLAYWRIGHT_PATH` can select a bundled runtime).
It exercises all languages at 320, 390 and 1440 px, the animated demo, dashboard,
connection pages, extension popup and manual/storage-denied fallbacks. Fixtures
never access live customers. Screenshots and a layout report go to `.artifacts/i18n`.

`scripts/translate-i18n.mjs` is an optional authoring helper, using an existing
OpenRouter key from `MQ_ENV_FILE`; only public interface copy is sent. `--review`
requests editorial corrections. Review the catalogs before publishing. Runtime
translation has no model/API dependency.

After deploying, run `node scripts/telegram-languages.ts` with `MQ_ENV_FILE` set to
the existing bot environment. It updates localized commands and profile descriptions
without changing the webhook, dropping updates or sending messages.
