// internal/url — shim over the platform WHATWG URL (Phase 2 #8).
//
// Node's real internal/url.js is a large parser bound to native ICU/ada. The
// browser (and Node host) already provide a spec-compliant global URL, so we
// re-export it and add the couple of helpers the http tree destructures.
import { fileUrlToPath as recoverFilePath, pathToFileUrl as buildFileUrl } from "../../file-url.js";

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
  // strings) — preserve the pre-#8 behavior. The rule itself lives in ../../file-url.js,
  // and it is NOT quite Node's: the scheme error and the percent decoding are the same,
  // but a HOST must not throw here. Node assumed a host can only name a machine and that
  // any other one was our own bug (`"file://" + relativeId`, see fileMetaPath in esm.js).
  // Neither holds in a browser: Chromium on Windows parses `"file:" + __filename` into
  // `file://home/user/x` (url/url_parse_file.cc's WIN32 branch), and this VFS has no
  // file hosts, so the promoted segment goes back in front of the pathname. That module
  // is the one copy every caller in this runtime shares — do not re-derive it here.
  function fileURLToPath(url) {
    return recoverFilePath(url);
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
    // loader relies on. Match Node: resolve, then let ../../file-url.js encode it
    // (three slashes, and a literal `%` escaped so fileURLToPath round-trips the name).
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
      return buildFileUrl(resolved);
    },
  };
}
