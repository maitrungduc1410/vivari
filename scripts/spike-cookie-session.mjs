// Spike (offline, needs the Wasm VFS): a login survives to the next request.
//
// It did not. The preview seam drops cookies in both directions — the browser
// appends `Cookie` after the Service Worker, so the SW cannot forward one, and a
// `Set-Cookie` on a Response the SW synthesised never enters the browser's store.
// So every session flow in Node — `express-session`, Passport, a CSRF token,
// "remember me" — issued a cookie into a void: login returned 200, the next
// request arrived with NO `Cookie` header at all, and the app answered 401 while
// looking completely correct from the outside. Nothing logged an error, because
// nothing was an error; the client just never sent anything back.
//
// The jar now lives in the kernel, one per port (packages/kernel-host/cookie-jar.js).
// probe-cookie-jar.mjs pins the RFC 6265 semantics as pure functions; this drives
// the whole path through a real in-VM server, which is the only way to catch the
// parts that are not in the jar: that the kernel attaches on the way in, harvests
// on the way out, and keeps two ports apart.
//
// No install and no network: plain node:http, offline tier, every push.
//
// Run: node scripts/spike-cookie-session.mjs

import { bootSpikeKernel, writeProject, waitListen } from "./lib/spike-harness.mjs";

const DIR = "/app";
const PORT = Number(process.env.VV_PORT || 3600);
const PORT2 = PORT + 1;

// A session server of the shape a real one has: an opaque id in an HttpOnly
// cookie, a second non-HttpOnly cookie beside it, a route scoped under /api, and
// a logout that expires the cookie instead of deleting server state.
const SERVER = (port, tag) => `const http = require('http');
const sessions = Object.create(null);
let n = 0;
const send = (res, code, obj) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
};
http.createServer((req, res) => {
  const cookie = req.headers.cookie || '';
  const sid = (/(?:^|;\\s*)sid=([^;]*)/.exec(cookie) || [])[1];
  const url = req.url.split('?')[0];

  if (url === '/login') {
    const id = '${tag}-' + (++n);
    sessions[id] = { user: 'duc' };
    res.setHeader('Set-Cookie', [
      'sid=' + id + '; Path=/; HttpOnly',
      'theme=dark; Path=/',
    ]);
    return send(res, 200, { ok: true, id: id });
  }
  if (url === '/logout') {
    // What res.clearCookie() sends: same name and path, already expired.
    res.setHeader('Set-Cookie', ['sid=; Path=/; Max-Age=0', 'theme=; Path=/; Max-Age=0']);
    return send(res, 200, { ok: true });
  }
  if (url === '/me') {
    const s = sid && sessions[sid];
    return send(res, s ? 200 : 401, { cookie: cookie, sid: sid || null, user: s ? s.user : null, port: ${port} });
  }
  if (url === '/api/token') {
    // No Path attribute: RFC 6265 default-path scopes this to /api, and it must
    // NOT leak to /.
    res.setHeader('Set-Cookie', 'csrf=t0k3n');
    return send(res, 200, { ok: true });
  }
  if (url === '/api/echo') return send(res, 200, { cookie: cookie });
  if (url === '/weird') {
    // A value with the characters that break naive splitting, and an Expires
    // whose own comma once destroyed the pair when two cookies were joined.
    res.setHeader('Set-Cookie', [
      'blob=eyJhIjoxfQ==; Path=/; Expires=Fri, 01 Jan 2027 00:00:00 GMT',
      'plain=a b c; Path=/',
    ]);
    return send(res, 200, { ok: true });
  }
  if (url === '/upload' && req.method === 'POST') {
    // Cookies and the inbound-body path in one request, since both rewrite the
    // request object on its way through the kernel.
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      res.setHeader('Set-Cookie', 'uploaded=yes; Path=/');
      send(res, 200, { bytes: Buffer.concat(chunks).length, cookie: cookie });
    });
    return;
  }
  send(res, 404, { ok: false });
}).listen(${port}, () => console.log('session server listening on ${port}'));
`;

const h = await bootSpikeKernel();
writeProject(h.kernel, DIR, { "server.js": SERVER(PORT, "a"), "server2.js": SERVER(PORT2, "b") });

const bound = await waitListen(h, { dir: DIR, port: PORT, argv: ["server.js"] });
const bound2 = await waitListen(h, { dir: DIR, port: PORT2, argv: ["server2.js"] });
console.log(`  servers bound: ${bound} / ${bound2}`);
if (!bound || !bound2) process.exit(1);

let failed = 0;
function ok(cond, label, detail) {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${label}${cond || detail === undefined ? "" : `\n        ${detail}`}`);
  if (!cond) failed++;
}

const call = async (url, { port = PORT, method = "GET", body = "" } = {}) => {
  const r = await h.kernel.handleHttpRequest(port, {
    port,
    method,
    url,
    headers: { host: `127.0.0.1:${port}`, ...(body ? { "content-type": "application/octet-stream" } : {}) },
    body,
  });
  let json = null;
  try {
    json = JSON.parse(typeof r.body === "string" ? r.body : Buffer.from(r.body).toString());
  } catch {
    /* leave null; the assertion reports it */
  }
  return { status: r.status, json, headers: r.headers };
};

console.log("\n== the break this exists for ==");
{
  const before = await call("/me");
  ok(before.status === 401, "no cookie yet, so /me is 401 — the starting point");
  const login = await call("/login");
  ok(login.status === 200, "/login succeeds");
  ok(Array.isArray(login.headers["set-cookie"]) && login.headers["set-cookie"].length === 2, "the response carries TWO Set-Cookie lines");
  const after = await call("/me");
  ok(after.status === 200 && after.json?.user === "duc", "the NEXT request is authenticated — this returned 401 before the jar", JSON.stringify(after.json));
  ok(after.json?.sid === login.json?.id, "…with the same session id the server issued");
  ok(/theme=dark/.test(after.json?.cookie || ""), "the second cookie survived too, not just the first");
}

console.log("\n== logout ==");
{
  const out = await call("/logout");
  ok(out.status === 200, "/logout succeeds");
  const me = await call("/me");
  ok(me.status === 401, "…and the session is gone: Max-Age=0 really removes the cookie");
  ok(!/theme/.test(me.json?.cookie || ""), "both cookies were cleared", JSON.stringify(me.json));
}

console.log("\n== path scoping (the leak that would not look like a bug) ==");
{
  await call("/api/token");
  const api = await call("/api/echo");
  ok(/csrf=t0k3n/.test(api.json?.cookie || ""), "a Path-less cookie set at /api/token reaches /api/echo");
  const root = await call("/me");
  ok(!/csrf/.test(root.json?.cookie || ""), "…and does NOT reach /, where a startsWith would have leaked it", JSON.stringify(root.json));
}

console.log("\n== values that break naive parsing ==");
{
  await call("/weird");
  const me = await call("/me");
  const c = me.json?.cookie || "";
  ok(/blob=eyJhIjoxfQ==/.test(c), "a base64 value keeps its `=` padding", c);
  ok(/plain=a b c/.test(c), "a value with spaces survives");
}

console.log("\n== one jar per port ==");
{
  const login2 = await call("/login", { port: PORT2 });
  ok(login2.status === 200, "the second server logs in independently");
  const me2 = await call("/me", { port: PORT2 });
  ok(me2.json?.sid === login2.json?.id, "port B sees port B's session");
  const me1 = await call("/me");
  ok(me1.json?.sid !== login2.json?.id, "port A did NOT receive port B's cookie — separate origins, separate jars", `A saw ${JSON.stringify(me1.json?.sid)}, B issued ${JSON.stringify(login2.json?.id)}`);
}

console.log("\n== a caller that sends its own Cookie owns the request ==");
{
  // spike-bun.mjs caught the first version of this: the jar merged its cookies
  // into an explicit header, so a driver describing one client silently received
  // another client's session. Nothing is lost on the real path — a request from
  // the preview never arrives with a Cookie header, because the browser attaches
  // it after the Service Worker.
  await call("/login");
  const r = await h.kernel.handleHttpRequest(PORT, {
    port: PORT,
    method: "GET",
    url: "/me",
    headers: { host: `127.0.0.1:${PORT}`, cookie: "sid=someone-else" },
    body: "",
  });
  const json = JSON.parse(typeof r.body === "string" ? r.body : Buffer.from(r.body).toString());
  ok(json.cookie === "sid=someone-else", "the jar stays out of a request that already has a Cookie", JSON.stringify(json.cookie));
  ok(r.status === 401, "…so an unknown session really is unknown, rather than rescued by the jar");
  const mine = await call("/me");
  ok(mine.status === 200, "and the jar's own session still works on the next request without one");
}

console.log("\n== cookies and a request body in the same request ==");
{
  const up = await call("/upload", { method: "POST", body: "x".repeat(4096) });
  ok(up.status === 200 && up.json?.bytes === 4096, "the body still arrives intact", JSON.stringify(up.json));
  const me = await call("/me", { port: PORT });
  ok(/uploaded=yes/.test(me.json?.cookie || ""), "and a cookie set on that response was harvested");
}

console.log(`\nRESULT: ${failed === 0 ? "PASS — a session survives the seam" : `FAIL — ${failed} check(s)`}`);
process.exit(failed === 0 ? 0 : 1);