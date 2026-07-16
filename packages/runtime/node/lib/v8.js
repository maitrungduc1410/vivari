// A pragmatic `v8` module. There is no V8 introspection API reachable from a
// wasm/Worker sandbox, so heap statistics are plausible constants and flag setters
// are no-ops. serialize/deserialize use a JSON round-trip: correct for JSON-safe
// values (what most consumers cache); it does not preserve Map/Set/typed-array
// identity the way the real structured serializer does.

export default function (exports, require, module) {
  const { Buffer } = require("buffer");

  const MB = 1024 * 1024;
  const heap = {
    total_heap_size: 16 * MB,
    total_heap_size_executable: 0,
    total_physical_size: 16 * MB,
    total_available_size: 2048 * MB,
    used_heap_size: 8 * MB,
    heap_size_limit: 2048 * MB,
    malloced_memory: MB,
    peak_malloced_memory: MB,
    does_zap_garbage: 0,
    number_of_native_contexts: 1,
    number_of_detached_contexts: 0,
    total_global_handles_size: 0,
    used_global_handles_size: 0,
    external_memory: 0,
  };

  exports.getHeapStatistics = () => ({ ...heap });
  exports.getHeapSpaceStatistics = () => [];
  exports.getHeapCodeStatistics = () => ({
    code_and_metadata_size: 0,
    bytecode_and_metadata_size: 0,
    external_script_source_size: 0,
    cpu_profiler_metadata_size: 0,
  });
  exports.getHeapSnapshot = () => {
    throw new Error("v8.getHeapSnapshot is not supported in Vivari");
  };
  exports.setFlagsFromString = () => {};
  exports.writeHeapSnapshot = () => {
    throw new Error("v8.writeHeapSnapshot is not supported in Vivari");
  };
  exports.cachedDataVersionTag = () => 0;
  exports.setHeapSnapshotNearHeapLimit = () => {};

  exports.serialize = (value) => Buffer.from(JSON.stringify(value ?? null), "utf8");
  exports.deserialize = (buffer) => JSON.parse(Buffer.from(buffer).toString("utf8"));

  class Serializer {
    constructor() {
      this._chunks = [];
    }
    writeHeader() {}
    writeValue(v) {
      this._chunks.push(v);
    }
    releaseBuffer() {
      return Buffer.from(JSON.stringify(this._chunks), "utf8");
    }
    writeUint32() {}
    writeUint64() {}
    writeDouble() {}
    writeRawBytes() {}
    _setTreatArrayBufferViewsAsHostObjects() {}
  }
  class Deserializer {
    constructor(buffer) {
      this._values = JSON.parse(Buffer.from(buffer).toString("utf8") || "[]");
      this._i = 0;
    }
    readHeader() {}
    readValue() {
      return this._values[this._i++];
    }
    readUint32() {
      return 0;
    }
    readUint64() {
      return 0;
    }
    readDouble() {
      return 0;
    }
    readRawBytes() {
      return Buffer.alloc(0);
    }
  }
  exports.Serializer = Serializer;
  exports.Deserializer = Deserializer;
  exports.DefaultSerializer = Serializer;
  exports.DefaultDeserializer = Deserializer;
  exports.promiseHooks = {
    createHook: () => () => {},
    onInit: () => () => {},
    onBefore: () => () => {},
    onAfter: () => () => {},
    onSettled: () => () => {},
  };
  exports.startupSnapshot = {
    isBuildingSnapshot: () => false,
    addSerializeCallback: () => {},
    addDeserializeCallback: () => {},
    setDeserializeMainFunction: () => {},
  };
  exports.takeCoverage = () => {};
  exports.stopCoverage = () => {};
  exports.setHeapSnapshotNearHeapLimit = () => {};
  exports.GCProfiler = class GCProfiler {
    start() {}
    stop() {
      return {};
    }
  };
}
