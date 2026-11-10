---
"@vivari/core": minor
"@vivari/react": minor
---

The bundled pnpm is now 11. `tls.connect` to an outside host works for HTTP/1.1 clients such as the undici pnpm 11 ships: requests written into the socket are answered through fetch, and anything that is not HTTP is refused by name. New `vivari.snapshot(path)` and `vivari.restore(bytes, { mountPoint })` pack a directory, `node_modules` included, into opaque bytes and unpack them, so a warmed project can skip its install next session; restore validates the bytes before writing anything. `vivari.spawn(..., { terminal: { cols, rows } })` and `proc.resize({ cols, rows })` give a process its real terminal size: it sees `process.stdout.columns`/`rows`, then a `'resize'` event and `SIGWINCH` when the size changes, and children inherit it. `vivari.export()` now returns each file's bytes as `contents`, as documented; it used to leave `contents` undefined.
