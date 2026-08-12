// Read templates straight out of packages/studio/src/vv/templates.ts.
//
// This used to be ~160 lines of hand-written scanner that looked for `manifest:
// { … }` and `files: { "<name>": `…`, … }` blocks and attributed each to its
// `id:`, because the studio file is TypeScript and the repo's own type-stripper
// cannot parse it. Node can, on the versions this repo supports — see
// `import-ts.mjs` for which those are and what happens on the ones that need
// help. So the file is now IMPORTED and the real exported objects are handed
// back.
//
// That is not just less code, it is strictly more correct. The scanner could
// only see inline string literals, so any file built by a helper
// (`backendDemoHtml("Bun")`, `bunPageStyles()`) or interpolating a local
// (`${JSON.stringify(HOME)}`) came back either skipped or containing the
// UNEVALUATED `${…}` source — which then failed to run as a project, for a
// reason that had nothing to do with the template. Every file map here is now
// exactly the bytes `vv-create-project` writes into the VFS.
//
// Nothing here is language-specific. Shared by scripts/spike-python-offline.mjs
// (registry integrity, no Pyodide), scripts/spike-python-bridge.mjs (runs the
// files against real Pyodide) and scripts/spike-bun-templates.mjs (runs them
// against the kernel).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { importTs, STRIP_DEFAULT_FROM } from "./import-ts.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const TEMPLATES_TS = path.join(ROOT, "packages/studio/src/vv/templates.ts");

let loaded = null;

/**
 * The studio's own TEMPLATES array. Cached: the import is evaluated once.
 *
 * A failure here is a real failure, so it is rethrown rather than swallowed
 * into a silent pass against nothing — but WHICH failure decides what the
 * message says, and this catch has now been wrong twice in the same place. The
 * first version asserted one cause for all of them ("Node <v> strips types on
 * import; enums/namespaces/parameter properties are refused"), which a
 * contributor on 22.16 read on a Node that does not strip types at all, about a
 * file that contains no enum. The second kept a generic fallback that answered
 * the SAME failure with "it did not compile or threw while evaluating: Unknown
 * file extension" — true, useless, and pointing at the file again.
 *
 * So every shape `importTs` can hand back is named, and the fallback now only
 * covers faults that really are in the file.
 */
export async function loadShippedTemplates() {
  if (loaded) return loaded;
  try {
    const mod = await importTs(TEMPLATES_TS);
    loaded = mod.TEMPLATES;
  } catch (e) {
    // Already names the Node versions and both remedies; wrapping it would only
    // bury them.
    if (e && e.code === "ERR_NODE_CANNOT_STRIP_TYPES") throw e;
    const rel = path.relative(ROOT, TEMPLATES_TS);
    const why =
      e && e.code === "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX"
        ? // The one failure the original message described, and the only one where
          // naming these features is a diagnosis rather than a guess.
          `it uses a TypeScript feature Node's stripper refuses (enum, namespace with runtime code, ` +
          `parameter properties, import alias)`
        : e && e.code === "ERR_UNKNOWN_FILE_EXTENSION"
          ? // `importTs` settles stripping on a scratch file before it touches this
            // one, so reaching here means the probe could not run at all — a tmpdir
            // that is missing, full or read-only — and this Node needed it.
            `this Node cannot import .ts files and the stripper probe could not run (no writable ` +
            `temp dir?); re-run with NODE_OPTIONS=--experimental-strip-types or upgrade to Node ` +
            `${STRIP_DEFAULT_FROM}+`
          : "it did not compile or threw while evaluating";
    throw new Error(`could not load ${rel}: ${why}: ${e && e.message}`, { cause: e });
  }
  return loaded;
}

/** The raw text, for checks that are about the SOURCE rather than the values. */
export function readTemplatesSource() {
  return fs.readFileSync(TEMPLATES_TS, "utf8");
}

/**
 * { templateId: { "path/in/project": contents } } for every template.
 *
 * The `source` argument is ignored and kept only so the existing call sites
 * (`readShippedTemplates(readTemplatesSource())`) keep reading naturally.
 */
export async function readShippedTemplates() {
  const out = {};
  for (const t of await loadShippedTemplates()) out[t.manifest.id] = t.files;
  return out;
}

/** { templateId: manifest }. */
export async function readShippedManifests() {
  const out = {};
  for (const t of await loadShippedTemplates()) out[t.manifest.id] = t.manifest;
  return out;
}