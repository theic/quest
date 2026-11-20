/**
 * Remakes the landing's pictures for search engines and link previews, in apps/web/public:
 * og.png (the link preview, from apps/web/share/card.html), apple-touch-icon.png, icon-512.png (the logo
 * in the structured data) and favicon.ico (32 and 48 px, for browsers and crawlers that ask for it).
 * The icons are favicon.svg; the card borrows the page's own sprite, so the logos stay the page's.
 * Run it after changing the Visor, the card or the networks. Set MQ_PLAYWRIGHT_PATH when using a bundled
 * Playwright runtime.
 */
const { chromium } = require(process.env.MQ_PLAYWRIGHT_PATH || 'playwright');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const pub = path.join(root, 'apps/web/public');
const work = path.join(root, '.artifacts/share');
fs.mkdirSync(work, { recursive: true });

const page = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
const sprite = page.match(/<svg class="sprite"[\s\S]*?<\/svg>\n/);
if (!sprite) throw new Error('index.html has no sprite');
const card = fs.readFileSync(path.join(root, 'apps/web/share/card.html'), 'utf8')
  .replaceAll('{{public}}', pathToFileURL(pub).href)
  .replaceAll('{{fonts}}', pathToFileURL(path.join(root, 'apps/extension/fonts')).href)
  .replace('<!-- sprite -->', sprite[0]);
fs.writeFileSync(path.join(work, 'card.html'), card);

const icon = (size, ground) => `<!doctype html><html><head><style>html,body{margin:0;background:${ground}}img{display:block;width:${size}px;height:${size}px}</style></head>`
  + `<body><img src="${pathToFileURL(path.join(pub, 'favicon.svg')).href}"></body></html>`;

/** An .ico that holds PNGs, which every browser since IE Vista reads. */
function ico(pngs) {
  const head = Buffer.alloc(6 + 16 * pngs.length);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(pngs.length, 4);
  let offset = head.length;
  pngs.forEach(({ size, data }, i) => {
    const at = 6 + 16 * i;
    head.writeUInt8(size % 256, at); head.writeUInt8(size % 256, at + 1);
    head.writeUInt16LE(1, at + 4); head.writeUInt16LE(32, at + 6);
    head.writeUInt32LE(data.length, at + 8); head.writeUInt32LE(offset, at + 12);
    offset += data.length;
  });
  return Buffer.concat([head, ...pngs.map((p) => p.data)]);
}

(async () => {
  const browser = await chromium.launch({ headless: true, channel: process.env.MQ_BROWSER_CHANNEL || 'chrome' });
  const shoot = async (file, { width, height }, options = {}) => {
    const tab = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    await tab.goto(pathToFileURL(file).href);
    await tab.evaluate(() => document.fonts.ready);
    await tab.waitForLoadState('networkidle');
    const data = await tab.screenshot({ type: 'png', ...options });
    await tab.close();
    return data;
  };
  fs.writeFileSync(path.join(pub, 'og.png'), await shoot(path.join(work, 'card.html'), { width: 1200, height: 630 }));
  // The touch icon is square: iOS rounds the corners itself, so they get the tile's colour, not transparency.
  for (const [name, size, ground] of [['apple-touch-icon.png', 180, '#0b0c0b'], ['icon-512.png', 512, 'transparent']]) {
    fs.writeFileSync(path.join(work, name + '.html'), icon(size, ground));
    fs.writeFileSync(path.join(pub, name), await shoot(path.join(work, name + '.html'), { width: size, height: size }, { omitBackground: ground === 'transparent' }));
  }
  const small = [];
  for (const size of [32, 48]) {
    fs.writeFileSync(path.join(work, `ico-${size}.html`), icon(size, 'transparent'));
    small.push({ size, data: await shoot(path.join(work, `ico-${size}.html`), { width: size, height: size }, { omitBackground: true }) });
  }
  fs.writeFileSync(path.join(pub, 'favicon.ico'), ico(small));
  await browser.close();
  for (const name of ['og.png', 'apple-touch-icon.png', 'icon-512.png', 'favicon.ico']) {
    console.log(name, fs.statSync(path.join(pub, name)).size, 'bytes');
  }
})().catch((error) => { console.error(error); process.exit(1); });
