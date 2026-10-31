// internal/url — shim over the platform WHATWG URL (Phase 2 #8).
//
// Node's real internal/url.js is a large parser bound to native ICU/ada. The
// browser (and Node host) already provide a spec-compliant global URL, so we
// re-export it and add the couple of helpers the http tree destructures.
export default function (exports, require, module, process, internalBinding, primordials) {
  "use strict";

  const URL = globalThis.URL;
  const URLSearchParams = globalThis.URLSearchParams;

  const isURL = (self) =>
    self != null &&
    (self instanceof URL ||
      (typeof self === "object" && typeof self.href === "string" && typeof self.origin === "string"));

  // Copied from Node's internal/url.js (minus primordials wrapping).
  function urlToHttpOptions(url) {
    const { hostname, pathname, port, username, password, search } = url;
    const options = {
      __proto__: null,
      ...url,
      protocol: url.protocol,
      hostname: hostname && hostname[0] === "[" ? hostname.slice(1, -1) : hostname,
      hash: url.hash,
      search: search,
      pathname: pathname,
      path: `${pathname || ""}${search || ""}`,
      href: url.href,
    };
    if (port !== "") options.port = Number(port);
    if (username || password) {
      options.auth = `${decodeURIComponent(username)}:${decodeURIComponent(password)}`;
    }
    return options;
  }

  // fs.js / internal/fs/utils.js call these on path arguments (mostly plain
  // strings) — preserve the pre-#8 behavior.
  // Node throws on a non-file scheme and on a hostful file URL (posix); the scheme
  // still throws here, but a HOST must not. Node's rule assumed a host can only name a
  // machine, and that any other host was our own bug (`"file://" + relativeId`, see
  // fileMetaPath in esm.js). Neither holds in a browser: Chrome parses `file:` URLs
  // with url/url_parse_file.cc, whose WIN32 branch treats everything that is not
  // `C:\` and not exactly three slashes as an UNC path — so `"file:" + "/home/user/x"`,
  // the idiom a package uses to turn `__filename` into a URL (PGlite's CJS build does
  // exactly that), is `file://home/user/x` on Windows and `file:///home/user/x`
  // everywhere else (url_parse_unittest.cc pins both tables). This VFS has no file
  // hosts, so a host can only be the first path segment that parser promoted: put it
  // back in front of the pathname instead of failing a whole database boot over the
  // browser's grammar. A three-slash URL, `localhost` and the scheme error are
  // unchanged, and the one deliberate deviation from Node is that a real UNC URL
  // (`file://server/share`) maps to "/server/share" instead of throwing.
  function fileURLToPath(url) {
    const u = typeof url === "string" ? new URL(url) : url;
    if (u.protocol !== "file:") {
      const err = new TypeError("The URL must be of scheme file");
      err.code = "ERR_INVALID_URL_SCHEME";
      throw err;
    }
    let pathname = u.pathname;
    if (u.hostname !== "" && u.hostname !== "localhost") {
      // `file:/home` parses as host "home" + pathname "/" (the authority form adds a
      // slash the intended path never had), so a bare "/" pathname takes no join.
      pathname = "/" + u.hostname + (u.pathname === "/" ? "" : u.pathname);
    }
    pathname = decodeURIComponent(pathname);
    return pathname || "/";
  }
  function toPathIfFileURL(fileURLOrPath) {
    if (
      fileURLOrPath &&
      typeof fileURLOrPath === "object" &&
      fileURLOrPath.protocol === "file:" &&
      typeof fileURLOrPath.pathname === "string"
    ) {
      return fileURLToPath(fileURLOrPath);
    }
    return fileURLOrPath;
  }

  module.exports = {
    URL,
    // Node's non-throwing parse: a URL, or null when the input is not one. Used by
    // SocketAddress.parse(), which must return undefined rather than throw for
    // something that is not an address.
    URLParse: (input, base) => {
      try {
        return base === undefined ? new URL(input) : new URL(input, base);
      } catch {
        return null;
      }
    },
    URLSearchParams,
    isURL,
    urlToHttpOptions,
    fileURLToPath,
    toPathIfFileURL,
    // Node resolves a relative path to absolute (against cwd) before building the
    // file: URL and percent-encodes the pathname. The old `new URL("file://"+p)`
    // threw "Invalid URL" for relative inputs (it parsed the first segment as the
    // host) — e.g. `pathToFileURL("@next/swc-wasm-nodejs")`, which Next.js's SWC
    // loader relies on. Match Node: resolve, then let URL#pathname encode it.
    pathToFileURL: (p) => {
      const path = require("path");
      const filepath = String(p);
      let resolved = path.resolve(filepath);
      // path.resolve() strips a trailing separator, but Node's pathToFileURL
      // preserves it (lib/internal/url.js re-adds the slash resolve() dropped).
      // This matters for directory bases: ESM/exsolve resolvers build
      // `new URL("./node_modules/<pkg>", base)`, which only stays inside the
      // directory when `base` keeps its trailing slash. Without it the request
      // resolves one directory too high and installed packages (e.g. @nuxt/kit)
      // fail to resolve ("Cannot resolve module").
      const last = filepath.charCodeAt(filepath.length - 1);
      if (last === 47 /* '/' */ && resolved[resolved.length - 1] !== "/") {
        resolved += "/";
      }
      const u = new URL("file:///");
      // URL#pathname does not touch `%` (it is not in the path percent-encode set), so
      // a literal percent in a file NAME would come back as an escape: "a%20b" would
      // decode to "a b". Node's pathToFileURL percent-encodes it, and a path this builds
      // has to survive fileURLToPath, so encode it before handing it to the setter.
      u.pathname = resolved.replace(/%/g, "%25");
      return u;
    },
  };
}
