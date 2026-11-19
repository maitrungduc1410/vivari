---
"@vivari/core": patch
---

`/bin`'s programs are on `PATH` under their bare names (`/bin/pnpm` next to `/bin/pnpm.js`), and npm, pnpm, yarn, corepack and tsc are there before their first use, as an installed tool would be. A program that searches `PATH` itself, as `which` does, found nothing: Nuxt's CLI checks for `pnpm` that way before `nuxt module add` installs with it, and stopped at "`pnpm` was not found" in a VM where `pnpm add` works. A tool found that way and spawned by its `/bin` path also loads on first use.
