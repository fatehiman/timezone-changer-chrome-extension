import { chromium } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// End-to-end test in a real Chromium with the extension loaded.
// Needs: npm install (playwright-core) and a Chromium build that still
// supports --load-extension (Playwright's Chromium, Chrome for Testing).
// Set CHROMIUM_PATH, or it looks in the Playwright browser folder.
//   npm run e2e

const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const base = process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA || '', 'ms-playwright')
    : path.join(os.homedir(), process.platform === 'darwin' ? 'Library/Caches/ms-playwright' : '.cache/ms-playwright');
  const dirs = fs.existsSync(base) ? fs.readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse() : [];
  for (const d of dirs) {
    for (const rel of ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe', 'chrome-linux64/chrome', 'chrome-linux/chrome',
      'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
      const p = path.join(base, d, rel);
      if (fs.existsSync(p)) return p;
    }
  }
  throw new Error('Chromium not found. Set CHROMIUM_PATH.');
}
const EXE = findChromium();
const SHOTS = path.join(os.tmpdir(), 'tzc-e2e');
fs.mkdirSync(SHOTS, { recursive: true });
const PORT = 18765;

const page = `<!doctype html><html><head><script>
window.R = {
  early: new Date(2026, 0, 1, 12).toString(),
  tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
  off: new Date(Date.UTC(2026, 6, 1)).getTimezoneOffset(),
};
</script></head><body><iframe id=f src="about:blank"></iframe><script>
R.iframeTz = document.getElementById('f').contentWindow.Intl.DateTimeFormat().resolvedOptions().timeZone;
R.iframeOff = new (document.getElementById('f').contentWindow.Date)(Date.UTC(2026,6,1)).getTimezoneOffset();
</script></body></html>`;
const server = http.createServer((q, r) => { r.setHeader('content-type', 'text/html'); r.end(page); }).listen(PORT);

const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tzc-'));
const ctx = await chromium.launchPersistentContext(userDir, {
  executablePath: EXE,
  headless: false,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--host-resolver-rules=MAP *.test 127.0.0.1'],
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker');
const extId = sw.url().split('/')[2];
for (let i = 0; i < 50 && !(await sw.evaluate(() => typeof chrome !== 'undefined' && !!chrome.storage)); i++) await new Promise((r) => setTimeout(r, 100));

const set = (o) => sw.evaluate((o) => chrome.storage.local.set(o), o);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const usAvail = () => sw.evaluate(() => { try { chrome.userScripts.getScripts(); return true; } catch { return false; } });
async function visit(url) {
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log('  pageerror:', e.message));
  await p.goto(url);
  await p.waitForTimeout(800); // debugger mode may reload the page once
  await p.waitForLoadState();
  const r = await p.evaluate(() => window.R);
  await p.close();
  return r;
}
const results = [];
function check(name, cond, info) {
  results.push(cond);
  console.log(cond ? 'PASS' : 'FAIL', name, cond ? '' : JSON.stringify(info));
}
const U = (h) => `http://${h}:${PORT}/`;
const tokyo = (r) => r.tz === 'Asia/Tokyo' && r.off === -540 && /GMT\+0900/.test(r.early) && r.iframeTz === 'Asia/Tokyo' && r.iframeOff === -540;

// ---------- A. injection, fallback (no user scripts) ----------
await set({ enabled: true, timezone: 'Asia/Tokyo', domains: '*.cloudflare.*', mode: 'inject' });
await wait(500);
console.log('userScripts available:', await usAvail());
let wins = 0;
for (let i = 0; i < 6; i++) if (tokyo(await visit(U(i % 2 ? 'cloudflare.test' : 'dash.cloudflare.test')))) wins++;
console.log(`INFO fallback: page fully patched before inline script in ${wins}/6 loads (local server, 0 ms latency)`);
let r = await visit(U('other.test'));
check('fallback: other site untouched', r.tz !== 'Asia/Tokyo', r);

// ---------- B. turn on "Allow User Scripts" ----------
const ext = await ctx.newPage();
await ext.goto(`chrome://extensions/?id=${extId}`);
await ext.waitForTimeout(800);
try {
  await ext.locator('#allow-user-scripts').click({ timeout: 3000 });
} catch {
  // older: developer mode switch
  await ext.goto('chrome://extensions/');
  await ext.locator('#devMode').click({ timeout: 3000 });
}
await ext.close();
await wait(500);
console.log('userScripts available after toggle:', await usAvail());
// options page asks the worker for status -> the worker registers the user script
const op0 = await ctx.newPage();
await op0.goto(`chrome-extension://${extId}/src/options.html`);
await op0.waitForTimeout(800);
const note = await op0.locator('#usBox').innerText();
await op0.close();
check('options shows user scripts are on', /is on/.test(note), note);

let all = true;
for (let i = 0; i < 6; i++) {
  r = await visit(U(i % 2 ? 'cloudflare.test' : 'a.b.cloudflare.test'));
  if (!tokyo(r)) { all = false; console.log('  miss', JSON.stringify(r)); }
}
check('userScripts: 6/6 loads patched before inline script (incl. bare domain, iframe)', all);
r = await visit(U('other.test'));
check('userScripts: other site untouched', r.tz !== 'Asia/Tokyo', r);

await set({ timezone: 'Europe/Berlin' });
await wait(500);
r = await visit(U('dash.cloudflare.test'));
check('userScripts: time zone change applied', r.tz === 'Europe/Berlin' && r.off === -120, r);

await set({ enabled: false });
await wait(500);
r = await visit(U('dash.cloudflare.test'));
check('disabled: matched site untouched', r.tz !== 'Europe/Berlin' && r.tz !== 'Asia/Tokyo', r);
const title = await sw.evaluate(async () => chrome.action.getTitle({}));
check('disabled: icon title says OFF', /OFF/.test(title), title);

// ---------- C. debugger mode ----------
await set({ enabled: true, mode: 'debugger', timezone: 'America/New_York' });
await wait(500);
r = await visit(U('dash.cloudflare.test'));
check('debugger: matched site tz (new tab)', r.tz === 'America/New_York' && r.off === 240 && /GMT-0500/.test(r.early), r);
r = await visit(U('other.test'));
check('debugger: other site untouched', r.tz !== 'America/New_York', r);
// same tab: matching -> other -> matching
const p = await ctx.newPage();
await p.goto(U('dash.cloudflare.test')); await p.waitForTimeout(800); await p.waitForLoadState();
await p.goto(U('other.test')); await p.waitForTimeout(300);
const o = await p.evaluate(() => window.R);
await p.goto(U('cloudflare.test')); await p.waitForTimeout(800); await p.waitForLoadState();
const m = await p.evaluate(() => window.R);
await p.close();
check('debugger: same tab leaves and comes back', o.tz !== 'America/New_York' && m.tz === 'America/New_York', { o, m });

// ---------- options page screenshots ----------
await set({ mode: 'inject', domains: '*.cloudflare.*\nexample.com\n*.google.com', timezone: 'Asia/Tokyo' });
const op = await ctx.newPage();
await op.setViewportSize({ width: 860, height: 1300 });
await op.goto(`chrome-extension://${extId}/src/options.html`);
await op.fill('#testHost', 'https://dash.cloudflare.com/login');
await wait(800);
await op.screenshot({ path: path.join(SHOTS, 'options.png'), fullPage: true });
await op.emulateMedia({ colorScheme: 'dark' });
await op.screenshot({ path: path.join(SHOTS, 'options-dark.png'), fullPage: true });

await ctx.close();
server.close();
const failed = results.filter((x) => !x).length;
console.log(failed ? `${failed} FAILED` : 'ALL PASSED');
console.log('Screenshots:', SHOTS);
process.exit(failed ? 1 : 0);
