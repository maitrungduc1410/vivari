//! OpenContainer kernel — the in-RAM Virtual File System (VFS).
//!
//! Brick #2: a real POSIX-ish filesystem tree (not a flat map). Files live in an
//! inode table; directories map names -> inode ids; symlinks store a target path.
//! Path resolution walks the tree from root, follows symlinks (with a loop
//! guard), and understands `.` / `..`.
//!
//! Errors are surfaced to JS as `errno`-style string codes ("ENOENT", ...) which
//! the JS `fs` facade turns into Node-compatible errors (`err.code`).

use std::collections::{BTreeMap, HashMap};
use wasm_bindgen::prelude::*;

const ROOT_ID: u64 = 1;
const SYMLINK_MAX_DEPTH: usize = 40;

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
    File(Vec<u8>),
    Dir(BTreeMap<String, u64>), // BTreeMap => readdir is naturally sorted
    Symlink(String),
}

struct Inode {
    data: NodeData,
    mode: u32,
    mtime: f64,
}

#[wasm_bindgen]
pub struct VirtualFileSystem {
    inodes: HashMap<u64, Inode>,
    next_id: u64,
    open_files: HashMap<u64, OpenFile>,
    // Descriptors start at 3, leaving 0/1/2 for the stdio the runtime owns.
    next_fd: u64,
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
    }

    fn child_id(&self, parent: u64, name: &str) -> Option<u64> {
        match &self.inodes.get(&parent)?.data {
            NodeData::Dir(m) => m.get(name).copied(),
            _ => None,
        }
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
                NodeData::File(b) => Ok(b.clone()),
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
            match self.child_id(parent, &name) {
                Some(cid) => match &mut self.inodes.get_mut(&cid).unwrap().data {
                    NodeData::File(buf) => {
                        *buf = content;
                        self.inodes.get_mut(&cid).unwrap().mtime = Self::now();
                        Ok(())
                    }
                    NodeData::Dir(_) => Err(VfsError::IsDir),
                    NodeData::Symlink(_) => Err(VfsError::Inval),
                },
                None => {
                    let id = self.alloc(NodeData::File(content), 0o644);
                    self.link_child(parent, &name, id);
                    Ok(())
                }
            }
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
            self.unlink_child(parent, &name);
            self.inodes.remove(&cid);
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
            self.unlink_child(parent, &name);
            self.inodes.remove(&cid);
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
            self.unlink_child(fparent, &fname);
            self.link_child(tparent, &tname, cid);
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
                                if let NodeData::File(buf) =
                                    &mut self.inodes.get_mut(&id).unwrap().data
                                {
                                    buf.clear();
                                }
                                self.inodes.get_mut(&id).unwrap().mtime = Self::now();
                            }
                        }
                        NodeData::Symlink(_) => {}
                    }
                    id
                }
                Err(VfsError::NoEnt) if flags & O_CREAT != 0 => {
                    let (parent, name) = self.resolve_parent(&path)?;
                    let id = self.alloc(NodeData::File(Vec::new()), mode & 0o777);
                    self.link_child(parent, &name, id);
                    id
                }
                Err(e) => return Err(e),
            };

            let pos = if flags & O_APPEND != 0 {
                match &self.inodes.get(&inode).unwrap().data {
                    NodeData::File(b) => b.len(),
                    _ => 0,
                }
            } else {
                0
            };
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

    /// close(2). Idempotent-ish: an unknown fd is EBADF.
    pub fn close(&mut self, fd: u32) -> Result<(), String> {
        self.open_files
            .remove(&(fd as u64))
            .map(|_| ())
            .ok_or(VfsError::Badf)
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
            let out = match &self.inodes.get(&inode).ok_or(VfsError::Badf)?.data {
                NodeData::File(b) => {
                    if start >= b.len() {
                        Vec::new()
                    } else {
                        let end = (start + len as usize).min(b.len());
                        b[start..end].to_vec()
                    }
                }
                NodeData::Dir(_) => return Err(VfsError::IsDir),
                NodeData::Symlink(_) => return Err(VfsError::Inval),
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
            let node = self.inodes.get_mut(&inode).ok_or(VfsError::Badf)?;
            let buf = match &mut node.data {
                NodeData::File(b) => b,
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

    /// ftruncate(2): grow (zero-filled) or shrink the file behind an open fd.
    pub fn ftruncate(&mut self, fd: u32, len: u32) -> Result<(), String> {
        (|| {
            let of = self.open_files.get(&(fd as u64)).ok_or(VfsError::Badf)?;
            if !of.writable {
                return Err(VfsError::Badf);
            }
            let inode = of.inode;
            let node = self.inodes.get_mut(&inode).ok_or(VfsError::Badf)?;
            match &mut node.data {
                NodeData::File(b) => b.resize(len as usize, 0),
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
    fn unlink_child(&mut self, parent: u64, name: &str) {
        if let Some(Inode {
            data: NodeData::Dir(m),
            ..
        }) = self.inodes.get_mut(&parent)
        {
            m.remove(name);
        }
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
            NodeData::File(b) => ("file", b.len()),
            NodeData::Dir(m) => ("dir", m.len()),
            NodeData::Symlink(t) => ("symlink", t.len()),
        };
        format!(
            "{{\"kind\":\"{}\",\"size\":{},\"mode\":{},\"mtimeMs\":{},\"ino\":{}}}",
            kind, size, node.mode, node.mtime, id
        )
    }
}

impl Default for VirtualFileSystem {
    fn default() -> Self {
        Self::new()
    }
}
