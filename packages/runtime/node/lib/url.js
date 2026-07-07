// Public `url` builtin. Node's real lib/url.js carries the whole legacy parser
// bound to native IDNA/ada. The browser already ships a spec-compliant global
// URL, so we forward the WHATWG surface and implement the legacy
// parse/format/resolve API that userland (parseurl, express, send, …) still
// relies on, in terms of URL where possible plus a manual fast path for the
// origin-relative request targets ("/foo?bar=1") HTTP servers actually see.

export default function (exports, require, module) {
  const internalUrl = require("internal/url");
  const URL = globalThis.URL;
  const URLSearchParams = globalThis.URLSearchParams;

  function parseQueryToObject(search) {
    const obj = {};
    if (!search) return obj;
    const sp = new URLSearchParams(search[0] === "?" ? search.slice(1) : search);
    for (const key of sp.keys()) {
      const all = sp.getAll(key);
      obj[key] = all.length > 1 ? all : all[0];
    }
    return obj;
  }

  // Legacy url.parse — returns the Node "Url" shape. Handles origin-relative
  // targets manually (WHATWG URL rejects them without a base) and delegates
  // absolute URLs to the platform parser.
  function parse(urlStr, parseQueryString = false, slashesDenoteHost = false) {
    if (urlStr && typeof urlStr === "object") return urlStr;
    const str = String(urlStr);

    // Origin-relative (starts with '/') or bare path: no host/protocol.
    const isAbsolute = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(str) || (slashesDenoteHost && str.startsWith("//"));
    if (!isAbsolute) {
      let pathname = str;
      let search = null;
      let hash = null;
      const hashIdx = str.indexOf("#");
      if (hashIdx !== -1) { hash = str.slice(hashIdx); pathname = str.slice(0, hashIdx); }
      const qIdx = pathname.indexOf("?");
      if (qIdx !== -1) { search = pathname.slice(qIdx); pathname = pathname.slice(0, qIdx); }
      const query = parseQueryString ? parseQueryToObject(search) : search ? search.slice(1) : null;
      return {
        protocol: null, slashes: null, auth: null, host: null, port: null, hostname: null,
        hash, search, query, pathname: pathname || null,
        path: `${pathname || ""}${search || ""}` || null,
        href: str,
      };
    }

    const u = new URL(str);
    const search = u.search || null;
    const query = parseQueryString ? parseQueryToObject(search) : search ? search.slice(1) : null;
    return {
      protocol: u.protocol,
      slashes: str.includes("//"),
      auth: u.username ? `${u.username}${u.password ? ":" + u.password : ""}` : null,
      host: u.host || null,
      port: u.port || null,
      hostname: u.hostname || null,
      hash: u.hash || null,
      search,
      query,
      pathname: u.pathname || null,
      path: `${u.pathname || ""}${search || ""}` || null,
      href: u.href,
    };
  }

  function format(urlObj) {
    if (typeof urlObj === "string") return urlObj;
    if (urlObj instanceof URL) return urlObj.href;
    if (urlObj && typeof urlObj.href === "string" && urlObj.protocol) return urlObj.href;

    let out = "";
    if (urlObj.protocol) out += urlObj.protocol.endsWith(":") ? urlObj.protocol : urlObj.protocol + ":";
    if (urlObj.slashes || urlObj.host || urlObj.hostname) out += "//";
    if (urlObj.auth) out += urlObj.auth + "@";
    if (urlObj.host) out += urlObj.host;
    else if (urlObj.hostname) out += urlObj.hostname + (urlObj.port ? ":" + urlObj.port : "");
    if (urlObj.pathname) out += urlObj.pathname;
    let search = urlObj.search;
    if (!search && urlObj.query) {
      search = typeof urlObj.query === "string" ? "?" + urlObj.query : "?" + new URLSearchParams(urlObj.query).toString();
    }
    if (search) out += search[0] === "?" ? search : "?" + search;
    if (urlObj.hash) out += urlObj.hash[0] === "#" ? urlObj.hash : "#" + urlObj.hash;
    return out;
  }

  function resolve(from, to) {
    try {
      return new URL(to, from).href;
    } catch {
      return to;
    }
  }

  module.exports = {
    parse,
    format,
    resolve,
    URL,
    URLSearchParams,
    domainToASCII: (d) => { try { return new URL("http://" + d).hostname; } catch { return ""; } },
    domainToUnicode: (d) => d,
    fileURLToPath: internalUrl.fileURLToPath,
    pathToFileURL: internalUrl.pathToFileURL,
    urlToHttpOptions: internalUrl.urlToHttpOptions,
    // Url/Url.prototype are intentionally omitted: parseurl treats an absent
    // `url.Url` as "use a plain object", which is exactly what we want.
  };
}
