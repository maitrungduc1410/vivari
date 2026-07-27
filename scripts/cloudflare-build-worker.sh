#!/usr/bin/env bash
# Build the static assets for the mode-C wildcard preview Worker.
#
#   npm run build:worker        # build studio + assemble worker/public/
#   npm run deploy:worker       # wrangler deploy (from worker/)
#
# The Worker (worker/src/index.js) is pure static hosting for the preview Service
# Worker runtime, served on wildcard per-port hosts `vv-<token>--<port>.<domain>`.
# It runs NO kernel and NO studio UI: the SW relays every preview request over a
# MessagePort to the kernel in the IDE tab (which lives on the main origin). So we
# only need the studio's `public/` assets + chobitsu.js — NOT the landing/docs/embed
# surfaces or the vendored package managers. We still build the Wasm crates because
# the studio's Vite build imports @vivari/core (which pulls them in) to emit sw.js.
#
# Point the IDE build at this Worker's domain with:
#   VITE_PREVIEW_WILDCARD_DOMAIN=jamesisme.com   (on the MAIN project)
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

# --- Studio build (only for its public/ assets: sw.js, __vv-bridge.html, the boot
#     page, and the copied vv-devtools/chobitsu.js) -----------------------------
( cd packages/studio && bun install && bun run build )

# --- Assemble the Worker's static assets into worker/public/ -------------------
node scripts/assemble-worker.mjs