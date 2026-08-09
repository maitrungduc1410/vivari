// Central site config. Cross-links stay root-relative so the same build works on
// any origin (localhost preview, *.pages.dev, or a custom domain).
//
// The strings under `seo` are the SINGLE source of truth for the document head.
// index.html holds `%VV_*%` placeholders and vite.config.ts substitutes them at
// build time, so the title, the description and the OG/Twitter cards cannot
// drift apart from each other or from `tagline` the way they previously did.
// `tagline` used to live here saying one thing while index.html hard-coded
// another, and nothing imported it at all.
export const site = {
  name: "Vivari",
  tagline: "Run Node, Bun and Python in the browser.",
  studioUrl: "/studio/",
  docsUrl: "/docs/",
  blogUrl: "/blog/",
  githubUrl: "https://github.com/maitrungduc1410/vivari",
  npmCoreUrl: "https://www.npmjs.com/package/@vivari/core",
} as const;

// `docs/readme-positioning-rewrite` rewrote these same strings on master, hard-coded
// into index.html. They live here instead so index.html and `tagline` cannot drift,
// but the rendered values are master's: the computed `title` is byte-identical to the
// one it hard-coded, and `ogDescription` and `twitterDescription` are its wording
// verbatim. `description` is the one merge: master's real-runtime claims, then the
// framework list this page kept for search.
export const seo = {
  title: `${site.name}: ${site.tagline.replace(/\.$/, "")}`,
  description:
    "Vivari is an open-source, MIT-licensed WebContainer: run Node, Bun and Python projects 100% inside the browser. Node's real lib/, the real npm/yarn/pnpm, and real CPython. React, Next.js, Docusaurus, Flask, Django and notebooks. No server, no per-seat fee.",
  ogDescription:
    "An open-source, MIT-licensed WebContainer. Run Node, Bun and Python 100% in the browser, with no server.",
  twitterDescription:
    "An open-source, MIT-licensed WebContainer. Run Node, Bun and Python 100% client-side.",
  url: "https://vivari.run",
  image: "https://vivari.run/og-v2.jpg",
  imageWidth: "1200",
  imageHeight: "630",
} as const;
