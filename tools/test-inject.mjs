// Test for src/inject.js.
//
// Idea: Node with the real time zone X must give the same results as
// Node with another time zone plus tzcPatch({tz: X}).
//
// Usage: node tools/test-inject.mjs
//   (it starts child Node processes with different TZ values)

import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const injectUrl = pathToFileURL(path.join(here, '..', 'src', 'inject.js')).href;

// ---- child mode: print results as JSON ----
if (process.argv[2] === 'child') {
  const target = process.argv[3];
  if (target) {
    const { tzcPatch } = await import(injectUrl);
    globalThis.window = globalThis;
    globalThis.location = { hostname: 'dash.cloudflare.com', ancestorOrigins: [] };
    tzcPatch({ tz: target, rx: ['^(?:.*\\.)?cloudflare\\..*$'] });
  }
  const out = {};
  const T = (name, fn) => {
    try { out[name] = fn(); } catch (e) { out[name] = 'THROW ' + e.constructor.name; }
  };
  const ts = [0, 1e12, 1762600000000, 1774000000000, 1793000000000, -2e12, 1710054000000, 1730613600000];
  for (const t of ts) {
    const d = new Date(t);
    // Chrome uses odd zone names for very old dates; compare them without the name.
    const nm = (x) => (t < 0 ? x.replace(/ \(.*\)$/, '') : x);
    T('toString ' + t, () => nm(d.toString()));
    T('toDateString ' + t, () => d.toDateString());
    T('toTimeString ' + t, () => nm(d.toTimeString()));
    T('offset ' + t, () => d.getTimezoneOffset());
    T('parts ' + t, () => [d.getFullYear(), d.getMonth(), d.getDate(), d.getDay(), d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()]);
    T('locale ' + t, () => d.toLocaleString('en-US'));
    T('localeDate ' + t, () => d.toLocaleDateString('de-DE', { weekday: 'long' }));
    T('localeTime ' + t, () => d.toLocaleTimeString());
    T('dtf ' + t, () => new Intl.DateTimeFormat('en-GB', { dateStyle: 'full', timeStyle: 'long' }).format(d));
    T('dtfCall ' + t, () => Intl.DateTimeFormat('en-US').format(d));
    T('dtfExplicit ' + t, () => new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Tokyo', timeStyle: 'full' }).format(d));
    T('setHours ' + t, () => { const x = new Date(t); x.setHours(2, 30); return x.getTime(); });
    T('setDate ' + t, () => { const x = new Date(t); x.setDate(40); return x.getTime(); });
    T('setMonth ' + t, () => { const x = new Date(t); x.setMonth(5, 15); return x.getTime(); });
    T('setFullYear ' + t, () => { const x = new Date(t); x.setFullYear(1999); return x.getTime(); });
    T('setMinutes ' + t, () => { const x = new Date(t); x.setMinutes(-30); return x.getTime(); });
  }
  T('resolvedTz', () => new Intl.DateTimeFormat().resolvedOptions().timeZone);
  T('ctor components', () => [
    new Date(2026, 0, 1).getTime(), new Date(2026, 6, 1, 12, 30).getTime(), new Date(99, 0).getTime(),
    new Date(2026, 2, 8, 2, 30).getTime(), new Date(2026, 10, 1, 1, 30).getTime(), // US DST gap / overlap
    new Date(2026, 2, 29, 2, 30).getTime(), new Date(2026, 9, 25, 2, 30).getTime(), // EU DST
    new Date(2026, 9, 4, 2, 30).getTime(), new Date(2026, 3, 5, 1, 45).getTime(), // AU DST
    new Date(1900, 0, 1).getTime(), new Date(2026, 0).getTime(), new Date(2026, 13, 40).getTime(),
  ]);
  T('ctor strings', () => [
    '2026-11-08', '2026-11-08T10:00', '2026-11-08T10:00:00Z', '2026-11-08T10:00:00+05:00',
    'Nov 8 2026 10:00', '2026/11/08', 'Sun Nov 08 2026 10:00:00 GMT+0330 (Iran Standard Time)',
    'March 8, 2026 02:30:00', 'garbage', '11/08/2026 23:59:59', '2026-11-08 10:00:00',
  ].map((s) => [new Date(s).getTime(), Date.parse(s)]));
  T('ctor misc', () => [new Date(new Date(5)).getTime(), new Date(true).getTime(), new Date(null).getTime(),
    new Date({ valueOf: () => 77 }).getTime(), new Date(NaN).getTime(), String(new Date(NaN))]);
  T('call', () => typeof Date());
  T('instanceof', () => new Date() instanceof Date && Object.prototype.toString.call(new Date()));
  T('subclass', () => { class M extends Date { foo() { return 1; } } const m = new M(2026, 0, 1); return [m instanceof M, m instanceof Date, m.foo(), m.getTime()]; });
  T('json', () => JSON.stringify(new Date(1e12)));
  T('length', () => [Date.length, Date.name, Date.prototype.getHours.name, Date.prototype.setHours.length, Intl.DateTimeFormat.length]);
  T('native', () => [String(Date), String(Date.prototype.getHours), Function.prototype.toString.call(Intl.DateTimeFormat), String(Function.prototype.toString)].map((s) => /\[native code\]/.test(s)));
  T('invalid', () => { const x = new Date(NaN); return [x.getHours(), x.setHours(1), x.setFullYear(2020)]; });
  T('dtfInstance', () => new Intl.DateTimeFormat() instanceof Intl.DateTimeFormat);
  T('concat', () => typeof ('' + new Date(0)));
  console.log(JSON.stringify(out));
  process.exit(0);
}

// ---- parent mode ----
function run(realTz, patchTz) {
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), 'child', patchTz || ''], {
    env: { ...process.env, TZ: realTz }, encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout);
}

const ZONES = ['Asia/Tehran', 'America/New_York', 'Europe/Berlin', 'Australia/Sydney', 'Asia/Kathmandu', 'UTC', 'Pacific/Chatham'];
const REAL = ['UTC', 'America/Los_Angeles', 'Asia/Tokyo'];
// some keys depend on the real zone by design in the native result too (none expected)
let fails = 0, checks = 0;
for (const tz of ZONES) {
  const expected = run(tz, '');
  const okTz = expected.resolvedTz === tz || (tz === 'UTC' && /^(Etc\/)?UTC$/.test(expected.resolvedTz)) ||
    (tz === 'Asia/Kathmandu' && expected.resolvedTz === 'Asia/Katmandu');
  if (!okTz) {
    console.log(`SKIP ${tz}: this Node ignores TZ env (got ${expected.resolvedTz})`);
    continue;
  }
  for (const real of REAL) {
    if (real === tz) continue;
    const got = run(real, tz);
    if (tz === 'Asia/Kathmandu') got.resolvedTz = expected.resolvedTz; // same zone, old alias
    for (const k of Object.keys(expected)) {
      checks++;
      const a = JSON.stringify(expected[k]), b = JSON.stringify(got[k]);
      if (a !== b) {
        fails++;
        console.log(`FAIL [${tz} on real ${real}] ${k}\n   want ${a}\n   got  ${b}`);
      }
    }
  }
}
console.log(`${checks - fails}/${checks} checks passed`);
process.exit(fails ? 1 : 0);
