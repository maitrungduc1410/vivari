# @vivari/react

From 1.1.0 on, entries are generated from [changesets](https://github.com/changesets/changesets).
`@vivari/core` and `@vivari/react` are released together under the same version, so a release
that says "No changes in this release" changed only `@vivari/core`.

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