// Records real Bun's Bun.Archive bytes and error strings into
// scripts/fixtures/bun-archive.json. Run it WITH a real bun binary:
//
//   /path/to/bun scripts/record-bun-archive.mjs
//
// Running it under node would record Vivari's own answers and turn the
// comparison in spike-bun-offline.mjs into a tautology — the same trap
// record-bun-serialize.mjs warns about.
//
// Two kinds of thing are captured. The ARCHIVES are bytes only a real writer can
// produce: what Bun emits for a plain object, for a name too long for a ustar
// header (a pax extension), for a name that splits across the ustar prefix field,
// and gzipped. What the spike does with them is drive OUR reader over Bun's own
// bytes, which is the only way to know the reader agrees with the thing it is
// imitating rather than only with our writer. The REFUSALS are the exact error
// strings, because those are API too and someone will search for them.
import { writeFileSync } from "node:fs";

if (typeof globalThis.Bun === "undefined" || typeof Bun.Archive !== "function") {
  console.error("this must be run by a real bun binary with Bun.Archive, not by node");
  process.exit(2);
}

const b64 = (bytes) => Buffer.from(bytes).toString("base64");

// The entry sets are shared with the spike through this file rather than through a
// module, so the recorded bytes and the expectations cannot drift apart.
const cases = {
  plain: { "a.txt": "hello", "dir/b.txt": "world", "empty.txt": "" },
  // 120 characters with no `/` to split on: real Bun writes a pax `x` header
  // carrying `path=`, which is the case a hand-built reader is most likely to get
  // wrong because GNU tar reaches for its own `L` extension instead.
  paxLongName: { ["L".repeat(120)]: "PAYLOAD" },
  // 152 characters that DO split: this one goes in the ustar prefix field, and Bun
  // picks the last `/` that fits rather than the first.
  ustarPrefixSplit: { ["s".repeat(50) + "/" + "t".repeat(50) + "/" + "u".repeat(50)]: "split" },
  // 20000 bytes forces the archive past one 10240-byte record, which is where a
  // padding rule guessed from small archives stops matching.
  multiRecord: { "big.bin": "z".repeat(20000), "small.txt": "s" },
};

const archives = {};
for (const [name, spec] of Object.entries(cases)) {
  archives[name] = {
    entries: Object.fromEntries(Object.entries(spec).map(([k, v]) => [k, v.length])),
    tar: b64(await new Bun.Archive(spec).bytes()),
    gzip: b64(await new Bun.Archive(spec, { compress: "gzip" }).bytes()),
  };
}

// Everything Bun refuses, recorded as the message it refuses with.
const message = async (fn) => {
  try {
    await fn();
    return null;
  } catch (e) {
    return { name: e?.constructor?.name ?? null, message: String(e?.message ?? e), code: e?.code ?? null };
  }
};

// A genuine zip, produced by Info-ZIP (`zip real.zip z.txt`) rather than
// hand-built: one stored entry `z.txt`, a central directory and an EOCD record.
// Real Bun cannot read it — `Unrecognized archive format`, the same words as
// random bytes — and neither may we. Reading a zip here would make Vivari a
// SUPERSET of Bun, which is the direction this project never goes: the code would
// work in the sandbox and throw in production.
const zip = Buffer.from(
  "UEsDBAoAAAAAAGJCBF0RMsqJDwAAAA8AAAAFABwAei50eHRVVAkAA3egcWp3oHFqdXgLAAEEAAAA" +
    "AAQAAAAAemlwcGVkIGNvbnRlbnQKUEsBAh4DCgAAAAAAYkIEXREyyokPAAAADwAAAAUAGAAAAAAA" +
    "AQAAAKSBAAAAAHoudHh0VVQFAAN3oHFqdXgLAAEEAAAAAAQAAAAAUEsFBgAAAAABAAEASwAAAE4A" +
    "AAAAAA==",
  "base64"
);

const truncated = (await new Bun.Archive({ "a.txt": "hello" }).bytes()).subarray(0, 512);

// Non-archives that are LONGER than one 512-byte block. These are the ones that
// actually exercise the format check: anything shorter is rejected on length
// alone, so a reader with no header validation at all passes every short case and
// then happily reads garbage entries out of a 4 KB file. Deterministic bytes
// rather than /dev/urandom, so the fixture is reproducible.
const bigBinary = new Uint8Array(4096);
for (let i = 0; i < bigBinary.length; i++) bigBinary[i] = (i * 37 + 11) & 0xff;
const longText = new TextEncoder().encode("A".repeat(1024));
const longJson = new TextEncoder().encode(JSON.stringify({ note: "not an archive", filler: "v".repeat(2000) }));

const refusals = {
  ctorString: await message(() => new Bun.Archive("hello")),
  ctorNumber: await message(() => new Bun.Archive(7)),
  ctorNothing: await message(() => new Bun.Archive()),
  ctorNoNew: await message(() => Bun.Archive({ "a.txt": "x" })),
  nonAsciiName: await message(() => new Bun.Archive({ "ü.txt": "x" }).bytes()),
  writeNoArgs: await message(() => Bun.Archive.write()),
  writeNumberPath: await message(() => Bun.Archive.write(7, { "a.txt": "x" })),
  writeNoFiles: await message(() => Bun.Archive.write("/tmp/vv-record.tar")),
  writeStringFiles: await message(() => Bun.Archive.write("/tmp/vv-record.tar", "str")),
  optionsNotObject: await message(() => Bun.Archive.write("/tmp/vv-record.tar", { a: "b" }, "gzip")),
  compressNotString: await message(() => Bun.Archive.write("/tmp/vv-record.tar", { a: "b" }, { compress: true })),
  compressNotGzip: await message(() => Bun.Archive.write("/tmp/vv-record.tar", { a: "b" }, { compress: "gz" })),
  extractNoPath: await message(() => new Bun.Archive({ "a.txt": "x" }).extract()),
  extractNumberPath: await message(() => new Bun.Archive({ "a.txt": "x" }).extract(7)),
  readZip: await message(() => new Bun.Archive(zip).files()),
  readGarbage: await message(() => new Bun.Archive(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])).files()),
  readEmpty: await message(() => new Bun.Archive(new Uint8Array(0)).files()),
  readText: await message(() => new Bun.Archive(new TextEncoder().encode("hello world, not an archive")).files()),
  // The three that are LONGER than one block, so a reader with no header
  // validation cannot pass them on length alone.
  readBigBinary: await message(() => new Bun.Archive(bigBinary).files()),
  readLongText: await message(() => new Bun.Archive(longText).files()),
  readLongJson: await message(() => new Bun.Archive(longJson).files()),
  readTruncated: await message(() => new Bun.Archive(truncated).files()),
  extractGarbage: await message(() => new Bun.Archive(new Uint8Array([1, 2, 3])).extract("/tmp/vv-record-x")),
  notAnArchive: await message(() => Bun.Archive.prototype.files.call({})),
};

// The shapes real Bun accepts and answers with an EMPTY archive — the data loss
// Vivari refuses instead. Recorded so the spike can prove the loss is real rather
// than take this file's word for it.
const silentlyEmpty = {
  fromMap: (await new Bun.Archive(new Map([["a.txt", "hello"]])).files()).size,
  fromSet: (await new Bun.Archive(new Set(["a.txt"])).files()).size,
  fromArchive: (await new Bun.Archive(new Bun.Archive({ "a.txt": "hello" })).files()).size,
  bunFileValueSize: (await new Bun.Archive({ "a.txt": Bun.file("scripts/record-bun-archive.mjs") }).files()).get("a.txt")
    .size,
};

// The quirks worth pinning as VALUES rather than as prose.
const observed = {
  bytesIsBuffer: Buffer.isBuffer(await new Bun.Archive({ a: "b" }).bytes()),
  filesIsMapOfBlobs: await (async () => {
    const files = await new Bun.Archive({ "a.txt": "hello" }).files();
    return { isMap: files instanceof Map, isBlob: files.get("a.txt") instanceof Blob, type: files.get("a.txt").type };
  })(),
  emptyArchiveLength: (await new Bun.Archive({}).bytes()).length,
  writeLength: Bun.Archive.write.length,
  toStringTag: Object.prototype.toString.call(new Bun.Archive({ a: "b" })),
  // extract() returns a COUNT, and it includes entries that create no file.
  extractCount: await new Bun.Archive(cases.plain).extract("/tmp/vv-record-x1"),
  // Names that escape the destination, and where they actually land.
  traversal: await (async () => {
    const out = {};
    for (const key of ["../escaped.txt", "a/../../b.txt", "..", "/abs/rooted.txt"]) {
      const dest = "/tmp/vv-record-t" + Object.keys(out).length;
      out[key] = { count: await new Bun.Archive({ [key]: "T" }).extract(dest), files: [] };
      const { readdirSync } = await import("node:fs");
      try {
        out[key].files = readdirSync(dest, { recursive: true }).sort();
      } catch {}
    }
    return out;
  })(),
  // `.zip`, `.tgz` and `{ format: "zip" }` all still produce a tar.
  writeIgnoresExtension: {},
};
for (const ext of ["tar", "tgz", "tar.gz", "zip", "txt"]) {
  const p = `/tmp/vv-record-ext.${ext}`;
  await Bun.Archive.write(p, { "x.txt": "x" });
  const bytes = await Bun.file(p).bytes();
  observed.writeIgnoresExtension[ext] = {
    length: bytes.length,
    magic: Buffer.from(bytes.subarray(257, 262)).toString("latin1"),
  };
}
await Bun.Archive.write("/tmp/vv-record-fmt.tar", { "x.txt": "x" }, { format: "zip" });
{
  const bytes = await Bun.file("/tmp/vv-record-fmt.tar").bytes();
  observed.writeIgnoresExtension.formatZipOption = {
    length: bytes.length,
    magic: Buffer.from(bytes.subarray(257, 262)).toString("latin1"),
  };
}

const out = {
  recordedFrom: "bun " + Bun.version,
  zip: b64(zip),
  archives,
  refusals,
  silentlyEmpty,
  observed,
};
writeFileSync(new URL("./fixtures/bun-archive.json", import.meta.url), JSON.stringify(out, null, 1) + "\n");
console.log(
  "recorded " +
    Object.keys(archives).length +
    " archives and " +
    Object.keys(refusals).length +
    " refusals from bun " +
    Bun.version
);
