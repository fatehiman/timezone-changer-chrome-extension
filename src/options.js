import { DEFAULTS, loadSettings, saveSettings } from './settings.js';
import { findMatch, hostOf, parsePatterns } from './match.js';

const $ = (id) => document.getElementById(id);
const els = {
  enabled: $('enabled'),
  tzSearch: $('tzSearch'),
  tz: $('tz'),
  nowThere: $('nowThere'),
  domains: $('domains'),
  testHost: $('testHost'),
  testResult: $('testResult'),
  usBox: $('usBox'),
  status: $('status'),
  logo: $('logo'),
};
let settings = { ...DEFAULTS };

// ---------- time zone list ----------

function allZones() {
  let list = [];
  try {
    list = Intl.supportedValuesOf('timeZone');
  } catch { /* very old Chrome */ }
  if (!list.includes('UTC')) list = ['UTC', ...list];
  return list;
}

function offsetLabel(tz) {
  try {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' })
      .formatToParts(new Date())
      .find((x) => x.type === 'timeZoneName');
    const v = p ? p.value : 'GMT';
    return v === 'GMT' ? 'GMT+00:00' : v;
  } catch {
    return '';
  }
}

const ZONES = allZones().map((tz) => ({ tz, label: `(${offsetLabel(tz)}) ${tz.replace(/_/g, ' ')}` }));

function fillZones() {
  const q = els.tzSearch.value.trim().toLowerCase().replace(/_/g, ' ');
  els.tz.textContent = '';
  let list = ZONES.filter((z) => !q || z.label.toLowerCase().includes(q));
  // Keep the current choice visible even when it does not match the search.
  if (!list.some((z) => z.tz === settings.timezone)) {
    const cur = ZONES.find((z) => z.tz === settings.timezone) || { tz: settings.timezone, label: settings.timezone };
    list = [cur, ...list];
  }
  for (const z of list) {
    const o = document.createElement('option');
    o.value = z.tz;
    o.textContent = z.label;
    if (z.tz === settings.timezone) o.selected = true;
    els.tz.append(o);
  }
  const sel = els.tz.selectedOptions[0];
  if (sel) sel.scrollIntoView({ block: 'nearest' });
}

function showNow() {
  try {
    els.nowThere.textContent = new Date().toLocaleString(undefined, {
      timeZone: settings.timezone, weekday: 'short', year: 'numeric', month: 'short',
      day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short',
    });
  } catch {
    els.nowThere.textContent = '–';
  }
}

// ---------- domain tester ----------

function runTest() {
  const raw = els.testHost.value.trim();
  els.testResult.className = 'small';
  if (!raw) {
    const n = parsePatterns(els.domains.value).length;
    els.testResult.textContent = n ? `${n} pattern${n > 1 ? 's' : ''} in the list.` : '';
    return;
  }
  const host = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? hostOf(raw) : hostOf('https://' + raw);
  const m = findMatch(els.domains.value, host);
  if (m) {
    els.testResult.textContent = `✓ ${host} matches "${m}"`;
    els.testResult.classList.add('ok');
  } else {
    els.testResult.textContent = `✗ ${host || raw} does not match`;
    els.testResult.classList.add('no');
  }
}

// ---------- user scripts status ----------

async function showUserScriptsStatus() {
  const box = els.usBox;
  box.hidden = settings.mode !== 'inject';
  if (box.hidden) return;
  let st = { usAvailable: false, usActive: false };
  try {
    st = await chrome.runtime.sendMessage({ type: 'status' });
  } catch { /* worker is starting */ }
  box.textContent = '';
  if (st.usAvailable) {
    box.className = 'note small good';
    box.textContent = '✓ "Allow User Scripts" is on. The time zone is set before any page script runs.';
    return;
  }
  box.className = 'note small';
  const b = document.createElement('strong');
  b.textContent = '⚠ Please turn on "Allow User Scripts".';
  box.append(
    b,
    document.createElement('br'),
    'Without it, a fallback is used. The fallback often runs after the first page scripts, ' +
    'so a site can still see your real time zone. ' +
    'Steps: open the extension details > turn on "Allow User Scripts" ' +
    '(older Chrome: turn on "Developer mode" at the top of chrome://extensions). ' +
    'Then come back to this page.',
    document.createElement('br'),
  );
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = 'Open extension details';
  btn.addEventListener('click', () => chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` }));
  box.append(btn);
}

// ---------- save ----------

let statusTimer;
async function save(patch, msg) {
  Object.assign(settings, patch);
  await saveSettings(patch);
  els.status.textContent = msg || 'Saved. Reload open pages to apply the change.';
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => (els.status.textContent = ''), 3500);
}

function renderEnabled() {
  els.enabled.checked = settings.enabled;
  els.logo.src = `../icons/clock-${settings.enabled ? 'on' : 'off'}-128.png`;
  document.querySelectorAll('.card:not(:first-of-type)').forEach((c) => {
    c.classList.toggle('disabled-look', !settings.enabled);
  });
}

// ---------- start ----------

async function init() {
  settings = await loadSettings();
  renderEnabled();
  fillZones();
  showNow();
  setInterval(showNow, 1000);
  els.domains.value = settings.domains;
  document.querySelector(`input[name="mode"][value="${settings.mode}"]`).checked = true;
  runTest();
  showUserScriptsStatus();

  els.enabled.addEventListener('change', () => {
    save({ enabled: els.enabled.checked }, els.enabled.checked ? 'Turned on.' : 'Turned off.');
    renderEnabled();
  });

  els.tzSearch.addEventListener('input', fillZones);
  els.tzSearch.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); els.tz.focus(); }
  });
  els.tz.addEventListener('change', () => {
    if (!els.tz.value) return;
    save({ timezone: els.tz.value });
    showNow();
  });

  let t;
  els.domains.addEventListener('input', () => {
    runTest();
    clearTimeout(t);
    t = setTimeout(() => save({ domains: els.domains.value }), 400);
  });
  els.domains.addEventListener('change', () => { // also save on blur
    clearTimeout(t);
    if (els.domains.value !== settings.domains) save({ domains: els.domains.value });
  });
  els.testHost.addEventListener('input', runTest);

  document.querySelectorAll('input[name="mode"]').forEach((r) => r.addEventListener('change', async () => {
    await save({ mode: r.value }, r.value === 'debugger'
      ? 'Saved. Debugger mode applies to open tabs now.'
      : 'Saved. Reload open pages to apply the change.');
    showUserScriptsStatus();
  }));

  // The toolbar icon can change "enabled" while this page is open.
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === 'local' && ch.enabled) {
      settings.enabled = ch.enabled.newValue;
      renderEnabled();
    }
  });
  // The user may come back from chrome://extensions after allowing user scripts.
  window.addEventListener('focus', showUserScriptsStatus);
}

init();
