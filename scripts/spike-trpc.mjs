// Spike (NETWORK): prove the tRPC template's server boots and answers a typed
// query in-VM. Mirrors the shipped `trpc` template's server in
// packages/studio/src/oc/templates.ts.
// The server entry is a raw `.ts` run via `node --experimental-strip-types
// server/index.ts` — this is the regression guard for the "Unexpected identifier
// 'AppRouter'" bug: OC's loader doesn't strip TS type syntax, so the template
// must keep the executed server free of type-only constructs (no `export type`).
// Gates: install ok, the .ts server binds :3001, and an httpBatchLink-style
// greeting query returns the expected typed payload.
//   run (Node 22+):  node scripts/spike-trpc.mjs   (needs vendored npm — see spike-harness)
import { bootSpikeKernel, writeProject, npmInstall, waitListen, httpGet } from "./lib/spike-harness.mjs";

const DIR = "/trpc";
const PORT = Number(process.env.OC_PORT || 3001);
const h = await bootSpikeKernel();

writeProject(h.kernel, DIR, {
  "package.json": `{
  "name": "trpc-app",
  "private": true,
  "version": "0.0.0",
  "scripts": { "server": "node --experimental-strip-types server/index.ts" },
  "dependencies": { "@trpc/server": "^11.0.0", "zod": "^3.24.0" }
}
`,
  "server/index.ts": `import { initTRPC } from '@trpc/server'
import { createHTTPServer } from '@trpc/server/adapters/standalone'
import { z } from 'zod'

const t = initTRPC.create()

export const appRouter = t.router({
  greeting: t.procedure
    .input(z.object({ name: z.string() }).optional())
    .query(({ input }) => 'Hello ' + (input?.name ?? 'world') + ' from tRPC!'),
})

createHTTPServer({ router: appRouter }).listen(${PORT})
console.log('[trpc] server listening on :${PORT}')
`,
});

const inst = await npmInstall(h, { dir: DIR });
if (inst.code !== 0) process.exit(1);
if (process.env.OC_INSTALL_ONLY === "1") process.exit(0);

// The whole point: run the raw .ts entry through OC's loader, exactly like the
// template's `npm run server` does.
const bound = await waitListen(h, { dir: DIR, port: PORT, argv: ["--experimental-strip-types", "server/index.ts"] });

let greetOk = false;
let defaultOk = false;

if (bound) {
  const input = encodeURIComponent(JSON.stringify({ 0: { name: "spike" } }));
  const batched = await httpGet(h.kernel, PORT, `/greeting?batch=1&input=${input}`);
  greetOk = batched.status === 200 && /Hello spike from tRPC!/.test(batched.body);
  console.log(`  GET /greeting (name=spike) -> ${batched.status}  ${batched.body.slice(0, 120)}`);

  const plain = await httpGet(h.kernel, PORT, "/greeting");
  defaultOk = plain.status === 200 && /Hello world from tRPC!/.test(plain.body);
  console.log(`  GET /greeting (no input) -> ${plain.status}  ${plain.body.slice(0, 120)}`);
}

const ok = inst.code === 0 && bound && greetOk && defaultOk;
console.log(
  "\nRESULT: " +
    (ok
      ? "PASS — tRPC .ts server runs through OC's loader and answers typed queries in-VM"
      : "FAIL — see logs above"),
);
process.exit(ok ? 0 : 1);
