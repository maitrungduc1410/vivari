// Set the release version across the publishable SDK workspaces.
//
// Why not `npm version --workspace @vivari/core`? That command bumps the target
// package's version and then reifies the workspace to sync the lockfile. During
// that reify @vivari/react (and examples/basic) still declare
// `@vivari/core@^0.0.1`, which the freshly bumped local core no longer satisfies,
// so npm falls back to the public registry and dies with:
//   npm error 404 '@vivari/core@^0.0.1' is not in this registry.
// npm also does NOT rewrite the interdependency range, so even with
// `--workspaces-update=false` the published @vivari/react would still point at a
// stale, unpublishable `@vivari/core` range.
//
// This script sets the version on the released packages AND rewrites the internal
// `@vivari/core` range on its dependents in lockstep, with no install/reify — so
// `npm pack` / `npm publish --workspace` emit a coherent tree that resolves the
// internal dependency to the version being shipped.
//
//   node scripts/set-sdk-version.mjs <semver>

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`Usage: node scripts/set-sdk-version.mjs <semver>  (got: ${JSON.stringify(version)})`);
  process.exit(1);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INTERNAL = "@vivari/core";
const range = `^${version}`;
const DEP_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

// Packages that carry the released SDK version.
const RELEASE_PKGS = ["packages/core", "packages/react"];
// Packages whose internal @vivari/core range must track the bump so a reify (or a
// consumer of the published tarball) links the shipped version, not a dead range.
// examples/basic is private (never published) but shares the workspace, so its
// range must move too or a workspace reify would 404 on the old spec.
const DEPENDENTS = ["packages/react", "examples/basic"];

function edit(rel, mutate) {
  const file = path.join(ROOT, rel, "package.json");
  const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
  mutate(pkg);
  fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
  return pkg;
}

for (const rel of RELEASE_PKGS) {
  const pkg = edit(rel, (p) => {
    p.version = version;
  });
  console.log(`${pkg.name}: version -> ${version}`);
}

for (const rel of DEPENDENTS) {
  edit(rel, (p) => {
    for (const field of DEP_FIELDS) {
      const deps = p[field];
      if (deps && Object.prototype.hasOwnProperty.call(deps, INTERNAL)) {
        console.log(`${p.name}: ${field}.${INTERNAL} -> ${range}`);
        deps[INTERNAL] = range;
      }
    }
  });
}