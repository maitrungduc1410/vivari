---
"@vivari/core": patch
---

A process's `ReadableStream` is async iterable in Safari too (`for await` and `values()`), including a `fetch` response's body. pnpm reads every tarball that way, so `pnpm install` and `pnpm add` failed on iOS with `undefined is not a function`.
