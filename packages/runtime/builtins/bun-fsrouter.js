// Bun.FileSystemRouter — Next.js-style file-system routing over the VFS.
// https://bun.com/docs/api/file-system-router
//
// Two halves: a directory scan (which reuses Bun.Glob's walker, see bun-glob.js)
// and a route matcher (this file, pure).
//
// ---- why a sibling matcher and not compileRoutes/matchRoute -----------------
// bun.js already has a compiled route table with parameters and precedence
// (`compileRoutes`/`matchRoute`, serving Bun.serve's `routes` option), so reusing
// it is the obvious first move. It is the wrong one, and not because of syntax.
// The two routers are different *languages* with different precedence rules that
// happen to describe the same shape of thing:
//
//   Bun.serve routes     `/blog/:slug`, `/files/*`, `/*`; precedence is a single
//                        number per route (exact 0, param 1, wildcard 2, global 3),
//                        which is enough because a serve route has one wildcard and
//                        it is always last.
//   FileSystemRouter     `[slug]`, `[...rest]`, `[[...rest]]`, plus `index`
//                        collapsing and extension stripping; precedence is
//                        per-SEGMENT and left-to-right, because two routes can
//                        disagree at any position (`/[org]/settings` vs
//                        `/acme/[page]` for the path `/acme/settings`).
//
// Generalising `matchRoute` to carry both grammars means teaching it that
// specificity is a vector rather than a scalar, and then Bun.serve's routing —
// which is load-bearing for every previewed Bun app, and which the kernel spike
// covers today — inherits the risk of every edit made for the router. The two are
// each about forty lines. A sibling keeps Bun.serve's semantics frozen and lets
// this file say exactly what Next.js precedence is, which is the part that is
// silently wrong when approximated: a static segment must beat a dynamic one, and
// a catch-all must lose to both.
//
// ---- documented divergences (pinned in scripts/spike-bun-offline.mjs) -------
//   * `params` values are STRINGS, including for a catch-all: Bun types
//     `MatchedRoute.params` as `Record<string, string>`, so `[...slug]` matching
//     /a/b yields `{ slug: "a/b" }`, not Next.js's `["a", "b"]` array.
//   * `pathname` is the path AS PASSED IN, query string included — that is what
//     the documented example prints (`router.match("/settings?foo=bar")` →
//     `pathname: "/settings?foo=bar"`). Surprising, so it is pinned rather than
//     "fixed" into the stripped path a reader might expect.
//   * `fileExtensions` defaults to the four Next.js `pageExtensions` values
//     (.tsx/.ts/.jsx/.js). Bun does not publish its default list; guessing wider
//     invents routes and guessing narrower loses them, so we take the documented
//     Next.js set and let the option override it.
//   * Two files that resolve to the SAME route name (`blog.tsx` and
//     `blog/index.tsx`) throw at construction naming both files, instead of one of
//     them silently winning. Next.js treats this as a project error too, and
//     "which file is actually serving /blog" is not something a shim should decide
//     by directory-iteration order.
//   * `match()` on a Request/Response whose `url` is `""` throws. Only a fetched
//     Response carries a URL; one you constructed has the empty string, which parses
//     as the root path — so the quiet behaviour here is "every locally built Response
//     matches the index route", which is exactly the shape of wrong answer this shim
//     is not allowed to give.

import { createBunGlob } from "./bun-glob.js";

// Per-segment precedence. The ORDER of these values is the rule itself: a static
// segment beats a dynamic one, a dynamic one beats a catch-all, and an optional
// catch-all (which can also match nothing) is last.
export const SEGMENT_RANK = { static: 0, dynamic: 1, "catch-all": 2, "optional-catch-all": 3 };

const ROUTE_ERROR = (msg) => new Error("Bun.FileSystemRouter: " + msg);

// Parse one path segment of a route name (already extension-stripped).
// A malformed bracket segment throws: `[slug` is not a static segment named
// "[slug" in any real sense — it is a typo that would otherwise compile into a
// route no request can ever reach.
export function parseRouteSegment(raw, filePath) {
  const hasBracket = raw.indexOf("[") !== -1 || raw.indexOf("]") !== -1;
  if (!hasBracket) return { kind: "static", literal: raw };

  let m = /^\[\[\.\.\.([^\]]+)\]\]$/.exec(raw);
  if (m) return { kind: "optional-catch-all", param: m[1] };
  m = /^\[\.\.\.([^\]]+)\]$/.exec(raw);
  if (m) return { kind: "catch-all", param: m[1] };
  m = /^\[([^\]]+)\]$/.exec(raw);
  if (m && m[1][0] !== ".") return { kind: "dynamic", param: m[1] };

  throw ROUTE_ERROR(
    `cannot parse the route segment ${JSON.stringify(raw)} in ${JSON.stringify(filePath)}. ` +
      `Next.js-style segments are [param], [...catchAll] or [[...optionalCatchAll]].`,
  );
}

const stripExtension = (name, fileExtensions) => {
  for (const ext of fileExtensions) if (name.length > ext.length && name.endsWith(ext)) return name.slice(0, -ext.length);
  return null;
};

export const DEFAULT_FILE_EXTENSIONS = [".tsx", ".ts", ".jsx", ".js"];

// Compile a list of paths RELATIVE to the router's dir (posix separators) into a
// precedence-ordered route table. Pure — no filesystem — so the whole grammar and
// every precedence rule is testable without a kernel.
export function compileFileSystemRoutes(relativeFiles, options) {
  const fileExtensions = (options && options.fileExtensions) || DEFAULT_FILE_EXTENSIONS;
  const routes = [];
  const seen = new Map(); // route name -> the file that claimed it

  for (const rel of relativeFiles.slice().sort()) {
    const parts = rel.split("/").filter((s) => s.length > 0);
    const base = stripExtension(parts[parts.length - 1], fileExtensions);
    if (base === null) continue; // not a page file
    // `index` collapses into its directory: pages/index.tsx is "/", and
    // pages/blog/index.tsx is "/blog". Note this happens BEFORE segment parsing,
    // so pages/blog/[slug]/index.tsx is "/blog/[slug]".
    const nameParts = base === "index" ? parts.slice(0, -1) : parts.slice(0, -1).concat([base]);
    const segments = nameParts.map((p) => parseRouteSegment(p, rel));

    for (let i = 0; i < segments.length; i++) {
      const s = segments[i];
      if ((s.kind === "catch-all" || s.kind === "optional-catch-all") && i !== segments.length - 1) {
        throw ROUTE_ERROR(
          `a catch-all segment must be last, but ${JSON.stringify(rel)} has one at position ${i + 1}.`,
        );
      }
    }

    const name = "/" + nameParts.join("/");
    if (seen.has(name)) {
      throw ROUTE_ERROR(
        `two files resolve to the route ${JSON.stringify(name)}: ${JSON.stringify(seen.get(name))} and ` +
          `${JSON.stringify(rel)}. Rename one — picking a winner here would depend on directory order.`,
      );
    }
    seen.set(name, rel);

    routes.push({ name, file: rel, segments, kind: routeKind(segments) });
  }

  // Precedence is a per-segment comparison, left to right — the first position
  // where two routes disagree decides, which is what makes `/acme/[page]` beat
  // `/[org]/settings` for /acme/settings even though both have one dynamic
  // segment. A single "how dynamic is this route" score cannot express that.
  //
  // A route that has ENDED ranks above any segment (-1 below), which is the rule
  // that keeps `/` ahead of `/[[...catchall]]`: both match the path "/", and the
  // documented answer is the index file. Sorting "more segments first" instead
  // reads as more-specific and is right for every pair EXCEPT the catch-alls,
  // which are the only routes that can match a shorter path than they are.
  const rankAt = (route, i) => (i < route.segments.length ? SEGMENT_RANK[route.segments[i].kind] : -1);
  routes.sort((a, b) => {
    const n = Math.max(a.segments.length, b.segments.length);
    for (let i = 0; i < n; i++) {
      const d = rankAt(a, i) - rankAt(b, i);
      if (d !== 0) return d;
    }
    // Identical shapes: order by name so the table is stable whatever order the
    // directory walk produced.
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });

  return routes;
}

function routeKind(segments) {
  let kind = "exact";
  for (const s of segments) {
    if (s.kind === "optional-catch-all") return "optional-catch-all";
    if (s.kind === "catch-all") kind = "catch-all";
    else if (s.kind === "dynamic" && kind === "exact") kind = "dynamic";
  }
  return kind;
}

// Split "/settings?foo=bar" into its path and its query object.
export function splitPathAndQuery(input) {
  const q = input.indexOf("?");
  const path = q === -1 ? input : input.slice(0, q);
  const query = {};
  if (q !== -1) {
    const params = new URLSearchParams(input.slice(q + 1));
    // Last value wins for a repeated key, matching Bun's Record<string, string>.
    for (const [k, v] of params) query[k] = v;
  }
  return { path, query };
}

// Match a pathname (no query) against a compiled table. Returns { route, params }
// or null. Pure, and the half that has to be exactly right.
export function matchFileSystemRoute(routes, pathname) {
  const parts = pathname
    .split("/")
    .filter((s) => s.length > 0)
    .map((s) => {
      try { return decodeURIComponent(s); } catch { return s; }
    });

  for (const route of routes) {
    const params = {};
    let i = 0;
    let ok = true;
    for (let s = 0; s < route.segments.length; s++) {
      const seg = route.segments[s];
      if (seg.kind === "static") {
        if (parts[i] !== seg.literal) { ok = false; break; }
        i++;
      } else if (seg.kind === "dynamic") {
        if (i >= parts.length) { ok = false; break; }
        params[seg.param] = parts[i];
        i++;
      } else {
        // Both catch-alls swallow the rest of the path; only the optional one may
        // swallow nothing. The value is the remaining segments joined with "/",
        // because Bun types params as Record<string, string> (see the header).
        const rest = parts.slice(i);
        if (seg.kind === "catch-all" && rest.length === 0) { ok = false; break; }
        if (rest.length) params[seg.param] = rest.join("/");
        i = parts.length;
      }
    }
    if (ok && i === parts.length) return { route, params };
  }
  return null;
}

// The class the `Bun` global exposes. The scan is Bun.Glob's walker (bun-glob.js)
// rather than a second recursive readdir: one traversal implementation means one
// place where symlinks, hidden files and the syscall cost are handled.
export function createBunFileSystemRouter({ lazy, process }) {
  const { Glob } = createBunGlob({ lazy, process });

  return class FileSystemRouter {
    constructor(options) {
      const opts = options || {};
      // Bun supports exactly one style and documents that; an unknown one must not
      // quietly fall back to Next.js semantics, since the whole point of the option
      // is which grammar the brackets are in.
      if (opts.style !== "nextjs") {
        throw ROUTE_ERROR(
          `style must be "nextjs" (got ${JSON.stringify(opts.style)}). Bun itself supports only ` +
            `Next.js-style pages routing; the Next.js 13 app directory is not supported either.`,
        );
      }
      if (!opts.dir || typeof opts.dir !== "string") {
        throw ROUTE_ERROR("`dir` is required and must be a string (the pages directory to scan).");
      }
      const path = lazy("path");
      this.dir = path.resolve(process.cwd(), opts.dir);
      this.style = "nextjs";
      this.origin = opts.origin || "";
      this.assetPrefix = opts.assetPrefix || "";
      this.fileExtensions = opts.fileExtensions ? opts.fileExtensions.slice() : DEFAULT_FILE_EXTENSIONS.slice();
      // Bun reads the directory on construction; .reload() re-reads it.
      this.reload();
    }

    reload() {
      // `**/*` with the walker's defaults: files only, no dotfiles, symlinked
      // directories not traversed. Extension filtering is done here rather than in
      // the pattern so an extension containing glob metacharacters cannot change
      // the meaning of the scan.
      const files = [];
      for (const rel of new Glob("**/*").scanSync({ cwd: this.dir })) {
        if (this.fileExtensions.some((ext) => rel.endsWith(ext))) files.push(rel);
      }
      this._routes = compileFileSystemRoutes(files, { fileExtensions: this.fileExtensions });
      // `.routes` is the documented name -> filePath map, in precedence order.
      this.routes = {};
      for (const r of this._routes) this.routes[r.name] = this._filePath(r);
      return undefined;
    }

    _filePath(route) {
      return this.dir + "/" + route.file;
    }

    // origin + assetPrefix + the file's path RELATIVE TO `dir` — the documented
    // example is dir "./pages" + assetPrefix "_next/static/" giving
    // "https://mydomain.com/_next/static/index.tsx", i.e. "pages" is not in it.
    _src(route) {
      const origin = this.origin.endsWith("/") ? this.origin.slice(0, -1) : this.origin;
      return origin + "/" + this.assetPrefix + route.file;
    }

    match(input) {
      let raw;
      if (typeof input === "string") raw = input;
      else if (input && typeof input.url === "string") {
        // A locally constructed Response has `url === ""` (only a fetched one
        // carries a URL), and an empty string parses as the root path — so this
        // would hand back the index route for any Response the caller built. That
        // is a plausible-looking wrong answer, which is the one thing this shim
        // may not produce, so it is loud instead.
        if (input.url === "") {
          throw ROUTE_ERROR(
            "match() was given a Request/Response whose `url` is the empty string, which only a " +
              "locally constructed Response has. An empty URL would match the index route; pass the " +
              "pathname you meant instead.",
          );
        }
        raw = input.url; // Request / Response
      } else if (input && typeof input.href === "string") raw = input.href; // URL, harmless to accept
      else {
        throw ROUTE_ERROR(
          "match() takes a pathname string, a Request or a Response (got " + typeof input + ").",
        );
      }
      // A full URL is reduced to path + query; a bare path is used as-is.
      if (raw.indexOf("://") !== -1) {
        try {
          const u = new URL(raw);
          raw = u.pathname + u.search;
        } catch { /* fall through and treat it as a path */ }
      }
      const { path: pathname, query } = splitPathAndQuery(raw);
      const hit = matchFileSystemRoute(this._routes, pathname);
      if (!hit) return null;
      return {
        filePath: this._filePath(hit.route),
        kind: hit.route.kind,
        name: hit.route.name,
        // Documented oddity: the input path, query string included. See the header.
        pathname: raw,
        src: this._src(hit.route),
        params: hit.params,
        query,
      };
    }
  };
}