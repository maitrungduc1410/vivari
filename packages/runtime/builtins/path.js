// A POSIX-only implementation of Node's `path` module. `resolve` needs the
// current working directory, which is injected via `getCwd` (so this stays
// decoupled from `process`).

export function createPath(getCwd) {
  function normalizeArray(parts, allowAboveRoot) {
    const res = [];
    for (const p of parts) {
      if (!p || p === ".") continue;
      if (p === "..") {
        if (res.length && res[res.length - 1] !== "..") res.pop();
        else if (allowAboveRoot) res.push("..");
      } else {
        res.push(p);
      }
    }
    return res;
  }

  function isAbsolute(p) {
    return p.charAt(0) === "/";
  }

  function normalize(p) {
    if (p.length === 0) return ".";
    const abs = isAbsolute(p);
    const trailing = p[p.length - 1] === "/";
    let out = normalizeArray(p.split("/"), !abs).join("/");
    if (!out && !abs) out = ".";
    if (out && trailing) out += "/";
    return (abs ? "/" : "") + out;
  }

  function join(...args) {
    const parts = [];
    for (const a of args) {
      if (typeof a !== "string") throw new TypeError("Path must be a string");
      if (a.length) parts.push(a);
    }
    if (!parts.length) return ".";
    return normalize(parts.join("/"));
  }

  function resolve(...args) {
    let resolved = "";
    let abs = false;
    for (let i = args.length - 1; i >= -1 && !abs; i--) {
      const p = i >= 0 ? String(args[i]) : getCwd();
      if (!p) continue;
      resolved = p + "/" + resolved;
      abs = p.charAt(0) === "/";
    }
    const joined = normalizeArray(resolved.split("/"), !abs).join("/");
    if (abs) return "/" + joined;
    return joined || ".";
  }

  function dirname(p) {
    if (p.length === 0) return ".";
    let s = p;
    while (s.length > 1 && s[s.length - 1] === "/") s = s.slice(0, -1);
    const idx = s.lastIndexOf("/");
    if (idx === -1) return ".";
    if (idx === 0) return "/";
    return s.slice(0, idx);
  }

  function basename(p, ext) {
    let s = p.replace(/\/+$/, "");
    let base = s.slice(s.lastIndexOf("/") + 1);
    if (ext && base !== ext && base.endsWith(ext)) base = base.slice(0, -ext.length);
    return base;
  }

  function extname(p) {
    const base = basename(p);
    const i = base.lastIndexOf(".");
    return i <= 0 ? "" : base.slice(i);
  }

  function relative(from, to) {
    from = resolve(from);
    to = resolve(to);
    if (from === to) return "";
    const fp = from.split("/").filter(Boolean);
    const tp = to.split("/").filter(Boolean);
    let i = 0;
    while (i < fp.length && i < tp.length && fp[i] === tp[i]) i++;
    const up = fp.slice(i).map(() => "..");
    return up.concat(tp.slice(i)).join("/");
  }

  function parse(p) {
    const root = isAbsolute(p) ? "/" : "";
    const base = basename(p);
    const ext = extname(base);
    const name = ext ? base.slice(0, -ext.length) : base;
    const dir = dirname(p);
    return { root, dir: dir === "." && !root ? "" : dir, base, ext, name };
  }

  function format(o) {
    const dir = o.dir || o.root || "";
    const base = o.base || (o.name || "") + (o.ext || "");
    if (!dir) return base;
    return dir.replace(/\/$/, "") + "/" + base;
  }

  const posix = {
    sep: "/",
    delimiter: ":",
    isAbsolute,
    normalize,
    join,
    resolve,
    dirname,
    basename,
    extname,
    relative,
    parse,
    format,
  };
  posix.posix = posix;
  return posix;
}
