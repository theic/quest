/** Rendering regression check. Set MQ_PLAYWRIGHT_PATH when using a bundled Playwright runtime. */
const { chromium } = require(process.env.MQ_PLAYWRIGHT_PATH || 'playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const http = require('node:http');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.artifacts/i18n');
fs.mkdirSync(output, { recursive: true });
const locales = ['en', 'ru', 'uk', 'pt', 'es', 'fr', 'de', 'zh', 'hi', 'ar'];
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const file = ['/glass', '/chrome', '/connect'].includes(pathname)
    ? path.join(root, 'apps/agent/public', pathname.slice(1) + '.html')
    : pathname.startsWith('/extension/') ? path.join(root, 'apps/extension', pathname.slice('/extension/'.length))
    : path.join(root, 'apps/web/public', pathname === '/' ? 'index.html' : pathname);
  try { const body = fs.readFileSync(file); res.writeHead(200, { 'Content-Type': (types[path.extname(file)] || 'application/octet-stream') + '; charset=utf-8' }); res.end(body); }
  catch { res.writeHead(404); res.end(); }
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, channel: process.env.MQ_BROWSER_CHANNEL || "chrome" });
  const report = [];
  try {
    for (const locale of locales) {
      const context = await browser.newContext({ locale: locale + ({ en: '-GB', pt: '-BR', uk: '-UA', zh: '-CN' }[locale] || ''), reducedMotion: 'reduce' });
      const page = await context.newPage();
      const errors = [];
      const catalog = JSON.parse(fs.readFileSync(path.join(root, `packages/i18n/src/locales/${locale}.json`), 'utf8'));
      page.on('pageerror', e => errors.push(e.message));
      for (const width of [1440, 390, 320]) {
        await page.setViewportSize({ width, height: width > 400 ? 1000 : 844 });
        await page.goto(base);
        await page.waitForSelector('#quest-language');
        await page.evaluate(() => document.fonts.ready);
        assert.equal(await page.locator('html').getAttribute('lang'), locale);
        assert.equal(await page.locator('html').getAttribute('dir'), locale === 'ar' ? 'rtl' : 'ltr');
        // The title is the line that says what Quest does: the first translated text.
        const heading = page.locator('.headline');
        const source = await heading.getAttribute('data-i18n');
        assert.equal(await heading.innerHTML(), catalog[source]);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
        const failures = [];
        if (overflow > 1) failures.push(`horizontal overflow ${overflow}px`);
        // The founder's feed: every logo, label, date and line of words stays inside its row, however long the language makes it.
        const spill = await page.evaluate(() => [...document.querySelectorAll('#public .feed-row')].flatMap(row => {
          const box = row.getBoundingClientRect();
          return [...row.querySelectorAll('.feed-logo, .feed-meta, .feed-text')].filter(el => {
            const r = el.getBoundingClientRect();
            return r.left < box.left - 0.5 || r.right > box.right + 0.5 || el.scrollWidth > el.clientWidth + 1;
          }).map(el => el.textContent || el.getAttribute('class'));
        }));
        if (spill.length) failures.push(`past its feed row: ${spill.join(', ')}`);
        // The title screen shows a different start button and note to a phone, to Chrome and to another browser:
        // check each, and that nothing in it (it clips its own overflow) reaches past the screen.
        for (const device of ['phone', 'other', 'chrome']) {
          await page.evaluate(d => { document.documentElement.dataset.device = d; }, device);
          const out = await page.evaluate(() => {
            const sticks = [...document.querySelectorAll('.hero a, .hero li, .hero p, .hero h1, #public *, #setup .step *, #start .actions *')].filter(el => {
              const r = el.getBoundingClientRect();
              return r.width > 0 && (r.left < -0.5 || r.right > innerWidth + 0.5);
            });
            return { sticks: sticks.map(el => el.className || el.tagName), doc: document.documentElement.scrollWidth - innerWidth };
          });
          if (out.sticks.length) failures.push(`${device}: past the screen: ${out.sticks.join(', ')}`);
          if (out.doc > 1) failures.push(`${device}: horizontal overflow ${out.doc}px`);
        }
        if (width !== 320) {
          await page.evaluate(() => window.scrollTo(0, 0));
          await page.screenshot({ path: path.join(output, `${locale}-${width}.png`), fullPage: true });
          await page.screenshot({ path: path.join(output, `${locale}-${width}-viewport.png`) });
        }
        report.push({ locale, width, failures });
        console.log(JSON.stringify(report.at(-1)));
      }
      // Test the populated Telegram Mini App without accounts, signatures or real customer data.
      await page.route('https://telegram.org/js/telegram-web-app.js', route => route.fulfill({ contentType: 'text/javascript', body: `window.Telegram={WebApp:{initData:'test-only',initDataUnsafe:{user:{language_code:'${locale}'}},ready(){},expand(){}}}` }));
      await page.route('**/glass/data', route => route.fulfill({ json: {
        chrome: { state: 'open', device: 'Chrome', seen: new Date().toISOString() },
        tasks: [{ title: 'Customer content 🇺🇦 العربية 中文', agent: 'explorer', status: 'running', at: new Date().toISOString() }],
        brief: 'Customer brief', plan: 'Customer plan',
        posting: [{ platform: 'reddit', alone: false, approved: 1, of: 3 }],
        people: [
          { key: 'you', name: 'Your posts and profile', platform: '', last: new Date().toISOString(), events: [{ at: new Date().toISOString(), what: 'Profile change', side: 'you', text: 'bio: Customer content 🇺🇦 العربية 中文', url: null, state: 'on a card', site: 'x.com' }] },
          { key: 'reddit:u/sam', name: 'u/sam', platform: 'reddit', last: new Date().toISOString(), events: [{ at: new Date().toISOString(), what: 'Their post', side: 'them', text: 'Customer content 🇺🇦 العربية 中文', url: 'https://example.test/1', state: null }, { at: new Date().toISOString(), what: 'Your reply', side: 'you', text: 'Original recipient language', url: null, state: 'on a card' }] }
        ],
        journal: [{ who: 'manager', what: 'Started a task · Customer content', at: new Date().toISOString() }]
      } }));
      await page.goto(base + '/glass');
      await page.waitForSelector('#view .card');
      for (const tab of ['now', 'people', 'memory', 'log']) {
        await page.locator(`[data-tab="${tab}"]`).click();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `${locale} dashboard ${tab}`);
        if (tab === 'memory') assert.equal(await page.locator('#view h2').first().textContent(), catalog.Brief);
        if (tab === 'people') {
          // A person's feed, their own and someone else's, fits too.
          for (const n of [0, 1]) {
            await page.locator('.person').nth(n).click();
            await page.waitForSelector('.bubble');
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `${locale} feed ${n}`);
            await page.locator('[data-tab="people"]').click();
          }
        }
      }
      // The popup uses a minimal Chrome API fixture, never the user's extension/session.
      await page.addInitScript(() => {
        window.chrome = { runtime: { sendMessage: async ({type}) => type === 'status' ? { connected: true, server: 'https://example.test', awake: true, pagesToday: 10, dailyPages: 400, reading: 'example.test' } : { ok: true } } };
      });
      await page.goto(base + '/extension/popup.html');
      await page.waitForSelector('#activity');
      await page.waitForFunction(() => document.getElementById('activity').textContent.includes('example.test'));
      assert.equal(await page.locator('html').getAttribute('lang'), locale);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `${locale} popup`);
      if (['ar', 'hi', 'uk'].includes(locale)) await page.screenshot({ path: path.join(output, `${locale}-popup.png`), fullPage: true });
      // Manual fallback persists and can be put back on automatic without altering Telegram links.
      await page.goto(base); await page.waitForSelector('#quest-language');
      await page.locator('#quest-language').selectOption(locale === 'en' ? 'uk' : 'en');
      await page.waitForLoadState('domcontentloaded');
      await page.waitForSelector('#quest-language');
      assert.equal(await page.locator('html').getAttribute('lang'), locale === 'en' ? 'uk' : 'en');
      assert.equal(await page.locator('.start-app').getAttribute('href'), 'https://t.me/messagingquestbot?start=founder');
      await page.locator('#quest-language').selectOption('auto');
      await page.waitForLoadState('domcontentloaded');
      await page.waitForSelector('#quest-language');
      assert.equal(await page.locator('html').getAttribute('lang'), locale);
      // Every extra public page uses the same locale and retains its functional state.
      for (const route of ['/experiments.html', '/chrome', '/connect#K7P2-9QXM', '/glass']) {
        await page.goto(base + route);
        await page.waitForSelector('#quest-language');
        assert.equal(await page.locator('html').getAttribute('lang'), locale);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
        report.push({ locale, route, width: 320, failures: overflow > 1 ? [`horizontal overflow ${overflow}px`] : [] });
      }
      assert.deepEqual(errors, [], locale);
      await context.close();
    }
    // Storage denial and unsupported preferences still leave the site usable.
    const context = await browser.newContext({ locale: 'it-IT', reducedMotion: 'reduce' });
    await context.addInitScript(() => { Object.defineProperty(window, 'localStorage', { get() { throw new Error('blocked'); } }); });
    const page = await context.newPage();
    await page.goto(base); await page.waitForSelector('#quest-language');
    assert.equal(await page.locator('html').getAttribute('lang'), 'en');
    assert(await page.locator('h1').isVisible());
    await page.locator('#quest-language').selectOption('uk');
    await page.waitForURL('**/?lang=uk');
    await page.waitForSelector('#quest-language');
    assert.equal(await page.locator('html').getAttribute('lang'), 'uk');
    await context.close();
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    assert.deepEqual(report.filter(r => r.failures.length), [], 'layout checks');
  } finally { await browser.close(); server.close(); }
})().catch(e => { console.error(e); server.close(); process.exitCode = 1; });
