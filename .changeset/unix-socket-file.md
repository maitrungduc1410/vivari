---
"@vivari/core": patch
"@vivari/react": patch
---

A server listening on a UNIX socket path now leaves a file at that path, as on a real system, and closing the server removes it. Tools that `chmod` or `stat` their socket right after `listen()` no longer fail with `ENOENT`; Nuxt 4's `nuxt dev` did exactly that with its vite-node `nuxt.sock`, closed the server, and its SSR worker's connection then failed with `connect ENOENT`.
