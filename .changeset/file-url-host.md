---
"@vivari/core": patch
---

Runtime: `import.meta.url`, `pathToFileURL()` (Node and Bun) and the debugger build `file:`
URLs from root-relative paths, so a relative module id can no longer become a URL host.
Chrome decides what a `file:` URL means with a **platform-dependent** parser —
`url/url_parse_file.cc` has a WIN32 branch that reads `file:/home/user/x` as the UNC path
`file://home/user/x` — so `fileURLToPath()` now rebuilds the absolute path a hostful URL
meant instead of throwing `ERR_INVALID_FILE_URL_HOST`, which made PGlite's CJS build (and
anything else that locates data through `"file:" + __filename`) fail to boot on Windows only.
`pathToFileURL()` also percent-encodes a literal `%` so file names round-trip.
