// What the kernel says when it cannot read a vendor manifest.
//
// Plain JS with no imports, like terminal-feedback.js beside it, so the kernel
// worker and `scripts/spike-install-latency.mjs` run the same code. The worker
// cannot be imported from Node, and this used to be gated by slicing the
// function out of kernel-worker.ts with a regex and evaluating it with stubbed
// globals. The decision is pure; only the posting stays in the worker.

const errMsg = (err) => (err && err.message) || String(err);

/**
 * A body that will not PARSE is the defect signature. A body that never
 * arrived in full — a reset or abort mid-transfer — rejects `r.json()` with a
 * TypeError instead, and must not be reported as one.
 *
 * `name` as well as `instanceof`, because an error built in another realm (a
 * test harness, a frame) fails the identity check while being exactly this.
 */
export function isParseFailure(err) {
  return err instanceof SyntaxError || (!!err && err.name === "SyntaxError");
}

/**
 * Decide what to say — once per session per manifest — when the kernel could
 * not read one, saying what actually failed rather than asserting one cause.
 *
 * Of the conditions that arrive here, only the first is a build defect:
 *
 *   2xx + a body that will not parse — the producer never ran, and a Pages SPA
 *     answers a missing file with 200 and index.html. This is the historical
 *     bug: it hid the shipped-snapshot feature having no producer at all, and
 *     then hid `predev` not running the two producers, at the cost of a user's
 *     afternoon. Loud, on `stderr` (red in the studio terminal, where they were
 *     looking) and on the console too, since the locks manifest is read at
 *     project-create when no terminal may be attached yet — and it names the
 *     command, because a warning that only reports is one more thing to scroll
 *     past.
 *   2xx + a body that failed mid-transfer — the file is there and the link
 *     dropped it. Transient: dim, quoting the error, claiming no cause.
 *   404 — legitimately absent. `KERNEL_ASSETS` marks both manifests optional,
 *     "opt-in by design", and an embedder hosting @vivari/core without a vendor
 *     tree is the ordinary case. Prescribing a command from a repo they have
 *     never seen, in red, in their users' terminal, would be this build's own
 *     contract contradicting itself. Dim, and no remedy.
 *   5xx — transient and nothing to do with how the app was built. Dim, and no
 *     cause claimed.
 *   A transport error (status 0, no response at all) — the same: dim, quoting
 *     the error, no cause claimed.
 *   The locks path's budget rejection — the manifest may be fine and the link
 *     slow. Always status 0: the budget only bounds the wait for headers. Dim.
 *
 * The distinction that keeps the loud case worth reading is one level down as
 * well: a manifest that is present and simply has no entry for this project is
 * the common case (coverage is one template), and says nothing at all. That is
 * why the report is made at the manifest load and not at the lookup.
 *
 * @param {{ tag: string, manifest: string, fix: string, produces: string,
 *           status: number, err: unknown }} m
 *   `status` is the HTTP status received, or 0 when no response arrived.
 * @returns {{ line: string, stream?: "stderr", dim?: true, console: boolean }}
 *   `line` is the terminal line; `stream`/`dim` are the log message's styling;
 *   `console` says whether to mirror it with `console.warn`.
 */
export function formatAbsentManifest(m) {
  const head = `  [${m.tag}] ${m.manifest}`;
  const ok = m.status >= 200 && m.status < 300;
  if (ok && isParseFailure(m.err)) {
    return {
      line:
        `${head} could not be read (${errMsg(m.err)}). This build was assembled without it, ` +
        `so nothing is prebuilt and every project installs from scratch. Fix: \`${m.fix}\`.`,
      stream: "stderr",
      console: true,
    };
  }
  let line;
  if (m.status === 404) {
    line = `${head} is not served — no prebuilt ${m.produces} for this origin.`;
  } else if (ok) {
    // Name the status: "could not be fetched" next to a bare network error
    // would read as no response at all, when one did arrive.
    line = `${head} could not be fetched (HTTP ${m.status}, then ${errMsg(m.err)}).`;
  } else {
    line = `${head} could not be fetched (${m.status ? `HTTP ${m.status}` : errMsg(m.err)}).`;
  }
  return { line, dim: true, console: false };
}
