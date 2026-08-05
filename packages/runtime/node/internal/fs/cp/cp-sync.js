// DERIVED from Node.js — lib/internal/fs/cp/cp-sync.js
// Upstream: https://github.com/nodejs/node/blob/v24.18.0/lib/internal/fs/cp/cp-sync.js
// PROVENANCE (honest): the repo pins v24.18.0, but this sandbox has no network.
// The body is the v22.23.2 builtin source (read out of a local Node via
// process.binding('natives')).
//
// NOT verbatim: the three helpers upstream calls on the native fs binding
// (cpSyncCheckPaths / cpSyncOverrideFile / cpSyncCopyDir) are implemented here in
// JS instead, marked `VIVARI DELTA`. Before that, `fs.cpSync` threw
// ERR_METHOD_NOT_IMPLEMENTED and `fsPromises.cp` threw with it, since
// lib/fs/promises.js wires `cp: wrap('cpSync')`. Gated by scripts/spike-fs-cp.mjs
// against the host's real Node, case by case.
// Wrapped as a builtin factory.
export default function (exports, require, module, process, internalBinding, primordials) {
'use strict';

// This file is a modified version of the fs-extra's copySync method.

const { isSrcSubdir } = require('internal/fs/cp/cp');
const { codes: {
  ERR_FS_CP_DIR_TO_NON_DIR,
  ERR_FS_CP_EEXIST,
  ERR_FS_CP_EINVAL,
  ERR_FS_CP_FIFO_PIPE,
  ERR_FS_CP_NON_DIR_TO_DIR,
  ERR_FS_CP_SOCKET,
  ERR_FS_CP_SYMLINK_TO_SUBDIRECTORY,
  ERR_FS_EISDIR,
  ERR_INVALID_RETURN_VALUE,
} } = require('internal/errors');
const {
  os: {
    errno: {
      EEXIST,
      EINVAL,
      EISDIR,
      ENOTDIR,
    },
  },
} = internalBinding('constants');
const {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  opendirSync,
  readlinkSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
} = require('fs');
const {
  dirname,
  isAbsolute,
  join,
  parse,
  resolve,
} = require('path');
const { isPromise } = require('util/types');

// ── VIVARI DELTA ────────────────────────────────────────────────────────────
// Upstream drives the sync copy through three helpers that are native in Node —
// cpSyncCheckPaths / cpSyncOverrideFile / cpSyncCopyDir — and our
// internalBinding('fs') has no such thing, so `fs.cpSync` threw
// ERR_METHOD_NOT_IMPLEMENTED and `fsPromises.cp` inherited it (lib/fs/promises.js
// wires `cp: wrap('cpSync')`), while the async `fs.cp` worked fine.
//
// Two of the three need no new logic: the file already implements `copyDir` in JS
// for the filter case (the native is only a no-filter fast path), and `copyFile`
// already does what an override does. So only the VALIDATION is new, and it is
// written here rather than in the binding because the errors it must throw are
// ERR_FS_CP_* classes that live above the binding line.
//
// Semantics are taken from the async `checkPaths` in internal/fs/cp/cp.js and
// pinned against the host's real Node by spike-fs-cp.mjs, which compares
// transcripts case by case — including the numeric `errno`, since these errors
// carry one.
//
// ONE DELIBERATE DIVERGENCE, in the safe direction: Node 22's native
// cpSyncCheckPaths reports ERR_FS_EISDIR for `cpSync(symlinkToAFile, dest,
// { dereference: true })`, complaining about "a directory" and naming the source
// with a trailing slash. The same Node's async `fs.cp` copies the file, and so does
// its own cpSync once `recursive: true` is added — the operation is identical, so
// the sync refusal is an upstream bug, not a contract. We copy the file. The spike
// asserts BOTH sides of that, so if Node ever fixes it the divergence is reported
// as obsolete rather than quietly kept.
function cpSyncCheckPaths(src, dest, dereference, recursive) {
  const statFn = dereference ? statSync : lstatSync;
  // No `throwIfNoEntry: false` here on purpose: a missing source is an ENOENT from
  // the stat itself, which is what the host reports.
  const srcStat = statFn(src, { bigint: true });
  const destStat = statFn(dest, { bigint: true, throwIfNoEntry: false });

  if (destStat) {
    if (destStat.ino && destStat.dev && destStat.ino === srcStat.ino &&
        destStat.dev === srcStat.dev) {
      throw new ERR_FS_CP_EINVAL({
        message: 'src and dest cannot be the same',
        path: dest,
        syscall: 'cp',
        errno: EINVAL,
        code: 'EINVAL',
      });
    }
    if (srcStat.isDirectory() && !destStat.isDirectory()) {
      throw new ERR_FS_CP_DIR_TO_NON_DIR({
        message: `cannot overwrite non-directory ${dest} with directory ${src}`,
        path: dest,
        syscall: 'cp',
        errno: EISDIR,
        code: 'EISDIR',
      });
    }
    if (!srcStat.isDirectory() && destStat.isDirectory()) {
      throw new ERR_FS_CP_NON_DIR_TO_DIR({
        message: `cannot overwrite directory ${dest} with non-directory ${src}`,
        path: dest,
        syscall: 'cp',
        errno: ENOTDIR,
        code: 'ENOTDIR',
      });
    }
  }

  if (srcStat.isDirectory() && isSrcSubdir(src, dest)) {
    throw new ERR_FS_CP_EINVAL({
      message: `cannot copy ${src} to a subdirectory of self ${dest}`,
      path: dest,
      syscall: 'cp',
      errno: EINVAL,
      code: 'EINVAL',
    });
  }

  checkParentPathsSync(src, srcStat, dest);

  if (srcStat.isDirectory() && !recursive) {
    throw new ERR_FS_EISDIR({
      message: `${src} is a directory (not copied)`,
      path: src,
      syscall: 'cp',
      errno: EISDIR,
      code: 'EISDIR',
    });
  }
  if (srcStat.isFIFO()) {
    throw new ERR_FS_CP_FIFO_PIPE({
      message: `cannot copy a FIFO pipe: ${src}`,
      path: src,
      syscall: 'cp',
      errno: EINVAL,
      code: 'EINVAL',
    });
  }
  if (srcStat.isSocket()) {
    throw new ERR_FS_CP_SOCKET({
      message: `cannot copy a socket file: ${dest}`,
      path: dest,
      syscall: 'cp',
      errno: EINVAL,
      code: 'EINVAL',
    });
  }

  // The async path creates a missing destination parent (checkParentDir), and the
  // native sync one does too — verified against the host, which copies into
  // `deep/nested/b.txt` without complaint.
  const destParent = dirname(dest);
  if (!statSync(destParent, { throwIfNoEntry: false })) {
    mkdirSync(destParent, { recursive: true });
  }
}

// Recursively check whether dest's parent is a subdirectory of src, by inode
// rather than by string, so a symlinked path cannot slip past it.
function checkParentPathsSync(src, srcStat, dest) {
  const srcParent = resolve(dirname(src));
  const destParent = resolve(dirname(dest));
  if (destParent === srcParent || destParent === parse(destParent).root) return;
  const destStat = statSync(destParent, { bigint: true, throwIfNoEntry: false });
  if (!destStat) return;
  if (destStat.ino && destStat.dev && destStat.ino === srcStat.ino &&
      destStat.dev === srcStat.dev) {
    throw new ERR_FS_CP_EINVAL({
      message: `cannot copy ${src} to a subdirectory of self ${dest}`,
      path: dest,
      syscall: 'cp',
      errno: EINVAL,
      code: 'EINVAL',
    });
  }
  return checkParentPathsSync(src, srcStat, destParent);
}

// What the native cpSyncOverrideFile does: replace an existing destination file.
// copyFileSync already truncates, so this is `copyFile` with the stat it needs.
function cpSyncOverrideFile(src, dest, mode, preserveTimestamps) {
  const srcStat = statSync(src);
  return copyFile(srcStat, src, dest, { mode, preserveTimestamps });
}
// ── end VIVARI DELTA ────────────────────────────────────────────────────────

function cpSyncFn(src, dest, opts) {
  // Warn about using preserveTimestamps on 32-bit node
  if (opts.preserveTimestamps && process.arch === 'ia32') {
    const warning = 'Using the preserveTimestamps option in 32-bit ' +
      'node is not recommended';
    process.emitWarning(warning, 'TimestampPrecisionWarning');
  }
  if (opts.filter) {
    const shouldCopy = opts.filter(src, dest);
    if (isPromise(shouldCopy)) {
      throw new ERR_INVALID_RETURN_VALUE('boolean', 'filter', shouldCopy);
    }
    if (!shouldCopy) return;
  }

  cpSyncCheckPaths(src, dest, opts.dereference, opts.recursive);

  return getStats(src, dest, opts);
}

function getStats(src, dest, opts) {
  // TODO(@anonrig): Avoid making two stat calls.
  const statSyncFn = opts.dereference ? statSync : lstatSync;
  const srcStat = statSyncFn(src);
  const destStat = statSyncFn(dest, { bigint: true, throwIfNoEntry: false });

  if (srcStat.isDirectory() && opts.recursive) {
    return onDir(srcStat, destStat, src, dest, opts);
  } else if (srcStat.isFile() ||
           srcStat.isCharacterDevice() ||
           srcStat.isBlockDevice()) {
    return onFile(srcStat, destStat, src, dest, opts);
  } else if (srcStat.isSymbolicLink()) {
    return onLink(destStat, src, dest, opts.verbatimSymlinks);
  }

  // It is not possible to get here because all possible cases are handled above.
  const assert = require('internal/assert');
  assert.fail('Unreachable code');
}

function onFile(srcStat, destStat, src, dest, opts) {
  if (!destStat) return copyFile(srcStat, src, dest, opts);

  if (opts.force) {
    return cpSyncOverrideFile(src, dest, opts.mode, opts.preserveTimestamps);
  }

  if (opts.errorOnExist) {
    throw new ERR_FS_CP_EEXIST({
      message: `${dest} already exists`,
      path: dest,
      syscall: 'cp',
      errno: EEXIST,
      code: 'EEXIST',
    });
  }
}

function copyFile(srcStat, src, dest, opts) {
  copyFileSync(src, dest, opts.mode);
  if (opts.preserveTimestamps) handleTimestamps(srcStat.mode, src, dest);
  return setDestMode(dest, srcStat.mode);
}

function handleTimestamps(srcMode, src, dest) {
  // Make sure the file is writable before setting the timestamp
  // otherwise open fails with EPERM when invoked with 'r+'
  // (through utimes call)
  if (fileIsNotWritable(srcMode)) makeFileWritable(dest, srcMode);
  return setDestTimestamps(src, dest);
}

function fileIsNotWritable(srcMode) {
  return (srcMode & 0o200) === 0;
}

function makeFileWritable(dest, srcMode) {
  return setDestMode(dest, srcMode | 0o200);
}

function setDestMode(dest, srcMode) {
  return chmodSync(dest, srcMode);
}

function setDestTimestamps(src, dest) {
  // The initial srcStat.atime cannot be trusted
  // because it is modified by the read(2) system call
  // (See https://nodejs.org/api/fs.html#fs_stat_time_values)
  const updatedSrcStat = statSync(src);
  return utimesSync(dest, updatedSrcStat.atime, updatedSrcStat.mtime);
}

// TODO(@anonrig): Move this function to C++.
function onDir(srcStat, destStat, src, dest, opts) {
  if (!destStat) return copyDir(src, dest, opts, true, srcStat.mode);
  return copyDir(src, dest, opts);
}

function copyDir(src, dest, opts, mkDir, srcMode) {
  // VIVARI DELTA: upstream takes a native fast path (cpSyncCopyDir) when there is
  // no filter. The JS loop below is the same walk and already ran for the filter
  // case, so it serves both — one code path rather than a fast one we do not have.

  if (mkDir) {
    mkdirSync(dest);
  }

  const dir = opendirSync(src);

  try {
    let dirent;

    while ((dirent = dir.readSync()) !== null) {
      const { name } = dirent;
      const srcItem = join(src, name);
      const destItem = join(dest, name);
      let shouldCopy = true;

      if (opts.filter) {
        shouldCopy = opts.filter(srcItem, destItem);
        if (isPromise(shouldCopy)) {
          throw new ERR_INVALID_RETURN_VALUE('boolean', 'filter', shouldCopy);
        }
      }

      if (shouldCopy) {
        getStats(srcItem, destItem, opts);
      }
    }
  } finally {
    dir.closeSync();

    if (srcMode !== undefined) {
      setDestMode(dest, srcMode);
    }
  }
}

// TODO(@anonrig): Move this function to C++.
function onLink(destStat, src, dest, verbatimSymlinks) {
  let resolvedSrc = readlinkSync(src);
  if (!verbatimSymlinks && !isAbsolute(resolvedSrc)) {
    resolvedSrc = resolve(dirname(src), resolvedSrc);
  }
  if (!destStat) {
    return symlinkSync(resolvedSrc, dest);
  }
  let resolvedDest;
  try {
    resolvedDest = readlinkSync(dest);
  } catch (err) {
    // Dest exists and is a regular file or directory,
    // Windows may throw UNKNOWN error. If dest already exists,
    // fs throws error anyway, so no need to guard against it here.
    if (err.code === 'EINVAL' || err.code === 'UNKNOWN') {
      return symlinkSync(resolvedSrc, dest);
    }
    throw err;
  }
  if (!isAbsolute(resolvedDest)) {
    resolvedDest = resolve(dirname(dest), resolvedDest);
  }
  if (isSrcSubdir(resolvedSrc, resolvedDest)) {
    throw new ERR_FS_CP_EINVAL({
      message: `cannot copy ${resolvedSrc} to a subdirectory of self ` +
          `${resolvedDest}`,
      path: dest,
      syscall: 'cp',
      errno: EINVAL,
      code: 'EINVAL',
    });
  }
  // Prevent copy if src is a subdir of dest since unlinking
  // dest in this case would result in removing src contents
  // and therefore a broken symlink would be created.
  if (statSync(dest).isDirectory() && isSrcSubdir(resolvedDest, resolvedSrc)) {
    throw new ERR_FS_CP_SYMLINK_TO_SUBDIRECTORY({
      message: `cannot overwrite ${resolvedDest} with ${resolvedSrc}`,
      path: dest,
      syscall: 'cp',
      errno: EINVAL,
      code: 'EINVAL',
    });
  }
  return copyLink(resolvedSrc, dest);
}

function copyLink(resolvedSrc, dest) {
  unlinkSync(dest);
  return symlinkSync(resolvedSrc, dest);
}

module.exports = { cpSyncFn };
}