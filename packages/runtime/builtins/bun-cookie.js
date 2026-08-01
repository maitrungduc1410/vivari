// Bun.Cookie / Bun.CookieMap — cookie parsing, serialisation and the Bun.serve
// request/response hook.
//
// Hand-rolled rather than vendored, for the same reason as bun-glob.js: the npm
// cookie libraries (`cookie`, `set-cookie-parser`, `tough-cookie`) each make a
// defensible choice at every point where Bun made a *different* defensible
// choice, and every one of those points changes the scope, lifetime or content
// of a cookie a browser actually stores. A cookie written with the wrong scope
// is not a crash; it is a session that silently does not come back. The five
// that matter, all verified against Bun's own implementation
// (src/jsc/bindings/Cookie.cpp + CookieMap.cpp) and its test suite:
//
//   1. Defaults are `path: "/"` and `sameSite: "lax"`, and BOTH are always
//      emitted — `new Cookie("a","b").toString()` is `a=b; Path=/; SameSite=Lax`,
//      not `a=b`. The npm `cookie` package emits neither unless asked. A shim
//      that omits Path writes a cookie scoped to the *request directory*
//      (`/admin/login` rather than `/`), which reads back on the page that set it
//      and vanishes everywhere else — the single hardest cookie bug to see.
//      Bun emits `SameSite=Lax` explicitly even though it is the browser default,
//      deliberately (see the blink-dev thread linked in Cookie.cpp).
//   2. RFC 6265 §5.3: `Max-Age` beats `Expires` when both are present, and that
//      precedence is about the computed expiry, NOT about which attribute is
//      kept. Both are parsed, both are re-serialised, and the result does not
//      depend on the order they appeared in the header. `isExpired()` consults
//      Max-Age first and only falls back to Expires when Max-Age is absent; a
//      non-positive Max-Age is expired *now* (that is the delete signal).
//   3. Values are percent-encoded on the way OUT and NOT decoded on the way IN.
//      `serialize()` runs the value through encodeURIComponent (so `;`, `=`,
//      spaces and non-ASCII survive a round trip through a header), but
//      `Cookie.parse()` hands back the raw attribute text. The asymmetry is
//      Bun's, not ours, and it is load-bearing: `Cookie.parse("a=%20").value` is
//      the four characters `%20`. Reproduced exactly, and pinned.
//   4. A `Cookie:` request header is parsed by a *different* rule than a
//      `Set-Cookie` string, and that rule is odd enough that it has to be copied
//      rather than reasoned about: CookieMap percent-decodes the values only when
//      the header contains a `%` ANYWHERE, and never decodes the names. Not
//      decoding names is a security property — a cookie literally called
//      `__%48ost-session` must not be allowed to answer to `__Host-session`,
//      because browsers enforce the `__Host-`/`__Secure-` prefix rules on the
//      literal name.
//   5. `sameSite: "none"` does NOT imply `Secure` in Bun, and we do not add it
//      either. See the note on SAME_SITE_NONE below for what that means in a
//      sandbox.
//
// Everything here is pure string/date computation with no fs, no kernel and no
// clock other than Date.now(), so scripts/spike-bun-offline.mjs covers it
// essentially completely — which matters, because that is the tier CI enforces
// on every PR.

// ---- validation --------------------------------------------------------------
// Transcribed from Cookie.cpp's isValidCookieName/Path/Domain. They are character
// allow-lists, not "looks reasonable" heuristics, and the exclusions are the
// point: a name may not contain `;`, `=`, a space or a control character, because
// each of those lets a caller inject a second attribute (or a second cookie) into
// a header we are about to write. Throwing is the only safe answer — silently
// stripping the character would hand back a cookie under a name the caller never
// asked for.
const VALID_NAME = /^[\u0021-\u003A\u003C\u003E-\u007E]+$/; // no space, `;`, `=`, DEL+
const VALID_PATH = /^[\u0020-\u003A\u003D-\u007E]*$/; // no `;`, `<`, controls
const VALID_DOMAIN = /^[a-z0-9.-]*$/; // Bun's current (deliberately crude) rule

// WebCore's isValidHTTPHeaderValue, which gates the string forms of the Cookie
// constructor and Cookie.parse. Note this rejects non-ASCII: `new Cookie("b=café")`
// throws under real Bun. Values only become header-safe once encodeURIComponent
// has run over them, which happens on serialize(), not on parse().
const isValidHeaderValue = (s) =>
  /^[\t\u0020-\u007e]*$/.test(s) && !/^[ \t]/.test(s) && !/[ \t]$/.test(s);

const INVALID_NAME = "Invalid cookie name: contains invalid characters";
const INVALID_PATH = "Invalid cookie path: contains invalid characters";
const INVALID_DOMAIN = "Invalid cookie domain: contains invalid characters";

// `sameSite: "none"` asks the browser to send the cookie on cross-site requests,
// and every current browser refuses to store such a cookie unless it also carries
// `Secure` (RFC 6265bis §4.1.2.7). Bun does NOT enforce that: it serialises
// exactly what you asked for and lets the browser reject it. We match Bun rather
// than "helpfully" adding Secure, because adding an attribute the caller did not
// write is precisely the class of silent divergence this shim exists to avoid —
// the cookie would then behave differently here than under Bun, and the caller
// would never see the attribute in their own code.
//
// The sandbox angle: a `Secure` cookie needs a secure context, and Vivari always
// has one. Cross-origin isolation (COOP/COEP) is mandatory for SharedArrayBuffer,
// which means the studio is only ever served over https or from localhost, and
// the Service-Worker preview inherits that origin. So `secure: true` is usable in
// a preview; it is `sameSite: "none"` WITHOUT it that a browser will drop, exactly
// as it would under real Bun.
const SAME_SITE_NONE = "none";

const SAME_SITE_LABEL = { strict: "Strict", lax: "Lax", none: "None" };

// ---- percent-coding ----------------------------------------------------------
// Bun encodes cookie values with encodeURIComponent on serialize. Decoding is
// lenient by comparison (Bun uses a SIMD decoder that leaves malformed input
// alone), so decode only well-formed `%XX` runs and hand back anything else
// untouched. Decoding run-by-run rather than whole-string also keeps a value that
// mixes raw UTF-8 with escapes ("café%20au%20lait") intact, which a bare
// decodeURIComponent over the whole string would still manage but a stricter
// implementation would not.
const decodePercentRuns = (s) =>
  s.replace(/(?:%[0-9a-fA-F]{2})+/g, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });

// ---- Cookie ------------------------------------------------------------------

// Internal marker for "this cookie has no Expires attribute". Bun uses INT64_MIN;
// null is the JS-shaped equivalent, and is distinct from `new Date(0)`, which is a
// real (already-past) expiry that must serialise as the epoch.
const NO_EXPIRY = null;

function coerceExpires(value) {
  if (value === undefined || value === null) return NO_EXPIRY;
  if (value instanceof Date) {
    const ms = value.getTime();
    if (!Number.isFinite(ms)) throw new RangeError("expires must be a valid Date (or Number)");
    return ms;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new RangeError("expires must be a valid Number (or Date)");
    // A bare number is SECONDS since the epoch, not milliseconds — the same unit
    // as Max-Age and as the `Expires` field of most cookie libraries' options.
    // Negative is allowed on purpose: it is how people force an expiry.
    return value * 1000;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isNaN(parsed)) throw new TypeError("Invalid cookie expiration date");
    return parsed;
  }
  throw new TypeError("Invalid expires value. Must be a Date or a number");
}

function coerceSameSite(value) {
  // Deliberately case-SENSITIVE, matching Bun: the init object takes the
  // lowercase spellings only (`sameSite: "Strict"` throws), while the attribute
  // in a Set-Cookie string is matched case-insensitively. Two different inputs,
  // two different rules, both reproduced.
  if (value === "strict" || value === "lax" || value === "none") return value;
  throw new TypeError("Invalid sameSite value. Must be 'strict', 'lax', or 'none'");
}

// The one internal constructor. Every public entry point (the three constructor
// overloads, Cookie.parse, Cookie.from, CookieMap.set/delete) funnels through
// here so the defaults and the validation cannot drift apart.
function makeCookie(fields) {
  const c = Object.create(Cookie.prototype);
  c._name = fields.name;
  c._value = fields.value;
  c._domain = fields.domain || "";
  c._path = fields.path === undefined ? "/" : fields.path;
  c._expires = fields.expires === undefined ? NO_EXPIRY : fields.expires;
  c._maxAge = fields.maxAge === undefined ? NO_EXPIRY : fields.maxAge;
  c._secure = !!fields.secure;
  c._sameSite = fields.sameSite || "lax";
  c._httpOnly = !!fields.httpOnly;
  c._partitioned = !!fields.partitioned;
  if (!VALID_NAME.test(c._name)) throw new TypeError(INVALID_NAME);
  if (!VALID_PATH.test(c._path)) throw new TypeError(INVALID_PATH);
  if (!VALID_DOMAIN.test(c._domain)) throw new TypeError(INVALID_DOMAIN);
  return c;
}

// Read a CookieInit object into the field bag makeCookie wants. `name`/`value`
// come from the positional arguments when there are any; the object may still
// override them in the single-argument form.
function fieldsFromInit(init, name, value) {
  const f = { name, value, path: "/", sameSite: "lax" };
  if (init === undefined || init === null) return f;
  if (typeof init !== "object") throw new TypeError("Options must be an object");
  if (name === undefined) {
    if (init.name !== undefined) f.name = String(init.name);
    if (!f.name) throw new TypeError("name is required");
    f.value = init.value === undefined ? "" : String(init.value);
  }
  if (init.domain !== undefined && init.domain !== null) f.domain = String(init.domain);
  if (init.path !== undefined && init.path !== null) f.path = String(init.path);
  if (init.expires !== undefined) f.expires = coerceExpires(init.expires);
  // Bun only honours a numeric maxAge; `maxAge: "3600"` is ignored rather than
  // coerced, so a stringly-typed caller gets a session cookie both here and there.
  if (typeof init.maxAge === "number") f.maxAge = init.maxAge;
  if (init.secure !== undefined) f.secure = !!init.secure;
  if (init.httpOnly !== undefined) f.httpOnly = !!init.httpOnly;
  if (init.partitioned !== undefined) f.partitioned = !!init.partitioned;
  if (init.sameSite !== undefined && init.sameSite !== null) f.sameSite = coerceSameSite(String(init.sameSite));
  return f;
}

// Parse one Set-Cookie-shaped string. Exported because it is the pure core of
// Cookie.parse and the offline spike drives it directly.
export function parseSetCookie(cookieString) {
  const str = String(cookieString);
  const firstSemi = str.indexOf(";");
  const pair = firstSemi === -1 ? str : str.slice(0, firstSemi);
  const eq = pair.indexOf("=");
  if (str.length < 2) throw new TypeError("Invalid cookie string: empty");
  if (eq === -1) throw new TypeError("Invalid cookie string: no '=' found");
  const name = pair.slice(0, eq).trim();
  if (!name) throw new TypeError("Invalid cookie string: name cannot be empty");

  const fields = {
    name,
    // NOT decoded. See point 3 in the header.
    value: pair.slice(eq + 1).trim(),
    path: "/",
    sameSite: "lax",
  };

  if (firstSemi !== -1) {
    for (const raw of str.slice(firstSemi + 1).split(";")) {
      const attr = raw.trim();
      if (!attr) continue;
      const assign = attr.indexOf("=");
      const key = (assign === -1 ? attr : attr.slice(0, assign)).trim().toLowerCase();
      const val = assign === -1 ? "" : attr.slice(assign + 1).trim();
      // RFC 6265 §5.2: every attribute is recorded independently and the LAST
      // occurrence wins. Max-Age's precedence over Expires (§5.3) is about the
      // computed expiry — applied in isExpired() — so it must not drop Expires
      // here, and the result must not depend on attribute order.
      if (key === "domain") {
        if (val) fields.domain = val.toLowerCase();
      } else if (key === "path") {
        // A Path that does not start with `/` is ignored, leaving the default.
        if (val && val[0] === "/") fields.path = val;
      } else if (key === "expires") {
        if (val) {
          const ms = Date.parse(val);
          if (Number.isFinite(ms)) fields.expires = ms;
        }
      } else if (key === "max-age") {
        // parseInt, not Number: Bun allows trailing junk ("60abc" is 60).
        const n = parseInt(val, 10);
        if (Number.isFinite(n)) fields.maxAge = n;
      } else if (key === "secure") {
        fields.secure = true;
      } else if (key === "httponly") {
        fields.httpOnly = true;
      } else if (key === "partitioned") {
        fields.partitioned = true;
      } else if (key === "samesite") {
        const lowered = val.toLowerCase();
        // Case-INSENSITIVE here (unlike the init object), and an unrecognised
        // value leaves the default rather than throwing — a header we did not
        // write is not the caller's bug to fix.
        if (lowered === "strict" || lowered === "lax" || lowered === "none") fields.sameSite = lowered;
      }
    }
  }
  return makeCookie(fields);
}

// Split a `Cookie:` REQUEST header into name/value pairs. A different grammar
// from parseSetCookie above (no attributes, many cookies), and a different
// encoding rule — see point 4 in the header. Exported for the offline spike.
export function parseCookieHeader(header) {
  const str = header == null ? "" : String(header);
  if (!str) return [];
  // Bun decides once, for the whole header, whether to percent-decode values.
  const anyPercent = str.indexOf("%") !== -1;
  const pairs = [];
  for (const part of str.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue; // an attribute-shaped fragment is skipped, not guessed at
    const name = part.slice(0, eq).trim();
    if (!name) continue;
    const value = part.slice(eq + 1).trim();
    // Names are never decoded: `__%48ost-session` must not answer to
    // `__Host-session`, because browsers apply the `__Host-` prefix rules to the
    // literal name and an alias would let an unprotected cookie shadow a
    // protected one.
    pairs.push([name, anyPercent ? decodePercentRuns(value) : value]);
  }
  return pairs;
}

export class Cookie {
  constructor(nameOrStringOrInit, value, options) {
    const argc = arguments.length;
    let fields;
    if (argc >= 2) {
      const name = String(nameOrStringOrInit);
      if (!name) throw new TypeError("name is required");
      fields = fieldsFromInit(argc > 2 ? options : undefined, name, String(value));
    } else if (argc === 1 && typeof nameOrStringOrInit === "string") {
      if (!isValidHeaderValue(nameOrStringOrInit)) {
        throw new TypeError("cookie string is not a valid HTTP header value");
      }
      const parsed = parseSetCookie(nameOrStringOrInit);
      // Adopt the parsed cookie's state; `this` is what the caller gets back.
      Object.assign(this, parsed);
      return;
    } else if (argc === 1 && nameOrStringOrInit && typeof nameOrStringOrInit === "object") {
      fields = fieldsFromInit(nameOrStringOrInit, undefined, undefined);
    } else {
      throw new TypeError("Not enough arguments");
    }
    Object.assign(this, makeCookie(fields));
  }

  // `name` is read-only, and assigning to it is silently ignored rather than
  // throwing — that is what Bun does (its binding declares a getter-only custom
  // accessor whose put is a no-op), and a strict-mode module assigning to a
  // getter-only property would otherwise throw here and not there.
  get name() {
    return this._name;
  }
  set name(_v) {}

  get value() {
    return this._value;
  }
  set value(v) {
    this._value = String(v);
  }

  // null, not undefined, when unset: `expect(cookie.domain).toBeNull()`.
  get domain() {
    return this._domain || null;
  }
  set domain(v) {
    const d = v == null ? "" : String(v);
    if (!VALID_DOMAIN.test(d)) throw new TypeError(INVALID_DOMAIN);
    this._domain = d;
  }

  get path() {
    return this._path;
  }
  set path(v) {
    const p = v == null ? "" : String(v);
    if (!VALID_PATH.test(p)) throw new TypeError(INVALID_PATH);
    this._path = p;
  }

  get expires() {
    return this._expires === NO_EXPIRY ? undefined : new Date(this._expires);
  }
  set expires(v) {
    this._expires = coerceExpires(v);
  }

  get maxAge() {
    return this._maxAge === NO_EXPIRY ? undefined : this._maxAge;
  }
  set maxAge(v) {
    this._maxAge = typeof v === "number" ? v : NO_EXPIRY;
  }

  get secure() {
    return this._secure;
  }
  set secure(v) {
    this._secure = !!v;
  }

  get httpOnly() {
    return this._httpOnly;
  }
  set httpOnly(v) {
    this._httpOnly = !!v;
  }

  get partitioned() {
    return this._partitioned;
  }
  set partitioned(v) {
    this._partitioned = !!v;
  }

  get sameSite() {
    return this._sameSite;
  }
  set sameSite(v) {
    this._sameSite = coerceSameSite(String(v));
  }

  // RFC 6265 §5.3, and the reason this method exists rather than being inlined
  // at each call site: Max-Age wins over Expires whenever it is present, so a
  // cookie carrying `Max-Age=3600` alongside an Expires from 2015 is NOT expired.
  // A non-positive Max-Age is expired immediately — `maxAge: 0` is how you delete.
  isExpired() {
    if (this._maxAge !== NO_EXPIRY) return this._maxAge <= 0;
    if (this._expires === NO_EXPIRY) return false; // session cookie
    return Date.now() > this._expires;
  }

  // Attribute order is Bun's, byte for byte, because Set-Cookie strings end up in
  // snapshot tests and in HTTP fixtures on both sides of the sandbox boundary.
  serialize() {
    let out = this._name + "=" + encodeURIComponent(this._value);
    if (this._domain) out += "; Domain=" + this._domain;
    if (this._path) out += "; Path=" + this._path;
    // toUTCString() is an IMF-fixdate ("Thu, 01 Jan 1970 00:00:00 GMT"), which is
    // exactly the format RFC 6265 asks for.
    if (this._expires !== NO_EXPIRY) out += "; Expires=" + new Date(this._expires).toUTCString();
    if (this._maxAge !== NO_EXPIRY) out += "; Max-Age=" + this._maxAge;
    if (this._secure) out += "; Secure";
    if (this._httpOnly) out += "; HttpOnly";
    if (this._partitioned) out += "; Partitioned";
    // SameSite is always emitted, Lax included — see point 1 in the header.
    out += "; SameSite=" + SAME_SITE_LABEL[this._sameSite];
    return out;
  }

  toString() {
    return this.serialize();
  }

  toJSON() {
    const json = { name: this._name, value: this._value };
    if (this._domain) json.domain = this._domain;
    json.path = this._path;
    if (this._expires !== NO_EXPIRY) json.expires = new Date(this._expires);
    if (this._maxAge !== NO_EXPIRY) json.maxAge = this._maxAge;
    json.secure = this._secure;
    json.sameSite = this._sameSite;
    json.httpOnly = this._httpOnly;
    json.partitioned = this._partitioned;
    return json;
  }

  static parse(cookieString) {
    if (cookieString === undefined) throw new TypeError("Not enough arguments");
    const str = String(cookieString);
    // Bun routes the empty string into an empty CookieInit, whose empty name then
    // fails validation — so it throws the name error, not the "empty" one.
    if (!str) throw new TypeError(INVALID_NAME);
    if (!isValidHeaderValue(str)) throw new TypeError("cookie string is not a valid HTTP header value");
    return parseSetCookie(str);
  }

  static from(name, value, options) {
    return new Cookie(name, value, options);
  }
}

// ---- CookieMap ---------------------------------------------------------------
// Two lists, not one map, because that is what the semantics need: the cookies
// that ARRIVED (name/value pairs off the request header) and the cookies that
// CHANGED (full Cookie objects, the only ones that become Set-Cookie headers).
// A request that reads cookies without touching them must emit no Set-Cookie at
// all, and only this split gets that right.
//
// A "deleted" cookie is a changed cookie with an empty value plus an expiry in
// the past. It is therefore invisible to get/has/size/iteration — the emptiness
// IS the tombstone — while still serialising into the Set-Cookie header that
// tells the browser to drop it.
export class CookieMap {
  constructor(init) {
    this._originals = [];
    this._changed = [];
    if (init === undefined || init === null) return;
    if (typeof init === "string") {
      for (const pair of parseCookieHeader(init)) this._originals.push(pair);
      return;
    }
    if (Array.isArray(init)) {
      for (const pair of init) {
        if (!Array.isArray(pair)) throw new TypeError("Expected each element to be an array of two strings");
        if (pair.length !== 2) throw new TypeError("Expected arrays of exactly two strings");
        // Values from an array/object initialiser are taken verbatim — NOT
        // percent-decoded, unlike the string form. Only a real header goes
        // through the decoder.
        this._originals.push([String(pair[0]), String(pair[1])]);
      }
      return;
    }
    if (typeof init === "object") {
      for (const key of Object.keys(init)) this._originals.push([key, String(init[key])]);
      return;
    }
    throw new TypeError("Invalid initializer type");
  }

  _forget(name) {
    this._originals = this._originals.filter((p) => p[0] !== name);
    this._changed = this._changed.filter((c) => c.name !== name);
  }

  get(name) {
    const key = String(name);
    for (const c of this._changed) {
      if (c.name === key) return c.value === "" ? null : c.value;
    }
    for (const p of this._originals) if (p[0] === key) return p[1];
    return null;
  }

  has(name) {
    return this.get(name) !== null;
  }

  set(nameOrCookieOrInit, value, options) {
    if (arguments.length < 1) return undefined;
    if (nameOrCookieOrInit instanceof Cookie) {
      // Stored BY REFERENCE: mutating the Cookie afterwards changes what the map
      // reports and what it serialises. Bun does the same, and copying here would
      // be the quieter but wrong choice.
      this._forget(nameOrCookieOrInit.name);
      this._changed.push(nameOrCookieOrInit);
      return undefined;
    }
    let cookie;
    if (nameOrCookieOrInit && typeof nameOrCookieOrInit === "object") {
      cookie = makeCookie(fieldsFromInit(nameOrCookieOrInit, undefined, undefined));
    } else {
      if (arguments.length < 2) throw new TypeError("Not enough arguments");
      const name = String(nameOrCookieOrInit);
      cookie = makeCookie(fieldsFromInit(arguments.length > 2 ? options : undefined, name, String(value)));
    }
    this._forget(cookie.name);
    this._changed.push(cookie);
    return undefined;
  }

  delete(nameOrOptions, maybeOptions) {
    if (arguments.length < 1) return undefined;
    let name;
    let options;
    if (nameOrOptions && typeof nameOrOptions === "object") {
      options = nameOrOptions;
      name = options.name;
    } else {
      name = nameOrOptions;
      if (arguments.length >= 2) {
        if (!maybeOptions || typeof maybeOptions !== "object") throw new TypeError("Options must be an object");
        options = maybeOptions;
      }
    }
    if (typeof name !== "string") throw new TypeError("Cookie name is required");
    const path = options && options.path !== undefined && options.path !== null ? String(options.path) : "/";
    const domain = options && options.domain !== undefined && options.domain !== null ? String(options.domain) : "";
    // A `__Host-`/`__Secure-` cookie was necessarily stored WITH Secure, and a
    // browser matches the deletion cookie against the stored one — so the
    // tombstone has to carry Secure too or the cookie survives the delete.
    const secure = /^__(secure|host)-/i.test(name);
    this._forget(name);
    this._changed.push(
      makeCookie({ name, value: "", domain, path, expires: 1, sameSite: "lax", secure }),
    );
    return undefined;
  }

  // Only the CHANGED cookies, in the order they were changed. A handler that read
  // cookies and set none gets an empty array, which is what keeps a plain GET from
  // rewriting every cookie the browser already had.
  toSetCookieHeaders() {
    return this._changed.map((c) => c.serialize());
  }

  toJSON() {
    const out = {};
    const seen = new Set();
    for (const c of this._changed) {
      if (c.value === "") continue;
      seen.add(c.name);
      out[c.name] = c.value;
    }
    for (const [name, value] of this._originals) {
      if (seen.has(name)) continue;
      seen.add(name);
      out[name] = value;
    }
    return out;
  }

  get size() {
    let n = 0;
    for (const c of this._changed) if (c.value !== "") n++;
    return n + this._originals.length;
  }

  *entries() {
    // Changed cookies first, then the ones that arrived — Bun's order, and the
    // reason a set() during iteration is visible immediately.
    for (const c of this._changed) {
      if (c.value === "") continue;
      yield [c.name, c.value];
    }
    for (const [name, value] of this._originals) yield [name, value];
  }

  *keys() {
    for (const [name] of this.entries()) yield name;
  }

  *values() {
    for (const [, value] of this.entries()) yield value;
  }

  forEach(callback, thisArg) {
    for (const [name, value] of this.entries()) callback.call(thisArg, value, name, this);
  }

  [Symbol.iterator]() {
    return this.entries();
  }
}

// ---- the Bun.serve hook ------------------------------------------------------
// Bun exposes `cookies` on BunRequest — the request object handed to a `routes`
// handler — and NOT on the plain Request a `fetch` handler receives. We reproduce
// that split exactly rather than attaching it everywhere: a shim that offers
// `req.cookies` inside `fetch` would make code that works here fail under real
// Bun, which is the one direction of divergence this file may not take. In a
// `fetch` handler the documented path is the same one Bun documents for non-Bun
// servers — `new CookieMap(req.headers.get("cookie"))` plus
// `toSetCookieHeaders()`.
//
// The map is created lazily, on first property access, for two reasons: parsing a
// header nobody reads is waste, and (more importantly) `pendingSetCookies` can
// then tell "the handler never looked at cookies" apart from "the handler looked
// and changed nothing" without either producing a Set-Cookie header.
const requestCookieMaps = new WeakMap();

export function attachRequestCookies(request, cookieHeader) {
  if (!request || typeof request !== "object") return request;
  Object.defineProperty(request, "cookies", {
    configurable: true,
    enumerable: false,
    get() {
      let map = requestCookieMaps.get(request);
      if (!map) {
        map = new CookieMap(cookieHeader || "");
        requestCookieMaps.set(request, map);
      }
      return map;
    },
  });
  return request;
}

// The Set-Cookie headers a request's cookie changes should add to its response.
// Empty unless a handler actually touched `req.cookies` and changed something.
export function pendingSetCookies(request) {
  const map = request && requestCookieMaps.get(request);
  return map ? map.toSetCookieHeaders() : [];
}