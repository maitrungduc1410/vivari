// Icons for the "what it runs" grid.
//
// Two kinds as far as a *reader* is concerned, and the distinction is the design
// rather than an accident of what happened to be available:
//
//   BRAND: the chip names a *product*, so it carries that product's own
//          official mark, unaltered and in full colour.
//   GLYPH: the chip names a *capability* (`Bun.serve`, `--watch`, `all 88
//          matchers`). No such thing as a "Bun.serve logo" exists, so these
//          take a neutral monochrome glyph chosen for meaning: a database for
//          bun:sqlite, a key for Bun.password, a lock for the lockfile. The
//          glyph is information, not decoration.
//
// ASSET is a third map but not a third *kind*: it holds brand marks too, and
// differs only in delivery. See the note above it.
//
// Read together the two form a legend a visitor picks up without being told:
// colour means "this is somebody's product", monochrome means "this is a
// capability of ours".
//
// ---------------------------------------------------------------------------
// WHY THE BRAND MARKS ARE NEVER RECOLOURED
//
// The icon licences cover copyright, not trademark, and several of these marks
// (the PSF's Python mark and the Django Software Foundation's especially) may
// not be modified or recoloured under their owners' own guidelines. So there is
// no `currentColor` treatment and no tint pass on anything in BRAND. If a future
// design wants monochrome product marks, it needs a different icon source, not a
// filter over these. GLYPH is the opposite: it is `currentColor` by design,
// because nothing in it belongs to anyone.
//
// Showing a mark states compatibility, not endorsement (see the disclaimer in
// Footer.tsx). Only add one for something Vivari genuinely runs.
//
// Sources, in the order they are tried when adding a new mark:
//   1. `~icons/logos/*`        @iconify-json/logos (CC0-1.0)
//   2. `~icons/vscode-icons/*` @iconify-json/vscode-icons (MIT)
//   3. `~icons/vv/*`           src/assets/icons, a filesystem collection for
//                              marks Iconify carries in neither set. Every file
//                              there is the project's official mark; provenance
//                              and licence are recorded in
//                              src/assets/icons/SOURCES.md.
// ---------------------------------------------------------------------------

import type { ComponentType, SVGProps } from "react";
import {
  ArrowLeftRight,
  Boxes,
  Camera,
  ChevronsRight,
  Code,
  Database,
  Eye,
  FileText,
  FlaskConical,
  Hourglass,
  KeyRound,
  Library,
  ListChecks,
  Lock,
  Package,
  PackagePlus,
  Play,
  Server,
  SquareTerminal,
  VenetianMask,
  Zap,
} from "lucide-react";

type IconComponent = ComponentType<SVGProps<SVGSVGElement>>;

// --- BRAND: official product marks, full colour, unaltered ------------------

// Runtimes.
import NodeIcon from "~icons/logos/nodejs-icon";
import BunIcon from "~icons/logos/bun";
import PythonIcon from "~icons/logos/python";

// Frontend frameworks.
import ReactIcon from "~icons/logos/react";
import VueIcon from "~icons/logos/vue";
import SvelteIcon from "~icons/logos/svelte-icon";
import AngularIcon from "~icons/logos/angular-icon";
import PreactIcon from "~icons/logos/preact";
import SolidIcon from "~icons/logos/solidjs-icon";
import LitIcon from "~icons/logos/lit-icon";
import QwikIcon from "~icons/logos/qwik-icon";

// Meta-frameworks.
import NextIcon from "~icons/logos/nextjs-icon";
import NuxtIcon from "~icons/logos/nuxt-icon";
import AstroIcon from "~icons/logos/astro-icon";
// React Router's own mark, not Remix's. The chip says "React Router", and
// `logos/remix-icon` is also #121212, which is invisible on this background.
import ReactRouterIcon from "~icons/logos/react-router";

// Docs tooling and slides.
import DocusaurusIcon from "~icons/logos/docusaurus";
import SlidevIcon from "~icons/logos/slidev";
import VitepressIcon from "~icons/vv/vitepress";
import StarlightIcon from "~icons/vv/starlight";

// Languages.
import TypescriptIcon from "~icons/logos/typescript-icon";

// Python web, notebooks and science. Both of these are recoloured white via
// BRAND_CLASS below, at the product owner's direction. See the note there.
import FlaskIcon from "~icons/logos/flask";
import JupyterIcon from "~icons/logos/jupyter";

// Build tools and test runners.
import ViteIcon from "~icons/logos/vitejs";
import WebpackIcon from "~icons/logos/webpack";
import TailwindIcon from "~icons/logos/tailwindcss-icon";
import VitestIcon from "~icons/logos/vitest";

// Databases and package managers.
import PostgresIcon from "~icons/logos/postgresql";
import NpmIcon from "~icons/logos/npm-icon";
import YarnIcon from "~icons/logos/yarn";
import PnpmIcon from "~icons/logos/pnpm";

// Python stack.
//
// Flask and scikit-learn are deliberately absent, on legibility rather than
// licence grounds. See the `library` glyph below.
import DjangoIcon from "~icons/logos/django-icon";
import FastapiIcon from "~icons/logos/fastapi-icon";
import NumpyIcon from "~icons/logos/numpy";
import PandasIcon from "~icons/logos/pandas-icon";
import ScipyIcon from "~icons/vv/scipy";
import RuffIcon from "~icons/vscode-icons/file-type-ruff";
import MypyIcon from "~icons/vscode-icons/file-type-mypy";
import PytestIcon from "~icons/vscode-icons/file-type-pytest";

// --- ASSET: heavy illustrative marks, emitted as files rather than inlined ----
//
// Four of these marks are illustrations, not logotypes: a rendered plot and
// three detailed mascots. They carry thousands of path nodes. Compiled to
// JSX and inlined they cost ~39.7 kB gzip of *JavaScript*, which is parsed on
// the critical path on every visit. Imported with `?url` they become separate
// content-hashed files: fetched in parallel, cached across deploys, and off the
// JS path entirely. The rest of the marks are small enough that inlining them
// (one fewer request, no flash) is the better trade.
//
// `<img>` is the right element here. The mark sits beside a text label that
// already names the technology, so it is decorative and takes `alt=""`; and
// these are full-colour brand marks that must not be recoloured anyway, so
// losing `currentColor` inheritance costs nothing. Width and height are set
// explicitly so the row cannot shift while they load.
// These live in `src/assets/img/`, deliberately NOT in `src/assets/icons/`.
// `FileSystemIconLoader` scans the latter by filename on demand, so anything
// sitting there is importable as `~icons/vv/<name>` and would be inlined, and
// all four of these are unsafe to inline. `matplotlib.svg` carries a `<style>`
// with a *universal* selector, and `rsbuild.svg` declares 25 single-letter ids.
// Keeping them in a directory the loader never scans makes that a structural
// guarantee rather than a comment somebody has to read.
import matplotlibUrl from "@/assets/img/matplotlib.svg?url";
import rspackUrl from "@/assets/img/rspack.svg?url";
import rsbuildUrl from "@/assets/img/rsbuild.svg?url";
import rspressUrl from "@/assets/img/rspress.svg?url";

const ASSET: Record<string, string> = {
  matplotlib: matplotlibUrl,
  rspack: rspackUrl,
  rsbuild: rsbuildUrl,
  rspress: rspressUrl,
};

const BRAND: Record<string, IconComponent> = {
  node: NodeIcon,
  bun: BunIcon,
  python: PythonIcon,

  react: ReactIcon,
  vue: VueIcon,
  svelte: SvelteIcon,
  angular: AngularIcon,
  preact: PreactIcon,
  solid: SolidIcon,
  lit: LitIcon,
  qwik: QwikIcon,

  next: NextIcon,
  nuxt: NuxtIcon,
  astro: AstroIcon,
  "react-router": ReactRouterIcon,

  docusaurus: DocusaurusIcon,
  slidev: SlidevIcon,
  vitepress: VitepressIcon,
  starlight: StarlightIcon,

  typescript: TypescriptIcon,
  flask: FlaskIcon,
  notebook: JupyterIcon,

  vite: ViteIcon,
  webpack: WebpackIcon,
  tailwind: TailwindIcon,
  vitest: VitestIcon,

  postgres: PostgresIcon,
  npm: NpmIcon,
  yarn: YarnIcon,
  pnpm: PnpmIcon,

  django: DjangoIcon,
  fastapi: FastapiIcon,
  numpy: NumpyIcon,
  pandas: PandasIcon,
  scipy: ScipyIcon,
  ruff: RuffIcon,
  mypy: MypyIcon,
  pytest: PytestIcon,
};

// --- BRAND_CLASS: per-mark recolouring, deliberately scoped ------------------
// Two marks are recoloured white, at the product owner's explicit direction, so
// they are legible on this dark page. Everything else ships unaltered.
//
// The selectors are Tailwind arbitrary *descendant* variants, which compile to a
// rule scoped by the icon's own generated class, so they cannot reach any
// other mark. Do not replace them with a bare `path { fill: … }` anywhere: these icons
// are inlined into one shared document alongside 60 others, and an unqualified
// `path` selector is exactly what made `starlight.svg` repaint the whole page
// black. See `src/assets/icons/SOURCES.md`.
const BRAND_CLASS: Record<string, string> = {
  // `logos:flask` is a single path carrying no `fill` attribute at all, so it
  // renders with the initial black and vanishes here. Nothing to override:
  // setting `fill` on the <svg> inherits down to the path.
  flask: "fill-white",

  // `logos:jupyter` is five paths with hard-coded fills: four greys that draw
  // the wordmark, and `#f37726` for the orange mark. Presentation attributes on
  // an element beat an inherited `fill`, so this targets the paths directly,
  // but only the grey ones, keeping the orange that carries the recognition.
  notebook: "[&_path:not([fill='#f37726'])]:fill-white",
};

// --- GLYPH: neutral marks for capabilities, and for products with no usable mark

const GLYPH: Record<string, IconComponent> = {
  // Bun runtime and CLI.
  "bun-run": Play,
  // `»` reads as an interactive prompt. Deliberately not `Terminal` or
  // `SquareChevronRight`: `Bun.$ shell` two groups down already wears
  // `SquareTerminal`, and at 14px both of those collapse to the same silhouette
  // as it, which would look like one of the two chips had the wrong icon.
  // `TextCursorInput` was the other candidate and is an illegible smudge at 14px.
  repl: ChevronsRight,
  "zero-config": Zap,
  await: Hourglass,
  watch: Eye,

  // Bun test runner.
  test: FlaskConical,
  matchers: ListChecks,
  mocks: VenetianMask,
  snapshots: Camera,

  // Bun APIs.
  serve: Server,
  shell: SquareTerminal,
  rewriter: Code,
  file: FileText,
  password: KeyRound,
  websocket: ArrowLeftRight,

  // Packaging.
  templates: Package,
  "pkg-add": PackagePlus,
  lockfile: Lock,
  corepack: Boxes,

  // Products whose official mark we cannot show *well*, so a neutral glyph is
  // the honest move rather than a smudge. Note Flask is no longer in this list:
  // it is recoloured white instead, at the owner's direction. See BRAND_CLASS.
  // These remain because recolouring would not rescue them either:
  //
  //   scikit-learn  the only official SVG is a wordmark, which turns to mush at
  //                 14px. The compact variant upstream is PNG only.
  //   SQLAlchemy    no official SVG at a canonical URL under a clear licence.
  //   Pillow        the documented logo path 404s upstream.
  //   rich          official SVG is a ~45 kB full-width text banner, not a mark.
  library: Library,

  // Both SQLite chips (Node's `SQLite` and Bun's `bun:sqlite`) share this rather
  // than carrying SQLite's mark. `logos:sqlite` is a 512x228 lockup of page,
  // quill and wordmark, and crushed into a 14px box it is an illegible smear
  // beside PostgreSQL's crisp elephant. `vscode-icons:file-type-sqlite` is the
  // same artwork minus the wordmark and is clean at 14px, but its quill is dark
  // navy and vanishes on this background, leaving an anonymous blue rectangle
  // that does not read as SQLite. Sharing one slug keeps the two columns from
  // drifting apart again.
  database: Database,
};

/**
 * An icon by slug, or null when we have neither a mark nor a glyph.
 *
 * Always `aria-hidden`: every call site pairs the icon with the product or
 * capability name in text, so it carries nothing a screen reader needs.
 */
export function TechIcon({ slug, className }: { slug?: string; className?: string }) {
  if (!slug) return null;

  const src = ASSET[slug];
  if (src)
    // `object-contain` because not every one of these is square. Rspack's mark
    // is 193x150, and a fixed 14x14 box would otherwise stretch it.
    return (
      <img
        src={src}
        alt=""
        width={14}
        height={14}
        loading="lazy"
        decoding="async"
        className={`${className ?? ""} object-contain`}
      />
    );

  const Brand = BRAND[slug];
  if (Brand)
    return <Brand aria-hidden className={`${className ?? ""} ${BRAND_CLASS[slug] ?? ""}`} />;

  // Glyphs inherit colour, so they sit back from the full-colour marks instead
  // of competing with them.
  const Glyph = GLYPH[slug];
  if (Glyph) return <Glyph aria-hidden className={`${className ?? ""} text-faint`} />;

  return null;
}
