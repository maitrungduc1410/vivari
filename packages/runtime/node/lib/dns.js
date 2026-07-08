// A loopback-aware `dns` shim. There is no real resolver in the browser, and
// OpenContainer's virtual network is in-process loopback only, so every name
// resolves to loopback (127.0.0.1 / ::1). This is exactly what the vendored
// lib/net.js needs: it does `require('dns')` and calls `dns.lookup(host, ...)`
// when you connect/listen by hostname (e.g. 'localhost'), so wiring this in
// makes `net.connect(port, 'localhost')` and hostname-based listen work.
//
// `resolve*` return loopback for localhost/IPs and ENOTFOUND otherwise (we have
// no way to answer real queries). Both callback and promise APIs are provided.

export default function (exports, require, module, process, internalBinding, primordials) {
  const isIPv4 = (s) =>
    /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(s) && s.split(".").every((o) => +o <= 255);
  const isIPv6 = (s) => typeof s === "string" && s.includes(":");
  const isIP = (s) => (isIPv4(s) ? 4 : isIPv6(s) ? 6 : 0);
  const isLoopbackName = (h) => h === "localhost" || h.endsWith(".localhost");

  function dnsError(hostname, syscall, code = "ENOTFOUND") {
    const err = new Error(`${syscall} ${code} ${hostname}`);
    err.code = code;
    err.errno = code;
    err.syscall = syscall;
    err.hostname = hostname;
    return err;
  }

  function lookup(hostname, options, callback) {
    if (typeof options === "function") {
      callback = options;
      options = {};
    }
    if (typeof options === "number") options = { family: options };
    options = options || {};
    const family = options.family || 0;
    const all = !!options.all;
    const host = hostname || "localhost";

    let address;
    let addrFamily;
    const ipType = isIP(host);
    if (ipType) {
      address = host;
      addrFamily = ipType;
    } else {
      // loopback-only virtual net: any resolvable name -> loopback.
      addrFamily = family === 6 ? 6 : 4;
      address = addrFamily === 6 ? "::1" : "127.0.0.1";
    }
    // honor an explicit family request
    if (family === 4 && addrFamily !== 4) {
      address = "127.0.0.1";
      addrFamily = 4;
    } else if (family === 6 && addrFamily !== 6) {
      address = "::1";
      addrFamily = 6;
    }

    process.nextTick(() => {
      if (all) callback(null, [{ address, family: addrFamily }]);
      else callback(null, address, addrFamily);
    });
  }

  const loopbackResolve = (family) => (hostname, options, callback) => {
    if (typeof options === "function") {
      callback = options;
      options = {};
    }
    const host = hostname || "";
    const ok = isLoopbackName(host) || isIP(host) === family;
    process.nextTick(() => {
      if (ok) callback(null, [family === 6 ? "::1" : "127.0.0.1"]);
      else callback(dnsError(host, family === 6 ? "queryAaaa" : "queryA"));
    });
  };

  const resolve4 = loopbackResolve(4);
  const resolve6 = loopbackResolve(6);
  function resolve(hostname, rrtype, callback) {
    if (typeof rrtype === "function") {
      callback = rrtype;
      rrtype = "A";
    }
    if (rrtype === "AAAA") return resolve6(hostname, callback);
    return resolve4(hostname, callback);
  }
  function reverse(ip, callback) {
    const loop = ip === "127.0.0.1" || ip === "::1" || ip === "0.0.0.0";
    process.nextTick(() => {
      if (loop) callback(null, ["localhost"]);
      else callback(dnsError(ip, "getHostByAddr"));
    });
  }
  const unsupportedResolve = (syscall) =>
    function (hostname, callback) {
      const cb = typeof callback === "function" ? callback : arguments[arguments.length - 1];
      process.nextTick(() => cb(dnsError(hostname, syscall, "ENODATA")));
    };

  function getServers() {
    return [];
  }
  function setServers() {}
  function setDefaultResultOrder() {}
  function getDefaultResultOrder() {
    return "verbatim";
  }

  const promisify = (fn) => (hostname, options) =>
    new Promise((resolve2, reject) => {
      fn(hostname, options, (err, ...rest) => (err ? reject(err) : resolve2(rest.length > 1 ? rest : rest[0])));
    });

  function lookupPromise(hostname, options) {
    return new Promise((resolve2, reject) => {
      lookup(hostname, options, (err, address, family) => {
        if (err) return reject(err);
        if (options && options.all) return resolve2(address);
        resolve2({ address, family });
      });
    });
  }

  const promises = {
    lookup: lookupPromise,
    resolve: promisify(resolve),
    resolve4: promisify(resolve4),
    resolve6: promisify(resolve6),
    reverse: (ip) => new Promise((res, rej) => reverse(ip, (e, v) => (e ? rej(e) : res(v)))),
    getServers,
    setServers,
    setDefaultResultOrder,
    getDefaultResultOrder,
  };

  module.exports = {
    lookup,
    lookupService: (address, port, cb) => process.nextTick(() => cb(null, "localhost", String(port))),
    resolve,
    resolve4,
    resolve6,
    resolveAny: unsupportedResolve("queryAny"),
    resolveCname: unsupportedResolve("queryCname"),
    resolveMx: unsupportedResolve("queryMx"),
    resolveNs: unsupportedResolve("queryNs"),
    resolveTxt: unsupportedResolve("queryTxt"),
    resolveSrv: unsupportedResolve("querySrv"),
    resolvePtr: unsupportedResolve("queryPtr"),
    resolveNaptr: unsupportedResolve("queryNaptr"),
    resolveSoa: unsupportedResolve("querySoa"),
    resolveCaa: unsupportedResolve("queryCaa"),
    reverse,
    getServers,
    setServers,
    setDefaultResultOrder,
    getDefaultResultOrder,
    promises,
    // hint/rrtype constants (values mirror Node; our lookup ignores hints).
    ADDRCONFIG: 32,
    V4MAPPED: 8,
    ALL: 16,
    NODATA: "ENODATA",
    FORMERR: "EFORMERR",
    SERVFAIL: "ESERVFAIL",
    NOTFOUND: "ENOTFOUND",
    NOTIMP: "ENOTIMP",
    REFUSED: "EREFUSED",
    BADQUERY: "EBADQUERY",
    BADNAME: "EBADNAME",
    BADFAMILY: "EBADFAMILY",
    BADRESP: "EBADRESP",
    CONNREFUSED: "ECONNREFUSED",
    TIMEOUT: "ETIMEOUT",
    EOF: "EOF",
    FILE: "EFILE",
    NOMEM: "ENOMEM",
    DESTRUCTION: "EDESTRUCTION",
    BADSTR: "EBADSTR",
    BADFLAGS: "EBADFLAGS",
    NONAME: "ENONAME",
    BADHINTS: "EBADHINTS",
    NOTINITIALIZED: "ENOTINITIALIZED",
    LOADIPHLPAPI: "ELOADIPHLPAPI",
    ADDRGETNETWORKPARAMS: "EADDRGETNETWORKPARAMS",
    CANCELLED: "ECANCELLED",
  };

  // dns.Resolver: a minimal class form some libs instantiate.
  class Resolver {
    constructor() {}
    getServers() {
      return [];
    }
    setServers() {}
    cancel() {}
  }
  for (const m of ["resolve", "resolve4", "resolve6", "reverse"]) Resolver.prototype[m] = module.exports[m];
  module.exports.Resolver = Resolver;
  module.exports.promises.Resolver = Resolver;
}
