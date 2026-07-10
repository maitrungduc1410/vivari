// Validate the interactive terminal plumbing end-to-end, headless: launch a
// long-lived `sh` (no args = REPL), feed keystrokes through kernel.sendStdin as a
// browser terminal would, and assert the shell echoes + runs commands with cwd
// persisting across them.
//
//   node scripts/probe-term.mjs
import { Kernel } from "../packages/kernel-host/kernel.js";
import { createKernelFs } from "../packages/kernel-host/kernel-fs.js";
import { Worker, MessageChannel } from "node:worker_threads";

const fsWorker = new Worker(new URL("./fs-worker.mjs", import.meta.url));
let onKernelFsMessage = () => {};
await new Promise((resolve) => { fsWorker.on("message", (m) => { if (m.type === "ready") resolve(); else onKernelFsMessage(m); }); });
const kernelFs = createKernelFs(fsWorker);
onKernelFsMessage = kernelFs.onMessage;
const spawnWorker = (info) => {
  const w = new Worker(new URL("./process-worker.mjs", import.meta.url));
  w.on("message", (m) => { const h = info.on[m.type]; if (h) h(m); });
  const { port1, port2 } = new MessageChannel();
  fsWorker.postMessage({ type: "fs-register", client: info.pid, sab: info.sab, port: port2 }, [port2]);
  const init = { type: "init", sab: info.sab, spec: info.spec, fsPort: port1 };
  const transfer = [port1];
  if (info.threadPort) { init.threadPort = info.threadPort; transfer.push(info.threadPort); }
  w.postMessage(init, transfer);
  return { terminate: () => { w.terminate(); fsWorker.postMessage({ type: "fs-unregister", client: info.pid }); }, postMessage: (m) => w.postMessage(m) };
};

let shellPid = null;
let out = "";
const kernel = new Kernel({
  fs: kernelFs.fs,
  spawnWorker,
  fetcher: async () => ({ ok: false, status: 0, headers: {}, body: new Uint8Array() }),
  stdout: (chunk, pid) => { if (pid === shellPid) out += chunk; process.stdout.write(chunk); },
  stderr: (chunk, pid) => { if (pid === shellPid) out += chunk; process.stderr.write(chunk); },
});
kernel.installCoreutils();
kernel.mkdirp("/work");
kernel.mkdirp("/work/sub");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const type = async (s) => { kernel.sendStdin(shellPid, s); await sleep(300); };
const section = (t) => console.log("\n== " + t + " ==");

section("launch interactive sh");
shellPid = kernel.launch("sh", [], { cwd: "/work", env: { PATH: "/bin", PS1: "$ " } });
console.log("  shell pid=" + shellPid);
await sleep(400);
const sawPrompt = /\$/.test(out);
console.log("  prompt shown: " + sawPrompt);

section("echo hello  (Enter = \\r)");
out = "";
await type("echo hello\r");
const echoed = out.includes("echo hello"); // local echo of keystrokes
const ran = out.includes("hello"); // command output
console.log("  keystrokes echoed: " + echoed);
console.log("  command output 'hello': " + ran);

section("cd sub ; pwd  (cwd persists in one shell)");
out = "";
await type("cd sub\r");
await type("pwd\r");
const cwdOk = out.includes("/work/sub");
console.log("  pwd after cd: " + JSON.stringify((out.match(/\/work\S*/) || [""])[0]) + " ok=" + cwdOk);

section("backspace editing (echo XYZ<bs><bs><bs>hi)");
out = "";
await type("echo XYZ");
await type("\x7f\x7f\x7fhi\r");
const bsOk = out.includes("hi") && !out.includes("XYZ\r") && !/\bhi\b[\s\S]*XYZ/.test(out);
console.log("  backspace result contains 'hi', not 'XYZ': " + (out.includes("hi") && !/^hi.*XYZ/.test(out)));
console.log("  raw: " + JSON.stringify(out.slice(-40)));

section("OC_RUN auto-runs a command at startup (the demo 'Run' mechanism)");
out = "";
const autoPid = kernel.launch("sh", [], { cwd: "/work", env: { PATH: "/bin", OC_RUN: "echo autorun-ok" } });
shellPid = autoPid; // route this shell's stdout into `out`
await sleep(700);
const autoRan = out.includes("autorun-ok");
console.log("  auto-ran OC_RUN without any stdin: " + autoRan);
console.log("  raw: " + JSON.stringify(out.slice(0, 80)));

const pass = sawPrompt && echoed && ran && cwdOk && out.includes("autorun-ok") && autoRan;
console.log("\nRESULT: " + (pass ? "PASS" : "FAIL"));
process.exit(pass ? 0 : 1);
