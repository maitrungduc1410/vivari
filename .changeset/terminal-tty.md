---
"@vivari/core": patch
---

A process whose stdout writes to the terminal now sees `process.stdout.isTTY` (and `tty.isatty(1)`) as true, with `getColorDepth`, `hasColors` and the cursor methods, and `readline.emitKeypressEvents` works. A child spawned with `stdio: 'inherit'` from a TTY gets the same. CLIs that draw a dashboard only on a TTY, such as `nuxt dev`, now draw it. A signal is also delivered once: a SIGINT handler that made a syscall used to run twice.
