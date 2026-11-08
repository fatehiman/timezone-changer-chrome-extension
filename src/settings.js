// Settings are kept in chrome.storage.local (no 8 KB per-item limit like sync).

export const DEFAULTS = {
  enabled: true,
  timezone: 'UTC',
  domains: '',
  mode: 'inject', // 'inject' | 'debugger'
};

export async function loadSettings() {
  const s = await chrome.storage.local.get(DEFAULTS);
  if (s.mode !== 'debugger') s.mode = 'inject';
  return s;
}

export function saveSettings(patch) {
  return chrome.storage.local.set(patch);
}
