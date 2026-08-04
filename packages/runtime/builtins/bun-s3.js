// Bun.S3Client / Bun.s3 — an S3 client over `fetch` and AWS Signature V4.
//
// This was a SHIM-tier refusal ("possible, unwritten"), and the refusal was right
// about the two things standing in the way: a signer, and CORS. The signer is
// written below. CORS is not something code can fix, so the whole of it is pushed
// into the ERROR PATH instead, which is the part of this file to read first if you
// are here because something failed.
//
// WHY A CLIENT-SIDE S3 CLIENT IS A DIFFERENT OBJECT FROM BUN'S
//
// Real Bun opens a socket to the bucket. This runs as page JavaScript, so the
// request is a cross-origin `fetch()` and the BUCKET decides whether the page may
// see the answer. Three consequences follow, and none of them are cosmetic:
//
//   1. A bucket with no CORS policy is unreachable. The browser blocks the
//      request and hands JavaScript a bare `TypeError: Failed to fetch` with no
//      status, no headers and no body — deliberately, so a page cannot use fetch
//      to probe hosts it is not allowed to read. To a caller that looks exactly
//      like a bug in their own code, so every failure of that shape is caught
//      here and rethrown as a sentence that says CORS, says which origin needs
//      allowing, and lists the headers the preflight has to permit. That message
//      is the single most useful thing in this file.
//   2. Every request this client makes is a PREFLIGHTED one. `authorization`,
//      `x-amz-date` and `x-amz-content-sha256` are not CORS-safelisted, so the
//      browser sends an `OPTIONS` first and the bucket must answer it with
//      matching `Access-Control-Allow-Headers`. A bucket policy that allows the
//      origin but not the headers fails in exactly the same opaque way.
//   3. Response headers are only readable if the bucket EXPOSES them.
//      `stat()`/`size()` read `content-length`, `etag` and `last-modified` off a
//      HEAD response; without `ExposeHeaders` in the policy those come back null
//      from a response that otherwise succeeded. `stat()` reports the nulls;
//      `size()` throws rather than return one, because a null size becomes 0 in
//      arithmetic and the object then looks empty. See the docs page.
//
// The distinction the error path exists to preserve: "S3 rejected you" is an HTTP
// status with an S3 error code in the body, and is surfaced verbatim with Bun's
// own `code`/`message`/`name`. "The browser never let the request out" has no
// status at all. Conflating those two sends someone to re-check their secret key
// over a policy problem, or to write a bucket policy over a wrong secret.
//
// WHAT THE BINARY TAUGHT US (1.3.6, probed against a local HTTP server standing
// in for S3, so every request could be read off the wire):
//
//   * Bun signs with `x-amz-content-sha256: UNSIGNED-PAYLOAD` on EVERY request,
//     including a PUT with a body. So do we — a byte-identical Authorization
//     header is worth more than a stricter-looking one, and the signer takes the
//     payload hash as a parameter so the published AWS vectors (which use real
//     digests) still pin the algorithm. Signed headers are therefore
//     `host;x-amz-content-sha256;x-amz-date`, plus `x-amz-security-token`,
//     `x-amz-acl` and `x-amz-storage-class` when those apply.
//   * `Content-Type` is NOT signed, and `Range` (from `.slice()`) is not either.
//     Its default is `application/octet-stream` for every body type — a string
//     included, and a `Blob`'s own `type` is ignored. An explicit `{ type }` is
//     sent as given (the binary first runs it through a MIME table that appends
//     `;charset=utf-8` to some text types; that table is not reproduced).
//   * Missing credentials are reported BEFORE a missing bucket: with an empty
//     environment `Bun.s3.presign("k")` is ERR_S3_MISSING_CREDENTIALS, not the
//     ERR_S3_INVALID_PATH the absent bucket also earns.
//   * `presign` accepts POST despite its error text naming four methods, and has
//     two rejection paths — see INVALID_METHOD_MESSAGE.
//   * `list()` hands back `lastModified` as the raw ISO string while `stat()`
//     returns a Date, and one of its fields is misspelled `checksumAlgorithme`.
//     Both copied: see parseListObjectsV2().
//   * `presign` signs only `host`, puts everything else in the query, defaults to
//     86400 seconds, and enforces no upper bound on `expiresIn` (S3's own limit
//     is 7 days for SigV4 — Bun will happily build a URL S3 refuses).
//   * The credential scope's region is `us-east-1` by default but `auto` as soon
//     as an `endpoint` is set and no region was given. `AWS_DEFAULT_REGION` is
//     ignored: only `S3_REGION`/`AWS_REGION` count.
//   * Keys are AWS-URI-encoded per segment (`/` kept, `%` becoming `%25`, `.` and
//     `..` NOT normalised) — and a key containing `?` is silently TRUNCATED at
//     the `?`, which operates on a different object than the caller named. That
//     one is refused here rather than reproduced; see s3KeyFromPath().
//   * Errors are `Error` instances with `name = "S3Error"`, `code` from the XML
//     `<Code>`, `message` from `<Message>`, and `path` set to the key on every
//     operation except `write`.
//
// One divergence in the other direction: `Bun.write(key, readableStream)` in
// 1.3.6 uploads the twenty-three bytes of `[object ReadableStream]` (measured —
// `content-length: 23`, body `[object ReadableStream]`). That is data loss rather
// than a behaviour worth matching, so a stream body is drained and its real bytes
// are sent.
//
// WHAT IS REFUSED, AND AT WHICH TIER (the two message shapes from
// ./bun-unsupported.js apply here too):
//   * `.writer()` past one part — SHIM. A FileSink over S3 is a multipart upload,
//     and multipart is plain HTTP: possible here, unwritten. Below the part size
//     Bun issues a single PUT, so that is what this does; at the point where Bun
//     would start a multipart upload it throws instead of buffering without a
//     bound. Nothing about a page forbids the multipart dance, but each part's
//     ETag has to be read back, which needs a bucket policy with
//     `ExposeHeaders: ETag` — writing it blind would mean shipping something no
//     check here can exercise.
//   * Streaming a request body incrementally — SANDBOX. `fetch` in a page cannot
//     stream an upload (request streams need HTTP/2 plus `duplex: "half"`, which
//     no S3 endpoint negotiates for this), so a body is whatever fits in memory.

// ---- constants --------------------------------------------------------------

/** Bun's payload-hash placeholder, on every request it signs. */
export const S3_UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";

/** SHA-256 of the empty string — the payload hash in AWS's own test vectors. */
export const SHA256_EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

const ALGORITHM = "AWS4-HMAC-SHA256";
const SERVICE = "s3";
const DEFAULT_EXPIRES_IN = 86400;

// Bun's strings, verbatim, including the misspelling in the first one: an error
// message is part of an API, and someone will paste it into a search box.
export const EXPIRES_IN_MESSAGE = "expiresIn must be greather than 0";
export const MISSING_CREDENTIALS_MESSAGE =
  "Missing S3 credentials. 'accessKeyId', 'secretAccessKey', 'bucket', and 'endpoint' are required";
export const INVALID_PATH_MESSAGE = "Invalid S3 bucket, key combination";
// Two messages for two failures, and the difference between them is measured. A
// token Bun's HTTP parser does not recognise at all ("GETX", a number) is an
// argument-type error and the message starts lowercase; a real HTTP method that S3
// has no use for (PATCH, OPTIONS, PROPFIND) gets the capitalised one. Both name
// only four methods even though POST is accepted — Bun's own text, left alone.
export const INVALID_METHOD_MESSAGE = "method must be GET, PUT, DELETE or HEAD when using s3 protocol";
export const INVALID_S3_METHOD_MESSAGE = "Method must be GET, PUT, DELETE or HEAD when using s3:// protocol";

// POST is in here because the binary signs it, whatever its error text says.
const PRESIGN_METHODS = new Set(["GET", "PUT", "DELETE", "HEAD", "POST"]);
// The methods Bun's parser knows and presign then rejects. Bun's table is longer
// than any list worth transcribing, so a token outside BOTH sets falls through to
// the argument-type error — which is the branch a typo lands in anyway.
const KNOWN_HTTP_METHODS = new Set([
  "OPTIONS",
  "PATCH",
  "TRACE",
  "CONNECT",
  "PROPFIND",
  "PROPPATCH",
  "MKCOL",
  "COPY",
  "MOVE",
  "LOCK",
  "UNLOCK",
  "SEARCH",
  "QUERY",
  "LINK",
  "UNLINK",
  "PURGE",
  "REPORT",
  "MERGE",
  "NOTIFY",
  "SUBSCRIBE",
  "UNSUBSCRIBE",
]);

// ---- AWS URI encoding -------------------------------------------------------

/**
 * RFC 3986 encoding as SigV4 defines it: unreserved characters pass through,
 * everything else becomes uppercase percent-escapes. `encodeURIComponent` is not
 * a substitute — it leaves `!'()*` alone, and each of those changes the canonical
 * request and therefore the signature.
 *
 * `encodeSlash: false` is the object-key case, where `/` stays a separator.
 */
export function awsUriEncode(value, encodeSlash = true) {
  const s = String(value);
  let out = "";
  for (const ch of s) {
    if (/[A-Za-z0-9\-._~]/.test(ch)) {
      out += ch;
    } else if (ch === "/") {
      out += encodeSlash ? "%2F" : "/";
    } else {
      for (const byte of new TextEncoder().encode(ch)) {
        out += "%" + byte.toString(16).toUpperCase().padStart(2, "0");
      }
    }
  }
  return out;
}

// ---- SigV4 ------------------------------------------------------------------

/**
 * The three primitives the signer needs, over whatever crypto the host has.
 * `node:crypto` in the runtime IS packages/crypto through
 * internalBinding('crypto') — the same seam ./bun-crypto.js uses — and outside it
 * (the offline spike tier) it is the host's OpenSSL. Either way there is no new
 * dependency and no hand-rolled SHA-256.
 */
export function createSigv4Hashers(crypto) {
  return {
    sha256Hex: (data) => crypto.createHash("sha256").update(data).digest("hex"),
    hmac: (key, data) => crypto.createHmac("sha256", key).update(data).digest(),
    hmacHex: (key, data) => crypto.createHmac("sha256", key).update(data).digest("hex"),
  };
}

/** A timestamp as SigV4 spells it: `20260804T083104Z` plus the `20260804` scope. */
export function amzDateStamps(date) {
  const iso = new Date(date).toISOString();
  const amzDate = iso.slice(0, 19).replace(/[-:]/g, "") + "Z";
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

/**
 * Canonical query string: every pair percent-encoded, then sorted by encoded name
 * and encoded value. `params` is an array of [name, value] pairs rather than an
 * object, because S3 allows a parameter to repeat.
 */
export function canonicalQueryString(params) {
  return (params || [])
    .map(([name, value]) => [awsUriEncode(name), awsUriEncode(value == null ? "" : value)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([name, value]) => name + "=" + value)
    .join("&");
}

/**
 * Canonical headers plus the signed-header list. Names lowercase and sorted,
 * values trimmed with internal runs of spaces collapsed to one — that last rule
 * is why AWS's `get-header-value-trim` vector exists, and it applies inside
 * quotes too.
 */
export function canonicalHeaders(headers) {
  const entries = Object.keys(headers || {})
    .map((name) => [name.toLowerCase(), String(headers[name]).trim().replace(/ +/g, " ")])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return {
    canonical: entries.map(([name, value]) => name + ":" + value + "\n").join(""),
    signedHeaders: entries.map(([name]) => name).join(";"),
  };
}

/**
 * The whole SigV4 chain for one request, returning every intermediate value.
 *
 * The intermediates are returned rather than kept private because they are what
 * AWS publishes vectors for: a signature that disagrees tells you nothing about
 * WHERE it went wrong, while a canonical request that disagrees points straight
 * at the offending line. `scripts/spike-bun-offline.mjs` asserts all three
 * against AWS's own signing test suite.
 *
 * `canonicalUri` must already be encoded (see s3ObjectPath); it is not
 * normalised, because S3 does not normalise object keys.
 */
export function sigv4({
  method,
  canonicalUri,
  query,
  headers,
  payloadHash,
  amzDate,
  dateStamp,
  region,
  service = SERVICE,
  accessKeyId,
  secretAccessKey,
  hashers,
}) {
  const { canonical, signedHeaders } = canonicalHeaders(headers);
  const canonicalRequest = [
    method,
    canonicalUri,
    typeof query === "string" ? query : canonicalQueryString(query),
    canonical,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const credentialScope = [dateStamp, region, service, "aws4_request"].join("/");
  const stringToSign = [ALGORITHM, amzDate, credentialScope, hashers.sha256Hex(canonicalRequest)].join("\n");

  // The HMAC chain: each step keys the next, so the finished key is bound to the
  // date, the region and the service and cannot be replayed against another.
  let key = hashers.hmac("AWS4" + secretAccessKey, dateStamp);
  key = hashers.hmac(key, region);
  key = hashers.hmac(key, service);
  key = hashers.hmac(key, "aws4_request");
  const signature = hashers.hmacHex(key, stringToSign);

  return {
    canonicalRequest,
    stringToSign,
    credentialScope,
    signedHeaders,
    signature,
    authorization:
      ALGORITHM +
      " Credential=" +
      accessKeyId +
      "/" +
      credentialScope +
      ", SignedHeaders=" +
      signedHeaders +
      ", Signature=" +
      signature,
  };
}

// ---- configuration ----------------------------------------------------------

const pick = (...values) => {
  for (const v of values) if (v !== undefined && v !== null && v !== "") return v;
  return undefined;
};

/** An Error carrying a Bun `code`. `name` stays "Error", as Bun's does here. */
const configError = (message, code) => {
  const err = new Error(message);
  err.code = code;
  return err;
};

/**
 * Bun's option/environment precedence, measured rather than read off the docs: an
 * explicit option beats `S3_*`, which beats `AWS_*`, PER VARIABLE — a config with
 * `S3_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` is a working pair. Region falls
 * back to `us-east-1`, or to `auto` when an endpoint is set and no region was
 * named, which is what the S3-compatible services expect. `AWS_DEFAULT_REGION` is
 * NOT consulted: real Bun ignores it, and honouring it here would sign with a
 * region the binary does not use.
 */
export function resolveS3Config(options, env) {
  const o = options || {};
  const e = env || {};
  const endpoint = pick(o.endpoint, e.S3_ENDPOINT, e.AWS_ENDPOINT);
  const region = pick(o.region, e.S3_REGION, e.AWS_REGION, endpoint ? "auto" : "us-east-1");
  return {
    accessKeyId: pick(o.accessKeyId, e.S3_ACCESS_KEY_ID, e.AWS_ACCESS_KEY_ID),
    secretAccessKey: pick(o.secretAccessKey, e.S3_SECRET_ACCESS_KEY, e.AWS_SECRET_ACCESS_KEY),
    sessionToken: pick(o.sessionToken, e.S3_SESSION_TOKEN, e.AWS_SESSION_TOKEN),
    region,
    endpoint,
    bucket: pick(o.bucket, e.S3_BUCKET, e.AWS_BUCKET),
    virtualHostedStyle: Boolean(o.virtualHostedStyle),
    acl: o.acl,
    storageClass: o.storageClass,
    type: o.type,
  };
}

/** Both keys, or Bun's ERR_S3_MISSING_CREDENTIALS. */
export function requireS3Credentials(config) {
  if (!config.accessKeyId || !config.secretAccessKey) {
    throw configError(MISSING_CREDENTIALS_MESSAGE, "ERR_S3_MISSING_CREDENTIALS");
  }
}

/**
 * Bun's key handling, measured: ANY `<scheme>://` prefix is stripped — `s3://`,
 * but equally `https://`, `gs://` and `weird://` — leading slashes are dropped,
 * and when no bucket is configured the first path segment BECOMES the bucket
 * (`s3://logs/app.txt` with no bucket set is key `app.txt` in bucket `logs`).
 * Nothing is normalised: `a/../b` is a key with `..` in it, because that is a
 * legal S3 key and S3 does not resolve it.
 *
 * The consequence worth knowing is that `client.file("https://host/x")` is not a
 * URL fetch, it is the key `host/x`. That is what the binary does, and a throw
 * here would fail code that works under `bun`.
 *
 * The one place this refuses instead of copying: a key containing `?`. Bun cuts
 * the key there — `presign("q?x.txt")` signs `/bucket/q` — so the object it reads
 * or writes is not the one that was named, silently. Reproducing that would
 * corrupt data on purpose; encoding the `?` would diverge from the binary without
 * saying so. Throwing does neither.
 */
export function s3KeyFromPath(path, configuredBucket) {
  const given = String(path == null ? "" : path)
    .replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//, "")
    .replace(/^\/+/, "");
  let key = given;
  let bucket = configuredBucket;
  if (!bucket) {
    const slash = key.indexOf("/");
    if (slash > 0) {
      bucket = key.slice(0, slash);
      key = key.slice(slash + 1);
    }
  }
  if (!bucket || !key) throw configError(INVALID_PATH_MESSAGE, "ERR_S3_INVALID_PATH");
  if (key.indexOf("?") >= 0) {
    throw configError(
      "Vivari refuses the S3 key " +
        JSON.stringify(key) +
        ": real Bun (1.3.6) truncates a key at the first '?' and would operate on " +
        JSON.stringify(key.slice(0, key.indexOf("?"))) +
        " instead — a different object, with no warning. Percent-encode the '?' " +
        "yourself if the object really is named that.",
      "ERR_S3_INVALID_PATH"
    );
  }
  // `name` is the scheme-stripped input, not the key: measured off the binary,
  // where `Bun.file("s3://logs/app.txt").name` is "logs/app.txt" while the object
  // fetched is `app.txt` in bucket `logs`. Odd, and load-bearing for anything that
  // logs a file handle.
  return { bucket, key, name: given };
}

/** Encoded object path — every segment escaped, `/` kept as a separator. */
export const s3ObjectPath = (key) => awsUriEncode(key, false);

/**
 * Where the request goes: origin, the canonical (signed) path, and the Host
 * header. Path style by default, `<bucket>.` prefixed for virtualHostedStyle
 * against AWS. `key === null` is the bucket listing.
 *
 * With an explicit endpoint AND virtualHostedStyle, Bun drops the bucket entirely
 * rather than prefixing the endpoint's host — `endpoint:
 * "http://minio.local:9000"` gives `http://minio.local:9000/<key>` (measured).
 * That is reproduced: the endpoint is then taken to address the bucket already,
 * and diverging would send requests somewhere the binary does not.
 */
export function s3RequestTarget(config, key) {
  let origin;
  let basePath = "";
  if (config.endpoint) {
    let u;
    try {
      u = new URL(config.endpoint);
    } catch {
      throw configError(
        "Bun.S3Client endpoint " + JSON.stringify(config.endpoint) + " is not a valid URL",
        "ERR_S3_INVALID_ENDPOINT"
      );
    }
    origin = u.origin;
    basePath = u.pathname.replace(/\/+$/, "");
    if (!config.virtualHostedStyle) basePath += "/" + config.bucket;
  } else if (config.virtualHostedStyle) {
    origin = "https://" + config.bucket + ".s3." + config.region + ".amazonaws.com";
  } else {
    origin = "https://s3." + config.region + ".amazonaws.com";
    basePath = "/" + config.bucket;
  }
  // A bucket listing addresses the bucket itself, and Bun keeps the trailing
  // slash: `GET /bucket/?list-type=2`. It is part of the canonical request, so
  // dropping it changes the signature.
  const path = key === null ? basePath + "/" : basePath + "/" + s3ObjectPath(key);
  return { origin, path, host: new URL(origin).host };
}

// ---- request building -------------------------------------------------------

/**
 * A fully signed request, as data. Returned rather than performed so the offline
 * tier can assert the exact bytes — method, path, host, header set, payload hash
 * — without a bucket, which is the only kind of check available without one.
 */
export function buildS3Request({
  config,
  method,
  key,
  query = [],
  payloadHash = S3_UNSIGNED_PAYLOAD,
  extraHeaders,
  date = Date.now(),
  hashers,
}) {
  requireS3Credentials(config);
  const { origin, path, host } = s3RequestTarget(config, key);
  const { amzDate, dateStamp } = amzDateStamps(date);

  const headers = {
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  if (config.sessionToken) headers["x-amz-security-token"] = config.sessionToken;
  for (const name of Object.keys(extraHeaders || {})) {
    if (extraHeaders[name] !== undefined && extraHeaders[name] !== null) {
      headers[name.toLowerCase()] = String(extraHeaders[name]);
    }
  }

  // Only `host` and the `x-amz-*` headers are signed, which is measured, not a
  // shortcut: the binary sends `Range` and `Content-Type` on the wire and leaves
  // both out of SignedHeaders. It is allowed — SigV4 requires only host — and
  // copying it matters, because a signature over headers a browser or proxy may
  // rewrite is a signature that breaks in transit.
  const signedHeaders = {};
  for (const name of Object.keys(headers)) {
    if (name === "host" || name.startsWith("x-amz-")) signedHeaders[name] = headers[name];
  }

  const signed = sigv4({
    method,
    canonicalUri: path,
    query,
    headers: signedHeaders,
    payloadHash,
    amzDate,
    dateStamp,
    region: config.region,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    hashers,
  });

  const qs = canonicalQueryString(query);
  return {
    method,
    url: origin + path + (qs ? "?" + qs : ""),
    path,
    host,
    headers: { ...headers, authorization: signed.authorization },
    signed,
  };
}

/**
 * A presigned URL: the same chain with the credential material moved into the
 * query and only `host` signed, which is what makes the URL usable from a browser
 * with no headers at all — and therefore the one part of this API that needs no
 * CORS policy for a plain GET (an `<img src>` or a download link is not a fetch
 * whose response the page reads).
 */
export function presignS3Url({
  config,
  key,
  method = "GET",
  expiresIn = DEFAULT_EXPIRES_IN,
  acl,
  storageClass,
  date = Date.now(),
  hashers,
}) {
  requireS3Credentials(config);
  // `null`, `undefined` and "" all mean GET to the binary, so they mean GET here.
  const verb = method == null || method === "" ? "GET" : String(method).toUpperCase();
  if (!PRESIGN_METHODS.has(verb)) {
    const known = typeof method === "string" && KNOWN_HTTP_METHODS.has(verb);
    const err = known ? new Error(INVALID_S3_METHOD_MESSAGE) : new TypeError(INVALID_METHOD_MESSAGE);
    err.code = known ? "ERR_S3_INVALID_METHOD" : "ERR_INVALID_ARG_TYPE";
    throw err;
  }
  const seconds = Number(expiresIn === undefined ? DEFAULT_EXPIRES_IN : expiresIn);
  // Bun's own check, and its own error code: a bad expiry is ERR_INVALID_ARG_TYPE,
  // not a range error, and `expiresIn: "abc"` lands here rather than signing NaN.
  if (!(seconds > 0)) {
    const err = new Error(EXPIRES_IN_MESSAGE);
    err.code = "ERR_INVALID_ARG_TYPE";
    throw err;
  }

  const { origin, path, host } = s3RequestTarget(config, key);
  const { amzDate, dateStamp } = amzDateStamps(date);
  const query = [
    ["X-Amz-Algorithm", ALGORITHM],
    ["X-Amz-Credential", config.accessKeyId + "/" + [dateStamp, config.region, SERVICE, "aws4_request"].join("/")],
    ["X-Amz-Date", amzDate],
    ["X-Amz-Expires", String(Math.floor(seconds))],
    ["X-Amz-SignedHeaders", "host"],
  ];
  if (config.sessionToken) query.push(["X-Amz-Security-Token", config.sessionToken]);
  // Bun spells these differently in a presigned URL — `X-Amz-Acl` but a lowercase
  // `x-amz-storage-class` — and the spelling is signed, so it is not cosmetic.
  if (acl) query.push(["X-Amz-Acl", String(acl)]);
  if (storageClass) query.push(["x-amz-storage-class", String(storageClass)]);

  const signed = sigv4({
    method: verb,
    canonicalUri: path,
    query,
    headers: { host },
    // A presigned URL is signed without knowing the body, so the payload hash IS
    // the literal string. S3 accepts whatever body then arrives.
    payloadHash: S3_UNSIGNED_PAYLOAD,
    amzDate,
    dateStamp,
    region: config.region,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    hashers,
  });

  const qs = canonicalQueryString([...query, ["X-Amz-Signature", signed.signature]]);
  return { url: origin + path + "?" + qs, signed };
}

// ---- errors -----------------------------------------------------------------

const xmlTag = (xml, tag) => {
  const m = new RegExp("<" + tag + "\\b[^>]*>([\\s\\S]*?)</" + tag + ">").exec(xml);
  if (!m) return undefined;
  return m[1]
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
};

// Bun's fallbacks when the response carries no parseable `<Error>`: 404 is the
// only status it names, everything else is one generic pair. Measured across
// 301/400/401/403/404/405/409/412/429/500/503, on GET and on HEAD — and a HEAD
// has no body at all, so this path is the ONLY one `exists()`/`stat()` can take.
const STATUS_FALLBACK = {
  404: { code: "NoSuchKey", message: "The specified key does not exist." },
};
const UNKNOWN_ERROR = { code: "UnknownError", message: "an unexpected error has occurred" };

/**
 * S3 said no, and said why. Bun's shape: an `Error` named `S3Error` carrying the
 * S3 error code, so `catch (e) { if (e.code === "NoSuchKey") … }` — the handling
 * Bun's own docs suggest — works unchanged here.
 */
export function s3ErrorFromResponse({ status, bodyText, path }) {
  const body = String(bodyText || "");
  let code = xmlTag(body, "Code");
  let message = xmlTag(body, "Message");
  if (!code) {
    const fallback = STATUS_FALLBACK[status] || UNKNOWN_ERROR;
    code = fallback.code;
    // A non-XML body is still the server explaining itself (a proxy's "oops", an
    // HTML error page); Bun surfaces it as the message rather than discarding it.
    message = body.trim() && !STATUS_FALLBACK[status] ? body.trim() : fallback.message;
  }
  const err = new Error(message || UNKNOWN_ERROR.message);
  err.name = "S3Error";
  err.code = code;
  err.status = status;
  if (path !== undefined) err.path = path;
  return err;
}

/**
 * The failure this whole file is shaped around: `fetch` rejected, so there is no
 * status, no headers and no body — the browser refused the page the response and
 * told it nothing.
 *
 * A caller who reads only the original `TypeError: Failed to fetch` cannot tell a
 * CORS block from a typo in the endpoint, and the first guess is almost always
 * "my code is broken". So the message names CORS first, names the origin that has
 * to be allowed, lists the headers the preflight must permit, and ends by
 * contrasting it with the other failure mode (a real HTTP status), because
 * knowing which of the two you are looking at IS the diagnosis.
 */
export function s3RequestBlockedError({ cause, method, url, headers, path, origin }) {
  const headerList = Object.keys(headers || {})
    .filter((h) => h !== "host")
    .sort()
    .join(", ");
  const pageOrigin =
    origin ||
    (typeof globalThis !== "undefined" && globalThis.location && globalThis.location.origin) ||
    "the origin this page is served from";
  let target = url;
  try {
    target = new URL(url).origin;
  } catch {
    /* not a parseable URL — report it as given */
  }
  const err = new Error(
    "The " +
      method +
      " request to " +
      target +
      " never left the browser, so S3 never answered it — there is no HTTP status to report. " +
      "In Vivari this client runs as JavaScript in a browser TAB rather than in the Bun binary, " +
      "so the request is a cross-origin fetch() and the bucket itself has to allow it.\n" +
      "The likely cause is CORS: the bucket needs a CORS policy allowing " +
      pageOrigin +
      ", the method " +
      method +
      ", and the request headers this client sends (" +
      headerList +
      "). Because x-amz-* headers are not CORS-safelisted, the browser sends a preflight OPTIONS " +
      "request first, which the bucket must answer with matching Access-Control-Allow-Headers — a " +
      "policy that allows the origin but not those headers fails exactly like no policy at all. " +
      "Vivari's Bun docs carry a bucket policy you can paste in.\n" +
      "If the policy is already in place, what is left is a wrong endpoint or bucket hostname, a " +
      "network that is down, or a blocking browser extension. Note what this is NOT: a bucket " +
      "that REJECTED you answers with an HTTP status and an S3 error code (AccessDenied, " +
      "SignatureDoesNotMatch, NoSuchBucket) and you would be reading that code instead. Nothing " +
      "answered here.\n" +
      "Original error: " +
      String((cause && cause.message) || cause)
  );
  err.name = "S3Error";
  // Vivari-only: real Bun cannot reach this state, so there is no Bun code to
  // match. Distinct from every S3 code so a handler can tell them apart.
  err.code = "ERR_S3_REQUEST_BLOCKED";
  err.cause = cause;
  if (path !== undefined) err.path = path;
  return err;
}

// ---- ListObjectsV2 ----------------------------------------------------------

/**
 * Bun's `list()` result, built from the XML S3 returns. Three measured details,
 * all of them things a "tidier" version would get wrong:
 *
 *   - the names are Bun's, including `eTag` with the quotes S3 sends still on it
 *     and `checksumAlgorithme`, which is a typo in Bun and therefore the name
 *     callers destructure;
 *   - `lastModified` stays the raw ISO STRING here, while `stat()` returns a Date.
 *     Bun is inconsistent about this and code reads one or the other;
 *   - absent fields are absent rather than present-and-undefined, so
 *     `"delimiter" in result` answers the question it looks like it answers.
 */
export function parseListObjectsV2(xml) {
  const body = String(xml || "");
  const num = (v) => (v === undefined ? undefined : Number(v));
  const contents = [];
  const contentsRe = /<Contents>([\s\S]*?)<\/Contents>/g;
  let m;
  while ((m = contentsRe.exec(body))) {
    const item = m[1];
    const entry = { key: xmlTag(item, "Key"), eTag: xmlTag(item, "ETag") };
    const checksum = xmlTag(item, "ChecksumAlgorithm");
    if (checksum !== undefined) entry.checksumAlgorithme = checksum;
    entry.lastModified = xmlTag(item, "LastModified");
    entry.size = num(xmlTag(item, "Size"));
    entry.storageClass = xmlTag(item, "StorageClass");
    const ownerBlock = /<Owner>([\s\S]*?)<\/Owner>/.exec(item);
    if (ownerBlock) {
      entry.owner = { id: xmlTag(ownerBlock[1], "ID"), displayName: xmlTag(ownerBlock[1], "DisplayName") };
    }
    contents.push(entry);
  }
  const commonPrefixes = [];
  const prefixRe = /<CommonPrefixes>([\s\S]*?)<\/CommonPrefixes>/g;
  while ((m = prefixRe.exec(body))) {
    commonPrefixes.push({ prefix: xmlTag(m[1], "Prefix") });
  }
  // The per-object blocks are removed before the top-level tags are read:
  // `<Prefix>` appears inside `<CommonPrefixes>` too, and a list with a delimiter
  // but no prefix of its own would otherwise report the first common prefix as the
  // request's.
  const head = body.replace(contentsRe, "").replace(prefixRe, "");
  // Built in Bun's key order. Object key order is observable through
  // JSON.stringify and console.log, and a diff against a captured fixture is one
  // of the few ways a change here gets noticed at all.
  const result = { name: xmlTag(head, "Name") };
  for (const [tag, field] of [
    ["Prefix", "prefix"],
    ["Delimiter", "delimiter"],
    ["StartAfter", "startAfter"],
    ["EncodingType", "encodingType"],
    ["ContinuationToken", "continuationToken"],
    ["NextContinuationToken", "nextContinuationToken"],
  ]) {
    const value = xmlTag(head, tag);
    if (value !== undefined) result[field] = value;
  }
  result.isTruncated = xmlTag(head, "IsTruncated") === "true";
  result.keyCount = num(xmlTag(head, "KeyCount"));
  result.maxKeys = num(xmlTag(head, "MaxKeys"));
  if (contents.length) result.contents = contents;
  if (commonPrefixes.length) result.commonPrefixes = commonPrefixes;
  return result;
}

// Bun's option -> query-parameter names for ListObjectsV2. `list-type=2` always
// goes out, and an option Bun does not know is dropped rather than sent.
const LIST_PARAMS = [
  ["prefix", "prefix"],
  ["delimiter", "delimiter"],
  ["maxKeys", "max-keys"],
  ["continuationToken", "continuation-token"],
  ["startAfter", "start-after"],
  ["fetchOwner", "fetch-owner"],
  ["encodingType", "encoding-type"],
];

export function listQuery(options) {
  const query = [["list-type", "2"]];
  for (const [option, param] of LIST_PARAMS) {
    const value = options && options[option];
    if (value !== undefined && value !== null && value !== "") query.push([param, String(value)]);
  }
  return query;
}

// ---- the client -------------------------------------------------------------

// Where the multipart wall is. Bun's default part size is 5 MiB and it issues a
// single PUT below it, so this is both Bun's boundary and the point past which
// buffering in a page stops being bounded.
const MULTIPART_THRESHOLD = 5 * 1024 * 1024;
const MULTIPART_MIB = MULTIPART_THRESHOLD / (1024 * 1024);

const MULTIPART_REASON =
  "writing more than " +
  MULTIPART_MIB +
  " MiB in one operation is a MULTIPART upload (CreateMultipartUpload, one signed " +
  "PUT per part, CompleteMultipartUpload), and that is not written here. It is " +
  "plain HTTPS, so nothing about a browser forbids it — but each part's ETag has " +
  "to be read off its response, which needs a bucket CORS policy carrying " +
  "ExposeHeaders: ETag, and an untestable upload path that corrupts an object " +
  "halfway is worse than a refusal. Below this size the behaviour is Bun's (one " +
  "PUT). For a larger object, presign a PUT and upload straight from the browser, " +
  "or run the upload outside the sandbox.";

export function createBunS3({ lazy, Buffer: BufferImpl, process: proc, fetch: hostFetch, shimMessage }) {
  const buffer = BufferImpl;
  let hashersCache = null;
  const hashers = () => hashersCache || (hashersCache = createSigv4Hashers(lazy("crypto")));
  const env = () => (proc && proc.env) || {};

  // Read at call time, not at construction: in a browser the guest's `fetch` IS
  // the page's own (packages/runtime/index.js hands the host realm's through), so
  // there is nothing to capture early, and a test can substitute one.
  const doFetch = (...args) => {
    const f = hostFetch || (typeof globalThis !== "undefined" && globalThis.fetch);
    if (typeof f !== "function") {
      throw new Error(
        "Bun.S3Client needs fetch(), and this process has none. Every S3 request " +
          "here is an HTTPS request; there is no socket path to fall back to."
      );
    }
    return f(...args);
  };

  /**
   * Every `fetch` this file makes goes through here, so no call site can forget
   * the translation. A rejected fetch is ALWAYS the blocked/unreachable case:
   * fetch does not reject over an HTTP status, however bad the status is.
   */
  const s3Fetch = async (request, path) => {
    try {
      return await doFetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
      });
    } catch (cause) {
      throw s3RequestBlockedError({
        cause,
        method: request.method,
        url: request.url,
        headers: request.headers,
        path,
      });
    }
  };

  // A body we may not be able to read (a HEAD has none; a cross-origin response
  // may expose nothing). Never let that hide the status we were called about.
  const safeText = async (res) => {
    try {
      return await res.text();
    } catch {
      return "";
    }
  };

  const OCTET_STREAM = "application/octet-stream";

  // Body normalisation. A page cannot stream a request body (see the header), so
  // everything becomes bytes here — including a ReadableStream, which is drained
  // rather than stringified the way the binary does. Every body type reports
  // `application/octet-stream`, which is measured: the binary sends that even for a
  // string, and an explicit `{ type }` is the only way to set another.
  const toBody = async (data) => {
    if (data == null) return { bytes: buffer.alloc(0), type: undefined };
    if (typeof data === "string") return { bytes: buffer.from(data, "utf8"), type: OCTET_STREAM };
    if (buffer.isBuffer(data)) return { bytes: data, type: OCTET_STREAM };
    if (data instanceof ArrayBuffer) return { bytes: buffer.from(new Uint8Array(data)), type: OCTET_STREAM };
    if (ArrayBuffer.isView(data)) return { bytes: buffer.from(data.buffer, data.byteOffset, data.byteLength), type: OCTET_STREAM };
    // A Blob, a BunFile or an S3File — anything with the Blob read protocol. The
    // Blob's own `type` is deliberately dropped: the binary sends
    // `application/octet-stream` for `write(key, new Blob(["hi"], { type:
    // "image/png" }))`, so honouring it here would put a different Content-Type on
    // the object than Bun does. Pass `{ type }` to set one.
    if (typeof data === "object" && typeof data.arrayBuffer === "function") {
      return { bytes: buffer.from(new Uint8Array(await data.arrayBuffer())), type: OCTET_STREAM };
    }
    if (typeof data === "object" && typeof data.getReader === "function") {
      const reader = data.getReader();
      const chunks = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = buffer.from(value.buffer ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : new Uint8Array(value));
        chunks.push(chunk);
        total += chunk.length;
        // Refuse at the point where Bun would switch to multipart, rather than
        // growing a buffer nobody bounded.
        if (total > MULTIPART_THRESHOLD) {
          try {
            reader.cancel();
          } catch {
            /* the stream is already going nowhere */
          }
          throw new Error(shimMessage("Bun.write() to S3 with a stream body over " + MULTIPART_MIB + " MiB", MULTIPART_REASON));
        }
      }
      return { bytes: buffer.concat(chunks, total), type: OCTET_STREAM };
    }
    throw new TypeError(
      "S3Client.write() expects a string, ArrayBuffer, TypedArray, Blob, BunFile " +
        "or ReadableStream, got " +
        typeof data
    );
  };

  // The credentials live OUT of the instance, for two reasons. Bun's S3Client has
  // no own properties at all (measured: `Object.getOwnPropertyNames(client)` is
  // empty), so an own `_config` would be a visible divergence — and a worse one
  // than it looks, because an enumerable field holding a secret access key means
  // `console.log(client)` and `JSON.stringify(client)` print it.
  const configs = new WeakMap();
  const configOf = (client) => configs.get(client);
  const configFor = (client, options) =>
    options ? resolveS3Config({ ...configOf(client), ...options }, {}) : configOf(client);
  const targetOf = (client, path, options) => {
    const config = configFor(client, options);
    // Credentials before the path, in that order, because that is the order the
    // binary reports: with an empty environment `Bun.s3.presign("k")` is
    // ERR_S3_MISSING_CREDENTIALS, not the ERR_S3_INVALID_PATH the missing bucket
    // would also earn. Two things are wrong and the message names the first.
    requireS3Credentials(config);
    const { bucket, key, name } = s3KeyFromPath(path, config.bucket);
    return { config: bucket === config.bucket ? config : { ...config, bucket }, key, name };
  };
  const headOf = async (client, path, options) => {
    const { config, key } = targetOf(client, path, options);
    const request = buildS3Request({ config, method: "HEAD", key, hashers: hashers() });
    return { res: await s3Fetch(request, key), key };
  };

  class S3Client {
    constructor(options) {
      // Resolved once, like Bun's: a client is a credential holder, and a later
      // process.env edit does not move one that already exists. Nothing is
      // VALIDATED here — reading `Bun.s3` at module level must not throw, so the
      // credential check belongs to each call.
      configs.set(this, resolveS3Config(options, env()));
    }

    file(path, options) {
      const { config, key, name } = targetOf(this, path, options);
      return new S3File(this, config, key, options, name);
    }

    async write(path, data, options) {
      const { config, key } = targetOf(this, path, options);
      const body = await toBody(data);
      const request = buildS3Request({
        config,
        method: "PUT",
        key,
        extraHeaders: {
          "x-amz-acl": (options && options.acl) || config.acl,
          "x-amz-storage-class": (options && options.storageClass) || config.storageClass,
        },
        hashers: hashers(),
      });
      // Content-Type is not signed (measured), so it rides outside the signature.
      // An explicit `type` goes on the wire verbatim. The binary runs it through
      // its MIME table first and appends `;charset=utf-8` to the text-ish entries
      // it recognises (`text/plain`, `text/html`, `application/json`, but not
      // `application/xml` or `text/csv`), which is a table we cannot read and would
      // be guessing at. The parameter the caller wrote is the honest thing to send.
      const type = (options && options.type) || config.type || body.type;
      if (type) request.headers["content-type"] = type;
      request.body = body.bytes;
      const res = await s3Fetch(request);
      // Bun's PUT error carries no `path`, unlike every read. Measured, and
      // matched, so a handler written against the binary sees the same object.
      if (!res.ok) throw s3ErrorFromResponse({ status: res.status, bodyText: await safeText(res) });
      return body.bytes.length;
    }

    async delete(path, options) {
      const { config, key } = targetOf(this, path, options);
      const request = buildS3Request({ config, method: "DELETE", key, hashers: hashers() });
      const res = await s3Fetch(request, key);
      if (!res.ok) throw s3ErrorFromResponse({ status: res.status, bodyText: await safeText(res), path: key });
      return true;
    }

    unlink(path, options) {
      return this.delete(path, options);
    }

    async exists(path, options) {
      // 404 is the answer, not an error; every other status still throws, so a
      // 403 does not quietly read as "no such object" and send someone looking
      // for a missing file instead of a missing permission.
      const { res, key } = await headOf(this, path, options);
      if (res.status === 404) return false;
      if (!res.ok) throw s3ErrorFromResponse({ status: res.status, bodyText: await safeText(res), path: key });
      return true;
    }

    async size(path, options) {
      const { size } = await this.stat(path, options);
      // A HEAD that succeeded but shows no Content-Length is the browser hiding it,
      // not S3 omitting it: only a handful of response headers are readable
      // cross-origin, and Content-Length is not one of them until the bucket lists
      // it in ExposeHeaders. `size()` has to return a number or say why it cannot —
      // handing back null gives the caller a value that turns into 0 in arithmetic.
      if (size === null) {
        const err = new Error(
          "S3 answered the HEAD request but the page cannot read its Content-Length, so there is no " +
            "size to return. Cross-origin JavaScript only sees the response headers a bucket names in " +
            "the CORS policy's ExposeHeaders — add \"Content-Length\" (and \"ETag\") there. This is a " +
            "browser rule, not an S3 one, which is why the same call works in the bun binary."
        );
        err.name = "S3Error";
        err.code = "ERR_S3_HEADER_NOT_EXPOSED";
        err.path = String(path);
        throw err;
      }
      return size;
    }

    async stat(path, options) {
      const { res, key } = await headOf(this, path, options);
      if (!res.ok) throw s3ErrorFromResponse({ status: res.status, bodyText: await safeText(res), path: key });
      const header = (name) => (res.headers && res.headers.get ? res.headers.get(name) : null);
      const length = header("content-length");
      const modified = header("last-modified");
      return {
        etag: header("etag") || undefined,
        // A Date, not the raw string — Bun's shape. Null when the bucket does not
        // EXPOSE the header to the page (see the CORS notes in the header).
        lastModified: modified ? new Date(modified) : null,
        size: length == null ? null : Number(length),
        type: header("content-type") || undefined,
      };
    }

    async list(input, options) {
      const config = configFor(this, options);
      requireS3Credentials(config);
      if (!config.bucket) throw configError(INVALID_PATH_MESSAGE, "ERR_S3_INVALID_PATH");
      const request = buildS3Request({
        config,
        method: "GET",
        key: null,
        query: listQuery(input),
        hashers: hashers(),
      });
      const res = await s3Fetch(request);
      const text = await safeText(res);
      if (!res.ok) throw s3ErrorFromResponse({ status: res.status, bodyText: text });
      return parseListObjectsV2(text);
    }

    presign(path, options) {
      const { config, key } = targetOf(this, path, options);
      return presignS3Url({
        config,
        key,
        method: options && options.method,
        expiresIn: options && options.expiresIn,
        acl: (options && options.acl) || config.acl,
        storageClass: (options && options.storageClass) || config.storageClass,
        hashers: hashers(),
      }).url;
    }
  }

  // Bun exposes the same nine names as STATICS, taking the credentials as the
  // LAST argument, and they are what every "just read one object" snippet uses.
  // Spelled out one by one rather than generated in a loop, because the
  // credentials sit in a different position for `write` — a loop that took the
  // last argument would read a Uint8Array body as a credential bag.
  S3Client.file = (path, options) => new S3Client(options).file(path, options);
  S3Client.presign = (path, options) => new S3Client(options).presign(path, options);
  S3Client.write = (path, data, options) => new S3Client(options).write(path, data, options);
  for (const name of ["delete", "unlink", "exists", "size", "stat"]) {
    S3Client[name] = (path, options) => new S3Client(options)[name](path, options);
  }
  // `list` is the odd one: its first argument is the list query, so
  // `S3Client.list(credentials)` is a credentials-shaped query and throws for
  // missing credentials. Reproduced, because it is what the binary does.
  S3Client.list = (input, options) => new S3Client(options).list(input, options);

  /**
   * Bun's S3File: the Blob read protocol over one object. Like this repo's
   * BunFile it is NOT a platform `Blob` instance (bun-file.js's header explains
   * why duck-typing and `extends Blob` are both wrong here), so
   * `new Response(s3file)` stringifies — `new Response(s3file.stream())` and
   * `await s3file.bytes()` are the portable forms.
   *
   * Its state is in a WeakMap for the same reason the client's is, and here it
   * matters more: a file handle is the thing a debugging session logs, and that
   * state holds the secret access key. Bun's S3File has no own properties either.
   */
  const fileState = new WeakMap();
  const st = (file) => fileState.get(file);

  class S3File {
    constructor(client, config, key, options, name) {
      fileState.set(this, {
        client,
        config,
        key,
        name: name === undefined ? key : name,
        type: (options && options.type) || "",
        range: null,
      });
    }

    get name() {
      return st(this).name;
    }
    get bucket() {
      return st(this).config.bucket;
    }
    get type() {
      return st(this).type;
    }
    // Both are the binary's sentinels for "not known yet", and both are odd enough
    // that they have to be copied rather than reasoned about: a fresh S3File
    // reports `size: NaN`, and `lastModified` is 2^52-1, WebKit's Blob placeholder.
    // Nothing is fetched to answer either — unlike a local file there is no stat
    // without a network round trip. Call `stat()` for the real numbers.
    get size() {
      return NaN;
    }
    get lastModified() {
      return 4503599627370495;
    }

    async text() {
      return (await s3Get(this)).text();
    }
    async json() {
      return (await s3Get(this)).json();
    }
    async arrayBuffer() {
      return (await s3Get(this)).arrayBuffer();
    }
    async bytes() {
      return new Uint8Array(await (await s3Get(this)).arrayBuffer());
    }
    async blob() {
      return (await s3Get(this)).blob();
    }
    async formData() {
      return (await s3Get(this)).formData();
    }

    /**
     * A lazy Range window, like BunFile's — nothing is fetched here, and the
     * eventual GET carries `Range: bytes=start-end`, so a slice of a 4 GB object
     * transfers only the window. The three documented overloads all collapse to
     * "a string argument is the contentType".
     */
    slice(begin, end, type) {
      const self = st(this);
      let start = begin;
      let stop = end;
      let contentType = type;
      if (typeof begin === "string") {
        contentType = begin;
        start = undefined;
        stop = undefined;
      } else if (typeof end === "string") {
        contentType = end;
        stop = undefined;
      }
      const next = new S3File(self.client, self.config, self.key, { type: contentType || self.type }, self.name);
      const base = self.range || { start: 0, end: undefined };
      st(next).range = {
        start: (base.start || 0) + (start || 0),
        // A Range end is INCLUSIVE and a slice end is exclusive.
        end: stop === undefined ? base.end : (base.start || 0) + stop - 1,
      };
      return next;
    }

    stream() {
      // One GET, its body handed straight over: the Response body is already a
      // ReadableStream, and re-chunking it here would only add a copy.
      const file = this;
      let inner = null;
      return new ReadableStream({
        async pull(controller) {
          if (!inner) inner = (await s3Get(file)).body.getReader();
          const { done, value } = await inner.read();
          if (done) controller.close();
          else controller.enqueue(value);
        },
      });
    }

    exists(options) {
      return st(this).client.exists(st(this).key, own(this, options));
    }
    stat(options) {
      return st(this).client.stat(st(this).key, own(this, options));
    }
    delete(options) {
      return st(this).client.delete(st(this).key, own(this, options));
    }
    unlink(options) {
      return st(this).client.delete(st(this).key, own(this, options));
    }
    write(data, options) {
      return st(this).client.write(st(this).key, data, own(this, { type: st(this).type || undefined, ...(options || {}) }));
    }
    presign(options) {
      return st(this).client.presign(st(this).key, own(this, options));
    }

    /**
     * Bun's FileSink over S3, buffered and flushed as ONE PUT by `end()` — which
     * is what Bun does below its part size. Past that it is a multipart upload
     * and this throws, at the SHIM tier: possible here, unwritten, and the CORS
     * policy it would need (`ExposeHeaders: ETag`) is why it is not written
     * blind. See MULTIPART_REASON.
     */
    writer(options) {
      const file = this;
      const chunks = [];
      let total = 0;
      let ended = false;
      const sink = {
        write(chunk) {
          if (ended) throw new Error("S3File.writer().write() called after end() — the upload is done");
          const bytes =
            typeof chunk === "string"
              ? buffer.from(chunk, "utf8")
              : buffer.isBuffer(chunk)
                ? chunk
                : chunk instanceof ArrayBuffer
                  ? buffer.from(new Uint8Array(chunk))
                  : ArrayBuffer.isView(chunk)
                    ? buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
                    : null;
          if (!bytes) {
            throw new TypeError(
              "S3File.writer().write() expects a string, ArrayBuffer or TypedArray, got " + typeof chunk
            );
          }
          chunks.push(bytes);
          total += bytes.length;
          if (total > MULTIPART_THRESHOLD) {
            throw new Error(shimMessage("S3File.writer() past " + MULTIPART_MIB + " MiB", MULTIPART_REASON));
          }
          return bytes.length;
        },
        // Nothing can be flushed early without multipart: a PUT is one request and
        // S3 has no append. Reporting 0 bytes drained is the honest answer, and it
        // is why this is documented as buffering rather than streaming.
        flush: () => 0,
        start: () => undefined,
        ref: () => {},
        unref: () => {},
        async end() {
          if (ended) return total;
          ended = true;
          await st(file).client.write(st(file).key, buffer.concat(chunks, total), own(file, {
            type: st(file).type || undefined,
            ...(options || {}),
          }));
          return total;
        },
        close() {
          return sink.end();
        },
      };
      return sink;
    }
  }

  /**
   * The file's own bucket, forced onto whatever options the caller passed, because
   * a file remembers where it came from: `client.file("s3://other/k")` on a client
   * configured for `cfg` is key `other/k` in `cfg` (the binary ignores the bucket
   * in the URL when the client has one), and handing the client an `s3://` string
   * back would parse `cfg` a second time and ask for `cfg/other/k`.
   */
  const own = (file, options) => ({ ...(options || {}), bucket: st(file).config.bucket });

  /**
   * The one GET behind every read method. A Range window rides OUTSIDE the
   * signature — Bun does not sign it either — but it does have to be in the
   * bucket policy's AllowedHeaders.
   */
  const s3Get = async (file) => {
    const self = st(file);
    const request = buildS3Request({
      config: self.config,
      method: "GET",
      key: self.key,
      extraHeaders: self.range ? { range: rangeHeader(self.range) } : undefined,
      hashers: hashers(),
    });
    const res = await s3Fetch(request, self.key);
    if (!res.ok) throw s3ErrorFromResponse({ status: res.status, bodyText: await safeText(res), path: self.key });
    return res;
  };

  /**
   * `Bun.s3` — the default client, built from the environment. An OBJECT in Bun
   * rather than a class, and `Bun.s3 instanceof Bun.S3Client` is true there, so
   * it is an instance here too rather than a hand-written façade. Built eagerly
   * because reading `Bun.s3` must not throw; the credential error belongs to the
   * first call, as in Bun.
   */
  const s3 = new S3Client();

  /**
   * Does this path belong to S3? Used by Bun.file/Bun.write. Case-SENSITIVE,
   * because the binary is: `Bun.file("S3://b/k")` is a local file whose name is
   * the whole string, and routing it to S3 here would make the shim accept a
   * spelling that fails under `bun`.
   */
  const isS3Path = (path) => typeof path === "string" && path.startsWith("s3://");

  return { S3Client, s3, isS3Path, S3File };
}

const rangeHeader = ({ start, end }) => "bytes=" + (start || 0) + "-" + (end === undefined ? "" : end);
