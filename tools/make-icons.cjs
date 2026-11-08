// Draws the extension icons (a smiling alarm clock) as PNG files.
// No dependencies: shapes are drawn with signed distance functions,
// anti-aliased with 4x4 supersampling, and saved with Node's zlib.
//
// Usage: node tools/make-icons.cjs

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZES = [16, 32, 48, 128];
const OUT = path.join(__dirname, '..', 'icons');

const THEMES = {
  on: {
    bell: '#1d5fc2', ring: '#2f80ed', face: '#ffffff', tick: '#2f80ed',
    eye: '#12306b', shine: '#ffffff', mouth: '#12306b', cheek: '#ffb4c2', leg: '#1d5fc2',
  },
  off: {
    bell: '#7d838c', ring: '#9aa0a8', face: '#f3f4f6', tick: '#9aa0a8',
    eye: '#4a4f57', shine: '#ffffff', mouth: '#4a4f57', cheek: '#d9dbde', leg: '#7d838c',
  },
};

// ---- distance functions (units: 0..128 canvas) ----
const circle = (cx, cy, r) => (x, y) => Math.hypot(x - cx, y - cy) - r;
const ellipse = (cx, cy, rx, ry) => (x, y) => {
  // approximate: good enough for small eyes
  const k = Math.hypot((x - cx) / rx, (y - cy) / ry);
  return (k - 1) * Math.min(rx, ry);
};
const capsule = (ax, ay, bx, by, r) => (x, y) => {
  const px = x - ax, py = y - ay, dx = bx - ax, dy = by - ay;
  const h = Math.max(0, Math.min(1, (px * dx + py * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - dx * h, py - dy * h) - r;
};
// arc from angle a0 to a1 (radians, y axis down), thickness 2*w
const arc = (cx, cy, r, a0, a1, w) => {
  const ex0 = cx + r * Math.cos(a0), ey0 = cy + r * Math.sin(a0);
  const ex1 = cx + r * Math.cos(a1), ey1 = cy + r * Math.sin(a1);
  return (x, y) => {
    let a = Math.atan2(y - cy, x - cx);
    if (a < 0) a += Math.PI * 2;
    if (a >= a0 && a <= a1) return Math.abs(Math.hypot(x - cx, y - cy) - r) - w;
    return Math.min(Math.hypot(x - ex0, y - ey0), Math.hypot(x - ex1, y - ey1)) - w;
  };
};

function shapes(t, size) {
  const small = size <= 16;
  const list = [
    // bells and legs (behind the body)
    [capsule(38, 104, 27, 119, 6), t.leg],
    [capsule(90, 104, 101, 119, 6), t.leg],
    [circle(30, 30, 17), t.bell],
    [circle(98, 30, 17), t.bell],
    [capsule(64, 14, 64, 22, 5), t.bell],
    // body
    [circle(64, 68, 52), t.ring],
    [circle(64, 68, small ? 39 : 42), t.face],
  ];
  if (!small) {
    list.push(
      [capsule(64, 30, 64, 37, 3), t.tick],
      [capsule(64, 99, 64, 106, 3), t.tick],
      [capsule(26, 68, 33, 68, 3), t.tick],
      [capsule(95, 68, 102, 68, 3), t.tick],
      [circle(40, 79, 6), t.cheek],
      [circle(88, 79, 6), t.cheek],
    );
  }
  list.push(
    [ellipse(51, 58, small ? 7 : 6, small ? 9 : 8.5), t.eye],
    [ellipse(77, 58, small ? 7 : 6, small ? 9 : 8.5), t.eye],
  );
  if (!small) {
    list.push([circle(53, 54.5, 2.3), t.shine], [circle(79, 54.5, 2.3), t.shine]);
  }
  list.push([arc(64, 70, 19, Math.PI * 0.12, Math.PI * 0.88, small ? 4.5 : 3.6), t.mouth]);
  return list;
}

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

function render(theme, size) {
  const list = shapes(theme, size).map(([fn, col]) => [fn, hex(col)]);
  const SS = 4;
  const scale = 128 / size;
  const buf = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) * scale;
          const y = (py + (sy + 0.5) / SS) * scale;
          let col = null;
          for (const [fn, c] of list) if (fn(x, y) <= 0) col = c; // last shape wins
          if (col) { r += col[0]; g += col[1]; b += col[2]; a += 1; }
        }
      }
      const i = (py * size + px) * 4;
      if (a) {
        buf[i] = Math.round(r / a);
        buf[i + 1] = Math.round(g / a);
        buf[i + 2] = Math.round(b / a);
        buf[i + 3] = Math.round((a / (SS * SS)) * 255);
      }
    }
  }
  return buf;
}

// ---- PNG writer ----
const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(rgba, size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

fs.mkdirSync(OUT, { recursive: true });
for (const [name, theme] of Object.entries(THEMES)) {
  for (const size of SIZES) {
    const file = path.join(OUT, `clock-${name}-${size}.png`);
    fs.writeFileSync(file, png(render(theme, size), size));
    console.log('wrote', path.relative(process.cwd(), file));
  }
}
