---
"@vivari/core": patch
---

`process.getActiveResourcesInfo()` exists and names what keeps a process alive, as Node does: its listening servers, sockets, child processes, fork channel, watchers, ref'd timers and immediates. Nuxt's CLI calls it when `nuxt dev` overruns its shutdown budget, to say what is still open before it exits anyway; the TypeError used to replace that exit, so `q` could sit at "Cleaning up..." until every close hook finished, or forever.
