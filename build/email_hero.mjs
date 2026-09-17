// Renders build/email-hero.html to assets/img/email/referral-hero.v1.jpg at 2x.
// Needs Playwright (npm i -D playwright && npx playwright install chromium).
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = path.join(root, 'assets/img/email/referral-hero.v1.jpg');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 600, height: 900 }, deviceScaleFactor: 2 });
await page.goto('file://' + path.join(root, 'build/email-hero.html'));
await page.evaluate(() => document.fonts.ready);
await page.locator('#hero').screenshot({ path: out, type: 'jpeg', quality: 90 });
await browser.close();
console.log('wrote', out);
