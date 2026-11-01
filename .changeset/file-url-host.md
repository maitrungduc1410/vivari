---
"@vivari/core": patch
---

Runtime: one shared rule (`file-url.js`) converts `file:` URLs to VFS paths and back.
`import.meta.url`, `pathToFileURL()` (Node and Bun) and the debugger build three-slash URLs
from root-relative paths, so a relative module id can no longer become a URL host, and every
conversion call site goes through that rule instead of stripping the prefix by hand — a
stripped URL came back as a RELATIVE path. Chrome decides what a `file:` URL means with a
**platform-dependent** parser — `url/url_parse_file.cc` has a WIN32 branch that reads
`file:/home/user/x` as the UNC path `file://home/user/x` — so `fileURLToPath()` now
rebuilds the path a hostful URL describes instead of throwing `ERR_INVALID_FILE_URL_HOST`,
which made PGlite's CJS build (and anything else that locates data through
`"file:" + __filename`) fail to boot on Windows only. The recovery cannot undo what the
parser normalised (the host is lowercased, `123` becomes `0.0.0.123`, `localhost`
collapses), so it returns the path the URL now describes, not the one it meant.
`pathToFileURL()` also percent-encodes a literal `%` so file names round-trip.
