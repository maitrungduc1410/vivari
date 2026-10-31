# @vivari/core

From 1.1.0 on, entries are generated from [changesets](https://github.com/changesets/changesets).
`@vivari/core` and `@vivari/react` are released together under the same version.

## 1.1.5

### Patch Changes

- [#19](https://github.com/maitrungduc1410/vivari/pull/19) [`86a20ce`](https://github.com/maitrungduc1410/vivari/commit/86a20cec6a0f20ea8b7cc43a9e1a49ec298e348e) Thanks [@kele23](https://github.com/kele23)! - Runtime: fall back to the next `exports` condition (and to `module`) when a package's declared `main`/`require` target is absent, so pruned ESM-only copies such as nitro's traced `dist/node_modules` load instead of throwing `MODULE_NOT_FOUND`.

## 1.1.4

### Patch Changes

- [`3921534`](https://github.com/maitrungduc1410/vivari/commit/39215341e186579f08ecebeff0126ee43056b528) Thanks [@maitrungduc1410](https://github.com/maitrungduc1410)! - Resolve symlinks in `fs.realpathSync.native` / `fs.realpath.native` (`binding.realpath`) so Vite's dependency optimizer can follow `pnpm`'s `.pnpm` symlink layout, and remap registry-aliased WASM packages (`lightningcss-wasm`, `esbuild-wasm`, `@rollup/wasm-node`, `bcryptjs`) when `pnpm` reads back from its content-addressed store so subsequent `pnpm` commands no longer fail with `ERR_PNPM_UNEXPECTED_PKG_CONTENT_IN_STORE` (GitHub issue [#17](https://github.com/maitrungduc1410/vivari/issues/17)).

## 1.1.3

### Patch Changes

- [`f469db1`](https://github.com/maitrungduc1410/vivari/commit/f469db17ab58c7c3608e699f0605b6afd4e5ba43) Thanks [@maitrungduc1410](https://github.com/maitrungduc1410)! - Preserve inbound Host headers and make the browser runtime's legacy `url.parse` compatible with protocol-relative host strings used by current development servers.

## 1.1.2

### Patch Changes

- [`b15a8f4`](https://github.com/maitrungduc1410/vivari/commit/b15a8f40deb02133d8bd87203fbab5d674bdbfa1) Thanks [@maitrungduc1410](https://github.com/maitrungduc1410)! - Guard `@npmcli/arborist`'s `#loadPeerSet` against a peer node that gets replaced and detached in its virtual `peerSet` mid-iteration (triggered by `@angular/build` → `vitest@4.1.12` → `@vitest/browser-webdriverio@4.1.11`), preventing `TypeError: Cannot read properties of null (reading 'edgesOut')` during `npm install`.

## 1.1.1

### Patch Changes

- [`93a6a79`](https://github.com/maitrungduc1410/vivari/commit/93a6a79b35d4e8800e93f67af6827761c07b494c) Thanks [@maitrungduc1410](https://github.com/maitrungduc1410)! - A `MessagePort` follows Node's rules in the browser: `onmessage` and `addEventListener('message')` now start the port and keep the process alive like `on('message')`, a port stops holding when its other end closes, and a worker's `parentPort` is a real `MessagePort` (GitHub issue [#13](https://github.com/maitrungduc1410/vivari/issues/13)).

## 1.1.0

### Minor Changes

- [#9](https://github.com/maitrungduc1410/vivari/pull/9) [`973e503`](https://github.com/maitrungduc1410/vivari/commit/973e503c1b1a5e4c792635b2cc1bd8f43442f12e) Thanks [@ThailerL](https://github.com/ThailerL)! - Add a `connection` event (with the `ConnectionEvent` and `ConnectionListener` types) that fires when one process in the VM opens a TCP connection to a server in another, before either end can send anything. It reports the server's port, the connection's `remotePort`, both pids, and the client's still-running ancestors.

- [#10](https://github.com/maitrungduc1410/vivari/pull/10) [`525b244`](https://github.com/maitrungduc1410/vivari/commit/525b24471aea1f15c8b97a675390421c7d827691) Thanks [@ThailerL](https://github.com/ThailerL)! - Previews now carry the host page's `Document-Isolation-Policy` (Chromium), so a same-origin preview lands in the page's agent cluster and its `contentWindow.location` stays readable. Declare the value with the new `BootOptions.documentIsolationPolicy` (the `DocumentIsolationPolicy` type, `"none"` for no header); left unset, the Service Worker learns it with a `HEAD` to the page's URL, without its query or fragment and without following redirects. Previews served to a cross-origin IDE (modes B and C) get no policy.

### Patch Changes

- [#9](https://github.com/maitrungduc1410/vivari/pull/9) [`973e503`](https://github.com/maitrungduc1410/vivari/commit/973e503c1b1a5e4c792635b2cc1bd8f43442f12e) Thanks [@ThailerL](https://github.com/ThailerL)! - A server accepting a connection from another process in the VM now sees a real `socket.remoteAddress` and `socket.remotePort`, which used to be `undefined`. The kernel picks the client's port from the ephemeral range, unique across the VM while the connection is open, so two processes dialing the same server no longer report the same `localPort`.

- [`4898638`](https://github.com/maitrungduc1410/vivari/commit/48986382c7118534cd67489474efdbe207427dcf) Thanks [@maitrungduc1410](https://github.com/maitrungduc1410)! - A cross-process TCP dial that finds every client port in use now fails with `EADDRNOTAVAIL`, as on a real host, instead of `ECONNREFUSED`.

- [#11](https://github.com/maitrungduc1410/vivari/pull/11) [`700ed05`](https://github.com/maitrungduc1410/vivari/commit/700ed05daea0b8ab8fe46aefeedfd1a9073d7ed2) Thanks [@ThailerL](https://github.com/ThailerL)! - A hard-reloaded page (Ctrl+Shift+R) has no Service Worker controller, so its previews used to go to the host's origin while `boot()` reported success. The page now asks the preview Service Worker to claim it. The standalone preview tab of modes B and C, `__vv-preview-boot.html`, does the same and comes back after a hard reload instead of waiting for a controller that never came.

## 1.0.3

### Patch Changes

- [#6](https://github.com/maitrungduc1410/vivari/pull/6) Thanks [@maceip](https://github.com/maceip)! - An optional network relay, off by default: with `BootOptions.netRelay` pointing at a local agent (`scripts/net-relay.mjs`), `connect()` to an external host rides a Wisp stream, and `listen(port)` also binds `127.0.0.1:<port>` on the relay's machine, so a browser redirected to `http://localhost:<port>/callback` reaches the in-VM server. Follow-ups harden it: the relay token is never logged, a failed dial emits `error` (`ECONNREFUSED`, `ENOTFOUND`) instead of `connect` then `close`, and a dropped relay reconnects with backoff and re-announces its listeners.
- [#5](https://github.com/maitrungduc1410/vivari/pull/5) Thanks [@ThailerL](https://github.com/ThailerL)! - A second `listen()` on a port that is already taken fails with `EADDRINUSE` without unregistering the server that holds it, which the same process could no longer reach.
- [#8](https://github.com/maitrungduc1410/vivari/pull/8) Thanks [@kkrausse](https://github.com/kkrausse)! - Deleting a file or directory in OPFS and recreating it at the same path, or changing its kind, no longer loses the new entry on reload.
- [#7](https://github.com/maitrungduc1410/vivari/issues/7) - A guest's `fetch("http://localhost:<port>")` reaches a server listening on that port in the VM, as `http.get` already did, instead of going to the browser's own localhost. `https:` to a local host rejects with `ERR_VIVARI_LOOPBACK_TLS`.

## 1.0.2

### Patch Changes

- The runtime works on Firefox. Packages that need V8's structured stack traces, such as `depd`, no longer crash on `require`, and uncaught errors keep their message.
- Whole-file reads made by the kernel (`vivari.export()`, recursive copy, search) no longer skip files larger than the 1 MiB shared window. `export()` used to drop them and still report `truncated: false`.

## 1.0.1

### Patch Changes

- Python: a notebook, `subprocess`, `python -m` for any module, `--reload`, and a scientific stack that works offline.
- Node and Bun: interactive REPLs, Bun's `new Worker()` on real threads, and wider Bun API coverage.
- The kernel keeps a cookie jar, so a login survives to the next request.
- File-system payloads larger than the 1 MiB shared window are carried whole.
- Node-fidelity fixes across the runtime, file system, network and codecs: HTTP body encoding is decided by the bytes, not the `Content-Type`; a handle's close callback runs in its loop phase; a failing guest process fails without taking the kernel down.
- `npm run dev` no longer kills a running Vite dev server, and the stall watchdog no longer reports a healthy dev server as stuck.

## 1.0.0

First release.