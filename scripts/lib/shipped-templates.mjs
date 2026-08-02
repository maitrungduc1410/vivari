// Read templates straight out of packages/studio/src/vv/templates.ts.
//
// This used to be ~160 lines of hand-written scanner that looked for `manifest:
// { … }` and `files: { "<name>": `…`, … }` blocks and attributed each to its
// `id:`, because the studio file is TypeScript and the repo's own type-stripper
// cannot parse it. Node can: since 22.6 it strips type annotations from an
// imported .ts on its own, and 22 is what .nvmrc and every CI job pin. So the
// file is now IMPORTED and the real exported objects are handed back.
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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const TEMPLATES_TS = path.join(ROOT, "packages/studio/src/vv/templates.ts");

const pathToFileUrl = (p) => new URL("file://" + p).href;

let loaded = null;

/**
 * The studio's own TEMPLATES array. Cached: the import is evaluated once.
 *
 * A failure here is a real failure — templates.ts using a TS feature Node's
 * stripper refuses (enum, namespace, parameter properties) or simply not
 * compiling — so it is rethrown with that context rather than swallowed into a
 * silent pass against nothing.
 */
export async function loadShippedTemplates() {
  if (loaded) return loaded;
  try {
    const mod = await import(pathToFileUrl(TEMPLATES_TS));
    loaded = mod.TEMPLATES;
  } catch (e) {
    throw new Error(
      `could not load ${path.relative(ROOT, TEMPLATES_TS)} (Node ${process.versions.node} strips types on import; ` +
        `enums/namespaces/parameter properties are refused): ${e && e.message}`,
      { cause: e },
    );
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