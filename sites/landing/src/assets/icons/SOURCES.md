# Icon sources

Marks in this directory live here because Iconify carries them in neither
`@iconify-json/logos` nor `@iconify-json/vscode-icons`. Those two sets are
always tried first.

## This directory is for marks that are safe to INLINE

`vite.config.ts` points `FileSystemIconLoader` at this directory, and the loader
resolves **by filename, on demand, across the whole directory**. So any `.svg`
sitting here is importable as `~icons/vv/<name>` by anyone, at any time, and will
be compiled to JSX and inlined into the page. There is no opt-in list to add to
and no way to mark a file here as off-limits.

That is why the four heavy marks served as `<img>` live in **`src/assets/img/`**
instead, a sibling directory the loader does not scan. It is not tidiness: both
`matplotlib.svg` and `rsbuild.svg` are actively unsafe to inline (see below), and
being in a directory the loader cannot reach is the only thing that actually
prevents it. **Do not move them back here, and do not point the loader at
`img/`.**

So:

- **`src/assets/icons/`** (here). Inlined via `~icons/vv/<name>`. Must satisfy
  the rules below. Currently `starlight.svg`, `vitepress.svg`, `scipy.svg`.
- **`src/assets/img/`**. Imported with Vite's `?url` suffix and rendered as
  `<img>`, becoming separate content-hashed assets. Each is its own document, so
  the rules below do not apply to them. Currently `matplotlib.svg`, `rspack.svg`,
  `rsbuild.svg`, `rspress.svg`.

Which directory a mark belongs in is a size decision. Inlining is right for small
marks, because it costs one fewer request and cannot flash. The four in `img/`
are illustrations rather
than logotypes (a rendered plot; three detailed mascots) carrying thousands of
path nodes: inlined they cost ~39.7 kB gzip of JavaScript on the critical path,
against ~25 kB of cacheable, parallel-fetched image.

**Every file here is the project's own official mark, committed unmodified.**
Nothing here is re-drawn or traced. The marks are used *nominatively*, to state
accurately that Vivari runs these tools, which is what makes the use fair; see
the disclaimer in `Footer.tsx`. Showing a mark is not a claim of endorsement or
affiliation.

If you add one: record it in the table below with the URL you fetched it from and
the licence, and do not add a mark for something Vivari does not actually run.

## Two marks *are* recoloured, deliberately

This used to say nothing on the page is recoloured. That is no longer true, and
the exception is recorded here rather than left for someone to discover.

**At the product owner's explicit direction**, two marks from `@iconify-json/logos`
are filled white so they are legible against this dark page:

| Mark | What it needed | Why |
| --- | --- | --- |
| `logos:flask` | `fill: white` on the icon | It is a single path with **no `fill` attribute at all**, so it renders with the initial black and disappears here. |
| `logos:jupyter` | `fill: white` on its four grey paths only | Five paths with hard-coded fills. The four greys draw the wordmark; `#f37726` is the orange mark and is **kept**, because it carries the recognition. |

Neither is in this directory, since both come from Iconify, but the rule belongs with
the other icon rules. The recolouring lives in `BRAND_CLASS` in
`src/components/techIcons.tsx`, as Tailwind arbitrary *descendant* variants that
compile to rules scoped by the icon's own class.

**Do not "fix" either back to its official colour, and do not widen the selector.**
An unqualified `path { fill: … }` would repaint every inlined mark on the page.
That is not hypothetical: it is what `starlight.svg` did, and it is documented
below.

## Rules for any SVG committed *here*

Everything in this directory ends up inlined into one shared document, so
anything in an SVG that is global in scope stops being that file's business and
becomes everybody's. Two things are global in an SVG: **stylesheets** and **ids**.

### 1. No `<style>` elements, express colour as attributes

A `<style>` block inside an inlined icon is not scoped to that icon; it is CSS
for the whole page. `starlight.svg` shipped upstream with

```html
<style>path{fill:#000}@media (prefers-color-scheme:dark){path{fill:#fff}}</style>
```

which selects `path` unqualified, so it repainted **every mark on the page**
black. It is easy to miss because a CSS rule beats a `fill` presentation
attribute, so correct-looking markup (`<path fill="#00d8ff">`) still renders
black, and the only marks that survive are the ones using inline `style=`
attributes. Its replacement carries the mark's own dark-mode colour as a root
`fill` instead. The page is dark-only, so that is the variant its author
intended here, not a recolour.

`matplotlib.svg` is a live example of why this rule needs the directory split
rather than good intentions: it carries `<style>*{...}</style>`, a *universal*
selector, which is strictly worse than the Starlight rule. It is safe only
because it lives in `img/` and is served as its own document.

### 2. Namespace every `id` as `vv-<mark>-<purpose>`

Ids are document-global too, and duplicates do not error: the **first** wins, and
every `url(#…)` in the document silently resolves to it. `scipy.svg` and
`vitepress.svg` both arrived declaring `id="a"`, a `<clipPath>` and a
`<linearGradient>` respectively. That rendered correctly only by accident of
paint order; reordering the groups so SciPy painted first would have made
VitePress's `fill="url(#a)"` resolve to a clip path and the mark would render
unfilled. They are now `vv-scipy-clip` and `vv-vitepress-grad-{a,b,c}`.

`rsbuild.svg` shows the scale of the hazard: 25 ids, `a` through `y`. Like
`matplotlib.svg`, it is safe only because it lives in `img/`.

**This is a hand-vendored problem specifically.** Every Iconify mark ships with a
pre-randomised id, so `@iconify-json/logos` and `@iconify-json/vscode-icons` are
collision-proof by construction. `FileSystemIconLoader` gives you no such
protection, and inlines whatever bytes you commit.

### Checklist before committing an SVG here

- No `<style>` element.
- Every `id` prefixed `vv-<mark>-`, with every `url(#…)` and `href="#…"` in the
  file updated to match.
- If either is awkward to satisfy, it belongs in `img/` as a `?url` asset.

| File | Dir | Project | Source | Licence |
| --- | --- | --- | --- | --- |
| `rspack.svg` | `img/` | Rspack | Vendored from `packages/studio/src/assets/rspack-logo.svg`; byte-identical to the official `https://assets.rspack.rs/rspack/rspack-logo.svg` (verified) | MIT (web-infra-dev/rspack) |
| `rsbuild.svg` | `img/` | Rsbuild | Vendored from `packages/studio/src/assets/rsbuild-logo.svg` | MIT (web-infra-dev/rsbuild) |
| `rspress.svg` | `img/` | Rspress | Vendored from `packages/studio/src/assets/rspress-logo.svg` | MIT (web-infra-dev/rspress) |
| `starlight.svg` | `icons/` | Starlight | Vendored from `packages/studio/src/assets/starlight-logo.svg` | MIT (withastro/starlight) |
| `vitepress.svg` | `icons/` | VitePress | `https://vitepress.dev/vitepress-logo-mini.svg` | MIT (vuejs/vitepress) |
| `scipy.svg` | `icons/` | SciPy | `https://raw.githubusercontent.com/scipy/scipy/main/doc/source/_static/logo.svg` | BSD-3-Clause (scipy/scipy) |
| `matplotlib.svg` | `img/` | Matplotlib | `https://raw.githubusercontent.com/matplotlib/matplotlib/main/lib/matplotlib/mpl-data/images/matplotlib.svg` | Matplotlib License (PSF-derived, BSD-compatible) (matplotlib/matplotlib) |

This table covers both directories, so there is one place to look for provenance.
All files were run through SVGO, a size optimisation only, which does not alter
how a mark renders. It also strips the Inkscape editor metadata `scipy.svg` shipped
with, whose `<inkscape:*>` namespace tags React's JSX cannot compile.

The four files taken from the studio are copies rather than cross-package imports because
`sites/landing` builds standalone. It has no path into `packages/studio`, and
adding one to share four icons would couple the marketing site to the IDE app.

## Deliberately absent

Jupyter and Flask were both listed here once and are **not absent any more**. See
the recolouring section above. Do not re-add them.

| Project | Why there is no mark here |
| --- | --- |
| SQLite | `logos:sqlite` is a 512x228 lockup (page, quill *and* wordmark); at 14px it is a formless smear beside PostgreSQL's crisp elephant. `vscode-icons:file-type-sqlite` is the same artwork icon-only and clean, but its quill is dark navy and vanishes on this background. Neutral `database` glyph, shared by the `SQLite` and `bun:sqlite` chips. |
| scikit-learn | The only official SVG is a wordmark, illegible at 14px; the compact `notext` variant upstream is PNG only. Neutral `library` glyph. |
| SQLAlchemy | No official SVG found at a canonical URL under a clear licence. Neutral `library` glyph instead of an approximation. |
| Pillow | Same again: the documented logo path 404s upstream. Neutral `library` glyph. |
| rich | An official SVG exists but it is a ~45 kB full-width text banner, not a compact mark; it is illegible at the 14px the chips render at and disproportionate in bytes. Neutral `library` glyph. |
| corepack | A Node.js-project tool with no distinct mark of its own. Using Node's mark would misattribute it. Neutral glyph. |
