// Spike (OFFLINE): a file: URL with a ?query or #hash loads its own module
// instance, as in Node's ESM loader, which keys modules by their whole URL.
//
// c12 (through @nuxt/kit) reloads nuxt.config.ts with `import(url + "?_N")` and
// compares the result with the config it already has. Our loader cached modules
// by path alone, so the reload returned the first evaluation and `nuxt dev`
// printed "nuxt.config.ts saved without changing config" for every edit.
//
// A plain path and a query-less URL keep sharing the CommonJS cache; the same
// query twice returns the same instance.
//
// createModuleSystem runs over host Node's fs, so this exercises the shipped
// loader with no kernel and no Wasm.
//
// Run:  node scripts/spike-import-query.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createModuleSystem } from "../packages/runtime/module.js";

let failures = 0;
const check = (label, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${label}`);
  if (!cond) failures++;
};

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vv-import-query-")));
const file = path.join(root, "config.cjs");
const url = pathToFileURL(file).href;
const sys = createModuleSystem({
  fs,
  path,
  builtins: {},
  process,
  nodeModules: { has: () => false, require: () => ({}), internalBinding: () => ({}) },
});
const require = sys.makeRequire(root);
const value = (id) => require(id).value;

try {
  fs.writeFileSync(file, "module.exports = { value: 1 };");
  check("plain path loads v1", value(file) === 1);
  check("?_1 loads v1", value(`${url}?_1`) === 1);

  fs.writeFileSync(file, "module.exports = { value: 2 };");
  check("plain path still cached (v1)", value(file) === 1);
  check("query-less URL shares the plain path's instance (v1)", value(url) === 1);
  check("same ?_1 still cached (v1)", value(`${url}?_1`) === 1);
  check("new ?_2 evaluates the file again (v2)", value(`${url}?_2`) === 2);
  check("new #t2 evaluates the file again (v2)", value(`${url}#t2`) === 2);
  check("?_2 twice is one instance", require(`${url}?_2`) === require(`${url}?_2`));

  // The way c12 actually reloads: a dynamic import() of an ESM config from an ESM
  // module. That goes through the transpiler's __oc_import, not a plain require, so the
  // query has to survive that path too.
  const cfg = path.join(root, "cfg.mjs");
  const cfgUrl = pathToFileURL(cfg).href;
  fs.writeFileSync(cfg, "export default { value: 1 };");
  fs.writeFileSync(
    path.join(root, "reload.mjs"),
    `export async function load(n) { return (await import(${JSON.stringify(cfgUrl)} + "?t=" + n)).default.value; }`,
  );
  const { load } = require(path.join(root, "reload.mjs"));
  const first = await load(1);
  fs.writeFileSync(cfg, "export default { value: 2 };");
  const second = await load(2);
  check(`ESM import() with ?t=1 loads v1 (${first})`, first === 1);
  check(`ESM import() with a new ?t=2 sees the edit (${second})`, second === 2);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(failures ? `RESULT: FAIL (${failures})` : "RESULT: PASS");
process.exit(failures ? 1 : 0);
