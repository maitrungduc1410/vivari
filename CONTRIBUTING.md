# Contributing to Vivari

Thanks for your interest in Vivari — an open-source, browser-native WebContainer.
Contributions of all kinds are welcome: bug reports, docs, tests, and code.

## Ground rules

- Be respectful. This project follows a [Code of Conduct](CODE_OF_CONDUCT.md).
- Keep changes focused. One logical change per pull request is much easier to review.
- Discuss large or breaking changes in an issue first.

## Prerequisites

- **Node.js `>=22`** (see `.nvmrc`). Several dev/test scripts rely on Node 22 APIs.
- **Rust** + [`wasm-pack`](https://rustwasm.github.io/wasm-pack/) to build the
  Wasm crates (VFS / codec / crypto).
- A recent browser for the studio app.

## Getting started

```bash
# 1. Install dependencies
npm install

# 2. Build the Rust -> Wasm crates (web + node targets)
npm run build

# 3. Prove the sync-bridge works end-to-end, headless (no browser)
npm run verify

# 4. Run the studio IDE locally
npm run dev
```

The monorepo layout and the "why" behind each package are documented in
[`ARCHITECTURE.md`](ARCHITECTURE.md); the incremental build log lives in
[`roadmap.md`](roadmap.md).

## Project layout

| Path | What it is |
| --- | --- |
| `packages/core` | `@vivari/core` — the framework-agnostic SDK |
| `packages/react` | `@vivari/react` — `<Vivari>` component + `useVivari()` |
| `packages/vfs` / `codec` / `crypto` | Rust crates compiled to Wasm |
| `packages/runtime`, `kernel-host`, `protocol` | the Node runtime shim + kernel |
| `packages/studio` | the studio IDE (Vite + React) |
| `sites/landing` | the marketing / landing site |
| `sites/docs` | the documentation site at `/docs/` (Docusaurus) |
| `sites/blog` | the engineering blog at `/blog/` (a second Docusaurus site) |
| `sites/embed` | the runnable examples the docs and blog iframe |
| `examples/basic` | a minimal, runnable SDK example |
| `scripts` | verify / smoke / spike harnesses |

## Tests & checks

Before opening a pull request, please run the checks that match your change:

```bash
npm run verify        # hermetic, offline end-to-end suite
npm run smoke         # SDK public-API + packaging guard (offline)
npm run typecheck:sdk # type-check @vivari/core and @vivari/react
```

CI runs the same checks (see `.gitlab-ci.yml`). The network-dependent spike tier
(`npm run spikes:net`) boots real templates against the live npm registry and is
run manually / on a schedule.

## Writing a blog post

Posts live in `sites/blog/posts/` as `YYYY-MM-DD-<slug>.mdx`. Two things are easy
to forget:

```bash
npm run og                        # render the social cards, then commit the PNGs
( cd sites/blog && npm run build ) # fails if a post has no card or no <!-- truncate -->
```

Social cards are generated at authoring time rather than during the deploy build,
because the renderer depends on host fonts and a build machine without them would
silently ship a blank card. The build only *checks* that each post has one.

The blog is a separate Docusaurus site from the docs because the landing owns the
origin root: a Docusaurus build always emits `index.html` at its own baseUrl root,
so a single site covering both `/docs/` and `/blog/` would have to take `/` and
overwrite the landing. Consequences worth knowing:

- Links between posts are root-relative to the blog (`/blocking-in-a-browser`).
  Links to the docs must be absolute (`https://vivari.jamesisme.com/docs/...`),
  otherwise Docusaurus prefixes the blog baseUrl and the build fails the
  broken-link check.
- `sites/blog/src/components/Playground.tsx` is a copy of the docs' one. Two
  separate builds cannot share a component tree; keep them in sync.
- `/blog/*` is cross-origin isolated (see `scripts/assemble-site.mjs`), so **every
  image must be same-origin** — a third-party image or embed without a
  `Cross-Origin-Resource-Policy` header will be blocked. In exchange, a post can
  embed a real running example with `<Playground scenario="..." />`; add the
  scenario to `sites/embed/src/scenarios/registry.tsx`.

## Commit & PR conventions

- Write clear commit messages; conventional-commit prefixes (`feat:`, `fix:`,
  `docs:`, `chore:`) are appreciated but not required.
- Fill out the pull-request template so reviewers have context.
- Make sure `verify` and `smoke` pass and there are no lint errors.

## License

By contributing, you agree that your contributions will be licensed under the
project's [MIT License](LICENSE).