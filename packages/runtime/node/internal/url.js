// internal/url — minimal shim (only what lib/fs.js needs: toPathIfFileURL).
//
// The real module is the whole WHATWG URL implementation. fs.js only calls
// `toPathIfFileURL` on its path arguments; almost all callers pass plain
// strings, so we pass those straight through and only special-case a real
// file: URL. It grows into the real vendored file if/when a module needs more.

export default function (exports, require, module, process, internalBinding, primordials) {
  "use strict";

  function fileURLToPath(url) {
    // Minimal POSIX file:// -> path. Enough for our single-root VFS.
    const pathname = decodeURIComponent(url.pathname);
    return pathname || "/";
  }

  function toPathIfFileURL(fileURLOrPath) {
    if (
      fileURLOrPath &&
      typeof fileURLOrPath === "object" &&
      fileURLOrPath.protocol === "file:" &&
      typeof fileURLOrPath.pathname === "string"
    ) {
      return fileURLToPath(fileURLOrPath);
    }
    return fileURLOrPath;
  }

  module.exports = { toPathIfFileURL, fileURLToPath };
}
