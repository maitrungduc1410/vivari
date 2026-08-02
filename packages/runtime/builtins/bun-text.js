// Bun text / terminal utilities: Bun.stringWidth, Bun.stripANSI, Bun.wrapAnsi,
// Bun.color, Bun.indexOfLine, and Bun.inspect's .table / .custom members.
//
// These live beside bun.js rather than inside it, which departs from the usual
// "a Bun.* member goes in bun.js" convention. bun.js is already ~1100 lines and
// this lands next to two sibling batches that all extend the same object literal;
// keeping the bodies out of it reduces the wiring in bun.js to an import plus a
// few purely additive lines. The createBunText() factory shape mirrors the
// makeBunJsc factory that still sits at the bottom of bun.js (bun:ffi's moved out
// to ./bun-unsupported.js with the rest of the impossible surface).
//
// Everything here is pure computation over strings and typed arrays — no VFS, no
// syscalls, no kernel — which is why all of it is reachable from
// scripts/spike-bun-offline.mjs, the only Bun tier CI enforces per-PR.

import ansiTextFactory from "../node/vendor/ansi-text.js";

// ---- the vendored width/strip/wrap implementations --------------------------
// string-width, strip-ansi and wrap-ansi, bundled into one CJS module (see the
// header of node/vendor/ansi-text.js for the regenerate command). Instantiated on
// first use rather than at import time, for the same reason bun.js uses a `lazy`
// require: a process that never touches Bun should not pay for the Unicode tables.
let vendorCache = null;
function vendor() {
  if (!vendorCache) {
    const mod = { exports: {} };
    // The bundle is self-contained (esbuild --platform=neutral): it never calls
    // require() and never reads process. Passing a throwing require makes that
    // assumption fail loudly if a future regenerate quietly breaks it.
    const noRequire = (name) => {
      throw new Error("vendor/ansi-text.js must be self-contained but required " + name);
    };
    ansiTextFactory(mod.exports, noRequire, mod, {});
    vendorCache = mod.exports;
  }
  return vendorCache;
}

// ---- Bun.stringWidth --------------------------------------------------------
// The column count a string occupies in a terminal: ANSI escapes are skipped,
// East Asian Wide/Fullwidth characters and emoji count as 2, control characters
// and combining marks as 0. Bun's docs state its implementation "passes
// string-width's tests" and that the option bag is the same, so string-width IS
// the reference behaviour here — see the vendor header for why this is vendored
// rather than hand-rolled.
//
// Divergence from real Bun: performance only. Bun's is SIMD native code and is
// documented at ~6,756x the npm package; this IS the npm package.
export function stringWidth(input, options) {
  return vendor().stringWidth(input, options);
}

// ---- Bun.stripANSI ----------------------------------------------------------
// Remove ANSI escape sequences (colors, cursor moves, OSC 8 hyperlinks).
export function stripANSI(input) {
  return vendor().stripAnsi(input);
}

// ---- Bun.wrapAnsi -----------------------------------------------------------
// Word-wrap to a column width while keeping ANSI styling intact: an open style is
// closed at each row end and re-opened on the next, so every row renders correctly
// on its own. Defaults match Bun's documented ones ({hard:false, wordWrap:true,
// trim:true, ambiguousIsNarrow:true}) because they are wrap-ansi's defaults.
export function wrapAnsi(input, columns, options) {
  return vendor().wrapAnsi(input, columns, options);
}

// ---- Bun.indexOfLine --------------------------------------------------------
// "Find the index of a newline character in potentially ill-formed UTF-8 text.
// This is sort of like readline() except without the IO." Returns the index of the
// next 0x0A at or after `offset`, or -1. It deliberately scans BYTES and not code
// points, which is the whole point: it is safe on a buffer that was cut mid-
// sequence, because 0x0A can never be a UTF-8 continuation byte.
export function indexOfLine(buffer, offset) {
  const view = asBytes(buffer, "Bun.indexOfLine");
  let i = offset === undefined ? 0 : Math.trunc(Number(offset));
  if (!Number.isFinite(i) || i < 0) i = 0;
  for (; i < view.length; i++) if (view[i] === 0x0a) return i;
  return -1;
}

function asBytes(buffer, who) {
  if (ArrayBuffer.isView(buffer)) {
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  }
  if (buffer instanceof ArrayBuffer || (typeof SharedArrayBuffer !== "undefined" && buffer instanceof SharedArrayBuffer)) {
    return new Uint8Array(buffer);
  }
  throw new TypeError(who + " expects an ArrayBuffer, SharedArrayBuffer or a typed array / DataView");
}

// ---- Bun.color --------------------------------------------------------------
// Parse any CSS colour and re-emit it in one of Bun's documented output formats.
// Real Bun runs its full CSS parser (the Lightning CSS port) over the input; we
// hand-roll the sRGB-space grammar instead. See CSS_FN_UNSUPPORTED below for the
// line that draws, and the MR description for why this is not vendored: every
// npm library that parses the CSS Color 4 function space (colorjs.io and friends)
// is an order of magnitude larger than this whole file, and this code ships into
// every process worker.
//
// Bun returns `null` — not a throw — when the input cannot be parsed, which is a
// documented part of the contract callers branch on. That makes "we understood the
// syntax but cannot convert it" indistinguishable from "that is not a colour", so
// the colour spaces we do not implement throw instead of returning null.

// 148 CSS named colours, from the `color-name` package (name:rrggbb). Kept as one
// string and parsed into a Map on first use: 148 object literal entries would be
// several KB of source for data that is only read when Bun.color sees a keyword.
const NAMED_COLOR_SOURCE =
  "aliceblue:f0f8ff,antiquewhite:faebd7,aqua:00ffff,aquamarine:7fffd4,azure:f0ffff," +
  "beige:f5f5dc,bisque:ffe4c4,black:000000,blanchedalmond:ffebcd,blue:0000ff," +
  "blueviolet:8a2be2,brown:a52a2a,burlywood:deb887,cadetblue:5f9ea0,chartreuse:7fff00," +
  "chocolate:d2691e,coral:ff7f50,cornflowerblue:6495ed,cornsilk:fff8dc,crimson:dc143c," +
  "cyan:00ffff,darkblue:00008b,darkcyan:008b8b,darkgoldenrod:b8860b,darkgray:a9a9a9," +
  "darkgreen:006400,darkgrey:a9a9a9,darkkhaki:bdb76b,darkmagenta:8b008b," +
  "darkolivegreen:556b2f,darkorange:ff8c00,darkorchid:9932cc,darkred:8b0000," +
  "darksalmon:e9967a,darkseagreen:8fbc8f,darkslateblue:483d8b,darkslategray:2f4f4f," +
  "darkslategrey:2f4f4f,darkturquoise:00ced1,darkviolet:9400d3,deeppink:ff1493," +
  "deepskyblue:00bfff,dimgray:696969,dimgrey:696969,dodgerblue:1e90ff,firebrick:b22222," +
  "floralwhite:fffaf0,forestgreen:228b22,fuchsia:ff00ff,gainsboro:dcdcdc," +
  "ghostwhite:f8f8ff,gold:ffd700,goldenrod:daa520,gray:808080,green:008000," +
  "greenyellow:adff2f,grey:808080,honeydew:f0fff0,hotpink:ff69b4,indianred:cd5c5c," +
  "indigo:4b0082,ivory:fffff0,khaki:f0e68c,lavender:e6e6fa,lavenderblush:fff0f5," +
  "lawngreen:7cfc00,lemonchiffon:fffacd,lightblue:add8e6,lightcoral:f08080," +
  "lightcyan:e0ffff,lightgoldenrodyellow:fafad2,lightgray:d3d3d3,lightgreen:90ee90," +
  "lightgrey:d3d3d3,lightpink:ffb6c1,lightsalmon:ffa07a,lightseagreen:20b2aa," +
  "lightskyblue:87cefa,lightslategray:778899,lightslategrey:778899,lightsteelblue:b0c4de," +
  "lightyellow:ffffe0,lime:00ff00,limegreen:32cd32,linen:faf0e6,magenta:ff00ff," +
  "maroon:800000,mediumaquamarine:66cdaa,mediumblue:0000cd,mediumorchid:ba55d3," +
  "mediumpurple:9370db,mediumseagreen:3cb371,mediumslateblue:7b68ee," +
  "mediumspringgreen:00fa9a,mediumturquoise:48d1cc,mediumvioletred:c71585," +
  "midnightblue:191970,mintcream:f5fffa,mistyrose:ffe4e1,moccasin:ffe4b5," +
  "navajowhite:ffdead,navy:000080,oldlace:fdf5e6,olive:808000,olivedrab:6b8e23," +
  "orange:ffa500,orangered:ff4500,orchid:da70d6,palegoldenrod:eee8aa,palegreen:98fb98," +
  "paleturquoise:afeeee,palevioletred:db7093,papayawhip:ffefd5,peachpuff:ffdab9," +
  "peru:cd853f,pink:ffc0cb,plum:dda0dd,powderblue:b0e0e6,purple:800080," +
  "rebeccapurple:663399,red:ff0000,rosybrown:bc8f8f,royalblue:4169e1,saddlebrown:8b4513," +
  "salmon:fa8072,sandybrown:f4a460,seagreen:2e8b57,seashell:fff5ee,sienna:a0522d," +
  "silver:c0c0c0,skyblue:87ceeb,slateblue:6a5acd,slategray:708090,slategrey:708090," +
  "snow:fffafa,springgreen:00ff7f,steelblue:4682b4,tan:d2b48c,teal:008080,thistle:d8bfd8," +
  "tomato:ff6347,turquoise:40e0d0,violet:ee82ee,wheat:f5deb3,white:ffffff," +
  "whitesmoke:f5f5f5,yellow:ffff00,yellowgreen:9acd32";

let namedColors = null;
let namesByHex = null;
function names() {
  if (!namedColors) {
    namedColors = new Map();
    namesByHex = new Map();
    for (const entry of NAMED_COLOR_SOURCE.split(",")) {
      const cut = entry.indexOf(":");
      const name = entry.slice(0, cut);
      const hex = entry.slice(cut + 1);
      namedColors.set(name, hex);
      // Several hexes have two spellings (aqua/cyan, gray/grey, fuchsia/magenta,
      // and the -gray/-grey pairs). The source list is alphabetical and we keep
      // the FIRST spelling, which is what Lightning CSS serialises to.
      if (!namesByHex.has(hex)) namesByHex.set(hex, name);
    }
  }
  return namedColors;
}

const CSS_COLOR_FUNCTIONS = ["lab", "lch", "oklab", "oklch", "color", "color-mix", "light-dark"];
const CSS_FN_UNSUPPORTED = (fn) =>
  "Bun.color: the CSS function " +
  fn +
  "() is not implemented in the Vivari shim. Real Bun parses it with its full CSS " +
  "engine; this shim implements the sRGB-space grammar only (named colours, hex, " +
  "rgb/rgba, hsl/hsla, hwb, numbers, {r,g,b,a} objects and [r,g,b,a] arrays). " +
  "Returning null here would be indistinguishable from 'not a colour', so this " +
  "throws instead. Convert the colour to rgb()/hex first.";

// Parse anything Bun.color accepts into {r,g,b,a} with r/g/b as 0-255 integers and
// a as a 0-1 float. Returns null for input that is genuinely not a colour.
export function parseColor(input) {
  if (typeof input === "number") {
    if (!Number.isFinite(input) || input < 0 || input > 0xffffff) return null;
    const n = Math.trunc(input);
    return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff, a: 1 };
  }
  if (Array.isArray(input)) {
    if (input.length < 3 || input.length > 4) return null;
    const [r, g, b, a] = input;
    if (![r, g, b].every((v) => typeof v === "number" && Number.isFinite(v))) return null;
    // Array form carries alpha as 0-255, unlike the object form's 0-1.
    const alpha = input.length === 4 ? clamp(Number(a), 0, 255) / 255 : 1;
    return { r: byte(r), g: byte(g), b: byte(b), a: alpha };
  }
  if (input && typeof input === "object") {
    const { r, g, b, a } = input;
    if (![r, g, b].every((v) => typeof v === "number" && Number.isFinite(v))) return null;
    return { r: byte(r), g: byte(g), b: byte(b), a: a === undefined ? 1 : clamp(Number(a), 0, 1) };
  }
  if (typeof input !== "string") return null;

  const raw = input.trim();
  if (raw === "") return null;
  const lower = raw.toLowerCase();

  if (lower === "transparent") return { r: 0, g: 0, b: 0, a: 0 };

  if (lower[0] === "#") return parseHex(lower.slice(1));

  const open = lower.indexOf("(");
  if (open > 0 && lower.endsWith(")")) {
    const fn = lower.slice(0, open).trim();
    const args = lower.slice(open + 1, -1);
    if (CSS_COLOR_FUNCTIONS.indexOf(fn) !== -1) throw new TypeError(CSS_FN_UNSUPPORTED(fn));
    if (fn === "rgb" || fn === "rgba") return parseRgbFn(args);
    if (fn === "hsl" || fn === "hsla") return parseHslFn(args);
    if (fn === "hwb") return parseHwbFn(args);
    return null;
  }

  const hex = names().get(lower);
  return hex ? parseHex(hex) : null;
}

function byte(v) {
  return clamp(Math.round(Number(v)), 0, 255);
}
function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function parseHex(h) {
  if (!/^[0-9a-f]+$/.test(h)) return null;
  const dup = (c) => parseInt(c + c, 16);
  if (h.length === 3) return { r: dup(h[0]), g: dup(h[1]), b: dup(h[2]), a: 1 };
  if (h.length === 4) return { r: dup(h[0]), g: dup(h[1]), b: dup(h[2]), a: dup(h[3]) / 255 };
  if (h.length === 6) {
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: 1 };
  }
  if (h.length === 8) {
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
      a: parseInt(h.slice(6, 8), 16) / 255,
    };
  }
  return null;
}

// CSS Color 4 allows both the legacy comma syntax `rgb(1, 2, 3, 0.5)` and the
// modern space syntax `rgb(1 2 3 / 50%)`; normalise both to a flat argument list.
function splitArgs(args) {
  return args.replace(/\//g, " / ").split(/[\s,]+/).filter((s) => s !== "");
}

function channel(tok, scale) {
  if (tok === "none") return 0;
  if (tok.endsWith("%")) {
    const p = Number(tok.slice(0, -1));
    return Number.isFinite(p) ? (p / 100) * scale : NaN;
  }
  const n = Number(tok);
  return Number.isFinite(n) ? n : NaN;
}

function alphaChannel(tok) {
  if (tok === undefined) return 1;
  if (tok === "none") return 0;
  const v = tok.endsWith("%") ? Number(tok.slice(0, -1)) / 100 : Number(tok);
  return Number.isFinite(v) ? clamp(v, 0, 1) : NaN;
}

function parseRgbFn(args) {
  const t = splitArgs(args).filter((s) => s !== "/");
  if (t.length !== 3 && t.length !== 4) return null;
  const r = channel(t[0], 255);
  const g = channel(t[1], 255);
  const b = channel(t[2], 255);
  const a = alphaChannel(t[3]);
  if ([r, g, b, a].some(Number.isNaN)) return null;
  return { r: byte(r), g: byte(g), b: byte(b), a };
}

// Hue accepts deg/grad/rad/turn or a bare number, per CSS Color 4.
function hue(tok) {
  if (tok === "none") return 0;
  const m = /^(-?[0-9.]+)(deg|grad|rad|turn)?$/.exec(tok);
  if (!m) return NaN;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return NaN;
  const unit = m[2] || "deg";
  const deg = unit === "grad" ? n * 0.9 : unit === "rad" ? (n * 180) / Math.PI : unit === "turn" ? n * 360 : n;
  return ((deg % 360) + 360) % 360;
}

function parseHslFn(args) {
  const t = splitArgs(args).filter((s) => s !== "/");
  if (t.length !== 3 && t.length !== 4) return null;
  const h = hue(t[0]);
  const s = clamp(channel(t[1], 100), 0, 100) / 100;
  const l = clamp(channel(t[2], 100), 0, 100) / 100;
  const a = alphaChannel(t[3]);
  if ([h, s, l, a].some(Number.isNaN)) return null;
  const [r, g, b] = hslToRgb(h, s, l);
  return { r: byte(r), g: byte(g), b: byte(b), a };
}

function parseHwbFn(args) {
  const t = splitArgs(args).filter((s) => s !== "/");
  if (t.length !== 3 && t.length !== 4) return null;
  const h = hue(t[0]);
  let w = clamp(channel(t[1], 100), 0, 100) / 100;
  let bl = clamp(channel(t[2], 100), 0, 100) / 100;
  const a = alphaChannel(t[3]);
  if ([h, w, bl, a].some(Number.isNaN)) return null;
  if (w + bl >= 1) {
    const grey = w / (w + bl);
    return { r: byte(grey * 255), g: byte(grey * 255), b: byte(grey * 255), a };
  }
  const [r, g, b] = hslToRgb(h, 1, 0.5);
  const mix = (c) => (c / 255) * (1 - w - bl) + w;
  return { r: byte(mix(r) * 255), g: byte(mix(g) * 255), b: byte(mix(b) * 255), a };
}

function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const m = l - c / 2;
  let rgb;
  if (hp < 1) rgb = [c, x, 0];
  else if (hp < 2) rgb = [x, c, 0];
  else if (hp < 3) rgb = [0, c, x];
  else if (hp < 4) rgb = [0, x, c];
  else if (hp < 5) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  return rgb.map((v) => (v + m) * 255);
}

function rgbToHsl(r, g, b) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  let h;
  if (max === rn) h = ((gn - bn) / d) % 6;
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return [h, s, l];
}

// ---- ANSI colour depth ------------------------------------------------------
// Bun.color(x, "ansi") "detects the color depth of stdout from environment
// variables" and returns "" when stdout supports no colour at all. Vivari's
// terminal is virtual, so what it claims is a choice, not an observation — and the
// runtime has ALREADY made that choice once, in node/internal/util/colors.js,
// which is the hook util.styleText consults. Reusing that precedence verbatim
// keeps Bun.color and util.styleText from disagreeing about whether colour is on:
//
//   1. NO_COLOR / NODE_DISABLE_COLORS set, or TERM=dumb  -> no colour, "" is returned
//   2. FORCE_COLOR set                                   -> ""/"1"/"2"/"3"/"true" on
//                                                           (at 16/256/16m depth),
//                                                           anything else off
//   3. otherwise follow stdout's TTY-ness, then COLORTERM/TERM for the depth
//
// Consequences worth stating, because they are the observable behaviour:
//   * Under Studio the kernel exports TERM=xterm-256color and FORCE_COLOR=3
//     (packages/core/src/workers/kernel-worker.ts), so Bun.color(x, "ansi") returns
//     24-bit "ansi-16m". That is correct: the studio terminal is xterm.js, which
//     renders truecolor. This is the deliberate claim, not an accident.
//   * In a headless kernel (spikes, verify-node) nothing sets FORCE_COLOR and
//     stdout is not a TTY, so it returns "" — the documented no-colour answer.
export function ansiColorDepth(env, stdout) {
  const e = env || {};
  if (e.NODE_DISABLE_COLORS !== undefined || e.NO_COLOR !== undefined || e.TERM === "dumb") return 0;
  if (e.FORCE_COLOR !== undefined) {
    // The ON/OFF half of this must match colors.js's shouldColorize() value-for-
    // value, or util.styleText and Bun.color disagree on a nonsense FORCE_COLOR.
    // That list is exactly "", "1", "2", "3" and "true"; everything else is off.
    const f = String(e.FORCE_COLOR);
    if (f === "1" || f === "true") return 4;
    if (f === "2") return 8;
    if (f === "3" || f === "") return 24;
    return 0;
  }
  if (!(stdout && stdout.isTTY)) return 0;
  const colorterm = String(e.COLORTERM || "");
  if (colorterm === "truecolor" || colorterm === "24bit") return 24;
  if (/-256(color)?$/.test(String(e.TERM || ""))) return 8;
  return 4;
}

// tmux's rgb -> 256 mapping, which is the algorithm Bun's docs say they ported
// (tmux colour.c colour_find_rgb): snap to the 6x6x6 cube, and prefer the
// greyscale ramp when it is closer.
const CUBE_LEVELS = [0x00, 0x5f, 0x87, 0xaf, 0xd7, 0xff];
function to6Cube(v) {
  if (v < 48) return 0;
  if (v < 114) return 1;
  return Math.floor((v - 35) / 40);
}
export function rgbToAnsi256(r, g, b) {
  const qr = to6Cube(r);
  const qg = to6Cube(g);
  const qb = to6Cube(b);
  const cr = CUBE_LEVELS[qr];
  const cg = CUBE_LEVELS[qg];
  const cb = CUBE_LEVELS[qb];
  const cubeIdx = 16 + 36 * qr + 6 * qg + qb;
  if (cr === r && cg === g && cb === b) return cubeIdx;
  const greyAvg = Math.floor((r + g + b) / 3);
  const greyIdx = greyAvg > 238 ? 23 : Math.floor((greyAvg - 3) / 10);
  const grey = 8 + 10 * greyIdx;
  const dist = (x, y, z) => (x - r) * (x - r) + (y - g) * (y - g) + (z - b) * (z - b);
  return dist(grey, grey, grey) < dist(cr, cg, cb) ? 232 + greyIdx : cubeIdx;
}

// 256 -> the 16 base colours, via the standard ansi-styles reduction. Bun documents
// the same two-step path ("to ansi-256, then to the nearest of the 16").
export function ansi256To16(code) {
  if (code < 8) return 30 + code;
  if (code < 16) return 90 + (code - 8);
  let r;
  let g;
  let b;
  if (code >= 232) {
    r = g = b = ((code - 232) * 10 + 8) / 255;
  } else {
    const c = code - 16;
    const rem = c % 36;
    r = Math.floor(c / 36) / 5;
    g = Math.floor(rem / 6) / 5;
    b = (rem % 6) / 5;
  }
  const value = Math.max(r, g, b) * 2;
  if (value === 0) return 30;
  let result = 30 + ((Math.round(b) << 2) | (Math.round(g) << 1) | Math.round(r));
  if (value === 2) result += 60;
  return result;
}

const HEX2 = (n) => n.toString(16).padStart(2, "0");

function toHex(c) {
  const base = HEX2(c.r) + HEX2(c.g) + HEX2(c.b);
  return c.a >= 1 ? "#" + base : "#" + base + HEX2(Math.round(c.a * 255));
}

// The "css" format is documented as "the most compact string representation".
// Divergence: we choose between a named colour, a 3- or 6-digit hex, and rgba();
// real Bun runs Lightning CSS's serialiser, which knows a few more equivalences,
// so exotic inputs may differ in form (never in colour).
function toCss(c) {
  if (c.a <= 0) return "transparent";
  if (c.a < 1) return "rgba(" + c.r + ", " + c.g + ", " + c.b + ", " + trimFloat(c.a) + ")";
  const long = HEX2(c.r) + HEX2(c.g) + HEX2(c.b);
  names();
  const name = namesByHex.get(long);
  const short =
    long[0] === long[1] && long[2] === long[3] && long[4] === long[5] ? "#" + long[0] + long[2] + long[4] : "#" + long;
  if (name && name.length <= short.length) return name;
  return short;
}

function trimFloat(a) {
  return String(Math.round(a * 1000) / 1000);
}

export const COLOR_FORMATS = [
  "css", "ansi", "ansi-16", "ansi-256", "ansi-16m", "number", "rgb", "rgba",
  "hsl", "hex", "HEX", "{rgb}", "{rgba}", "[rgb]", "[rgba]",
];

// `env`/`stdout` are threaded in rather than read off a global so the depth policy
// above is testable without a real terminal — spike-bun-offline.mjs builds runtimes
// with a fake process to pin every branch of it.
export function color(input, outputFormat, env, stdout) {
  const c = parseColor(input);
  if (!c) return null;
  const format = outputFormat === undefined ? "css" : outputFormat;

  switch (format) {
    case "css":
      return toCss(c);
    case "number":
      return (c.r << 16) | (c.g << 8) | c.b;
    case "hex":
      return toHex(c);
    case "HEX":
      return toHex(c).toUpperCase();
    case "rgb":
      return "rgb(" + c.r + ", " + c.g + ", " + c.b + ")";
    case "rgba":
      return "rgba(" + c.r + ", " + c.g + ", " + c.b + ", " + trimFloat(c.a) + ")";
    case "hsl": {
      const [h, s, l] = rgbToHsl(c.r, c.g, c.b);
      return "hsl(" + Math.round(h) + ", " + Math.round(s * 100) + "%, " + Math.round(l * 100) + "%)";
    }
    case "{rgb}":
      return { r: c.r, g: c.g, b: c.b };
    // The object form carries alpha as 0-1 and the array form as 0-255. That
    // asymmetry is in Bun's docs, not a typo here.
    case "{rgba}":
      return { r: c.r, g: c.g, b: c.b, a: c.a };
    case "[rgb]":
      return [c.r, c.g, c.b];
    case "[rgba]":
      return [c.r, c.g, c.b, Math.round(c.a * 255)];
    case "ansi-16m":
      return "\u001b[38;2;" + c.r + ";" + c.g + ";" + c.b + "m";
    case "ansi-256":
      return "\u001b[38;5;" + rgbToAnsi256(c.r, c.g, c.b) + "m";
    case "ansi-16":
      return "\u001b[" + ansi256To16(rgbToAnsi256(c.r, c.g, c.b)) + "m";
    case "ansi": {
      const depth = ansiColorDepth(env, stdout);
      if (depth === 0) return "";
      if (depth === 24) return color(input, "ansi-16m", env, stdout);
      if (depth === 8) return color(input, "ansi-256", env, stdout);
      return color(input, "ansi-16", env, stdout);
    }
    default:
      // An unknown format is a caller bug, not an unparseable colour — returning
      // null would let it read as "bad input" forever.
      throw new TypeError(
        "Bun.color: unknown output format " + JSON.stringify(format) + ". Expected one of: " + COLOR_FORMATS.join(", ")
      );
  }
}

// ---- Bun.inspect.table ------------------------------------------------------
// console.table's rendering, returned as a string instead of printed. Bun's
// documented frame uses box-drawing characters and an EMPTY header cell above the
// index column (Node prints "(index)" there).
//
// Divergences, both cosmetic and both deliberate: cell values are rendered with
// util.inspect, so strings come out single-quoted the way the rest of Bun.inspect
// renders them here rather than double-quoted the way real Bun does; and columns
// are left-aligned. Column widths are measured with stringWidth above, so a table
// of CJK or emoji cells still lines up.
export function inspectTable(data, properties, options, inspect) {
  // Bun's signature is (tabularData, properties?, options?) but the docs also show
  // the options bag in the second position, so accept both.
  let props = properties;
  let opts = options;
  if (props && !Array.isArray(props)) {
    opts = props;
    props = undefined;
  }
  const colors = !!(opts && opts.colors);
  const render = (v) => inspect(v, { colors, depth: 0, compact: true, breakLength: Infinity, sorted: false });

  const entries = [];
  if (Array.isArray(data)) {
    data.forEach((v, i) => entries.push([String(i), v]));
  } else if (data instanceof Map) {
    let i = 0;
    for (const [k, v] of data) entries.push([render(k), v, i++]);
  } else if (data instanceof Set) {
    let i = 0;
    for (const v of data) entries.push([String(i++), v]);
  } else if (data && typeof data === "object") {
    for (const k of Object.keys(data)) entries.push([k, data[k]]);
  } else {
    throw new TypeError("Bun.inspect.table expects an array or object of tabular data");
  }

  const isRow = (v) => v !== null && typeof v === "object";
  const columns = [];
  let hasValues = false;
  if (props) {
    columns.push(...props.map(String));
  } else {
    for (const [, v] of entries) {
      if (isRow(v)) {
        for (const k of Object.keys(v)) if (columns.indexOf(k) === -1) columns.push(k);
      } else {
        hasValues = true;
      }
    }
  }

  const header = ["", ...columns];
  if (hasValues) header.push("Values");
  const body = entries.map(([key, v]) => {
    const cells = [key];
    for (const col of columns) {
      cells.push(isRow(v) && Object.prototype.hasOwnProperty.call(v, col) ? render(v[col]) : "");
    }
    if (hasValues) cells.push(isRow(v) ? "" : render(v));
    return cells;
  });

  const widths = header.map((h, i) => Math.max(stringWidth(h), ...body.map((row) => stringWidth(row[i]))));
  const pad = (s, w) => " " + s + " ".repeat(Math.max(0, w - stringWidth(s))) + " ";
  const rule = (l, mid, r) => l + widths.map((w) => "\u2500".repeat(w + 2)).join(mid) + r;
  const line = (cells) => "\u2502" + cells.map((s, i) => pad(s, widths[i])).join("\u2502") + "\u2502";

  const out = [rule("\u250c", "\u252c", "\u2510"), line(header), rule("\u251c", "\u253c", "\u2524")];
  for (const row of body) out.push(line(row));
  out.push(rule("\u2514", "\u2534", "\u2518"));
  return out.join("\n");
}

// ---- factory ----------------------------------------------------------------
export function createBunText({ lazy, process }) {
  // Bun.inspect already existed as a plain delegate to util.inspect; it becomes a
  // function object here so it can carry .table and .custom the way Bun's does.
  const inspect = (v, opts) => lazy("util").inspect(v, opts);
  // "Identical to util.inspect.custom in Node.js" — and that is a registry symbol,
  // so Symbol.for() is the same symbol object the runtime's own util uses.
  inspect.custom = Symbol.for("nodejs.util.inspect.custom");
  inspect.table = (data, properties, options) => inspectTable(data, properties, options, inspect);

  return {
    stringWidth,
    stripANSI,
    wrapAnsi,
    indexOfLine,
    inspect,
    color: (input, outputFormat) => color(input, outputFormat, process.env, process.stdout),
  };
}