// Page script for "Injection" mode.
//
// tzcPatch() runs in the page's MAIN world, before the page's own scripts.
// It makes Date and Intl behave as if the computer used another time zone.
//
// IMPORTANT: this function is turned into a string (fn.toString()) and run
// inside the page. It must be fully self-contained: no imports, no outer
// variables.
//
// cfg = { tz: 'Asia/Tehran', rx: ['^(?:.*\\.)?cloudflare\\..*$', ...] }

export function tzcPatch(cfg) {
  'use strict';
  const TZ = cfg && cfg.tz;
  if (!TZ) return;

  // ---- 1. Does this page (or the top page of this frame) match? ----
  try {
    const rx = (cfg.rx || []).map((s) => new RegExp(s));
    const hosts = [location.hostname];
    const ao = location.ancestorOrigins;
    if (ao && ao.length) hosts.push(new URL(ao[ao.length - 1]).hostname);
    const ok = hosts.some((h) => {
      h = String(h || '').toLowerCase().replace(/\.+$/, '');
      return h && rx.some((r) => r.test(h));
    });
    if (!ok) return;
    new Intl.DateTimeFormat('en-US', { timeZone: TZ }); // throws if TZ is not valid
  } catch (e) {
    return;
  }

  const done = new WeakSet();
  const call = Reflect.apply;
  const defProp = Object.defineProperty;

  function patchWindow(win) {
    try {
      if (!win || done.has(win)) return;
      done.add(win);
      void win.Date; // throws for cross-origin frames
    } catch (e) {
      return;
    }

    const OD = win.Date;
    const DP = OD.prototype;
    const ODTF = win.Intl.DateTimeFormat;
    const FP = win.Function.prototype;
    const fmtToParts = ODTF.prototype.formatToParts;
    const odNow = OD.now;
    const odUTC = OD.UTC;
    const odParse = OD.parse;

    const orig = {};
    for (const k of Object.getOwnPropertyNames(DP)) {
      const d = Object.getOwnPropertyDescriptor(DP, k);
      if (d && typeof d.value === 'function') orig[k] = d.value;
    }
    const getTime = (d) => call(orig.getTime, d, []);

    // ---- hide our functions: make them print like native code ----
    const fakes = new WeakMap();
    const oFnToString = FP.toString;
    function nativeLike(fn, name, len) {
      fakes.set(fn, 'function ' + name + '() { [native code] }');
      try {
        if (len !== undefined) defProp(fn, 'length', { value: len, configurable: true });
        Object.setPrototypeOf(fn, FP);
      } catch (e) { /* ignore */ }
      return fn;
    }
    function define(obj, key, fn, len) {
      nativeLike(fn, key, len);
      defProp(obj, key, { value: fn, writable: true, configurable: true, enumerable: false });
    }
    define(FP, 'toString', {
      toString() {
        return fakes.has(this) ? fakes.get(this) : call(oFnToString, this, []);
      },
    }.toString);

    // ---- time zone math ----
    const partsFmt = new ODTF('en-US', {
      timeZone: TZ, hourCycle: 'h23', era: 'short',
      year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric',
    });
    const nameFmt = new ODTF('en-US', { timeZone: TZ, timeZoneName: 'long' });
    const cache = new Map();
    const STEP = 900000; // offsets only change on 15-minute UTC boundaries

    // Offset of TZ (in ms, east of UTC is positive) at UTC time t.
    function offsetMs(t) {
      const key = Math.floor(t / STEP);
      let v = cache.get(key);
      if (v !== undefined) return v;
      const bt = key * STEP;
      const parts = call(fmtToParts, partsFmt, [bt]);
      const p = {};
      for (let i = 0; i < parts.length; i++) p[parts[i].type] = parts[i].value;
      let y = +p.year;
      if (/^b/i.test(p.era || '')) y = 1 - y;
      const u = new OD(0);
      call(orig.setUTCFullYear, u, [y, +p.month - 1, +p.day]);
      call(orig.setUTCHours, u, [+p.hour % 24, +p.minute, +p.second, 0]);
      v = getTime(u) - bt;
      if (cache.size > 5000) cache.clear();
      cache.set(key, v);
      return v;
    }

    // Wall-clock time in TZ (as a UTC-based number) -> real UTC time.
    // Follows the JS rules: in a DST gap use the offset from before the
    // change; in an overlap use the earlier time.
    function wallToUtc(w) {
      if (!isFinite(w)) return NaN;
      const oA = offsetMs(w - 86400000);
      const oB = offsetMs(w + 86400000);
      let best = NaN;
      for (const o of oA === oB ? [oA] : [oA, oB]) {
        const t = w - o;
        if (offsetMs(t) === o && !(t >= best)) best = t;
      }
      return best === best ? best : w - Math.min(oA, oB);
    }

    const wallDate = (t) => new OD(t + offsetMs(t));

    // Real-local wall time of d (the computer's own time zone).
    function realWall(d) {
      const u = new OD(0);
      call(orig.setUTCFullYear, u, [
        call(orig.getFullYear, d, []), call(orig.getMonth, d, []), call(orig.getDate, d, []),
      ]);
      call(orig.setUTCHours, u, [
        call(orig.getHours, d, []), call(orig.getMinutes, d, []),
        call(orig.getSeconds, d, []), call(orig.getMilliseconds, d, []),
      ]);
      return getTime(u);
    }

    // Does a date string carry its own zone? If not, it is local time.
    function hasZone(s) {
      s = s.trim();
      if (/^[+-]?\d{4,6}(?:-\d\d(?:-\d\d)?)?$/.test(s)) return true; // ISO date only = UTC
      if (/\dZ\b/i.test(s)) return true;
      if (/\d\d:\d\d(?::\d\d(?:[.,]\d+)?)?\s*[+-]\d\d:?\d\d\b/.test(s)) return true;
      if (/\b(?:GMT|UTC|UT|[ECMP][SD]T)\b/i.test(s)) return true;
      return false;
    }

    function parseLocal(s) {
      s = String(s);
      const ms = call(odParse, OD, [s]);
      if (ms !== ms || hasZone(s)) return ms;
      // Wall time from the real local zone (wrong by 1h inside a real DST gap).
      let w = realWall(new OD(ms));
      // Better: read the same text as UTC to get the wall time directly.
      const st = s.trim();
      const asUtc = call(odParse, OD, [/^[+-]?\d{4,6}-\d\d-\d\dT[\d:.,]+$/.test(st) ? st + 'Z' : st + ' UTC']);
      if (asUtc === asUtc && Math.abs(asUtc - w) <= 7200000) w = asUtc;
      return wallToUtc(w);
    }

    // ---- Date.prototype getters ----
    const GET = {
      getFullYear: 'getUTCFullYear', getMonth: 'getUTCMonth', getDate: 'getUTCDate',
      getDay: 'getUTCDay', getHours: 'getUTCHours', getMinutes: 'getUTCMinutes',
      getSeconds: 'getUTCSeconds', getMilliseconds: 'getUTCMilliseconds',
    };
    for (const name of Object.keys(GET)) {
      const utcFn = orig[GET[name]];
      define(DP, name, {
        [name]() {
          const t = getTime(this);
          if (t !== t) return NaN;
          return call(utcFn, wallDate(t), []);
        },
      }[name], 0);
    }
    if (orig.getYear) {
      define(DP, 'getYear', {
        getYear() {
          const t = getTime(this);
          if (t !== t) return NaN;
          return call(orig.getUTCFullYear, wallDate(t), []) - 1900;
        },
      }.getYear, 0);
    }
    define(DP, 'getTimezoneOffset', {
      getTimezoneOffset() {
        const t = getTime(this);
        if (t !== t) return NaN;
        return 0 - Math.trunc(offsetMs(t) / 60000); // whole minutes, like Chrome
      },
    }.getTimezoneOffset, 0);

    // ---- Date.prototype setters ----
    const SET = {
      setFullYear: 'setUTCFullYear', setMonth: 'setUTCMonth', setDate: 'setUTCDate',
      setHours: 'setUTCHours', setMinutes: 'setUTCMinutes', setSeconds: 'setUTCSeconds',
      setMilliseconds: 'setUTCMilliseconds',
    };
    for (const name of Object.keys(SET)) {
      const utcFn = orig[SET[name]];
      define(DP, name, {
        [name](...args) {
          const t = getTime(this);
          let w;
          if (t !== t) {
            if (name !== 'setFullYear') return NaN;
            w = new OD(0);
          } else {
            w = wallDate(t);
          }
          call(utcFn, w, args);
          return call(orig.setTime, this, [wallToUtc(getTime(w))]);
        },
      }[name], orig[name].length);
    }
    if (orig.setYear) {
      define(DP, 'setYear', {
        setYear(y) {
          let n = Number(y);
          if (n === n) {
            n = Math.trunc(n);
            if (n >= 0 && n <= 99) n += 1900;
          }
          return call(DP.setFullYear, this, [n]);
        },
      }.setYear, 1);
    }

    // ---- Date.prototype strings ----
    const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const pad = (n, l) => String(n).padStart(l || 2, '0');
    function rawZoneName(t) {
      const parts = call(fmtToParts, nameFmt, [t]);
      for (let i = 0; i < parts.length; i++) if (parts[i].type === 'timeZoneName') return parts[i].value;
      return '';
    }
    // Old dates often have no real name ("GMT+01:00"). Then use the name of
    // a modern date with the same offset, like Chrome does.
    function zoneName(t) {
      const n = rawZoneName(t);
      if (!/^GMT[+-]/.test(n)) return n || TZ;
      const o = offsetMs(t);
      const y = call(orig.getUTCFullYear, new OD(call(odNow, OD, [])), []);
      for (const m of [0, 6]) {
        const r = call(odUTC, OD, [y, m, 1]);
        if (offsetMs(r) === o) {
          const n2 = rawZoneName(r);
          if (!/^GMT[+-]/.test(n2)) return n2;
        }
      }
      return n;
    }
    function gmt(t) {
      const m = Math.trunc(offsetMs(t) / 60000);
      const a = Math.abs(m);
      return 'GMT' + (m < 0 ? '-' : '+') + pad(Math.floor(a / 60)) + pad(a % 60);
    }
    function dateStr(w) {
      const y = call(orig.getUTCFullYear, w, []);
      return WD[call(orig.getUTCDay, w, [])] + ' ' + MO[call(orig.getUTCMonth, w, [])] + ' ' +
        pad(call(orig.getUTCDate, w, [])) + ' ' + (y < 0 ? '-' + pad(-y, 6) : pad(y, 4));
    }
    function timeStr(t, w) {
      return pad(call(orig.getUTCHours, w, [])) + ':' + pad(call(orig.getUTCMinutes, w, [])) + ':' +
        pad(call(orig.getUTCSeconds, w, [])) + ' ' + gmt(t) + ' (' + zoneName(t) + ')';
    }
    const toStr = {
      toString() {
        const t = getTime(this);
        if (t !== t) return 'Invalid Date';
        const w = wallDate(t);
        return dateStr(w) + ' ' + timeStr(t, w);
      },
    }.toString;
    define(DP, 'toString', toStr, 0);
    define(DP, 'toDateString', {
      toDateString() {
        const t = getTime(this);
        return t !== t ? 'Invalid Date' : dateStr(wallDate(t));
      },
    }.toDateString, 0);
    define(DP, 'toTimeString', {
      toTimeString() {
        const t = getTime(this);
        return t !== t ? 'Invalid Date' : timeStr(t, wallDate(t));
      },
    }.toTimeString, 0);

    // Add our time zone to Intl options when the caller did not set one.
    function withTz(o) {
      if (o === undefined) return { timeZone: TZ };
      if (o === null) return o; // let the native code throw
      const obj = Object(o);
      if (obj.timeZone !== undefined) return o;
      const c = Object.create(obj);
      defProp(c, 'timeZone', { value: TZ, enumerable: true, writable: true, configurable: true });
      return c;
    }
    for (const name of ['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString']) {
      const fn = orig[name];
      define(DP, name, {
        [name](locales, options) {
          return call(fn, this, [locales, withTz(options)]);
        },
      }[name], 0);
    }

    // ---- Intl.DateTimeFormat ----
    const DTF = function DateTimeFormat(locales, options) {
      return new.target
        ? Reflect.construct(ODTF, [locales, withTz(options)], new.target)
        : call(ODTF, this, [locales, withTz(options)]);
    };
    nativeLike(DTF, 'DateTimeFormat', 0);
    defProp(DTF, 'prototype', { value: ODTF.prototype, writable: false });
    defProp(DTF, 'supportedLocalesOf', {
      value: ODTF.supportedLocalesOf, writable: true, configurable: true, enumerable: false,
    });
    defProp(ODTF.prototype, 'constructor', { value: DTF, writable: true, configurable: true, enumerable: false });
    defProp(win.Intl, 'DateTimeFormat', { value: DTF, writable: true, configurable: true, enumerable: false });

    // ---- Date constructor ----
    function toPrim(a) {
      const tp = a[Symbol.toPrimitive];
      if (typeof tp === 'function') return call(tp, a, ['default']);
      const v = a.valueOf();
      if (v === null || (typeof v !== 'object' && typeof v !== 'function')) return v;
      return String(a);
    }
    function isDate(a) {
      try { getTime(a); return true; } catch (e) { return false; }
    }
    const D = function Date(...args) {
      if (!new.target) return call(toStr, new OD(), []);
      let v;
      if (args.length === 0) {
        v = call(odNow, OD, []);
      } else if (args.length === 1) {
        const a = args[0];
        if (typeof a === 'string') {
          v = parseLocal(a);
        } else if (a !== null && (typeof a === 'object' || typeof a === 'function') && !isDate(a)) {
          const p = toPrim(a);
          v = typeof p === 'string' ? parseLocal(p) : getTime(new OD(p));
        } else {
          v = getTime(new OD(a));
        }
      } else {
        v = wallToUtc(call(odUTC, OD, args.slice(0, 7)));
      }
      return Reflect.construct(OD, [v], new.target);
    };
    nativeLike(D, 'Date', 7);
    defProp(D, 'prototype', { value: DP, writable: false });
    for (const k of ['now', 'UTC']) {
      defProp(D, k, { value: OD[k], writable: true, configurable: true, enumerable: false });
    }
    define(D, 'parse', {
      parse(s) {
        return parseLocal(String(s));
      },
    }.parse, 1);
    defProp(DP, 'constructor', { value: D, writable: true, configurable: true, enumerable: false });
    defProp(win, 'Date', { value: D, writable: true, configurable: true, enumerable: false });

    // ---- Temporal (if the browser has it) ----
    try {
      const N = win.Temporal && win.Temporal.Now;
      if (N) {
        define(N, 'timeZoneId', { timeZoneId() { return TZ; } }.timeZoneId, 0);
        for (const k of ['plainDateTimeISO', 'plainDateISO', 'plainTimeISO', 'zonedDateTimeISO']) {
          const f = N[k];
          if (typeof f !== 'function') continue;
          define(N, k, {
            [k](tz) {
              return call(f, N, [tz === undefined ? TZ : tz]);
            },
          }[k], 0);
        }
      }
    } catch (e) { /* ignore */ }

    // ---- same-origin iframes (about:blank etc.) get the same patch ----
    for (const C of [win.HTMLIFrameElement, win.HTMLFrameElement]) {
      const proto = C && C.prototype;
      if (!proto) continue;
      for (const prop of ['contentWindow', 'contentDocument']) {
        const d = Object.getOwnPropertyDescriptor(proto, prop);
        if (!d || !d.get) continue;
        const g = d.get;
        const getter = Object.getOwnPropertyDescriptor({
          get [prop]() {
            const r = call(g, this, []);
            try {
              patchWindow(prop === 'contentWindow' ? r : r && r.defaultView);
            } catch (e) { /* ignore */ }
            return r;
          },
        }, prop).get;
        nativeLike(getter, 'get ' + prop, 0);
        defProp(proto, prop, { get: getter, set: d.set, enumerable: d.enumerable, configurable: true });
      }
    }
  }

  patchWindow(window);
}
