#!/usr/bin/env bash
# Cloudflare Pages build for the unified Vivari site (landing + docs + blog + studio).
#
#   Build command:            bash scripts/cloudflare-build.sh
#   Build output directory:   dist
#
# It provisions the Rust toolchain + wasm-pack (the studio bundles the VFS/codec/
# crypto Wasm crates from source), builds each surface, then assembles dist/.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

# --- Rust + wasm-pack (for the Wasm crates the studio imports from source) ------
if ! command -v cargo >/dev/null 2>&1; then
  curl https://sh.rustup.rs -sSf | sh -s -- -y --profile minimal
fi
export PATH="$HOME/.cargo/bin:$PATH"
rustup target add wasm32-unknown-unknown
if ! command -v wasm-pack >/dev/null 2>&1; then
  curl https://rustwasm.github.io/wasm-pack/installer/init.sh -sSf | sh
fi

# --- bun (studio + landing use it) ---------------------------------------------
if ! command -v bun >/dev/null 2>&1; then
  curl -fsSL https://bun.sh/install | bash
  export BUN_INSTALL="$HOME/.bun"
  export PATH="$BUN_INSTALL/bin:$PATH"
fi

# --- SDK deps + Wasm (web target) ----------------------------------------------
npm ci
npm run build:vfs
npm run build:codec
npm run build:crypto

# --- Vendored package managers (real npm/yarn/pnpm/corepack + tsgo) + Pyodide ---
# The studio's own `bun run build` (below) does NOT run the root predev/
# prebuild:studio hooks, so the gitignored delivery assets in
# packages/studio/public/vendor/**  must be built explicitly here. Without them
# the studio ships with no `npm`/`yarn`/`pnpm` on PATH — and, without
# vendor:pyodide, no `python` (its CPython/WASM core + wheels live under
# public/vendor/pyodide/, copied into dist by the Vite build). Uses host npm + network.
npm run vendor:npm
npm run vendor:yarn
npm run vendor:pnpm
npm run vendor:corepack
npm run vendor:tsgo
npm run vendor:pyodide
# ruff and sqlite were in prebuild:studio but not here, and this script is the
# one that runs on the deploy — so /studio/vendor/sqlite/sqlite3.wasm answered
# with the landing page's index.html and a 200. A 404 would have been noticed;
# a 200 of the wrong content type is not, which is why the two lists must not
# drift again. Keep them in step with `prebuild:studio` in package.json.
npm run vendor:ruff
npm run vendor:sqlite

# --- Resolved lockfiles + prebuilt node_modules snapshots ----------------------
# The two producers behind the first-install cost. `vendor:locks` resolves a
# package-lock.json per template so Arborist never takes its full-packument
# branch (measured on react-ts: 143.0 MiB of metadata down to zero), and
# `vendor:depcache` installs the covered templates once, here, so a first run in
# the browser restores the tree instead of building it. Both are pure
# optimisations that fail soft — a template with no asset installs the way it
# always has — and both are keyed on the lock, so locks must come first.
npm run vendor:locks
npm run vendor:depcache

# --- Studio (served under /studio/) --------------------------------------------
( cd packages/studio && bun install && VV_BASE=/studio/ bun run build )

# --- Embed playground (served under /embed/; iframed by the docs) ---------------
( cd sites/embed && bun install && VV_BASE=/embed/ bun run build )

# --- Landing (served at /) -----------------------------------------------------
( cd sites/landing && bun install && bun run build )

# --- Docs (served under /docs/) ------------------------------------------------
( cd sites/docs && npm install --no-audit --no-fund && npm run build )

# --- Blog (served under /blog/) ------------------------------------------------
( cd sites/blog && npm install --no-audit --no-fund && npm run build )

# --- Assemble into dist/ -------------------------------------------------------
node scripts/assemble-site.mjs