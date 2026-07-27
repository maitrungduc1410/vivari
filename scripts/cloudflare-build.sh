#!/usr/bin/env bash
# Cloudflare Pages build for the unified Vivari site (landing + docs + studio).
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

# --- Studio (served under /studio/) --------------------------------------------
( cd packages/studio && bun install && VV_BASE=/studio/ bun run build )

# --- Embed playground (served under /embed/; iframed by the docs) ---------------
( cd sites/embed && bun install && VV_BASE=/embed/ bun run build )

# --- Landing (served at /) -----------------------------------------------------
( cd sites/landing && bun install && bun run build )

# --- Docs (served under /docs/) ------------------------------------------------
( cd sites/docs && npm install --no-audit --no-fund && npm run build )

# --- Assemble into dist/ -------------------------------------------------------
node scripts/assemble-site.mjs