// Spike (NETWORK): prove the Lit template's Vite dev server boots + serves in-VM.
// Mirrors the shipped `lit` template in packages/studio/src/vv/templates.ts.
// Run (Node 22+):  node scripts/spike-lit.mjs   (see spike-vite-lib.mjs for setup)

import { runViteSpike } from "./spike-vite-lib.mjs";

const ok = await runViteSpike({
  name: "Lit",
  dir: "/lit",
  templateId: "lit",
  entryModule: "/src/my-element.ts",
  titleMarker: /Vite \+ Lit/,
  files: {
    "package.json": `{
  "name": "lit-app",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": { "dev": "vite", "build": "vite build", "preview": "vite preview" },
  "dependencies": { "lit": "^3.2.0" },
  "devDependencies": { "typescript": "^5.7.0", "@rolldown/binding-wasm32-wasi": "~1.2.0", "vite": "^8.0.0" }
}
`,
    "index.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Vite + Lit</title>
  </head>
  <body>
    <my-element></my-element>
    <script type="module" src="/src/my-element.ts"></script>
  </body>
</html>
`,
    "src/my-element.ts": `import { LitElement, html, css } from 'lit'

export class MyElement extends LitElement {
  static properties = { count: { type: Number } }

  static styles = css\`
    :host { display: block; font-family: system-ui, sans-serif; text-align: center; padding: 3rem; }
    button { padding: .6rem 1.2rem; border-radius: 8px; border: 1px solid #324fff; background: #324fff; color: #fff; cursor: pointer; }
  \`

  declare count: number
  constructor() {
    super()
    this.count = 0
  }

  render() {
    return html\`
      <h1>Vite + Lit</h1>
      <button @click=\${() => this.count++}>count is \${this.count}</button>
      <p>A web component running inside Vivari.</p>
    \`
  }
}

customElements.define('my-element', MyElement)
`,
    "tsconfig.json": `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "skipLibCheck": true,
    "noEmit": true,
    "strict": true,
    "useDefineForClassFields": false
  },
  "include": ["src"]
}
`,
  },
});

process.exit(ok ? 0 : 1);