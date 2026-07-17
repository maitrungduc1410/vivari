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

# --- Studio (served under /studio/) --------------------------------------------
( cd packages/studio && bun install && VV_BASE=/studio/ bun run build )

# --- Landing (served at /) -----------------------------------------------------
( cd sites/landing && bun install && bun run build )

# --- Docs (served under /docs/) ------------------------------------------------
( cd sites/docs && npm install --no-audit --no-fund && npm run build )

# --- Assemble into dist/ -------------------------------------------------------
node scripts/assemble-site.mjs
