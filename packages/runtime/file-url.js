// The one place a `file:` URL becomes a VFS path — and a path becomes one.
//
// This exists as a module rather than a `slice("file://".length)` per call site
// because a HOST in a file: URL is a platform difference, not a typo. Chromium's
// url/url_parse_file.cc takes its `#ifdef WIN32` branch for anything that is not
// `C:\` and is not exactly three slashes and parses the rest as an **UNC path**,
// so the same string means two different things:
//
//   "file:" + "/home/user/x"    Node, Chrome on Linux/macOS: file:///home/user/x
//                               Chrome on Windows:          file://home/user/x
//                                                           (host "home", path "/user/x")
//
// url/url_parse_unittest.cc pins both tables. Everything userland does to turn a
// `__filename` into a URL goes through that string form, which is why this runtime
// must (a) never build a file: URL that can grow a host — a relative id is
// root-relative, never an authority — and (b) never hand back a RELATIVE path when
// one has. A naked strip of the scheme gives "home/user/x" for the Windows form:
// a path that resolves against nothing and silently reads the wrong file.
//
// This VFS has no file hosts, so a host can only be a path segment some parser
// promoted. Putting it back in front of the pathname is the only reconstruction
// that gets the file the URL was built from — and it is LOSSY by construction,
// because the parser normalises the host before anyone can see it:
//
//   file://MyApp/x      -> host "myapp"        -> /myapp/x        (case gone)
//   file://123/x        -> host "0.0.0.123"    -> /0.0.0.123/x    (parsed as IPv4)
//   file://localhost/x  -> hostless            -> /x              (label gone)
//   file://@scope/x     -> Invalid URL at parse (falls back, see below)
//
// So what this returns is the path the URL **now describes**, not "the path it
// meant". That is enough here on purpose: the URLs this runtime builds are all
// three-slash (esm.js fileMetaPath, debugger.js toUrl, module.js sourceUrlFor), so
// a host only appears when a package built the URL itself out of an absolute path,
// whose first segment is a directory name (`home`, `user`, `app`) rather than
// something the parser normalises away.
//
// The one deliberate deviation from Node: a real UNC URL (`file://server/share`)
// maps to "/server/share" instead of throwing ERR_INVALID_FILE_URL_HOST. It cannot
// be told apart from the Windows form above, and a wrong path beats a dead boot —
// the case that started this is PGlite's CJS build.
//
// Regression: scripts/spike-esm.mjs sections 9-10 (9 pins the rule and its limits, 10
// fails if any call site hand-rolls the conversion again) and scripts/spike-bun-offline.mjs.

/**
 * Rebuild the absolute path a parsed file: URL now describes.
 * The authority form adds a slash the intended path never had (`file:/home` parses
 * as host "home" + pathname "/"), so a bare "/" pathname takes no join.
 */
function pathFromParsed(u) {
  let p = u.pathname;
  if (u.hostname !== "" && u.hostname !== "localhost") {
    p = "/" + u.hostname + (u.pathname === "/" ? "" : u.pathname);
  }
  return p || "/";
}

/**
 * Node's `fileURLToPath`, except that a host does not throw (see the header).
 * `url` is a string or a URL object. A non-file scheme still throws
 * ERR_INVALID_URL_SCHEME, and a malformed percent escape still throws, as in Node.
 */
export function fileUrlToPath(url) {
  const u = typeof url === "string" ? new URL(url) : url;
  if (!u || u.protocol !== "file:") {
    const err = new TypeError("The URL must be of scheme file");
    err.code = "ERR_INVALID_URL_SCHEME";
    throw err;
  }
  return decodeURIComponent(pathFromParsed(u)) || "/";
}

/**
 * The loader's variant, for a module specifier that IS a file: URL (`fromFileUrl`,
 * `Bun.resolveSync`'s parent, `worker_threads`' entry). Same rule, plus the two
 * tolerances a specifier needs and `fileURLToPath` must not have:
 *
 *  - Never throws. A URL the platform cannot parse at all (`file://@scope/x` is
 *    Invalid URL, because `@` cannot start a host) and a bad percent escape both
 *    fall back to the old tolerant read instead of failing a dynamic import.
 *  - Never returns a relative path — the invariant this whole module exists for.
 *    The fallback therefore always puts a leading "/" back, which is what the
 *    parser-promoted segment would have had.
 *
 * Returns null when `spec` is not a file: URL, so a caller that did not check the
 * scheme does not silently get a path-shaped URL back.
 */
export function fileUrlSpecifierToPath(spec) {
  const s = typeof spec === "string" ? spec : spec && typeof spec.href === "string" ? spec.href : "";
  try {
    const u = new URL(s);
    if (u.protocol !== "file:") return null;
    const p = pathFromParsed(u);
    try {
      return decodeURIComponent(p) || "/";
    } catch {
      // A malformed escape ("%ZZ", or a literal "%" the URL left alone) is not a
      // reason to lose the file: keep the pathname as written.
      return p || "/";
    }
  } catch {
    /* not a URL the platform can parse — read it the tolerant way below */
  }
  let r = s.replace(/^file:(\/\/)?/i, "");
  try {
    r = decodeURIComponent(r);
  } catch {
    /* leave the escapes as written */
  }
  const h = r.indexOf("#");
  if (h >= 0) r = r.slice(0, h);
  const q = r.indexOf("?");
  if (q >= 0) r = r.slice(0, q);
  return r.startsWith("/") ? r : "/" + r;
}

/**
 * The other direction: an absolute VFS path as a file: URL, with a literal "%"
 * percent-encoded.
 *
 * Two rules are load-bearing. URL#pathname does not touch "%" (it is not in the
 * path percent-encode set), so without the explicit escape a file NAME like
 * "a%20b" would come back from fileUrlToPath as "a b". And a path is always
 * ROOT-relative: a relative input gets its leading "/" rather than becoming the
 * host, so this cannot produce the string that started all of this.
 *
 * Callers that need cwd resolution (pathToFileURL, in node/internal/url.js and
 * bun.js) resolve first; this function must not, because it is also what turns a
 * module id into import.meta.url, and that id is absolute by construction.
 */
export function pathToFileUrl(p) {
  let pathname = String(p);
  if (!pathname.startsWith("/")) pathname = "/" + pathname;
  const u = new URL("file:///");
  u.pathname = pathname.replace(/%/g, "%25");
  return u;
}
