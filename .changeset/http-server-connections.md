---
"@vivari/core": patch
---

An `http.Server` knows its connections, so `server.close()` closes the idle keep-alive ones and `closeIdleConnections()` and `closeAllConnections()` close what they say, as in Node. The list behind them was always empty, so `server.close()` waited for every keep-alive or streaming connection to end by itself: with a browser connected, `nuxt dev`'s `r` (hard restart, `@nuxt/cli` 4.1) hung at "Restarting Nuxt in a new process..." and `q` waited out its 15 s budget.
