// Probe (offline, Wasm-free, no kernel): the cookie jar's RFC 6265 subset.
//
// The jar exists because the preview seam drops cookies both ways — see
// packages/kernel-host/cookie-jar.js for why — and it is the kind of code where
// being 95% right is worse than being absent: a path rule that is slightly too
// generous hands one route's session to another, and an expiry rule that is
// slightly too eager logs a user out for no reason. Neither shows up as an
// error, so both get pinned here.
//
// The end-to-end proof is scripts/spike-cookie-session.mjs, which drives a real
// in-VM server. This is the unit layer: every branch of the parse, the path match
// and the ordering, without booting anything.
//
// Run: node scripts/probe-cookie-jar.mjs

import { CookieJar, defaultPath, pathMatches, parseSetCookie } from "../packages/kernel-host/cookie-jar.js";

let failed = 0;
function ok(cond, label) {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${label}`);
  if (!cond) failed++;
}
function eq(got, want, label) {
  ok(got === want, `${label}${got === want ? "" : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
}

console.log("\n== default-path (RFC 6265 §5.1.4) ==");
// The one that matters: a cookie set by POST /api/login with no Path must not be
// scoped to `/`, or an API hands its session to every other route on the port.
eq(defaultPath("/api/login"), "/api", "/api/login -> /api");
eq(defaultPath("/login"), "/", "/login -> /");
eq(defaultPath("/"), "/", "/ -> /");
eq(defaultPath("/a/b/c"), "/a/b", "/a/b/c -> /a/b");
eq(defaultPath(""), "/", "empty -> /");
eq(defaultPath("noslash"), "/", "relative -> /");

console.log("\n== path-match, including the boundary that leaks ==");
ok(pathMatches("/", "/anything"), "/ matches everything");
ok(pathMatches("/foo", "/foo"), "/foo matches itself");
ok(pathMatches("/foo", "/foo/bar"), "/foo matches /foo/bar");
ok(pathMatches("/foo/", "/foo/bar"), "trailing slash matches below it");
ok(!pathMatches("/foo", "/foobar"), "/foo does NOT match /foobar — a startsWith would leak here");
ok(!pathMatches("/foo/bar", "/foo"), "a deeper cookie does not match a shallower path");

console.log("\n== parsing ==");
{
  const c = parseSetCookie("sid=abc; Path=/; HttpOnly; SameSite=Lax");
  eq(c.name, "sid", "name");
  eq(c.value, "abc", "value");
  eq(c.path, "/", "explicit Path");
  ok(c.httpOnly === true, "HttpOnly is recorded (and then ignored — nothing here is page JS)");
}
{
  const c = parseSetCookie("empty=; Path=/");
  eq(c.value, "", "an empty value is a value, not a delete");
}
{
  const c = parseSetCookie('json={"a":1}; Path=/');
  eq(c.value, '{"a":1}', "a value containing = and quotes survives");
}
ok(parseSetCookie("novalue") === null, "a line with no `=` is discarded, not guessed");
ok(parseSetCookie("=novalue") === null, "a nameless cookie is discarded");
ok(parseSetCookie(null) === null, "a non-string does not throw");
ok(parseSetCookie("") === null, "an empty line does not throw");
{
  // A guest can send anything; the kernel must not throw on it.
  const c = parseSetCookie("a=b; Max-Age=notanumber; Expires=notadate");
  ok(c !== null && c.expiresAt === null, "unparseable Max-Age/Expires leave a session cookie, not a deleted one");
}

console.log("\n== lifetimes ==");
{
  const now = 1_000_000;
  const jar = new CookieJar();
  jar.store("a=1; Path=/; Max-Age=60", "/", now);
  eq(jar.header("/", now), "a=1", "a Max-Age cookie is live before it expires");
  eq(jar.header("/", now + 59_000), "a=1", "…still live one second early");
  eq(jar.header("/", now + 61_000), "", "…and gone one second late");
}
{
  const now = 1_000_000;
  const jar = new CookieJar();
  jar.store("a=1; Path=/", "/", now);
  jar.store("a=1; Path=/; Max-Age=0", "/", now);
  eq(jar.header("/", now), "", "Max-Age=0 deletes — this is what res.clearCookie() sends");
  eq(jar.size, 0, "…and the entry is actually removed, not just hidden");
}
{
  const now = Date.parse("2026-01-01T00:00:00Z");
  const jar = new CookieJar();
  jar.store("a=1; Path=/; Expires=Thu, 01 Jan 2026 00:00:00 GMT", "/", now);
  eq(jar.header("/", now), "", "an Expires in the past deletes");
  jar.store("b=2; Path=/; Expires=Fri, 01 Jan 2027 00:00:00 GMT", "/", now);
  eq(jar.header("/", now), "b=2", "an Expires in the future keeps");
}
{
  const now = 1_000_000;
  const jar = new CookieJar();
  // Max-Age must win over Expires (§5.3 step 3), or a server that sends both to
  // support old clients gets the wrong one honoured.
  jar.store("a=1; Path=/; Max-Age=60; Expires=Thu, 01 Jan 1970 00:00:00 GMT", "/", now);
  eq(jar.header("/", now), "a=1", "Max-Age wins over a contradicting Expires");
}
{
  const jar = new CookieJar();
  jar.store("a=1; Path=/", "/", 1_000_000);
  eq(jar.header("/", 1_000_000 + 10 * 365 * 86400_000), "a=1", "a session cookie outlives any clock, until the kernel goes");
}

console.log("\n== identity and scoping ==");
{
  const jar = new CookieJar();
  jar.store("sid=root; Path=/", "/");
  jar.store("sid=admin; Path=/admin", "/admin");
  // Same name, different path: two cookies, not one overwriting the other.
  eq(jar.size, 2, "(name, path) is the identity — same name at two paths is two cookies");
  eq(jar.header("/admin"), "sid=admin; sid=root", "the deeper path comes first (§5.4), and both are sent");
  eq(jar.header("/other"), "sid=root", "the /admin cookie is not sent elsewhere");
}
{
  const jar = new CookieJar();
  jar.store("a=1; Path=/", "/");
  jar.store("a=2; Path=/", "/");
  eq(jar.size, 1, "re-setting the same (name, path) replaces");
  eq(jar.header("/"), "a=2", "…with the newer value");
}
{
  const jar = new CookieJar();
  jar.store("first=1; Path=/", "/");
  jar.store("second=2; Path=/", "/");
  jar.store("first=1b; Path=/", "/");
  // Re-setting keeps creation order (§5.3 step 11): some servers read only the
  // first occurrence of a name, so this ordering is contract, not cosmetics.
  eq(jar.header("/"), "first=1b; second=2", "a re-set cookie keeps its original position");
}
{
  const jar = new CookieJar();
  // Node hands `set-cookie` over as an array; a single string must work too.
  eq(jar.store(["a=1; Path=/", "b=2; Path=/"], "/"), 2, "an array of Set-Cookie lines stores both");
  eq(jar.store("c=3; Path=/", "/"), 1, "a bare string stores one");
  eq(jar.store(null, "/"), 0, "no Set-Cookie stores nothing");
  eq(jar.header("/"), "a=1; b=2; c=3", "all three are sent");
}
{
  const jar = new CookieJar();
  jar.store("sid=abc", "/api/login"); // no Path -> default-path
  eq(jar.header("/api/anything"), "sid=abc", "a Path-less cookie is scoped to its directory");
  eq(jar.header("/"), "", "…and NOT to the site root");
}
{
  const jar = new CookieJar();
  jar.store("sid=abc; Path=/", "/");
  eq(jar.header("/x?a=1&b=2"), "sid=abc", "a query string is not part of the path");
}

console.log(`\nRESULT: ${failed === 0 ? "PASS — cookie jar semantics pinned" : `FAIL — ${failed} check(s)`}`);
process.exit(failed === 0 ? 0 : 1);