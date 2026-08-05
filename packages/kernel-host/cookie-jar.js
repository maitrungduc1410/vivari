// A cookie jar for in-VM servers, because the browser will not keep one for them.
//
// On a real machine the client stores cookies. Here the "client" is a preview
// iframe whose requests are intercepted by a Service Worker and answered from a
// server that exists only in memory, and that seam drops cookies in BOTH
// directions:
//
//   • Response: a `Set-Cookie` on a Response the SW synthesises never reaches
//     the browser's cookie store — the store is filled by network fetches, and
//     this response never touched the network.
//   • Request: the browser appends `Cookie` in the network step, which is AFTER
//     the Service Worker, so the SW cannot read it and cannot forward it.
//
// So `express-session`, Passport, a CSRF cookie, "remember me" — every ordinary
// session flow — issued a cookie into a void and never saw it again. Login
// returned 200, the next request arrived with no `Cookie` header at all, and the
// app answered 401 while looking entirely correct from the outside.
//
// The jar therefore lives on this side of the seam, in the kernel, one per
// listening port. Per port because that is what the platform emulates: on a real
// machine `localhost:3000` and `localhost:5173` are separate origins with
// separate jars, and sharing one jar between them would leak a session from an
// API to a frontend.
//
// What is deliberately NOT implemented, since the jar's only client is a single
// in-VM host: `Domain` (there is one host, so a domain attribute can only ever
// match it — it is parsed and ignored), `Secure` (the guest is reached over a
// message channel, not a scheme, so honouring it would drop cookies for no
// security gain), and `SameSite`/`Partitioned` (there is no cross-site request
// to distinguish). `HttpOnly` is parsed and ignored too, and that one is honest
// rather than lazy: the flag exists to hide a cookie from page JavaScript, and
// nothing in this jar is reachable from page JavaScript.

/**
 * RFC 6265 §5.1.4 default-path: the directory of the request path. A cookie set
 * by `POST /api/login` with no `Path` must NOT be sent to `/`, which is what a
 * naive "default to /" would do — it would hand an API's session to every other
 * route on the port.
 */
export function defaultPath(requestPath) {
  const path = String(requestPath || "");
  if (!path.startsWith("/")) return "/";
  const lastSlash = path.lastIndexOf("/");
  if (lastSlash === 0) return "/";
  return path.slice(0, lastSlash);
}

/**
 * RFC 6265 §5.1.4 path-match. The boundary conditions are the point: `/foo` must
 * match `/foo` and `/foo/bar` but NOT `/foobar`, which a plain `startsWith`
 * would happily accept and leak a cookie to a neighbouring route.
 */
export function pathMatches(cookiePath, requestPath) {
  const cp = cookiePath || "/";
  const rp = requestPath || "/";
  if (cp === rp) return true;
  if (!rp.startsWith(cp)) return false;
  return cp.endsWith("/") || rp[cp.length] === "/";
}

/**
 * Parse one `Set-Cookie` line. Returns null for anything unusable — a malformed
 * header from a guest is the guest's business and must not throw in the kernel.
 *
 * `expiresAt` is null for a session cookie (no `Max-Age`, no `Expires`), which
 * this jar keeps for as long as the kernel lives; that is the closest analogue
 * of "until the browser closes" available here.
 */
export function parseSetCookie(line, requestPath = "/") {
  if (typeof line !== "string") return null;
  const parts = line.split(";");
  const first = parts[0] || "";
  const eq = first.indexOf("=");
  // A cookie with no `=` is discarded rather than guessed at (RFC 6265 §5.2).
  if (eq < 1) return null;
  const name = first.slice(0, eq).trim();
  const value = first.slice(eq + 1).trim();
  if (!name) return null;

  const out = {
    name,
    value,
    path: null,
    domain: null,
    expiresAt: null,
    httpOnly: false,
    // A delete is a normal Set-Cookie, not a separate operation: servers expire a
    // cookie to remove it, and `res.clearCookie()` sends exactly this.
    expired: false,
  };

  for (let i = 1; i < parts.length; i++) {
    const attr = parts[i];
    const j = attr.indexOf("=");
    const key = (j === -1 ? attr : attr.slice(0, j)).trim().toLowerCase();
    const val = j === -1 ? "" : attr.slice(j + 1).trim();
    if (key === "path") {
      out.path = val.startsWith("/") ? val : null;
    } else if (key === "domain") {
      out.domain = val.replace(/^\./, "").toLowerCase() || null;
    } else if (key === "httponly") {
      out.httpOnly = true;
    } else if (key === "max-age") {
      // Max-Age wins over Expires (RFC 6265 §5.3 step 3), and a non-numeric
      // Max-Age is ignored rather than treated as 0 — treating it as 0 would
      // delete a cookie the server meant to keep.
      const secs = Number(val);
      if (Number.isFinite(secs)) {
        out.maxAgeSeconds = secs;
      }
    } else if (key === "expires") {
      const t = Date.parse(val);
      if (Number.isFinite(t)) out.expiresAbs = t;
    }
  }

  return out;
}

/** Resolve the parsed attributes into a concrete lifetime at `now`. */
function applyLifetime(c, now) {
  if (c.maxAgeSeconds !== undefined) {
    if (c.maxAgeSeconds <= 0) c.expired = true;
    else c.expiresAt = now + c.maxAgeSeconds * 1000;
  } else if (c.expiresAbs !== undefined) {
    if (c.expiresAbs <= now) c.expired = true;
    else c.expiresAt = c.expiresAbs;
  }
  delete c.maxAgeSeconds;
  delete c.expiresAbs;
  return c;
}

// Bounds, for the same reason browsers have them: a jar with none is a guest
// setting cookies in a loop and a `header()` that walks every one of them on
// every request. The numbers follow the browsers rather than RFC 6265's much
// lower "at least 50" floor, so nothing an app does on a real machine hits these
// first here.
export const MAX_COOKIE_BYTES = 4096; // name + value, as Chrome and Firefox cap it
export const MAX_COOKIES = 180; // per jar, i.e. per port

/**
 * One jar. A cookie's identity is (name, path) — NOT name alone: a server may
 * legitimately hold `sid` for `/admin` and a different `sid` for `/`, and
 * collapsing them would have one silently overwrite the other.
 *
 * A jar outlives the process that filled it, deliberately: restart a dev server
 * on the same port and a real browser still holds its cookies, so clearing on
 * exit would log the user out on every reload of their own code.
 */
export class CookieJar {
  constructor() {
    this.cookies = new Map(); // `${name}\u0000${path}` -> cookie
    this.seq = 0;
  }

  get size() {
    return this.cookies.size;
  }

  clear() {
    this.cookies.clear();
  }

  /**
   * Harvest the `Set-Cookie` header(s) of a response. Accepts what Node gives:
   * an array (Node keeps `set-cookie` as one, unlike every other header), a
   * single string, or nothing.
   */
  store(setCookie, requestPath = "/", now = Date.now()) {
    if (setCookie == null) return 0;
    const lines = Array.isArray(setCookie) ? setCookie : [setCookie];
    let n = 0;
    for (const line of lines) {
      const parsed = parseSetCookie(line, requestPath);
      if (!parsed) continue;
      applyLifetime(parsed, now);
      if (parsed.path == null) parsed.path = defaultPath(requestPath);
      const key = `${parsed.name}\u0000${parsed.path}`;
      if (parsed.expired) {
        this.cookies.delete(key);
        continue;
      }
      // Oversized cookies are dropped rather than truncated: half a signed
      // session id verifies as nothing, so a silent truncation would look like a
      // corrupt session instead of a refused one.
      if (parsed.name.length + parsed.value.length > MAX_COOKIE_BYTES) continue;
      // Re-setting a cookie keeps its original creation order (RFC 6265 §5.3
      // step 11), which is what decides ties in the Cookie header below.
      const prev = this.cookies.get(key);
      parsed.seq = prev ? prev.seq : this.seq++;
      this.cookies.set(key, parsed);
      // Evict the oldest, which is what browsers do when a domain is over its
      // limit. The cookie just set is never the victim.
      while (this.cookies.size > MAX_COOKIES) {
        let oldestKey = null;
        let oldestSeq = Infinity;
        for (const [k, c] of this.cookies) {
          if (c.seq < oldestSeq) {
            oldestSeq = c.seq;
            oldestKey = k;
          }
        }
        if (oldestKey == null || oldestKey === key) break;
        this.cookies.delete(oldestKey);
      }
      n++;
    }
    return n;
  }

  /**
   * The `Cookie` header value for a request to `requestPath`, or "" when nothing
   * matches. Ordering follows RFC 6265 §5.4: longer paths first, then oldest
   * first — some servers read only the first occurrence of a name, so the order
   * is part of the contract, not cosmetic.
   */
  header(requestPath = "/", now = Date.now()) {
    const path = String(requestPath || "/").split("?")[0] || "/";
    const out = [];
    for (const [key, c] of this.cookies) {
      if (c.expiresAt != null && c.expiresAt <= now) {
        this.cookies.delete(key);
        continue;
      }
      if (!pathMatches(c.path, path)) continue;
      out.push(c);
    }
    out.sort((a, b) => b.path.length - a.path.length || a.seq - b.seq);
    return out.map((c) => `${c.name}=${c.value}`).join("; ");
  }
}
