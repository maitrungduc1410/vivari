# @vivari/react

From 1.1.0 on, entries are generated from [changesets](https://github.com/changesets/changesets).
`@vivari/core` and `@vivari/react` are released together under the same version, so a release
that says "No changes in this release" changed only `@vivari/core`.

## 1.3.4

No changes in this release.

## 1.3.3

### Patch Changes

- [#47](https://github.com/maitrungduc1410/vivari/pull/47) [`1d1ad56`](https://github.com/maitrungduc1410/vivari/commit/1d1ad56639c86ce0ce3ed5b4842ea0541e0b04c1) Thanks [@atinux](https://github.com/atinux)! - Previews now load on Safari and every iOS browser. The preview Service Worker's first redirect (which takes the routing token off the preview URL) carried no headers, and WebKit refused it inside a cross-origin isolated page ("Redirection was blocked by Cross-Origin-Embedder-Policy"), so the preview stayed blank; it now carries the same COEP/CORP as the preview document.

- [#46](https://github.com/maitrungduc1410/vivari/pull/46) [`23e5f14`](https://github.com/maitrungduc1410/vivari/commit/23e5f14a320a6cd73edc585738b3139e7dedaf31) Thanks [@atinux](https://github.com/atinux)! - A server listening on a UNIX socket path now leaves a file at that path, as on a real system, and closing the server removes it. Tools that `chmod` or `stat` their socket right after `listen()` no longer fail with `ENOENT`; Nuxt 4's `nuxt dev` did exactly that with its vite-node `nuxt.sock`, closed the server, and its SSR worker's connection then failed with `connect ENOENT`.

## 1.3.2

No changes in this release.

## 1.3.1

### Patch Changes

- [`d13e37f`](https://github.com/maitrungduc1410/vivari/commit/d13e37f3cd757c4d647f53e859f97c8fe1f5ac0b) Thanks [@maitrungduc1410](https://github.com/maitrungduc1410)! - ES modules that put a comment inside an `import { … }` or `export { … }` list now load correctly. parse5 8.1 does this, and the comment was being read as part of the name, so the export came out `undefined`; Astro Starlight pages that render Markdown failed with a 500 `MDXError`.

## 1.3.0

### Minor Changes

- [`3bc9309`](https://github.com/maitrungduc1410/vivari/commit/3bc93091a7545d546809f44e297cbd4b2e924347) Thanks [@maitrungduc1410](https://github.com/maitrungduc1410)! - The bundled pnpm is now 11. `tls.connect` to an outside host works for HTTP/1.1 clients such as the undici pnpm 11 ships: requests written into the socket are answered through fetch, and anything that is not HTTP is refused by name. New `vivari.snapshot(path)` and `vivari.restore(bytes, { mountPoint })` pack a directory, `node_modules` included, into opaque bytes and unpack them, so a warmed project can skip its install next session; restore validates the bytes before writing anything. `vivari.spawn(..., { terminal: { cols, rows } })` and `proc.resize({ cols, rows })` give a process its real terminal size: it sees `process.stdout.columns`/`rows`, then a `'resize'` event and `SIGWINCH` when the size changes, and children inherit it. `vivari.export()` now returns each file's bytes as `contents`, as documented; it used to leave `contents` undefined.

## 1.2.1

No changes in this release.

## 1.2.0

### Minor Changes

- [`890c5f0`](https://github.com/maitrungduc1410/vivari/commit/890c5f00a97a507b2464a8ce98463a72dd095b63) Thanks [@maitrungduc1410](https://github.com/maitrungduc1410)! - `node:sqlite` is available in guest processes (`DatabaseSync`, `StatementSync`), on the same wasm SQLite as `bun:sqlite`, and matches real Node's behaviour case by case. SQLite file locks are now real across processes and threads, so several processes can write one database without losing rows; `bun:sqlite` gets this too. `crypto.getCurves()` exists and returns an empty list until ECDH is supported.

## 1.1.5

No changes in this release.

## 1.1.4

No changes in this release.

## 1.1.3

No changes in this release.

## 1.1.2

No changes in this release.

## 1.1.1

No changes in this release.

## 1.1.0

### Minor Changes

- [#9](https://github.com/maitrungduc1410/vivari/pull/9) [`973e503`](https://github.com/maitrungduc1410/vivari/commit/973e503c1b1a5e4c792635b2cc1bd8f43442f12e) Thanks [@ThailerL](https://github.com/ThailerL)! - Add a `connection` event (with the `ConnectionEvent` and `ConnectionListener` types) that fires when one process in the VM opens a TCP connection to a server in another, before either end can send anything. It reports the server's port, the connection's `remotePort`, both pids, and the client's still-running ancestors.

## 1.0.3

No changes in this release.

## 1.0.2

No changes in this release.

## 1.0.1

No changes in this release.

## 1.0.0

First release: the `<Vivari>` component and the `useVivari()` hook.