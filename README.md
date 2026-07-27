# Vivari

<div align="center">
  <img src="./icon.svg" width="128" height="128" />
</div>

**An open-source WebContainer.** Run Node-style projects (Vite, Express, and more)
**100% inside the browser** — a virtual filesystem, a Node-compatible runtime, and
virtual networking, with no server doing the work.

<p>
  <a href="https://vivari.jamesisme.com">Website</a> ·
  <a href="https://vivari.jamesisme.com/docs">Docs</a> ·
  <a href="https://vivari.jamesisme.com/blog/">Blog</a> ·
  <a href="https://vivari.jamesisme.com/studio/">Studio</a> ·
  <a href="https://www.npmjs.com/package/@vivari/core">npm</a>
</p>

Vivari is **MIT-licensed** — there is no commercial license and no usage fee: embed it, fork it, ship it.

> **Vivari** *(vih-VAH-ree)* takes its name from the Latin *vivarium* — a self-contained enclosure for living things. That's exactly what it is for a running Node app: a sealed, self-contained environment in the browser where a whole project lives and runs.

## Install

```bash
npm install @vivari/core        # framework-agnostic SDK
npm install @vivari/react       # React <Vivari> component + useVivari()
```

```ts
import { Vivari } from "@vivari/core";

const vivari = await Vivari.boot();
await vivari.mount({
  "package.json": { file: { contents: '{ "type": "module" }' } },
  "index.js": { file: { contents: "console.log('hello from the browser')" } },
});

const proc = await vivari.spawn("node", ["index.js"]);
proc.output.pipeTo(new WritableStream({ write: (c) => console.log(c) }));
await proc.exit;
```

> Vivari needs a **cross-origin isolated** page (`COOP: same-origin` +
> `COEP: require-corp`) so `SharedArrayBuffer` is available. Full guides,
> the API reference, and interactive examples live in the
> [documentation](https://vivari.jamesisme.com/docs).

## How it works (in one breath)

Node's APIs are **synchronous**. Browsers won't let you block on async work
— *except on a Web Worker thread*, where `Atomics.wait()` can genuinely park
execution. So `fs.readFileSync` parks the worker until the host answers over a
`SharedArrayBuffer`; a kernel over a Rust/Wasm VFS services the syscalls, and a
Service Worker previews an in-VM HTTP server live in an iframe. See
[How it works](https://vivari.jamesisme.com/docs/how-it-works) for the full story.

## Repository layout

```
packages/
  core/      @vivari/core   — the framework-agnostic SDK
  react/     @vivari/react  — <Vivari> component + useVivari()
  vfs/ codec/ crypto/       — Rust crates compiled to Wasm
  runtime/ kernel-host/ protocol/  — the Node runtime shim + kernel
  studio/    the studio IDE (Vite + React)
sites/
  landing/   the marketing site (Vite + React)
  docs/      the documentation site (Docusaurus)
examples/
  basic/     a minimal, runnable SDK example
scripts/     verify / smoke / spike harnesses + the site build
```

## Develop

Prereqs: **Node `>=22`** (see `.nvmrc`), plus Rust + `wasm-pack` for the Wasm crates.

```bash
npm install
npm run build      # compile the Rust VFS/codec/crypto to Wasm
npm run verify     # headless proof the sync-bridge works end-to-end
npm run dev        # start the studio IDE
```

Build the full site (landing + docs + studio) for a static deploy:

```bash
npm run build:site   # assembles everything into dist/ (see sites/docs deployment guide)
```

## Contributing & security

- [Contributing guide](CONTRIBUTING.md) · [Code of Conduct](CODE_OF_CONDUCT.md)
- Found a vulnerability? See [SECURITY.md](SECURITY.md).

Releases are cut from the manual **Publish SDK** GitHub Actions workflow
(`.github/workflows/publish.yml`).

## License

[MIT](LICENSE) — free for any use, commercial or otherwise.