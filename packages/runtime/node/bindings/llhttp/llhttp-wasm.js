// Synchronous, in-worker instantiation of the vendored llhttp.wasm.
//
// internalBinding('http_parser') is built synchronously during process
// bootstrap, so we cannot await WebAssembly.instantiate(). Instead we do a
// synchronous new WebAssembly.Module()/Instance(). This is allowed inside Web
// Workers (where Vivari runs guest processes); on the main thread the
// 4KB sync-compile cap makes new WebAssembly.Module() throw for a ~54KB payload —
// which is exactly what we want: the caller catches and falls back to the
// pure-JS parser.

import { LLHTTP_WASM_BASE64, LLHTTP_WASM_VERSION } from "./llhttp-wasm-data.js";

export { LLHTTP_WASM_VERSION };

function decodeBase64(b64) {
  const B = globalThis.Buffer;
  if (B && typeof B.from === "function") {
    const buf = B.from(b64, "base64");
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  // atob path (available in worker + window globals).
  const bin = globalThis.atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

let _module = null; // compiled WebAssembly.Module, cached per realm.

// Compile+instantiate synchronously. `imports` is the { env: {...callbacks} }
// object. Throws if Wasm is unavailable (e.g. main thread) — callers fall back.
export function instantiate(imports) {
  if (_module == null) {
    _module = new WebAssembly.Module(decodeBase64(LLHTTP_WASM_BASE64));
  }
  const instance = new WebAssembly.Instance(_module, imports);
  return instance.exports;
}
