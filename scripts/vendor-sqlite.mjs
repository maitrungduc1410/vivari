// Deliver the vendored SQLite engine to the studio's same-origin vendor tree, and
// (with --refresh) re-pull it from upstream.
//
//   node scripts/vendor-sqlite.mjs             # validate + copy. NO NETWORK.
//   node scripts/vendor-sqlite.mjs --refresh   # re-download the pinned version first
//
// WHY THE ARTIFACT IS COMMITTED. The other vendor scripts (npm/yarn/pnpm/corepack/
// tsgo/pyodide) download on every predev/prebuild because their payloads are 12-200 MB
// and cannot live in git. This one is 846 KB — smaller than packages/runtime/node/vendor/
// napi-wasm-runtime.js, which is already committed — and committing it buys something
// the others cannot have: CI never has to reach the network to have a working SQLite.
// That matters here specifically, because the bun spikes ASSERT against a real engine
// and AGENTS.md's documented trap is a spike that silently skips when its Wasm artifact
// is missing and therefore looks green. With the bytes in the tree there is no skip path
// to get wrong: the artifact is either there or the checkout is broken.
//
// So the division is: packages/runtime/vendor/sqlite/sqlite3.wasm is the source of truth
// and is committed; packages/studio/public/vendor/sqlite/sqlite3.wasm is a build output
// (that whole tree is gitignored) that this script produces so the browser can fetch it
// same-origin. A CDN is not an option under COEP: require-corp, and Vivari's premise is
// that nothing is fetched from off-origin at runtime anyway.
//
// Provenance: the bytes are lifted verbatim from the official @sqlite.org/sqlite-wasm
// npm package, which is sqlite.org's own build. We take ONLY dist/sqlite3.wasm — not
// sqlite3.mjs (578 KB of Emscripten glue whose entry point is async) and not
// sqlite3-opfs-async-proxy.js. SQLite is public domain (https://www.sqlite.org/copyright.html),
// so vendoring the compiled artifact carries no obligation; provenance is recorded in
// the manifest beside it regardless.

import { execFileSync } from "node:child_process";
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync,
  statSync, writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ENGINE_IMPORT_NAMES, ENGINE_MEMORY } from "../packages/runtime/builtins/bun-sqlite.js";

// Pinned. Bumping this is a deliberate act: re-run with --refresh, check the validation
// output below, and commit the new bytes + manifest together.
const SQLITE_WASM_VERSION = "3.53.0-build1";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIR = path.join(ROOT, "packages/runtime/vendor/sqlite");
const SRC_WASM = path.join(SRC_DIR, "sqlite3.wasm");
const MANIFEST = path.join(SRC_DIR, "manifest.json");
const OUT_DIR = path.join(ROOT, "packages/studio/public/vendor/sqlite");
const OUT_WASM = path.join(OUT_DIR, "sqlite3.wasm");

// Every symbol the runtime reaches for. Checking these at vendor time turns "a refreshed
// upstream build dropped an export" from a mystery at the user's first `new Database()`
// into a failure here, with the name printed.
const REQUIRED_EXPORTS = [
  "__wasm_call_ctors", "__indirect_function_table", "malloc", "free",
  "sqlite3_initialize", "sqlite3_libversion", "sqlite3_vfs_register", "sqlite3_vfs_find",
  "sqlite3_open_v2", "sqlite3_close_v2", "sqlite3_prepare_v2", "sqlite3_step",
  "sqlite3_reset", "sqlite3_finalize", "sqlite3_clear_bindings", "sqlite3_expanded_sql",
  "sqlite3_bind_null", "sqlite3_bind_int64", "sqlite3_bind_double", "sqlite3_bind_text",
  "sqlite3_bind_blob", "sqlite3_bind_parameter_count", "sqlite3_bind_parameter_name",
  "sqlite3_column_count", "sqlite3_column_name", "sqlite3_column_decltype",
  "sqlite3_column_type", "sqlite3_column_int64", "sqlite3_column_double",
  "sqlite3_column_text", "sqlite3_column_blob", "sqlite3_column_bytes",
  "sqlite3_changes", "sqlite3_last_insert_rowid", "sqlite3_get_autocommit",
  "sqlite3_errmsg", "sqlite3_extended_errcode", "sqlite3_error_offset",
  "sqlite3_serialize", "sqlite3_deserialize", "sqlite3_malloc", "sqlite3_free",
];

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

// Read the memory import's declared limits straight out of the binary. The loader
// creates env.memory itself, and a mismatch between what it creates and what the module
// declares is a LinkError — so this is the check that catches an upstream build changing
// its initial heap or its shared flag.
function readMemoryImport(bytes) {
  let p = 8; // skip \0asm + version
  const u32 = () => {
    let r = 0;
    let shift = 0;
    let byte;
    do {
      byte = bytes[p++];
      r |= (byte & 0x7f) << shift;
      shift += 7;
    } while (byte & 0x80);
    return r >>> 0;
  };
  while (p < bytes.length) {
    const id = bytes[p++];
    const len = u32();
    const end = p + len;
    if (id !== 2) {
      p = end;
      continue;
    }
    const count = u32();
    for (let i = 0; i < count; i++) {
      // Two length-prefixed names, skipped. NOT `p += u32()`: compound assignment reads
      // the old p before u32() advances it, which silently discards the advance.
      const modLen = u32();
      p += modLen;
      const nameLen = u32();
      p += nameLen;
      const kind = bytes[p++];
      if (kind === 0) u32(); // function: type index
      else if (kind === 1) {
        p++; // table: element type
        const flags = u32();
        u32(); // initial
        if (flags & 1) u32(); // maximum
      } else if (kind === 2) {
        const flags = u32();
        const initial = u32();
        const maximum = flags & 1 ? u32() : null;
        return { initial, maximum, shared: !!(flags & 2) };
      } else if (kind === 3) p += 2;
    }
    return null;
  }
  return null;
}

function validate(bytes) {
  const problems = [];
  if (Buffer.from(bytes.subarray(0, 4)).toString("latin1") !== "\0asm") {
    throw new Error("not a WebAssembly module (bad magic bytes)");
  }

  const mod = new WebAssembly.Module(bytes);

  const exported = new Set(WebAssembly.Module.exports(mod).map((e) => e.name));
  const missing = REQUIRED_EXPORTS.filter((n) => !exported.has(n));
  if (missing.length) problems.push("missing exports: " + missing.join(", "));

  // The loader supplies a fixed import set; anything new is an unsatisfiable import.
  const supplied = new Set();
  for (const [mod_, names] of Object.entries(ENGINE_IMPORT_NAMES)) {
    for (const n of names) supplied.add(mod_ + "." + n);
  }
  const extra = WebAssembly.Module.imports(mod)
    .map((i) => i.module + "." + i.name)
    .filter((k) => !supplied.has(k));
  if (extra.length) {
    problems.push(
      "the build imports symbols the loader does not provide: " + extra.join(", ") +
        " — add them to ENGINE_IMPORT_NAMES in packages/runtime/builtins/bun-sqlite.js",
    );
  }

  const mem = readMemoryImport(bytes);
  if (!mem) problems.push("no imported memory found (the loader creates env.memory)");
  else {
    if (mem.shared) problems.push("the build wants a SHARED memory; the loader creates an unshared one");
    if (mem.initial > ENGINE_MEMORY.initial) {
      problems.push(
        `declared minimum memory is ${mem.initial} pages but ENGINE_MEMORY.initial is ` +
          `${ENGINE_MEMORY.initial}`,
      );
    }
    if (mem.maximum != null && mem.maximum !== ENGINE_MEMORY.maximum) {
      problems.push(
        `declared maximum memory is ${mem.maximum} pages but ENGINE_MEMORY.maximum is ` +
          `${ENGINE_MEMORY.maximum}`,
      );
    }
  }

  if (problems.length) {
    throw new Error("vendored sqlite3.wasm failed validation:\n  - " + problems.join("\n  - "));
  }
  return { exportCount: exported.size, memory: mem };
}

function refresh() {
  const dir = mkdtempSync(path.join(tmpdir(), "vv-vendor-sqlite-"));
  try {
    console.log(`fetching @sqlite.org/sqlite-wasm@${SQLITE_WASM_VERSION} …`);
    execFileSync("npm", ["pack", `@sqlite.org/sqlite-wasm@${SQLITE_WASM_VERSION}`], {
      cwd: dir,
      stdio: "inherit",
    });
    const tgz = readdirSync(dir).find((f) => f.endsWith(".tgz"));
    if (!tgz) throw new Error("npm pack produced no tarball");
    execFileSync("tar", ["-xzf", tgz], { cwd: dir });
    // The package restructured between 3.41 (sqlite-wasm/jswasm/) and 3.53 (dist/), so
    // try both rather than pinning a layout that a bump will silently break.
    const candidates = [
      path.join(dir, "package/dist/sqlite3.wasm"),
      path.join(dir, "package/sqlite-wasm/jswasm/sqlite3.wasm"),
    ];
    const found = candidates.find((p) => existsSync(p));
    if (!found) {
      throw new Error("sqlite3.wasm not found in the package; looked in:\n  " + candidates.join("\n  "));
    }
    const bytes = readFileSync(found);
    const info = validate(bytes);
    mkdirSync(SRC_DIR, { recursive: true });
    writeFileSync(SRC_WASM, bytes);
    writeFileSync(
      MANIFEST,
      JSON.stringify(
        {
          _comment:
            "Generated by scripts/vendor-sqlite.mjs --refresh. sqlite3.wasm beside this " +
            "file is the official sqlite.org build, taken verbatim from the npm package " +
            "below; none of the package's Emscripten glue is used. SQLite is public domain.",
          package: "@sqlite.org/sqlite-wasm",
          version: SQLITE_WASM_VERSION,
          file: path.relative(path.join(dir, "package"), found),
          bytes: bytes.length,
          sha256: sha256(bytes),
          exportCount: info.exportCount,
          memory: info.memory,
        },
        null,
        2,
      ) + "\n",
    );
    console.log(`wrote ${path.relative(ROOT, SRC_WASM)} (${bytes.length} bytes) + manifest.json`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const wantRefresh = process.argv.includes("--refresh");
if (wantRefresh) refresh();

if (!existsSync(SRC_WASM)) {
  console.error(
    `vendor-sqlite: ${path.relative(ROOT, SRC_WASM)} is missing.\n` +
      "It is a committed artifact, so this means an incomplete checkout. Restore it with " +
      "git, or re-create it with: node scripts/vendor-sqlite.mjs --refresh",
  );
  process.exit(1);
}

const bytes = readFileSync(SRC_WASM);
const info = validate(bytes);

// Idempotent: skip the copy when the destination is already these exact bytes, so
// predev/prebuild:studio stay cheap on a warm tree.
if (existsSync(OUT_WASM) && statSync(OUT_WASM).size === bytes.length &&
    sha256(readFileSync(OUT_WASM)) === sha256(bytes)) {
  console.log(`vendor-sqlite: ${path.relative(ROOT, OUT_WASM)} already up to date (${bytes.length} bytes)`);
} else {
  mkdirSync(OUT_DIR, { recursive: true });
  copyFileSync(SRC_WASM, OUT_WASM);
  console.log(
    `vendor-sqlite: ${path.relative(ROOT, OUT_WASM)} <- ${path.relative(ROOT, SRC_WASM)} ` +
      `(${bytes.length} bytes, ${info.exportCount} exports)`,
  );
}