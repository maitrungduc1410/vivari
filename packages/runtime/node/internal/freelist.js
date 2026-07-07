// VENDORED VERBATIM from Node.js v24.18.0 — lib/internal/freelist.js
// Source: https://github.com/nodejs/node/blob/v24.18.0/lib/internal/freelist.js
// Wrapped as a builtin factory. Object pool used by _http_common's parser cache.
export default function (exports, require, module, process, internalBinding, primordials) {
  "use strict";

  const { ReflectApply } = primordials;

  class FreeList {
    constructor(name, max, ctor) {
      this.name = name;
      this.ctor = ctor;
      this.max = max;
      this.list = [];
    }

    alloc() {
      return this.list.length > 0 ? this.list.pop() : ReflectApply(this.ctor, this, arguments);
    }

    free(obj) {
      if (this.list.length < this.max) {
        this.list.push(obj);
        return true;
      }
      return false;
    }
  }

  module.exports = FreeList;
}
