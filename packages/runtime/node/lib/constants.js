// The deprecated public `constants` module — a flat aggregate of the errno,
// signal, dlopen, priority, fs and OpenSSL tables. Modern code uses
// `fs.constants` / `os.constants` / `crypto.constants`; some older packages still
// `require('constants')`.
//
// Built from internalBinding('constants'), as Node builds it. It used to carry its
// own second copy of errno and signals — half the names, and two Windows-only ones
// (WSAEINTR, WSAEBADF) that a Linux Node does not define — so the same constant
// could read one way here and another way through `os.constants`.

export default function (
  exports,
  require,
  module,
  process,
  internalBinding,
  primordials,
) {
  const { os, fs, crypto } = internalBinding("constants");

  module.exports = {
    ...os.errno,
    ...os.signals,
    ...os.dlopen,
    ...os.priority,
    ...fs,
    ...crypto,
  };
}
