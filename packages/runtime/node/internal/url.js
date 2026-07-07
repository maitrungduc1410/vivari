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
  function fileURLToPath(url) {
    const u = typeof url === "string" ? new URL(url) : url;
    const pathname = decodeURIComponent(u.pathname);
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
    URLSearchParams,
    isURL,
    urlToHttpOptions,
    fileURLToPath,
    toPathIfFileURL,
    pathToFileURL: (p) => new URL("file://" + p),
  };
}
