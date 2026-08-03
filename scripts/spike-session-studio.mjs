// Spike (net: a real npm install): the shipped "Login & sessions" template
// actually logs in, stays logged in, and logs out — in-VM, on real
// `express-session`.
//
// spike-cookie-session.mjs proves the kernel's jar against a hand-written server,
// which is the right shape for a gate that must run on every push. It cannot
// prove this: `express-session` signs the cookie (`sid=s%3A<id>.<hmac>`),
// URL-encodes it, rotates the id on `regenerate()`, and reads the value back
// through its own parser. If the jar mangled a `%` or dropped a `.` the
// hand-written server would never notice and every real app would.
//
// It also drives the parts a template gate cannot see: the form POST arrives
// urlencoded, the redirect chain works, and the view counter proves the SAME
// session came back rather than a fresh one being minted per request.
//
// Files come from the shipped template, so this cannot pass against code nobody
// runs.
//
// Run: node scripts/spike-session-studio.mjs

import { bootSpikeKernel, writeProject, npmInstall, waitListen } from "./lib/spike-harness.mjs";
import { loadShippedTemplates } from "./lib/shipped-templates.mjs";

const DIR = "/app";
const PORT = Number(process.env.VV_PORT || 3000);

const templates = await loadShippedTemplates();
const tpl = templates.find((t) => t.manifest?.id === "session-login");
if (!tpl) {
  console.log("RESULT: FAIL — no `session-login` template is registered");
  process.exit(1);
}
console.log(`\n== shipped template: ${tpl.manifest.name} (${Object.keys(tpl.files).length} files) ==`);

const h = await bootSpikeKernel();
writeProject(h.kernel, DIR, tpl.files);

const inst = await npmInstall(h, { dir: DIR });
console.log(`  npm install ok: ${inst.ok !== false}`);

const bound = await waitListen(h, { dir: DIR, port: PORT, argv: [tpl.manifest.entry] });
console.log(`  server bound: ${bound}`);
if (!bound) process.exit(1);

let failed = 0;
function ok(cond, label, detail) {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${label}${cond || detail === undefined ? "" : `\n        ${detail}`}`);
  if (!cond) failed++;
}

const text = (b) => (typeof b === "string" ? b : Buffer.from(b || "").toString());
async function call(url, { method = "GET", form = null, prefix = null } = {}) {
  const body = form == null ? "" : new URLSearchParams(form).toString();
  const r = await h.kernel.handleHttpRequest(PORT, {
    port: PORT,
    method,
    url,
    headers: {
      host: `127.0.0.1:${PORT}`,
      // The Service Worker strips /preview/<port> off the path and hands it back
      // as this header; a guest that ignores it emits URLs that leave the preview.
      ...(prefix ? { "x-forwarded-prefix": prefix } : {}),
      ...(form == null ? {} : { "content-type": "application/x-www-form-urlencoded" }),
    },
    body,
  });
  return { status: r.status, body: text(r.body), headers: r.headers };
}
const whoami = async () => JSON.parse((await call("/whoami")).body);

console.log("\n== anonymous ==");
{
  const home = await call("/");
  ok(home.status === 200 && home.body.includes("Log in"), "the login form is served");
  const who = await whoami();
  ok(who.user === null, "nobody is logged in yet", JSON.stringify(who));
}

console.log("\n== logging in ==");
let signedCookie = null;
{
  const bad = await call("/login", { method: "POST", form: { username: "duc", password: "nope" } });
  ok(bad.status === 302 && /bad=1/.test(bad.headers.location || ""), "a wrong password is refused", JSON.stringify(bad.headers.location));
  const afterBad = await whoami();
  ok(afterBad.user === null, "…and does not create a session");

  const good = await call("/login", { method: "POST", form: { username: "duc", password: "vivari" } });
  ok(good.status === 302, "a correct password redirects");
  const set = good.headers["set-cookie"];
  signedCookie = Array.isArray(set) ? set[0] : set;
  ok(!!signedCookie && signedCookie.startsWith("sid=s%3A"), "express-session issued a SIGNED, url-encoded cookie", String(signedCookie).slice(0, 60));

  const who = await whoami();
  ok(who.user === "duc", "the next request is authenticated — the signature survived the jar", JSON.stringify(who));
  ok(/^sid=s%3A/.test(who.cookie || ""), "…and the server received the cookie byte for byte", who.cookie);
}

console.log("\n== the session persists across requests ==");
{
  const a = await call("/");
  ok(a.body.includes("Hello, duc"), "the home page greets the logged-in user");
  const first = /loaded this page <strong>(\d+)<\/strong>/.exec(a.body);
  const b = await call("/");
  const second = /loaded this page <strong>(\d+)<\/strong>/.exec(b.body);
  ok(
    first && second && Number(second[1]) > Number(first[1]),
    "the view counter advances, so it is the SAME session, not a new one per request",
    `${first && first[1]} then ${second && second[1]}`,
  );
}

console.log("\n== session fixation and logout ==");
{
  const before = (await whoami()).cookie;
  const again = await call("/login", { method: "POST", form: { username: "guest", password: "guest" } });
  const set = again.headers["set-cookie"];
  const rotated = Array.isArray(set) ? set[0] : set;
  ok(!!rotated && rotated.split(";")[0] !== String(before).split(";")[0], "regenerate() rotated the session id on login", `${String(before).slice(0, 28)} -> ${String(rotated).slice(0, 28)}`);
  ok((await whoami()).user === "guest", "…and the new session is the new user");

  const out = await call("/logout", { method: "POST", form: {} });
  ok(out.status === 302, "logout redirects");
  const who = await whoami();
  ok(who.user === null, "the session is gone", JSON.stringify(who));
  const home = await call("/");
  ok(home.body.includes("Log in"), "…and the login form is back");
}

console.log("\n== behind the preview's path prefix ==");
{
  // The 404 this leg exists for: clicking Log in POSTed to http://localhost:5173/login
  // — the studio's own origin — instead of /preview/3000/login. Everything above
  // passed while that was broken, because driving the kernel directly puts the app
  // at the root, where an absolute /login happens to be correct.
  //
  // A fetch() from the page survives a missing prefix (the worker routes it by the
  // iframe that issued it) but a form POST and a redirect are NAVIGATIONS, and the
  // worker deliberately leaves those to the network. So a root-absolute action
  // leaves the preview and hits the studio.
  const PREFIX = "/preview/3000";
  const home = await call("/", { prefix: PREFIX });
  ok(home.body.includes(`action="${PREFIX}/login"`), "the login form posts inside the preview", `no ${PREFIX}/login in the form`);
  ok(!home.body.includes('action="/login"'), "…and not to the studio's own origin");

  const login = await call("/login", { method: "POST", form: { username: "duc", password: "vivari" }, prefix: PREFIX });
  ok(String(login.headers.location || "").startsWith(`${PREFIX}/`), "the post-login redirect stays inside the preview", JSON.stringify(login.headers.location));

  const inside = await call("/", { prefix: PREFIX });
  ok(inside.body.includes(`action="${PREFIX}/logout"`), "so does the logout form");

  const bad = await call("/login", { method: "POST", form: { username: "duc", password: "no" }, prefix: PREFIX });
  ok(String(bad.headers.location || "").startsWith(`${PREFIX}/`), "…and so does the failure redirect", JSON.stringify(bad.headers.location));

  // Mode C: a wildcard per-port origin serves at the root and sends no prefix.
  // State-independent on purpose: whichever form the page is showing, the action
  // must be root-absolute and carry no prefix.
  const rootMode = await call("/", { prefix: null });
  ok(
    /action="\/(login|logout)"/.test(rootMode.body) && !rootMode.body.includes("/preview/"),
    "with no prefix header it emits root-absolute URLs, which is what a per-port origin needs",
  );
}

console.log(`\nRESULT: ${failed === 0 ? "PASS — the shipped template's session flow works in-VM" : `FAIL — ${failed} check(s)`}`);
process.exit(failed === 0 ? 0 : 1);