---
"@vivari/core": patch
---

`stream.finished()` now works on web streams a process creates in the browser, and `performance.markResourceTiming` exists, as in Node. undici's `fetch` uses both on every response body; without them it aborted each response, so `pnpm add` in a browser tab waited out its retries on every package's metadata and took minutes.
