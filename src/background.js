// Background service worker.
//  - Toolbar icon click: turn the extension on / off.
//  - Injection mode: register the page script (userScripts API), or inject
//    it early with chrome.scripting as a fallback.
//  - Debugger mode: attach chrome.debugger to matching tabs and set
//    Emulation.setTimezoneOverride.

import { loadSettings, saveSettings } from './settings.js';
import { compilePatterns, hostMatches, hostOf } from './match.js';
import { tzcPatch } from './inject.js';

const US_ID = 'tzc-main';
const DBG_VERSION = '1.3';

let state = null; // { s: settings, rx: regex sources }
let usActive = false; // user script is registered and running
let stateReady = loadState();
let applyChain = Promise.resolve();

async function loadState() {
  const s = await loadSettings();
  state = { s, rx: compilePatterns(s.domains) };
  return state;
}

const isOn = () => state.s.enabled && state.rx.length > 0;

// Run applyAll() one at a time (settings can change quickly).
function scheduleApply() {
  applyChain = applyChain.then(applyAll, applyAll);
  return applyChain;
}

async function applyAll() {
  await stateReady;
  await updateIcon();
  await syncUserScripts();
  await syncDebuggerAllTabs();
}

// ---------------- icon ----------------

function iconSet(on) {
  const c = on ? 'on' : 'off';
  return {
    16: `/icons/clock-${c}-16.png`,
    32: `/icons/clock-${c}-32.png`,
    48: `/icons/clock-${c}-48.png`,
    128: `/icons/clock-${c}-128.png`,
  };
}

async function updateIcon() {
  const { s } = state;
  const mode = s.mode === 'debugger' ? 'Debugger' : 'Injection';
  let title;
  if (s.enabled) {
    title = `Timezone Changer: ON\nTime zone: ${s.timezone}\nMode: ${mode}\nSites: ${state.rx.length}\nClick to turn OFF`;
    if (!state.rx.length) title += '\n(No sites in the list yet. Right-click > Options)';
  } else {
    title = 'Timezone Changer: OFF\nClick to turn ON';
  }
  await chrome.action.setIcon({ path: iconSet(s.enabled) });
  await chrome.action.setTitle({ title });
}

chrome.action.onClicked.addListener(async () => {
  await stateReady;
  const enabled = !state.s.enabled;
  state.s.enabled = enabled;
  updateIcon(); // fast feedback; storage.onChanged runs the full apply
  await saveSettings({ enabled });
});

// ---------------- settings changes ----------------

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  stateReady = loadState();
  scheduleApply();
});

chrome.runtime.onInstalled.addListener((d) => {
  scheduleApply();
  if (d.reason === 'install') chrome.runtime.openOptionsPage();
});
chrome.runtime.onStartup.addListener(() => scheduleApply());

// Messages from the options page.
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg && msg.type === 'status') {
    scheduleApply().then(() => reply({ usAvailable: userScriptsAvailable(), usActive }));
    return true;
  }
  return false;
});

// ---------------- injection mode: userScripts API ----------------

// The userScripts API works only when the user allows it
// (chrome://extensions > Details > "Allow User Scripts", or Developer mode
// in older Chrome). Without it, chrome.userScripts throws.
function userScriptsAvailable() {
  try {
    chrome.userScripts.getScripts();
    return true;
  } catch {
    return false;
  }
}

async function userScriptRegistered() {
  if (!userScriptsAvailable()) return false;
  try {
    return (await chrome.userScripts.getScripts({ ids: [US_ID] })).length > 0;
  } catch {
    return false;
  }
}

function pageConfig() {
  return { tz: state.s.timezone, rx: state.rx };
}

async function syncUserScripts() {
  usActive = false;
  if (!userScriptsAvailable()) return;
  try {
    const want = isOn() && state.s.mode === 'inject';
    const code = `(${tzcPatch.toString()})(${JSON.stringify(pageConfig())});`;
    const old = await chrome.userScripts.getScripts({ ids: [US_ID] });
    if (want && old.length && old[0].js?.[0]?.code === code) {
      usActive = true; // already registered with the same settings
      return;
    }
    if (old.length) await chrome.userScripts.unregister({ ids: [US_ID] });
    if (!want) return;
    await chrome.userScripts.register([{
      id: US_ID,
      matches: ['<all_urls>'],
      js: [{ code }],
      runAt: 'document_start',
      world: 'MAIN',
      allFrames: true,
    }]);
    usActive = true;
  } catch (e) {
    console.warn('Timezone Changer: userScripts failed, using fallback.', e);
  }
}

// ---------------- injection mode: fallback ----------------

// Inject as early as possible after the page commits. Usually this runs
// before the page's own scripts, but it is not guaranteed.
chrome.webNavigation.onCommitted.addListener(async (d) => {
  await stateReady;
  if (!isOn() || state.s.mode !== 'inject' || usActive) return;
  if (await userScriptRegistered()) return; // the user script already runs here
  let ok = hostMatches(state.rx, hostOf(d.url));
  if (!ok && d.frameId !== 0) {
    try {
      const tab = await chrome.tabs.get(d.tabId);
      ok = hostMatches(state.rx, hostOf(tab.url || tab.pendingUrl));
    } catch { /* tab is gone */ }
  }
  if (!ok) return;
  chrome.scripting.executeScript({
    target: { tabId: d.tabId, frameIds: [d.frameId] },
    world: 'MAIN',
    injectImmediately: true,
    func: tzcPatch,
    args: [pageConfig()],
  }).catch(() => { /* page not scriptable (chrome://, web store, ...) */ });
});

// ---------------- debugger mode ----------------

const attached = new Set(); // tab ids we attached to
const tabQueues = new Map(); // one operation at a time per tab
const attachedReady = chrome.storage.session.get('dbgTabs').then(({ dbgTabs = [] }) => {
  dbgTabs.forEach((id) => attached.add(id));
});
const saveAttached = () => chrome.storage.session.set({ dbgTabs: [...attached] });

function queueTab(tabId, fn) {
  const next = (tabQueues.get(tabId) || Promise.resolve()).then(fn, fn);
  tabQueues.set(tabId, next);
  next.finally(() => {
    if (tabQueues.get(tabId) === next) tabQueues.delete(tabId);
  });
  return next;
}

function dbgWanted(url) {
  return isOn() && state.s.mode === 'debugger' && hostMatches(state.rx, hostOf(url));
}

async function setTz(target, tz) {
  try {
    await chrome.debugger.sendCommand(target, 'Emulation.setTimezoneOverride', { timezoneId: tz });
  } catch {
    // Clear the old value, then try again.
    await chrome.debugger.sendCommand(target, 'Emulation.setTimezoneOverride', { timezoneId: '' }).catch(() => {});
    await chrome.debugger.sendCommand(target, 'Emulation.setTimezoneOverride', { timezoneId: tz }).catch((e) => {
      console.warn('Timezone Changer: setTimezoneOverride failed', e);
    });
  }
}

// Main-frame navigation per tab: did the new page already commit?
const navs = new Map();

function dbgApplyTab(tabId, url, fromNav = false) {
  return queueTab(tabId, async () => {
    await stateReady;
    await attachedReady;
    const target = { tabId };
    if (dbgWanted(url)) {
      if (!attached.has(tabId)) {
        try {
          await chrome.debugger.attach(target, DBG_VERSION);
        } catch (e) {
          if (!/already attached/i.test(String(e && e.message))) return;
        }
        attached.add(tabId);
        saveAttached();
        await setTz(target, state.s.timezone);
        // The attach was too slow: the page already started with the real
        // time zone. Load it again once (now with the override).
        if (fromNav && navs.get(tabId)?.committed) chrome.tabs.reload(tabId).catch(() => {});
        return;
      }
      await setTz(target, state.s.timezone);
    } else if (attached.has(tabId)) {
      attached.delete(tabId);
      saveAttached();
      await chrome.debugger.detach(target).catch(() => {});
    }
  });
}

async function syncDebuggerAllTabs() {
  await attachedReady;
  const tabs = await chrome.tabs.query({});
  const ids = new Set(tabs.map((t) => t.id));
  for (const id of [...attached]) {
    if (!ids.has(id)) attached.delete(id);
  }
  await Promise.all(tabs.map((t) => dbgApplyTab(t.id, t.url || t.pendingUrl || '')));
  saveAttached();
}

// Attach before the new page loads.
chrome.webNavigation.onBeforeNavigate.addListener((d) => {
  if (d.frameId !== 0) return;
  navs.set(d.tabId, { committed: false });
  dbgApplyTab(d.tabId, d.url, true);
});
// Check again after redirects.
chrome.webNavigation.onCommitted.addListener((d) => {
  if (d.frameId !== 0) return;
  const n = navs.get(d.tabId);
  if (n) n.committed = true;
  dbgApplyTab(d.tabId, d.url, true);
});

chrome.debugger.onDetach.addListener((source) => {
  // The user clicked "Cancel" on the yellow bar, closed the tab, or opened
  // DevTools in a way that removed us. We attach again on the next page load.
  if (source.tabId != null && attached.delete(source.tabId)) saveAttached();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  navs.delete(tabId);
  if (attached.delete(tabId)) saveAttached();
});

// Service worker woke up: make sure the icon and scripts are right.
scheduleApply();
