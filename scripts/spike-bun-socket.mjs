// Bun.listen / Bun.connect, inside the VM.
//
// These used to throw "there is no raw TCP in a browser", which is half true and
// therefore wrong: the VM has had its own kernel-routed loopback network for as
// long as Bun.serve has worked, and `node:net` has been using it all along. This
// asserts the half that works — a server and a client in one process, and two
// processes talking to each other — and that the half that cannot work still
// fails by name rather than by hanging.
//
// Needs the kernel and the Wasm VFS: two real processes, over the real network.
//
// Run: node scripts/run-spikes.mjs --offline bun-socket

import { bootSpikeKernel, writeProject, defaultEnv } from "./lib/spike-harness.mjs";

const APP = "/app";
let failed = 0;
const ok = (cond, label) => {
  console.log((cond ? "  ✓ " : "  ✗ ") + label);
  if (!cond) failed++;
};

const { kernel } = await bootSpikeKernel();

console.log("\n1) a server and a client in one process");
writeProject(kernel, APP, {
  "echo.ts": `
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open(s) { s.data = { seen: 0 }; },
        data(s, chunk) {
          s.data.seen += chunk.byteLength;
          console.log("SRV-DATA:" + (chunk instanceof Uint8Array) + ":" + Buffer.from(chunk).toString());
          s.write("echo:" + Buffer.from(chunk).toString());
        },
        close() { console.log("SRV-CLOSE"); },
      },
    });
    console.log("PORT:" + (typeof server.port === "number" && server.port > 0));
    console.log("HOST:" + server.hostname);

    const client = await Bun.connect({
      hostname: "127.0.0.1",
      port: server.port,
      socket: {
        open(s) { console.log("CLI-OPEN:" + (s.readyState === 1)); s.write("hello"); },
        data(s, chunk) {
          console.log("CLI-DATA:" + Buffer.from(chunk).toString());
          s.end();
          server.stop();
        },
        close() { console.log("CLI-CLOSE"); },
      },
    });
    console.log("REMOTE:" + (typeof client.remotePort === "number"));
    console.log("USERDATA:" + JSON.stringify(client.data));
  `,
});
{
  const r = await kernel.start("bun", ["run", "echo.ts"], { cwd: APP, env: defaultEnv(APP), capture: true });
  const out = r.stdout || "";
  ok(/PORT:true/.test(out), "Bun.listen() returns a real port synchronously, as Bun does");
  ok(/HOST:127\.0\.0\.1/.test(out), "and reports the hostname it bound");
  ok(/CLI-OPEN:true/.test(out), "Bun.connect() resolves and the socket reports readyState 1");
  ok(/SRV-DATA:true:hello/.test(out), "the server handler gets (socket, Uint8Array) — the shape Bun passes");
  ok(/CLI-DATA:echo:hello/.test(out), "and the reply comes back to the client");
  ok(/CLI-CLOSE/.test(out) && /SRV-CLOSE/.test(out), "both sides get their close handler");
  ok(r.code === 0, "the process exits cleanly rather than hanging on a live listener (exit " + r.code + ")");
  if (r.code !== 0 || failed) console.log("    stdout: " + JSON.stringify(out.slice(0, 400)) + "\n    stderr: " + JSON.stringify((r.stderr || "").slice(0, 400)));
}

console.log("\n2) two processes, one socket");
writeProject(kernel, APP, {
  "server.ts": `
    const server = Bun.listen({
      port: 8123,
      socket: {
        data(s, chunk) {
          const line = Buffer.from(chunk).toString();
          s.write("pong:" + line);
          if (line === "bye") { s.end(); server.stop(); }
        },
      },
    });
    console.log("READY");
    // Nothing else keeps this process alive; the listener does, until stop().
  `,
  "client.ts": `
    const done = Promise.withResolvers();
    const socket = await Bun.connect({
      hostname: "localhost",
      port: 8123,
      socket: {
        open(s) { s.write("ping"); },
        data(s, chunk) {
          const text = Buffer.from(chunk).toString();
          console.log("GOT:" + text);
          if (text === "pong:ping") s.write("bye");
          else done.resolve();
        },
      },
    });
    await done.promise;
    socket.end();
  `,
});
{
  const server = kernel.start("bun", ["run", "server.ts"], { cwd: APP, env: defaultEnv(APP), capture: true });
  // The client races the server's listen(), so give the listener a moment; the
  // kernel refuses a connection to a port nobody holds, exactly as a real one does.
  await new Promise((r) => setTimeout(r, 400));
  const client = await kernel.start("bun", ["run", "client.ts"], { cwd: APP, env: defaultEnv(APP), capture: true });
  const srv = await server;
  ok(/GOT:pong:ping/.test(client.stdout || ""), "a client process reaches a server process over Bun.connect");
  ok(client.code === 0, "the client exits 0 (was " + client.code + ")");
  ok(srv.code === 0 && /READY/.test(srv.stdout || ""), "and the server exits when it stops listening (was " + srv.code + ")");
  if (failed) console.log("    client: " + JSON.stringify((client.stdout || "") + (client.stderr || "").slice(0, 300)) + "\n    server: " + JSON.stringify((srv.stdout || "") + (srv.stderr || "").slice(0, 300)));
}

console.log("\n3) what still cannot work, and how it says so");
writeProject(kernel, APP, {
  "refuse.ts": `
    const said = {};
    const grab = async (name, fn) => {
      try { await fn(); said[name] = "NOT REFUSED"; }
      catch (e) { said[name] = e.message; }
    };
    await grab("outside-connect", () => Bun.connect({ hostname: "example.com", port: 443, socket: { data() {} } }));
    await grab("outside-listen", () => Bun.listen({ hostname: "0.0.0.0.1", port: 1234, socket: { data() {} } }));
    await grab("tls-connect", () => Bun.connect({ hostname: "localhost", port: 1, tls: true, socket: { data() {} } }));
    await grab("tls-listen", () => Bun.listen({ hostname: "localhost", port: 0, tls: true, socket: { data() {} } }));
    // A closed port must reject AND call connectError — Bun does both, and code
    // in the wild registers only one of the two.
    let viaHandler = "";
    await grab("refused", () => Bun.connect({
      hostname: "127.0.0.1", port: 9,
      socket: { data() {}, connectError(_s, e) { viaHandler = e.code || e.message; } },
    }));
    said["refused-handler"] = viaHandler;
    console.log("SAID:" + JSON.stringify(said));
  `,
});
{
  const r = await kernel.start("bun", ["run", "refuse.ts"], { cwd: APP, env: defaultEnv(APP), capture: true });
  const said = JSON.parse(((r.stdout || "").match(/SAID:(.*)/) || [, "{}"])[1]);
  ok(/no raw TCP to the outside world/.test(said["outside-connect"] || ""), "connecting outside names the wall and points at fetch(): " + JSON.stringify((said["outside-connect"] || "").slice(0, 60)));
  ok(/loopback-only/.test(said["outside-listen"] || ""), "binding a non-loopback host is refused with the reason: " + JSON.stringify((said["outside-listen"] || "").slice(0, 60)));
  ok(/no certificate authority/.test(said["tls-connect"] || "") && /no certificate authority/.test(said["tls-listen"] || ""), "TLS is refused rather than faked on both sides");
  ok(/ECONNREFUSED/.test(said["refused"] || ""), "a closed port rejects the promise with ECONNREFUSED: " + JSON.stringify(said["refused"]));
  ok(/ECONNREFUSED/.test(said["refused-handler"] || ""), "and calls connectError too, as Bun does");
  if (failed) console.log("    said: " + JSON.stringify(said));
}

console.log(failed ? `\nFAIL: ${failed} check(s) failed` : "\nOK: Bun.listen/Bun.connect work inside the VM");
process.exit(failed ? 1 : 0);
