// Central site config. Cross-links stay root-relative so the same build works on
// any origin (localhost preview, *.pages.dev, or a custom domain).
export const site = {
  name: "Vivari",
  tagline: "Run Node.js in the browser.",
  studioUrl: "/studio/",
  docsUrl: "/docs/",
  blogUrl: "/blog/",
  githubUrl: "https://github.com/maitrungduc1410/vivari",
  npmCoreUrl: "https://www.npmjs.com/package/@vivari/core",
} as const;
