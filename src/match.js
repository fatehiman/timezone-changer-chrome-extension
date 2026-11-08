// Domain pattern helpers. Used by the background worker and the options page.
//
// Rules:
//   - One pattern per line. Empty lines and lines starting with # are ignored.
//   - "*" matches any characters (also dots).
//   - A leading "*." also matches the bare domain:
//       *.cloudflare.*  ->  cloudflare.com, dash.cloudflare.com, a.b.cloudflare.net
//   - A pattern without "*" matches only that exact host.
//   - Full URLs are accepted; scheme, port and path are removed.

export function cleanPattern(line) {
  let p = String(line).trim().toLowerCase();
  if (!p || p.startsWith('#')) return '';
  p = p.replace(/^[a-z][a-z0-9+.-]*:\/\//, ''); // scheme
  p = p.replace(/[/?#].*$/, ''); // path, query, hash
  p = p.replace(/^[^@]*@/, ''); // user:pass@
  p = p.replace(/:(\d+|\*)$/, ''); // port
  p = p.replace(/\.+$/, ''); // trailing dots
  return p;
}

export function parsePatterns(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const p = cleanPattern(line);
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

const esc = (s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

// Returns a RegExp source string (strings can be sent to the page script).
export function patternToRegexSource(p) {
  if (p === '*') return '^.+$';
  let prefix = '';
  if (p.startsWith('*.')) {
    prefix = '(?:.*\\.)?';
    p = p.slice(2);
  }
  return '^' + prefix + p.split('*').map(esc).join('.*') + '$';
}

export function compilePatterns(text) {
  return parsePatterns(text).map(patternToRegexSource);
}

export function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.+$/, '');
  } catch {
    return '';
  }
}

// Returns the first pattern that matches the host, or '' if none matches.
export function findMatch(text, host) {
  host = String(host || '').toLowerCase().replace(/\.+$/, '');
  if (!host) return '';
  for (const p of parsePatterns(text)) {
    if (new RegExp(patternToRegexSource(p)).test(host)) return p;
  }
  return '';
}

export function hostMatches(regexSources, host) {
  if (!host) return false;
  return regexSources.some((src) => new RegExp(src).test(host));
}
