#!/usr/bin/env bash
# Cloudflare Pages build for the SECOND project — the separate preview origin
# (mode B, e.g. vivari-preview.pages.dev).
#
#   Build command:            bash scripts/cloudflare-build-preview.sh
#   Build output directory:   dist-preview
#
# This origin is pure static hosting: it serves only the preview Service Worker,
# the hidden bridge doc, and the DevTools CDP backend. The SW relays every preview
# request over a MessagePort to the kernel running in the IDE tab (which lives on
# the main origin). So we only need the studio's `public/` assets + chobitsu.js —
# NOT the landing/docs/embed surfaces, and NOT the vendored package managers (those
# run in the kernel on the IDE origin). We still build the Wasm crates because the
# studio's Vite build imports @vivari/core (which pulls them in) to emit sw.js etc.
#
# Point the IDE build at this origin with:
#   VITE_PREVIEW_ORIGIN=https://vivari-preview.pages.dev  (on the MAIN project)
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

# --- bun (studio uses it) ------------------------------------------------------
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

# --- Studio build (only for its public/ assets: sw.js, __vv-bridge.html, and the
#     copied vv-devtools/chobitsu.js) --------------------------------------------
( cd packages/studio && bun install && bun run build )

# --- Assemble the preview origin into dist-preview/ ----------------------------
node scripts/assemble-preview.mjs