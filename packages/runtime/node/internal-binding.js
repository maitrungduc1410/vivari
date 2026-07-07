// internalBinding — the seam Node's lib/ uses to reach its C++ core.
//
// In real Node, `internalBinding('fs')` returns the native (C++) module. In
// OpenContainer (Path B), THIS is where we substitute our own implementations:
// JS shims, Wasm codecs, or calls down to the Rust VFS via the sync bridge. The
// JS layer above the binding line (Node's real lib/) stays unmodified.
//
// Right now only a couple of stub bindings exist because the first vendored
// module (path) needs none. Each new real lib/ module we adopt adds the
// binding(s) it requires here (fs → Rust VFS, buffer, zlib, etc.).

export function createInternalBinding() {
  const bindings = {
    // Minimal so `require('internal/validators')` (real version, later) can do
    // `internalBinding('constants').os.signals`. Grown when we need real signals.
    constants: {
      os: { signals: {}, errno: {}, priority: {} },
      fs: {},
    },
  };

  return function internalBinding(name) {
    if (Object.prototype.hasOwnProperty.call(bindings, name)) return bindings[name];
    throw new Error(
      `OpenContainer: internalBinding('${name}') is not implemented yet`,
    );
  };
}
