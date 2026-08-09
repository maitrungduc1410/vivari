// The three runtimes, and what each one is honestly proven to run.
//
// This file is the single source of truth for the hero's runtime switcher and
// the "what it runs" grid, so the two can never drift apart.
//
// ---------------------------------------------------------------------------
// HOW TO ADD SOMETHING HERE
//
// The page's whole argument is that its claims are true, so an entry earns its
// place by being backed by a passing spike in `scripts/run-spikes.mjs`. The
// `evidence` field records HOW it is backed, because the spike tiers are not
// equally strong. From `.github/workflows/ci.yml`:
//
//   "always"    the spike runs in `toolchain-gate` or `verify`, which are on
//               every push and pull request and block the merge. The strongest
//               claim available.
//   "nightly"   the spike runs in `template-gate` or `pm-gate`. Those jobs can
//               go red, but they are scheduled/dispatch-only, so a regression
//               can sit unnoticed for up to a day.
//   "advisory"  the spike runs only in `spikes-net`, which is
//               `continue-on-error: true`, so its run is green whatever
//               happens inside it. Credible, but unverified today.
//   "shipped"   NO spike exercises it. It ships as a template and its source is
//               parsed by `template-syntax` on every push, but that spike's own
//               header says it is "deliberately NOT type-checking, linting or
//               executing anything". Parsing is not running. Nothing would catch
//               a regression here, and the caption has to say so.
//
// When an item's tier is ambiguous, put it in the LOWER group. Under-claiming
// costs the page nothing; over-claiming costs it the argument.
//
// The check is mechanical, so do it rather than guessing: a spike of that name
// must exist in `scripts/` AND be selected by the job the tier claims. Note that
// a spike merely *mentioning* a tool proves nothing. `spike-python-offline.mjs`
// names ruff, mypy, pandas and numpy dozens of times, but it uses them as
// stand-in command names for argv-contract tests and its header states it never
// boots an interpreter. That is why the Python library groups sit at "advisory",
// backed by the bridge spike, and not higher.
// ---------------------------------------------------------------------------

export type RuntimeId = "node" | "bun" | "python";

export type Evidence = "always" | "nightly" | "advisory" | "shipped";

/** Short labels for the evidence tiers; explained in full under the grid. */
export const EVIDENCE_LABEL: Record<Evidence, string> = {
  always: "every change",
  nightly: "nightly",
  advisory: "nightly, advisory",
  shipped: "shipped, not gated",
};

export type CapabilityGroup = {
  title: string;
  evidence: Evidence;
  /** `icon` is a slug in techIcons.tsx; omit it and the chip shows the name alone. */
  items: { name: string; icon?: string }[];
};

export type RuntimeDef = {
  id: RuntimeId;
  /** Tab label and column heading. */
  label: string;
  /** Brand mark slug (see techIcons.tsx). */
  icon: string;
  /** One line under the column heading. */
  blurb: string;
  /**
   * Tailwind text colour for the column accent. Drawn from the site's own brand
   * ramp rather than from each project's brand colour, so the three columns read
   * as one design; the official marks carry the real brand colours.
   */
  accent: string;
  /** Shown as a pill next to the label, e.g. Python's honest "beta". */
  tag?: string;
  /** The caveat a reader deserves before they try it. Rendered under the groups. */
  note: string;
  groups: CapabilityGroup[];
};

export const RUNTIME_DEFS: RuntimeDef[] = [
  {
    id: "node",
    label: "Node",
    icon: "node",
    blurb: "The full toolchain: install, build, serve, test.",
    accent: "text-brand-2",
    note: "npm, yarn and pnpm are the real CLIs from the registry, not reimplemented installers.",
    groups: [
      {
        title: "Frontend frameworks",
        evidence: "nightly",
        items: [
          { name: "React", icon: "react" },
          { name: "Vue", icon: "vue" },
          { name: "Svelte", icon: "svelte" },
          { name: "Preact", icon: "preact" },
          { name: "Solid", icon: "solid" },
          { name: "Lit", icon: "lit" },
          { name: "Qwik", icon: "qwik" },
          // Placed here by the mechanical check above, not by association.
          // `scripts/spike-ember.mjs` exists, is registered `net: true` in
          // `run-spikes.mjs`, and is named in the very same `template-gate` step
          // as the seven above (`ci.yml:218`, `… qwik$ ember$`) — the step whose
          // schedule is what earns this group "nightly". Same job, same trigger,
          // same evidence, so this is the group its gate genuinely supports.
          { name: "Ember", icon: "ember" },
        ],
      },
      {
        title: "Full frameworks & SSR",
        evidence: "advisory",
        items: [
          { name: "Next.js", icon: "next" },
          { name: "Angular", icon: "angular" },
          { name: "Astro", icon: "astro" },
        ],
      },
      {
        // These three ship as templates you can boot today, but no spike in
        // `scripts/` exercises them: there is no spike-nuxt, spike-sveltekit or
        // spike-react-router, so `npm run spikes:net` never selects them and a
        // regression would go unnoticed. `spike-nitro.mjs` covers Nitro, which is
        // a Nuxt dependency, not Nuxt. They were briefly grouped with Next.js at
        // "advisory", which told the reader a nightly job proves them. It does
        // not. Move an item up here only when a spike of its name lands.
        title: "More SSR frameworks",
        evidence: "shipped",
        items: [
          { name: "Nuxt", icon: "nuxt" },
          { name: "SvelteKit", icon: "svelte" },
          { name: "React Router", icon: "react-router" },
        ],
      },
      {
        title: "Documentation & slides",
        evidence: "advisory",
        items: [
          { name: "Docusaurus", icon: "docusaurus" },
          { name: "VitePress", icon: "vitepress" },
          { name: "Starlight", icon: "starlight" },
          { name: "Rspress", icon: "rspress" },
          { name: "Slidev", icon: "slidev" },
        ],
      },
      {
        title: "Build tools & test runners",
        evidence: "advisory",
        items: [
          { name: "Vite", icon: "vite" },
          { name: "webpack", icon: "webpack" },
          { name: "Rspack", icon: "rspack" },
          { name: "Rsbuild", icon: "rsbuild" },
          { name: "Tailwind", icon: "tailwind" },
          { name: "Vitest", icon: "vitest" },
        ],
      },
      {
        title: "Databases, in the VM",
        evidence: "nightly",
        items: [
          { name: "SQLite", icon: "database" },
          { name: "PostgreSQL", icon: "postgres" },
        ],
      },
      {
        title: "Package managers",
        evidence: "nightly",
        items: [
          { name: "npm", icon: "npm" },
          { name: "yarn", icon: "yarn" },
          { name: "pnpm", icon: "pnpm" },
          { name: "corepack", icon: "corepack" },
        ],
      },
    ],
  },
  {
    id: "bun",
    label: "Bun",
    icon: "bun",
    blurb: "The APIs, the CLI and the test runner, gated on every change.",
    accent: "text-brand-3",
    note: "An API-compatible shim, not the native Bun binary. Nothing can execute one in a page. `bun add` delegates to the real npm CLI and writes a text bun.lock.",
    groups: [
      {
        title: "Runtime",
        evidence: "always",
        items: [
          { name: "bun run", icon: "bun-run" },
          { name: "TypeScript & JSX", icon: "typescript" },
          { name: "zero config", icon: "zero-config" },
          { name: "top-level await", icon: "await" },
          { name: "--watch", icon: "watch" },
          // `spike-repl.mjs` section 7 drives `bun repl` by keystroke and asserts
          // Bun's own banner, TypeScript at the prompt, the `Bun` global in scope,
          // `Bun.version` returning the real shim rather than a stub, the `_error`
          // binding and Ctrl+D ending the session. It is registered `net: false`
          // and runs in `verify`, so it earns this group's tier on its own.
          { name: "bun repl", icon: "repl" },
        ],
      },
      {
        title: "Test runner",
        evidence: "always",
        items: [
          { name: "bun test", icon: "test" },
          { name: "all 88 matchers", icon: "matchers" },
          { name: "mocks & spies", icon: "mocks" },
          { name: "snapshots", icon: "snapshots" },
        ],
      },
      {
        title: "Bun APIs",
        evidence: "always",
        items: [
          { name: "Bun.serve", icon: "serve" },
          { name: "bun:sqlite", icon: "database" },
          { name: "Bun.$ shell", icon: "shell" },
          { name: "HTMLRewriter", icon: "rewriter" },
          { name: "Bun.file", icon: "file" },
          { name: "Bun.password", icon: "password" },
          { name: "WebSockets", icon: "websocket" },
        ],
      },
      {
        title: "Starter templates",
        evidence: "always",
        items: [{ name: "all 10, run from their shipped bytes", icon: "templates" }],
      },
      {
        title: "Packages",
        evidence: "advisory",
        items: [{ name: "bun add", icon: "pkg-add" }, { name: "text bun.lock", icon: "lockfile" }],
      },
    ],
  },
  {
    id: "python",
    label: "Python",
    icon: "python",
    blurb: "Real CPython 3.14, compiled to WebAssembly.",
    accent: "text-brand",
    tag: "beta",
    note: "Flask and Django serve through a WSGI bridge: `gunicorn wsgi:application`, not `runserver`, which needs a TCP socket. A cold project installs from PyPI, so it needs the network once.",
    groups: [
      {
        title: "Web frameworks",
        evidence: "advisory",
        items: [
          { name: "Flask", icon: "flask" },
          { name: "Django", icon: "django" },
          { name: "FastAPI", icon: "fastapi" },
        ],
      },
      {
        title: "Notebooks",
        evidence: "always",
        // The `notebook` icon is Project Jupyter's mark, present by the product
        // owner's explicit direction. It was a neutral glyph before, because
        // Vivari's notebook is a bespoke UI with a custom stdlib-only kernel and
        // its own wire protocol, so there is no Jupyter kernel and no Jupyter
        // server here. That is still true, so **the chip's text is what keeps
        // this accurate**: it names the *format* (`.ipynb`) and the property we
        // actually prove (byte-identical round-trip), and claims nothing about
        // the implementation. Do not reword it, and do not remove the mark:
        // the mark is the owner's call and the wording is the safeguard.
        items: [{ name: ".ipynb, byte-identical on save", icon: "notebook" }],
      },
      {
        title: "Data & science",
        evidence: "advisory",
        items: [
          { name: "NumPy", icon: "numpy" },
          { name: "pandas", icon: "pandas" },
          { name: "Matplotlib", icon: "matplotlib" },
          { name: "SciPy", icon: "scipy" },
          { name: "scikit-learn", icon: "library" },
        ],
      },
      {
        title: "Libraries & tooling",
        evidence: "advisory",
        items: [
          { name: "SQLAlchemy", icon: "library" },
          { name: "Pillow", icon: "library" },
          { name: "rich", icon: "library" },
          { name: "ruff", icon: "ruff" },
          { name: "mypy", icon: "mypy" },
        ],
      },
      {
        title: "Testing",
        evidence: "advisory",
        items: [{ name: "pytest", icon: "pytest" }],
      },
    ],
  },
];

export const RUNTIME_IDS = RUNTIME_DEFS.map((r) => r.id);