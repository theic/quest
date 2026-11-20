/**
 * Draws every image the Chrome Web Store listing needs, and the extension's own icons.
 *
 *   node store/chrome-web-store/render.cjs
 *
 * Needs Google Chrome (Playwright drives it, channel "chrome"; MQ_BROWSER_CHANNEL picks
 * another) and the network for the site's fonts. Nothing here touches a customer, a server
 * or a bot: the popup is drawn with a stand-in `chrome` API, the chat is the landing page's
 * own demo (a sample conversation), and the mark is the Q from brand/visor/render/mq.js.
 *
 * Writes:
 *   apps/extension/icons/icon-{16,32,48,128}.png   the toolbar and extension-page icons
 *   store/chrome-web-store/icon-128.png             the store icon (96 px art, 16 px clear)
 *   store/chrome-web-store/screenshot-*.png         1280 x 800
 *   store/chrome-web-store/promo-small-440x280.png, promo-marquee-1400x560.png
 * Pieces it photographs on the way go to .artifacts/store-parts (not kept).
 */
const { chromium } = require(process.env.MQ_PLAYWRIGHT_PATH || "playwright");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");

const root = path.resolve(__dirname, "../..");
const here = __dirname;
const parts = path.join(root, ".artifacts/store-parts");
fs.mkdirSync(parts, { recursive: true });

const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2" };
const mounts = [
  ["/extension/", path.join(root, "apps/extension")],
  ["/brand/", path.join(root, "brand")],
  ["/store/", here],
  ["/parts/", parts],
  ["/", path.join(root, "apps/web/public")],
];
const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  const [prefix, dir] = mounts.find(([p]) => pathname.startsWith(p));
  const file = path.join(dir, pathname === "/" ? "index.html" : pathname.slice(prefix.length));
  if (!file.startsWith(dir)) return void res.writeHead(403).end();
  fs.readFile(file, (err, body) => {
    if (err) return void res.writeHead(404).end();
    res.writeHead(200, { "Content-Type": `${types[path.extname(file)] || "application/octet-stream"}; charset=utf-8`, "Cache-Control": "no-store" });
    res.end(body);
  });
});

/** The popup's stand-in for the extension's service worker: what `status` answers, nothing else. */
const popupFixture = (status) => `window.chrome = { runtime: { sendMessage: async ({ type }) => type === "status" ? ${JSON.stringify(status)} : { ok: true } } };`;

const ICON_SIZES = [16, 32, 48, 128];

(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, channel: process.env.MQ_BROWSER_CHANNEL || "chrome" });
  const context = (options = {}) => browser.newContext({ locale: "en-US", reducedMotion: "reduce", colorScheme: "dark", ...options });
  try {
    // 1. The icons, from the vector Q. The toolbar sizes fill their square; the 128 keeps 16 px clear
    //    around 96 px of art, as the store asks, and doubles as the store icon.
    {
      const ctx = await context({ deviceScaleFactor: 1 });
      const page = await ctx.newPage();
      for (const size of ICON_SIZES) {
        await page.setViewportSize({ width: size, height: size });
        await page.goto(`${base}/store/scenes.html?icon=${size}`);
        await page.waitForFunction(() => window.__ready === true);
        const png = await page.locator("#icon").screenshot({ omitBackground: true });
        fs.writeFileSync(path.join(root, `apps/extension/icons/icon-${size}.png`), png);
        if (size === 128) fs.writeFileSync(path.join(here, "icon-128.png"), png);
      }
      await ctx.close();
    }

    // 2. The pieces, at twice the pixels so they stay sharp when placed.
    {
      const ctx = await context({ deviceScaleFactor: 2, viewport: { width: 1440, height: 1000 } });
      const page = await ctx.newPage();
      await page.goto(base);
      await page.waitForSelector("#quest-language");
      await page.evaluate(() => document.fonts.ready);
      await page.addStyleTag({ content: "html, body { background: transparent !important; } .ink-bed, .tap { display: none !important; }" });
      for (const chapter of [3, 5, 6, 7]) {
        await page.locator(`.chapters button[data-ch="${chapter}"]`).click();
        await page.waitForTimeout(900);
        // The newest card still waiting for its tap, its buttons showing (reduced motion plays a chapter to its end).
        if (chapter === 5) await page.evaluate(() => {
          for (const card of document.querySelectorAll('.tg-msg.card[data-ch="5"]')) card.classList.remove("done");
          const feed = document.querySelector(".tg-feed");
          feed.scrollTop = feed.scrollHeight;
        });
        await page.locator(".phone").screenshot({ path: path.join(parts, `phone-${chapter}.png`), omitBackground: true });
      }
      await ctx.close();
    }
    const popup = async (name, status, fill) => {
      const ctx = await context({ deviceScaleFactor: 2, viewport: { width: 320, height: 640 } });
      await ctx.addInitScript(popupFixture(status));
      const page = await ctx.newPage();
      await page.goto(`${base}/extension/popup.html`);
      await page.waitForSelector(status.connected ? "#connected:not([hidden])" : "#setup:not([hidden])");
      await page.evaluate(() => document.fonts.ready);
      if (fill) await fill(page);
      await page.waitForTimeout(300);
      await page.locator("body").screenshot({ path: path.join(parts, `popup-${name}.png`) });
      await ctx.close();
    };
    await popup("reading", { connected: true, server: "https://mq-v2-agent.fly.dev", device: "Chrome 155 on Windows", link: "ok", reading: "reddit.com", pagesToday: 37, dailyPages: 400, awake: true, visual: true, customServer: false });
    await popup("setup", { connected: false, server: "https://mq-v2-agent.fly.dev", link: null, customServer: false }, (page) => page.fill("#code", "K7P2-9QXM"));

    // 3. The listing's images, composed at the store's exact pixels.
    const scenes = [
      ["screenshot-1-hire.png", "hire", 1280, 800],
      ["screenshot-2-your-chrome.png", "chrome", 1280, 800],
      ["screenshot-3-connect.png", "connect", 1280, 800],
      ["screenshot-4-your-call.png", "drafts", 1280, 800],
      ["screenshot-5-nothing-hidden.png", "glass", 1280, 800],
      ["promo-small-440x280.png", "small", 440, 280],
      ["promo-marquee-1400x560.png", "marquee", 1400, 560],
    ];
    const ctx = await context({ deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    for (const [file, scene, width, height] of scenes) {
      await page.setViewportSize({ width, height });
      await page.goto(`${base}/store/scenes.html?scene=${scene}`);
      await page.waitForFunction(() => window.__ready === true);
      await page.screenshot({ path: path.join(here, file), clip: { x: 0, y: 0, width, height } });
      console.log(`${file} ${width}x${height}`);
    }
    await ctx.close();
  } finally {
    await browser.close();
    server.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
