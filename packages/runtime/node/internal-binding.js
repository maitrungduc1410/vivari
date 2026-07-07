// internalBinding — the seam Node's lib/ uses to reach its C++ core.
//
// In real Node, `internalBinding('fs')` returns the native (C++) module. In
// OpenContainer (Path B), THIS is where we substitute our own implementations:
// JS shims, Wasm codecs, or calls down to the Rust VFS via the sync bridge. The
// JS layer above the binding line (Node's real lib/) stays unmodified.
//
// Bindings are added as each real lib/ module comes online: 'buffer' (codecs),
// with 'fs' (Rust VFS), 'zlib', etc. to follow.

import { createBufferBinding } from "./bindings/buffer.js";

// Node's v8::PropertyFilter values used by getOwnNonIndexProperties.
const ALL_PROPERTIES = 0;
const ONLY_ENUMERABLE = 2;

function getOwnNonIndexProperties(obj, filter) {
  const isIndex = (k) => /^(?:0|[1-9]\d*)$/.test(k) && Number(k) <= 0xffffffff;
  const keep = (d) => (filter === ONLY_ENUMERABLE ? d.enumerable : true);
  const out = [];
  for (const k of Object.getOwnPropertyNames(obj)) {
    if (isIndex(k)) continue;
    if (keep(Object.getOwnPropertyDescriptor(obj, k))) out.push(k);
  }
  for (const s of Object.getOwnPropertySymbols(obj)) {
    if (keep(Object.getOwnPropertyDescriptor(obj, s))) out.push(s);
  }
  return out;
}

export function createInternalBinding() {
  const bindings = {
    buffer: createBufferBinding(),
    util: {
      constants: { ALL_PROPERTIES, ONLY_ENUMERABLE },
      getOwnNonIndexProperties,
      isInsideNodeModules: () => false,
      privateSymbols: {
        untransferable_object_private_symbol: Symbol("untransferable_object"),
      },
    },
    // hasIntl=false keeps Buffer.transcode / ICU paths dormant (no icu binding).
    config: { hasIntl: false },
    constants: {
      os: { signals: {}, errno: {}, priority: {} },
      fs: {},
    },
  };

  return function internalBinding(name) {
    if (Object.prototype.hasOwnProperty.call(bindings, name)) return bindings[name];
    throw new Error(`OpenContainer: internalBinding('${name}') is not implemented yet`);
  };
}
