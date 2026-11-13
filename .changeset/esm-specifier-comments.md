---
"@vivari/core": patch
"@vivari/react": patch
---

ES modules that put a comment inside an `import { … }` or `export { … }` list now load correctly. parse5 8.1 does this, and the comment was being read as part of the name, so the export came out `undefined`; Astro Starlight pages that render Markdown failed with a 500 `MDXError`.
