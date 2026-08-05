//! Vivari kernel — the in-RAM Virtual File System (VFS).
//!
//! Brick #2: a real POSIX-ish filesystem tree (not a flat map). Files live in an
//! inode table; directories map names -> inode ids; symlinks store a target path.
//! Path resolution walks the tree from root, follows symlinks (with a loop
//! guard), and understands `.` / `..`.
//!
//! Errors are surfaced to JS as `errno`-style string codes ("ENOENT", ...) which
//! the JS `fs` facade turns into Node-compatible errors (`err.code`).

use std::collections::{BTreeMap, HashMap, VecDeque};
use wasm_bindgen::prelude::*;

const ROOT_ID: u64 = 1;
const SYMLINK_MAX_DEPTH: usize = 40;

// --- Whole-file lazy compression tuning -----------------------------------
// Files smaller than this are never worth compressing (zlib framing overhead +
// the CPU cost dwarfs the win). node_modules is dominated by small JS files,
// but the big wins come from the handful of large bundles/maps.
const MIN_COMPRESS_BYTES: usize = 4096;
// If zlib can't beat this fraction of the original size, keep the file Raw so we
// never pay decompression cost for a negligible saving (e.g. already-compressed
// assets like .png/.woff2 inside node_modules).
const MIN_COMPRESS_RATIO: f64 = 0.95;
// Bound on the transient decompressed-bytes cache used to serve chunked reads of
// cold (compressed) files without re-inflating on every fd_read call.
const HOT_CACHE_MAX_BYTES: usize = 48 * 1024 * 1024;

/// zlib-compress a whole file body. Never panics; on encoder error returns an
/// empty vec (caller treats a poor ratio as "keep Raw", so this stays correct).
fn zlib_compress(raw: &[u8]) -> Vec<u8> {
    use flate2::write::ZlibEncoder;
    use flate2::Compression;
    use std::io::Write;
    let mut enc = ZlibEncoder::new(
        Vec::with_capacity(raw.len() / 3 + 64),
        Compression::new(6),
    );
    if enc.write_all(raw).is_err() {
        return Vec::new();
    }
    enc.finish().unwrap_or_default()
}

/// Inflate bytes produced by `zlib_compress`. `len` is the known logical length,
/// used to pre-size the output buffer so there's a single allocation.
fn zlib_decompress(data: &[u8], len: usize) -> Vec<u8> {
    use flate2::read::ZlibDecoder;
    use std::io::Read;
    let mut dec = ZlibDecoder::new(data);
    let mut out = Vec::with_capacity(len);
    dec.read_to_end(&mut out).ok();
    out
}

/// Slice `[start, start+len)` out of a byte buffer, clamped to its bounds.
fn read_range(buf: &[u8], start: usize, len: usize) -> Vec<u8> {
    if start >= buf.len() {
        return Vec::new();
    }
    let end = (start + len).min(buf.len());
    buf[start..end].to_vec()
}

/// A regular file's contents: either plain bytes (hot / being written) or a
/// zlib blob plus the known uncompressed length (cold). Reads transparently
/// inflate; the first write inflates in place (see `raw_mut`) and the file is
/// (re)compressed when its last writable fd closes.
enum FileBody {
    Raw(Vec<u8>),
    Zip { data: Vec<u8>, len: usize },
}

impl FileBody {
    fn raw(v: Vec<u8>) -> Self {
        FileBody::Raw(v)
    }

    /// Uncompressed length — what `stat().size` and offsets are measured in.
    fn logical_len(&self) -> usize {
        match self {
            FileBody::Raw(b) => b.len(),
            FileBody::Zip { len, .. } => *len,
        }
    }

    /// Bytes actually held in RAM (compressed size for Zip). Drives mem_bytes.
    fn physical_len(&self) -> usize {
        match self {
            FileBody::Raw(b) => b.len(),
            FileBody::Zip { data, .. } => data.len(),
        }
    }

    fn is_zip(&self) -> bool {
        matches!(self, FileBody::Zip { .. })
    }

    /// Borrow the raw bytes. Only valid for Raw bodies; callers use this on the
    /// non-compressed fast path (Zip reads go through the hot cache instead).
    fn raw_ref(&self) -> &[u8] {
        match self {
            FileBody::Raw(b) => b.as_slice(),
            FileBody::Zip { .. } => &[],
        }
    }

    /// Materialize a full owned copy of the logical bytes (inflating if needed).
    fn to_vec(&self) -> Vec<u8> {
        match self {
            FileBody::Raw(b) => b.clone(),
            FileBody::Zip { data, len } => zlib_decompress(data, *len),
        }
    }

    /// Get a mutable handle to the raw bytes, inflating a Zip body in place. Any
    /// mutation makes the file Raw until it is re-compressed on close.
    fn raw_mut(&mut self) -> &mut Vec<u8> {
        if let FileBody::Zip { data, len } = self {
            let raw = zlib_decompress(data, *len);
            *self = FileBody::Raw(raw);
        }
        match self {
            FileBody::Raw(b) => b,
            FileBody::Zip { .. } => unreachable!("just converted to Raw"),
        }
    }

    /// Reset to an empty Raw body (O_TRUNC / truncate to 0).
    fn clear(&mut self) {
        *self = FileBody::Raw(Vec::new());
    }
}

/// Bounded FIFO cache of decompressed bytes for cold files. Keyed by inode so a
/// chunked read loop (fd_read called repeatedly) inflates once. Invalidated when
/// the file is written or recompressed.
struct HotCache {
    map: HashMap<u64, Vec<u8>>,
    order: VecDeque<u64>,
    bytes: usize,
    cap: usize,
}

impl HotCache {
    fn new(cap: usize) -> Self {
        Self {
            map: HashMap::new(),
            order: VecDeque::new(),
            bytes: 0,
            cap,
        }
    }

    fn contains(&self, inode: u64) -> bool {
        self.map.contains_key(&inode)
    }

    fn get(&self, inode: u64) -> Option<&Vec<u8>> {
        self.map.get(&inode)
    }

    fn insert(&mut self, inode: u64, buf: Vec<u8>) {
        self.invalidate(inode);
        self.bytes += buf.len();
        self.map.insert(inode, buf);
        self.order.push_back(inode);
        while self.bytes > self.cap && self.order.len() > 1 {
            if let Some(old) = self.order.pop_front() {
                if let Some(v) = self.map.remove(&old) {
                    self.bytes -= v.len();
                }
            }
        }
    }

    fn invalidate(&mut self, inode: u64) {
        if let Some(v) = self.map.remove(&inode) {
            self.bytes -= v.len();
            self.order.retain(|&x| x != inode);
        }
    }

    fn clear(&mut self) {
        self.map.clear();
        self.order.clear();
        self.bytes = 0;
    }
}

/// errno-style errors. `code()` is what crosses the Wasm boundary into JS.
#[derive(Clone, Copy)]
enum VfsError {
    NoEnt,    // ENOENT   — no such file or directory
    NotDir,   // ENOTDIR  — a path component is not a directory
    IsDir,    // EISDIR   — target is a directory where a file was expected
    Exist,    // EEXIST   — already exists
    NotEmpty, // ENOTEMPTY— directory not empty
    Loop,     // ELOOP    — too many symlink levels
    Inval,    // EINVAL   — invalid argument
    Badf,     // EBADF    — bad file descriptor
}

impl VfsError {
    fn code(self) -> String {
        match self {
            VfsError::NoEnt => "ENOENT",
            VfsError::NotDir => "ENOTDIR",
            VfsError::IsDir => "EISDIR",
            VfsError::Exist => "EEXIST",
            VfsError::NotEmpty => "ENOTEMPTY",
            VfsError::Loop => "ELOOP",
            VfsError::Inval => "EINVAL",
            VfsError::Badf => "EBADF",
        }
        .to_string()
    }
}

// POSIX open(2) flag bits (Linux values — must match internalBinding('constants').fs
// on the JS side, since stringToFlags there produces these numbers).
const O_WRONLY: i32 = 0o1;
const O_RDWR: i32 = 0o2;
const O_CREAT: i32 = 0o100;
const O_EXCL: i32 = 0o200;
const O_TRUNC: i32 = 0o1000;
const O_APPEND: i32 = 0o2000;

/// An open file description: which inode, the read/write cursor, and how it was
/// opened. This is what a file descriptor points at (fd -> OpenFile).
struct OpenFile {
    inode: u64,
    pos: usize,
    readable: bool,
    writable: bool,
    append: bool,
}

type VfsResult<T> = Result<T, VfsError>;

enum NodeData {
    File(FileBody),
    Dir(BTreeMap<String, u64>), // BTreeMap => readdir is naturally sorted
    Symlink(String),
}

struct Inode {
    data: NodeData,
    mode: u32,
    mtime: f64,
    // Last access time, in ms since the epoch. Kept because utimes(2) sets BOTH
    // times and a caller that reads one back gets the one it wrote; nothing in
    // here advances it on a plain read, the way a real filesystem mounted
    // `relatime` mostly does not either.
    atime: f64,
    // Number of directory entries pointing at this inode (POSIX st_nlink). Hard
    // links (VFS.link) share one inode across several names; the inode is only
    // freed when the last link is removed. Regular files/dirs have exactly 1.
    nlink: u32,
    // Number of currently-open writable fds. A file is only (re)compressed once
    // this drops back to 0, so an in-progress write is never fighting the
    // compressor. Non-files stay at 0.
    wopen: u32,
}

#[wasm_bindgen]
pub struct VirtualFileSystem {
    inodes: HashMap<u64, Inode>,
    next_id: u64,
    open_files: HashMap<u64, OpenFile>,
    // Descriptors start at 3, leaving 0/1/2 for the stdio the runtime owns.
    next_fd: u64,
    // Whole-file lazy compression gate. Off by default; the FS worker flips it on
    // via `set_compression` (URL ?compress=1) so it can be A/B benchmarked.
    compression: bool,
    // Transient decompressed bytes for cold-file reads (not part of the FS state).
    hot: HotCache,
}

// ---------------------------------------------------------------------------
// Internal engine (pure Rust, errno errors). Not exposed to JS directly.
// ---------------------------------------------------------------------------
impl VirtualFileSystem {
    fn now() -> f64 {
        js_sys::Date::now()
    }

    fn alloc(&mut self, data: NodeData, mode: u32) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        self.inodes.insert(
            id,
            Inode {
                data,
                mode,
                mtime: Self::now(),
                atime: Self::now(),
                nlink: 0, // linked (nlink -> 1) when attached to a parent dir
                wopen: 0,
            },
        );
        id
    }

    fn dir_children(&self, id: u64) -> VfsResult<&BTreeMap<String, u64>> {
        match &self.inodes.get(&id).ok_or(VfsError::NoEnt)?.data {
            NodeData::Dir(m) => Ok(m),
            _ => Err(VfsError::NotDir),
        }
    }

    /// Split a path into meaningful components, dropping "" and ".".
    fn components(path: &str) -> Vec<String> {
        path.split('/')
            .filter(|c| !c.is_empty() && *c != ".")
            .map(String::from)
            .collect()
    }

    /// Walk `comps` starting from the inode stack, following symlinks. The stack
    /// keeps ancestry so `..` works. `follow_last` controls whether a trailing
    /// symlink is dereferenced (stat vs lstat semantics).
    fn walk(
        &self,
        stack: &mut Vec<u64>,
        comps: &[String],
        follow_last: bool,
        depth: usize,
    ) -> VfsResult<()> {
        if depth > SYMLINK_MAX_DEPTH {
            return Err(VfsError::Loop);
        }
        for (i, comp) in comps.iter().enumerate() {
            let is_last = i + 1 == comps.len();
            if comp == ".." {
                if stack.len() > 1 {
                    stack.pop();
                }
                continue;
            }
            let cur = *stack.last().unwrap();
            let child_id = *self.dir_children(cur)?.get(comp).ok_or(VfsError::NoEnt)?;
            match &self.inodes.get(&child_id).unwrap().data {
                NodeData::Symlink(target) if !(is_last && !follow_last) => {
                    let target_comps = Self::components(target);
                    if target.starts_with('/') {
                        stack.truncate(1); // absolute target => restart from root
                    }
                    self.walk(stack, &target_comps, true, depth + 1)?;
                }
                _ => stack.push(child_id),
            }
        }
        Ok(())
    }

    fn resolve(&self, path: &str, follow_last: bool) -> VfsResult<u64> {
        let comps = Self::components(path);
        let mut stack = vec![ROOT_ID];
        self.walk(&mut stack, &comps, follow_last, 0)?;
        Ok(*stack.last().unwrap())
    }

    /// Resolve everything but the final component. Returns (parent dir id, name).
    fn resolve_parent(&self, path: &str) -> VfsResult<(u64, String)> {
        let comps = Self::components(path);
        let (name, parent_comps) = comps.split_last().ok_or(VfsError::Inval)?;
        if name == ".." {
            return Err(VfsError::Inval);
        }
        let mut stack = vec![ROOT_ID];
        self.walk(&mut stack, parent_comps, true, 0)?;
        let parent = *stack.last().unwrap();
        self.dir_children(parent)?; // ensure it is a directory
        Ok((parent, name.clone()))
    }

    fn link_child(&mut self, parent: u64, name: &str, child: u64) {
        if let Some(Inode {
            data: NodeData::Dir(m),
            ..
        }) = self.inodes.get_mut(&parent)
        {
            m.insert(name.to_string(), child);
        }
        if let Some(node) = self.inodes.get_mut(&child) {
            node.nlink = node.nlink.saturating_add(1);
        }
    }

    fn child_id(&self, parent: u64, name: &str) -> Option<u64> {
        match &self.inodes.get(&parent)?.data {
            NodeData::Dir(m) => m.get(name).copied(),
            _ => None,
        }
    }

    /// Ensure the decompressed bytes for a cold file are present in the hot cache.
    /// No-op for Raw files (they're read directly) and for cache hits.
    fn ensure_hot(&mut self, inode: u64) {
        if self.hot.contains(inode) {
            return;
        }
        let raw = match self.inodes.get(&inode).map(|n| &n.data) {
            Some(NodeData::File(FileBody::Zip { data, len })) => zlib_decompress(data, *len),
            _ => return,
        };
        self.hot.insert(inode, raw);
    }

    /// Compress a file body if it's Raw, eligible (large enough, no writable fd
    /// open, gate enabled) and zlib actually beats MIN_COMPRESS_RATIO. Otherwise
    /// leaves it untouched. Called on the last writable close and after write_file.
    fn maybe_compress(&mut self, inode: u64) {
        if !self.compression {
            return;
        }
        // Phase 1: decide + produce the compressed bytes while only borrowing
        // immutably, so we can swap the body in afterwards without borrow clashes.
        let produced = {
            let node = match self.inodes.get(&inode) {
                Some(n) => n,
                None => return,
            };
            if node.wopen > 0 {
                return;
            }
            match &node.data {
                NodeData::File(FileBody::Raw(raw)) => {
                    if raw.len() < MIN_COMPRESS_BYTES {
                        return;
                    }
                    let compressed = zlib_compress(raw);
                    if compressed.is_empty()
                        || compressed.len() as f64 >= raw.len() as f64 * MIN_COMPRESS_RATIO
                    {
                        return;
                    }
                    (compressed, raw.len())
                }
                _ => return,
            }
        };
        let (data, len) = produced;
        if let Some(node) = self.inodes.get_mut(&inode) {
            node.data = NodeData::File(FileBody::Zip { data, len });
        }
        self.hot.invalidate(inode);
    }
}

// ---------------------------------------------------------------------------
// JS-facing API. Every fallible call returns Result<_, String(errno)>, so JS
// gets a thrown errno code on failure.
// ---------------------------------------------------------------------------
#[wasm_bindgen]
impl VirtualFileSystem {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        let mut fs = Self {
            inodes: HashMap::new(),
            next_id: ROOT_ID,
            open_files: HashMap::new(),
            next_fd: 3,
            compression: false,
            hot: HotCache::new(HOT_CACHE_MAX_BYTES),
        };
        fs.alloc(NodeData::Dir(BTreeMap::new()), 0o755); // root (== ROOT_ID)

        // Seed a fake OS release file, StackBlitz-style, to fool env sniffers.
        // We masquerade as Ubuntu 22.04 (glibc/Debian family) rather than a made-up
        // distro so libraries that branch on ID / ID_LIKE (e.g. prebuilt selection)
        // land on the common, well-supported path instead of an "unknown" fallback.
        fs.mkdir("/etc".into(), false).ok();
        fs.write_file(
            "/etc/os-release".into(),
            b"PRETTY_NAME=\"Ubuntu 22.04.4 LTS\"\nNAME=\"Ubuntu\"\nVERSION_ID=\"22.04\"\nVERSION=\"22.04.4 LTS (Jammy Jellyfish)\"\nVERSION_CODENAME=jammy\nID=ubuntu\nID_LIKE=debian\nUBUNTU_CODENAME=jammy\nHOME_URL=\"https://www.ubuntu.com/\"\n".to_vec(),
        )
        .ok();
        // A glibc `ldd` so musl-vs-glibc sniffers (e.g. napi-rs `isMuslFromFilesystem`
        // reads /usr/bin/ldd) resolve to glibc and pick glibc prebuilts, not musl.
        fs.mkdir("/usr/bin".into(), true).ok();
        fs.write_file(
            "/usr/bin/ldd".into(),
            b"#!/bin/sh\necho \"ldd (Ubuntu GLIBC 2.35-0ubuntu3) 2.35\"\n".to_vec(),
        )
        .ok();
        fs
    }

    /// Read a whole file. Errors: ENOENT, EISDIR.
    pub fn read_file(&self, path: String) -> Result<Vec<u8>, String> {
        (|| {
            let id = self.resolve(&path, true)?;
            match &self.inodes.get(&id).unwrap().data {
                NodeData::File(fb) => Ok(fb.to_vec()),
                NodeData::Dir(_) => Err(VfsError::IsDir),
                NodeData::Symlink(_) => Err(VfsError::Inval),
            }
        })()
        .map_err(VfsError::code)
    }

    /// Create or overwrite a file. Parent must already exist (like Node).
    pub fn write_file(&mut self, path: String, content: Vec<u8>) -> Result<(), String> {
        (|| {
            let (parent, name) = self.resolve_parent(&path)?;
            let id = match self.child_id(parent, &name) {
                Some(cid) => {
                    match &mut self.inodes.get_mut(&cid).unwrap().data {
                        NodeData::File(fb) => *fb = FileBody::raw(content),
                        NodeData::Dir(_) => return Err(VfsError::IsDir),
                        NodeData::Symlink(_) => return Err(VfsError::Inval),
                    }
                    self.inodes.get_mut(&cid).unwrap().mtime = Self::now();
                    cid
                }
                None => {
                    let id = self.alloc(NodeData::File(FileBody::raw(content)), 0o644);
                    self.link_child(parent, &name, id);
                    id
                }
            };
            // Content changed: drop any cached inflate, then (maybe) recompress.
            self.hot.invalidate(id);
            self.maybe_compress(id);
            Ok(())
        })()
        .map_err(VfsError::code)
    }

    /// Make a directory. With `recursive`, create missing parents (mkdir -p).
    pub fn mkdir(&mut self, path: String, recursive: bool) -> Result<(), String> {
        (|| {
            if !recursive {
                let (parent, name) = self.resolve_parent(&path)?;
                if self.child_id(parent, &name).is_some() {
                    return Err(VfsError::Exist);
                }
                let id = self.alloc(NodeData::Dir(BTreeMap::new()), 0o755);
                self.link_child(parent, &name, id);
                return Ok(());
            }
            let mut cur = ROOT_ID;
            for comp in Self::components(&path) {
                if comp == ".." {
                    return Err(VfsError::Inval);
                }
                match self.child_id(cur, &comp) {
                    Some(cid) => {
                        if !matches!(self.inodes.get(&cid).unwrap().data, NodeData::Dir(_)) {
                            return Err(VfsError::NotDir);
                        }
                        cur = cid;
                    }
                    None => {
                        let id = self.alloc(NodeData::Dir(BTreeMap::new()), 0o755);
                        self.link_child(cur, &comp, id);
                        cur = id;
                    }
                }
            }
            Ok(())
        })()
        .map_err(VfsError::code)
    }

    /// List directory entry names (sorted). Errors: ENOENT, ENOTDIR.
    pub fn readdir(&self, path: String) -> Result<Vec<String>, String> {
        (|| {
            let id = self.resolve(&path, true)?;
            Ok(self.dir_children(id)?.keys().cloned().collect())
        })()
        .map_err(VfsError::code)
    }

    /// Remove a file or symlink (not a directory). Errors: ENOENT, EISDIR.
    pub fn unlink(&mut self, path: String) -> Result<(), String> {
        (|| {
            let (parent, name) = self.resolve_parent(&path)?;
            let cid = self.child_id(parent, &name).ok_or(VfsError::NoEnt)?;
            if matches!(self.inodes.get(&cid).unwrap().data, NodeData::Dir(_)) {
                return Err(VfsError::IsDir);
            }
            // unlink_child decrements the link count and frees the inode on the
            // last link (a hard-linked file stays until its other names go).
            self.unlink_child(parent, &name);
            Ok(())
        })()
        .map_err(VfsError::code)
    }

    /// Remove an empty directory. Errors: ENOENT, ENOTDIR, ENOTEMPTY.
    pub fn rmdir(&mut self, path: String) -> Result<(), String> {
        (|| {
            let (parent, name) = self.resolve_parent(&path)?;
            let cid = self.child_id(parent, &name).ok_or(VfsError::NoEnt)?;
            match &self.inodes.get(&cid).unwrap().data {
                NodeData::Dir(m) => {
                    if !m.is_empty() {
                        return Err(VfsError::NotEmpty);
                    }
                }
                _ => return Err(VfsError::NotDir),
            }
            // unlink_child decrements the dir's single link and frees its inode.
            self.unlink_child(parent, &name);
            Ok(())
        })()
        .map_err(VfsError::code)
    }

    /// Rename/move an entry, overwriting the destination name if present.
    pub fn rename(&mut self, from: String, to: String) -> Result<(), String> {
        (|| {
            let (fparent, fname) = self.resolve_parent(&from)?;
            let cid = self.child_id(fparent, &fname).ok_or(VfsError::NoEnt)?;
            let (tparent, tname) = self.resolve_parent(&to)?;
            // Renaming a name onto itself is a no-op (and must skip the steps below,
            // which would otherwise free the inode).
            if fparent == tparent && fname == tname {
                return Ok(());
            }
            // POSIX rename atomically replaces an existing destination: drop its
            // link first (frees the clobbered inode on its last link).
            if self.child_id(tparent, &tname).is_some() {
                self.unlink_child(tparent, &tname);
            }
            // Add the new name BEFORE removing the old one so the moved inode's
            // link count never transiently hits 0 (which would free its data).
            self.link_child(tparent, &tname, cid);
            self.unlink_child(fparent, &fname);
            Ok(())
        })()
        .map_err(VfsError::code)
    }

    /// hard link: make `linkpath` an additional name for the SAME inode as
    /// `existing` (link(2)), sharing its bytes with no copy. Does not follow a
    /// trailing symlink on `existing`. Errors: ENOENT (existing missing), EEXIST
    /// (linkpath taken), EINVAL (refuse to hard-link a directory).
    pub fn link(&mut self, existing: String, linkpath: String) -> Result<(), String> {
        (|| {
            let src = self.resolve(&existing, false)?;
            if matches!(
                self.inodes.get(&src).ok_or(VfsError::NoEnt)?.data,
                NodeData::Dir(_)
            ) {
                return Err(VfsError::Inval);
            }
            let (parent, name) = self.resolve_parent(&linkpath)?;
            if self.child_id(parent, &name).is_some() {
                return Err(VfsError::Exist);
            }
            self.link_child(parent, &name, src);
            Ok(())
        })()
        .map_err(VfsError::code)
    }

    /// Create a symbolic link at `linkpath` pointing to `target`.
    pub fn symlink(&mut self, target: String, linkpath: String) -> Result<(), String> {
        (|| {
            let (parent, name) = self.resolve_parent(&linkpath)?;
            if self.child_id(parent, &name).is_some() {
                return Err(VfsError::Exist);
            }
            let id = self.alloc(NodeData::Symlink(target), 0o777);
            self.link_child(parent, &name, id);
            Ok(())
        })()
        .map_err(VfsError::code)
    }

    /// Read a symlink's target (does not follow it). Errors: ENOENT, EINVAL.
    pub fn readlink(&self, path: String) -> Result<String, String> {
        (|| {
            let id = self.resolve(&path, false)?;
            match &self.inodes.get(&id).unwrap().data {
                NodeData::Symlink(t) => Ok(t.clone()),
                _ => Err(VfsError::Inval),
            }
        })()
        .map_err(VfsError::code)
    }

    /// stat (follows a trailing symlink). Returns a small JSON string.
    pub fn stat(&self, path: String) -> Result<String, String> {
        self.stat_impl(&path, true).map_err(VfsError::code)
    }

    /// lstat (does not follow a trailing symlink).
    pub fn lstat(&self, path: String) -> Result<String, String> {
        self.stat_impl(&path, false).map_err(VfsError::code)
    }

    /// Whether a path exists (following symlinks).
    pub fn exists(&self, path: String) -> bool {
        self.resolve(&path, true).is_ok()
    }

    // ---- file-descriptor layer (brick #4 / Phase 2 #4) --------------------
    // Real fds let us run Node's actual `lib/fs.js`, which routes even
    // `readFileSync` through open -> fstat -> read -> close.

    /// open(2). `flags` are POSIX O_* bits (see stringToFlags on the JS side).
    /// Creates the file with `mode` when O_CREAT is set. Returns a numeric fd.
    pub fn open(&mut self, path: String, flags: i32, mode: u32) -> Result<u32, String> {
        (|| {
            let accmode = flags & 0o3;
            let writable = accmode == O_WRONLY || accmode == O_RDWR;
            let readable = accmode == 0 /* O_RDONLY */ || accmode == O_RDWR;

            let inode = match self.resolve(&path, true) {
                Ok(id) => {
                    if flags & O_EXCL != 0 && flags & O_CREAT != 0 {
                        return Err(VfsError::Exist);
                    }
                    match &self.inodes.get(&id).unwrap().data {
                        NodeData::Dir(_) => {
                            if writable {
                                return Err(VfsError::IsDir);
                            }
                        }
                        NodeData::File(_) => {
                            if flags & O_TRUNC != 0 && writable {
                                if let NodeData::File(fb) =
                                    &mut self.inodes.get_mut(&id).unwrap().data
                                {
                                    fb.clear();
                                }
                                self.inodes.get_mut(&id).unwrap().mtime = Self::now();
                                self.hot.invalidate(id);
                            }
                        }
                        NodeData::Symlink(_) => {}
                    }
                    id
                }
                Err(VfsError::NoEnt) if flags & O_CREAT != 0 => {
                    let (parent, name) = self.resolve_parent(&path)?;
                    let id = self.alloc(NodeData::File(FileBody::raw(Vec::new())), mode & 0o777);
                    self.link_child(parent, &name, id);
                    id
                }
                Err(e) => return Err(e),
            };

            let pos = if flags & O_APPEND != 0 {
                match &self.inodes.get(&inode).unwrap().data {
                    NodeData::File(fb) => fb.logical_len(),
                    _ => 0,
                }
            } else {
                0
            };
            // Track writable opens so we only compress once the file is quiescent.
            if writable {
                if let Some(node) = self.inodes.get_mut(&inode) {
                    node.wopen = node.wopen.saturating_add(1);
                }
            }
            let fd = self.next_fd;
            self.next_fd += 1;
            self.open_files.insert(
                fd,
                OpenFile {
                    inode,
                    pos,
                    readable,
                    writable,
                    append: flags & O_APPEND != 0,
                },
            );
            Ok(fd as u32)
        })()
        .map_err(VfsError::code)
    }

    /// close(2). Idempotent-ish: an unknown fd is EBADF. Closing the last
    /// writable fd on a file is the trigger to (re)compress it.
    pub fn close(&mut self, fd: u32) -> Result<(), String> {
        match self.open_files.remove(&(fd as u64)) {
            Some(of) => {
                if of.writable {
                    if let Some(node) = self.inodes.get_mut(&of.inode) {
                        node.wopen = node.wopen.saturating_sub(1);
                    }
                    self.maybe_compress(of.inode);
                }
                Ok(())
            }
            None => Err(VfsError::Badf),
        }
        .map_err(VfsError::code)
    }

    /// pread/read: read up to `len` bytes. `pos < 0` reads at (and advances) the
    /// fd cursor; `pos >= 0` reads at that absolute offset without moving it.
    pub fn fd_read(&mut self, fd: u32, len: u32, pos: f64) -> Result<Vec<u8>, String> {
        (|| {
            let of = self.open_files.get(&(fd as u64)).ok_or(VfsError::Badf)?;
            if !of.readable {
                return Err(VfsError::Badf);
            }
            let inode = of.inode;
            let cursor = of.pos;
            let start = if pos >= 0.0 { pos as usize } else { cursor };
            // Cold (compressed) files are inflated once into the bounded hot cache
            // so a chunked read loop doesn't re-inflate on every call; the file
            // itself stays compressed. Raw files are read directly.
            let is_zip = matches!(
                self.inodes.get(&inode).ok_or(VfsError::Badf)?.data,
                NodeData::File(FileBody::Zip { .. })
            );
            let out = if is_zip {
                self.ensure_hot(inode);
                match self.hot.get(inode) {
                    Some(buf) => read_range(buf, start, len as usize),
                    None => Vec::new(),
                }
            } else {
                match &self.inodes.get(&inode).ok_or(VfsError::Badf)?.data {
                    NodeData::File(fb) => read_range(fb.raw_ref(), start, len as usize),
                    NodeData::Dir(_) => return Err(VfsError::IsDir),
                    NodeData::Symlink(_) => return Err(VfsError::Inval),
                }
            };
            if pos < 0.0 {
                self.open_files.get_mut(&(fd as u64)).unwrap().pos = start + out.len();
            }
            Ok(out)
        })()
        .map_err(VfsError::code)
    }

    /// pwrite/write: write `data`. `pos < 0` writes at (and advances) the cursor;
    /// `pos >= 0` writes at that absolute offset. O_APPEND always writes at EOF.
    /// Gaps are zero-filled. Returns the number of bytes written.
    pub fn fd_write(&mut self, fd: u32, data: Vec<u8>, pos: f64) -> Result<u32, String> {
        (|| {
            let of = self.open_files.get(&(fd as u64)).ok_or(VfsError::Badf)?;
            if !of.writable {
                return Err(VfsError::Badf);
            }
            let inode = of.inode;
            let cursor = of.pos;
            let append = of.append;
            // Writing invalidates any cached inflate and (via raw_mut) inflates a
            // compressed body in place; it recompresses when the last fd closes.
            self.hot.invalidate(inode);
            let node = self.inodes.get_mut(&inode).ok_or(VfsError::Badf)?;
            let buf = match &mut node.data {
                NodeData::File(fb) => fb.raw_mut(),
                NodeData::Dir(_) => return Err(VfsError::IsDir),
                NodeData::Symlink(_) => return Err(VfsError::Inval),
            };
            let start = if append {
                buf.len()
            } else if pos >= 0.0 {
                pos as usize
            } else {
                cursor
            };
            if start > buf.len() {
                buf.resize(start, 0);
            }
            let end = start + data.len();
            if end > buf.len() {
                buf.resize(end, 0);
            }
            buf[start..end].copy_from_slice(&data);
            node.mtime = Self::now();
            if append || pos < 0.0 {
                self.open_files.get_mut(&(fd as u64)).unwrap().pos = end;
            }
            Ok(data.len() as u32)
        })()
        .map_err(VfsError::code)
    }

    /// fstat(2): stat the inode behind an open fd.
    pub fn fstat(&self, fd: u32) -> Result<String, String> {
        (|| {
            let of = self.open_files.get(&(fd as u64)).ok_or(VfsError::Badf)?;
            Ok(self.stat_node_json(of.inode))
        })()
        .map_err(VfsError::code)
    }

    /// Diagnostic: total bytes of content the VFS holds in RAM — file bodies +
    /// symlink targets + a rough per-directory-entry overhead. This is the logical
    /// footprint (what dominates the File System Worker's Wasm linear memory when a
    /// big `node_modules` is loaded); returned as f64 so it never overflows u32 past
    /// 4 GiB. Used by the studio's memory readout to attribute the tab's RAM.
    pub fn mem_bytes(&self) -> f64 {
        let mut total: usize = 0;
        for node in self.inodes.values() {
            total += match &node.data {
                // Physical footprint: compressed size for cold files.
                NodeData::File(fb) => fb.physical_len(),
                NodeData::Symlink(t) => t.len(),
                // Directory storage is the sum of its entry names + a per-entry map
                // overhead (name String + u64 id ~ 8 bytes); a rough estimate.
                NodeData::Dir(m) => m.keys().map(|k| k.len() + 8).sum::<usize>(),
            };
        }
        // The hot-read cache is genuinely resident RAM too, so count it.
        (total + self.hot.bytes) as f64
    }

    /// Diagnostic companion to `mem_bytes`: the uncompressed footprint the VFS
    /// would occupy with compression off. Dividing mem_bytes by this gives the
    /// realized compression ratio for the Measure Memory readout.
    pub fn logical_mem_bytes(&self) -> f64 {
        let mut total: usize = 0;
        for node in self.inodes.values() {
            total += match &node.data {
                NodeData::File(fb) => fb.logical_len(),
                NodeData::Symlink(t) => t.len(),
                NodeData::Dir(m) => m.keys().map(|k| k.len() + 8).sum::<usize>(),
            };
        }
        total as f64
    }

    /// Enable/disable whole-file lazy compression at runtime. Turning it off does
    /// not eagerly inflate existing Zip bodies; they inflate lazily on read/write.
    pub fn set_compression(&mut self, on: bool) {
        self.compression = on;
        if !on {
            self.hot.clear();
        }
    }

    /// Diagnostic companion to `mem_bytes`: how many regular files the VFS holds.
    pub fn file_count(&self) -> u32 {
        self.inodes
            .values()
            .filter(|n| matches!(n.data, NodeData::File(_)))
            .count() as u32
    }

    /// chmod(2) / lchmod: replace the permission bits at `path`. `follow` resolves
    /// a trailing symlink (chmod) or changes the link itself (lchmod).
    ///
    /// The mode is stored, not enforced — there is one user here and no kernel
    /// beneath us — but stored is what callers actually need: an extracted archive
    /// keeps its executable bits, `access(X_OK)` answers from what chmod set, and a
    /// build script that chmods its own output and then runs it works. Dropping
    /// the call (which is what happened before) meant stat() reported a mode
    /// nobody had asked for.
    pub fn set_mode(&mut self, path: String, mode: u32, follow: bool) -> Result<(), String> {
        (|| {
            let id = self.resolve(&path, follow)?;
            let node = self.inodes.get_mut(&id).ok_or(VfsError::NoEnt)?;
            node.mode = mode & 0o7777;
            Ok(())
        })()
        .map_err(VfsError::code)
    }

    /// fchmod(2): the same, for an open fd.
    pub fn fset_mode(&mut self, fd: u32, mode: u32) -> Result<(), String> {
        (|| {
            let of = self.open_files.get(&(fd as u64)).ok_or(VfsError::Badf)?;
            let inode = of.inode;
            let node = self.inodes.get_mut(&inode).ok_or(VfsError::Badf)?;
            node.mode = mode & 0o7777;
            Ok(())
        })()
        .map_err(VfsError::code)
    }

    /// utimes(2) / lutimes: set access and modification times, in ms since the
    /// epoch. `follow` resolves a trailing symlink (utimes) or stamps the link
    /// itself (lutimes).
    pub fn set_times(
        &mut self,
        path: String,
        atime_ms: f64,
        mtime_ms: f64,
        follow: bool,
    ) -> Result<(), String> {
        (|| {
            let id = self.resolve(&path, follow)?;
            let node = self.inodes.get_mut(&id).ok_or(VfsError::NoEnt)?;
            node.atime = atime_ms;
            node.mtime = mtime_ms;
            Ok(())
        })()
        .map_err(VfsError::code)
    }

    /// futimes(2): the same, for an open fd.
    pub fn fset_times(&mut self, fd: u32, atime_ms: f64, mtime_ms: f64) -> Result<(), String> {
        (|| {
            let of = self.open_files.get(&(fd as u64)).ok_or(VfsError::Badf)?;
            let inode = of.inode;
            let node = self.inodes.get_mut(&inode).ok_or(VfsError::Badf)?;
            node.atime = atime_ms;
            node.mtime = mtime_ms;
            Ok(())
        })()
        .map_err(VfsError::code)
    }

    /// ftruncate(2): grow (zero-filled) or shrink the file behind an open fd.
    pub fn ftruncate(&mut self, fd: u32, len: u32) -> Result<(), String> {
        (|| {
            let of = self.open_files.get(&(fd as u64)).ok_or(VfsError::Badf)?;
            if !of.writable {
                return Err(VfsError::Badf);
            }
            let inode = of.inode;
            self.hot.invalidate(inode);
            let node = self.inodes.get_mut(&inode).ok_or(VfsError::Badf)?;
            match &mut node.data {
                NodeData::File(fb) => fb.raw_mut().resize(len as usize, 0),
                NodeData::Dir(_) => return Err(VfsError::IsDir),
                NodeData::Symlink(_) => return Err(VfsError::Inval),
            }
            node.mtime = Self::now();
            Ok(())
        })()
        .map_err(VfsError::code)
    }
}

// Non-#[wasm_bindgen] helpers that need &mut self / shared logic.
impl VirtualFileSystem {
    // Remove a name→inode link from `parent`, decrement the target's link count,
    // and free the inode once its last link is gone. Returns the (former) child id
    // when the name existed. This is the single place inodes are reclaimed, so
    // hard-linked files survive until every name referencing them is unlinked.
    fn unlink_child(&mut self, parent: u64, name: &str) -> Option<u64> {
        let cid = match self.inodes.get_mut(&parent) {
            Some(Inode {
                data: NodeData::Dir(m),
                ..
            }) => m.remove(name),
            _ => None,
        }?;
        if let Some(node) = self.inodes.get_mut(&cid) {
            node.nlink = node.nlink.saturating_sub(1);
            if node.nlink == 0 {
                self.inodes.remove(&cid);
            }
        }
        Some(cid)
    }

    fn stat_impl(&self, path: &str, follow_last: bool) -> VfsResult<String> {
        let id = self.resolve(path, follow_last)?;
        Ok(self.stat_node_json(id))
    }

    /// Format one inode as the small JSON blob the JS `fs` binding parses into a
    /// Node `Stats`. `ino` is the inode id, so different paths to the same file
    /// share it; the JS side composes the full `mode` (type bits) from `kind`.
    fn stat_node_json(&self, id: u64) -> String {
        let node = self.inodes.get(&id).unwrap();
        let (kind, size) = match &node.data {
            NodeData::File(fb) => ("file", fb.logical_len()),
            NodeData::Dir(m) => ("dir", m.len()),
            NodeData::Symlink(t) => ("symlink", t.len()),
        };
        format!(
            "{{\"kind\":\"{}\",\"size\":{},\"mode\":{},\"mtimeMs\":{},\"atimeMs\":{},\"ino\":{},\"nlink\":{}}}",
            kind,
            size,
            node.mode,
            node.mtime,
            node.atime,
            id,
            node.nlink.max(1)
        )
    }
}

impl Default for VirtualFileSystem {
    fn default() -> Self {
        Self::new()
    }
}