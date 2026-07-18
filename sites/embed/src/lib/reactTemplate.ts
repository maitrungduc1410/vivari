import type { FileSystemTree } from "@vivari/core";

// A minimal Vite + React project, mirrored from the studio's built-in template
// (packages/studio/src/vv/templates.ts). It boots a real Vite dev server inside
// the VM; editing App.jsx writes back into the VFS and Vite HMR updates the
// preview. Kept intentionally tiny so the example boots fast.

// Vite's rolldown config bundler throws "Invalid URL" in-VM, so the dev server
// loads its config natively (npm eats the first --).
export const REACT_DEV = "npm run dev -- --configLoader native";

export const APP_JSX = `import { useState } from 'react'

function App() {
  const [count, setCount] = useState(0)

  return (
    <>
      <h1>Vite + React</h1>
      <div className="card">
        <button onClick={() => setCount((c) => c + 1)}>
          count is {count}
        </button>
        <p>
          Edit <code>src/App.jsx</code> on the left and save to test HMR.
        </p>
      </div>
      <p>Running inside Vivari \u2014 a real Vite dev server in your browser.</p>
    </>
  )
}

export default App
`;

const PACKAGE_JSON = `{
  "name": "vite-react",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "^5.0.0",
    "vite": "^8.0.0"
  }
}
`;

const VITE_CONFIG = `import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
})
`;

const INDEX_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Vite + React</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
`;

const MAIN_JSX = `import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
`;

const INDEX_CSS = `:root {
  font-family: system-ui, Avenir, Helvetica, Arial, sans-serif;
  line-height: 1.5;
  color-scheme: light dark;
  color: rgba(255, 255, 255, 0.87);
  background-color: #242424;
}
body { margin: 0; display: flex; place-items: center; min-width: 320px; min-height: 100vh; }
#root { max-width: 1280px; margin: 0 auto; padding: 2rem; text-align: center; }
button {
  border-radius: 8px; border: 1px solid transparent; padding: 0.6em 1.2em;
  font-size: 1em; font-weight: 500; font-family: inherit;
  background-color: #1a1a1a; color: white; cursor: pointer; transition: border-color 0.25s;
}
button:hover { border-color: #646cff; }
`;

export const REACT_APP_PATH = "/src/App.jsx";

export function reactFiles(appJsx: string): FileSystemTree {
  return {
    "package.json": { file: { contents: PACKAGE_JSON } },
    "vite.config.js": { file: { contents: VITE_CONFIG } },
    "index.html": { file: { contents: INDEX_HTML } },
    src: {
      directory: {
        "index.css": { file: { contents: INDEX_CSS } },
        "main.jsx": { file: { contents: MAIN_JSX } },
        "App.jsx": { file: { contents: appJsx } },
      },
    },
  };
}
