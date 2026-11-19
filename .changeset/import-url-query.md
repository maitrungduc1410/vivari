---
"@vivari/core": patch
---

A `file:` URL imported with a `?query` or `#hash` now loads its own module instance, as in Node, instead of returning the module already loaded from that path. Config loaders that re-import a file with a cache-busting query now see the edited file: c12 does this for `nuxt.config.ts`, so `nuxt dev` used to print "nuxt.config.ts saved without changing config" for every edit and never reload.
