// Spike: `readline` actually reads lines.
//
// It used to not. The shim's header explained that "Vivari has no interactive TTY
// (process.stdin is a stub), so a faithful line editor would never receive input
// anyway", and every behaviour followed from that premise: createInterface returned
// an EventEmitter that never emitted 'line', `rl.question` printed the query and
// dropped the callback, and the async iterator ended immediately. The premise went
// stale when stdin became a real flowing TTY. What that cost, concretely, is that
// every interactive scaffolder printed its first question and exited 0 without
// asking anything.
//
// The scaffolder leg lives in spike-scaffolder.mjs, on the net tier: it drives a real
// `npm init`, and a vendored npm is something only that tier provisions.
//
// So the assertions here are the ones that were silently false before: a question
// gets answered, 'line' fires, `for await` yields more than zero lines, and a real
// scaffolder walks its whole script. The cursor/clear no-ops are pinned too — Vite
// calls those on every rebuild and a throw there takes a dev server down, so
// "readline got real" must not have made them real enough to fail.
//
//   run:  node scripts/spike-readline.mjs

import { bootSpikeKernel } from "./lib/spike-harness.mjs";

let failed = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  ✓ " : "  ✗ ") + msg);
  if (!cond) failed++;
};

const h = await bootSpikeKernel();
const { kernel } = h;
const APP = "/app";
kernel.mkdirp(APP);
kernel.mkdirp("/home/user");
const ENV = { PATH: "/bin", HOME: "/home/user", PWD: APP };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const write = (rel, lines) => kernel.writeFile(APP + "/" + rel, lines.join("\n"));

// An interactive run: launch uncaptured (so stdin is a tty), type, collect. Same
// shape as spike-repl.mjs, including answerTo — the echo of what we typed is in the
// transcript, so an assertion that reads the whole thing can match the keystrokes
// instead of the program's answer. That trap has caught this branch three times.
async function run(argv, script) {
  const from = h.out.length;
  const pid = kernel.launch(argv[0], argv.slice(1), { cwd: APP, env: ENV });
  if (pid < 0) throw new Error("could not launch " + argv.join(" "));
  let code;
  kernel.procs.get(pid).onExit = (r) => { code = r && r.code; };
  await sleep(900);
  for (const step of script) {
    if (typeof step === "number") { await sleep(step); continue; }
    kernel.sendStdin(pid, step);
    await sleep(600);
  }
  await sleep(700);
  const text = h.out.slice(from).join("");
  return {
    text,
    code: () => code,
    alive: () => !!kernel.procs.get(pid),
    // Everything after the first newline, i.e. past the echo of the first line typed.
    answerTo: () => (text.indexOf("\n") < 0 ? "" : text.slice(text.indexOf("\n") + 1)),
    // Everything after the LAST occurrence of a marker the program printed. Echo is
    // only one way an assertion gets fed its own answer: a log line above it can
    // contain the very string being looked for, and then the assertion passes even if
    // the thing it names never happened. Reading only past a known landmark removes
    // both sources at once, which answerTo (fixed at the first newline) does not.
    after: (needle) => {
      const i = text.lastIndexOf(needle);
      return i < 0 ? "" : text.slice(i + needle.length);
    },
    pid,
  };
}

console.log("\n1) rl.question answers, in both the callback and the promise form");
{
  write("q-cb.js", [
    "const readline = require('readline');",
    "const rl = readline.createInterface({ input: process.stdin, output: process.stdout });",
    "rl.question('name? ', (a) => { console.log('CB-GOT[' + a + ']'); rl.close(); });",
  ]);
  const r = await run(["node", "q-cb.js"], ["Ada\n"]);
  ok(/name\? /.test(r.text), "the query is written: " + JSON.stringify(r.text.slice(0, 20)));
  ok(/CB-GOT\[Ada\]/.test(r.answerTo()), "the callback fires with the line: " + JSON.stringify(r.answerTo()));
  ok(r.code() === 0 && !r.alive(), "…and close() lets the process exit: code=" + r.code());
}
{
  write("q-promise.mjs", [
    "import * as rlp from 'readline/promises';",
    "const rl = rlp.createInterface({ input: process.stdin, output: process.stdout });",
    "const a = await rl.question('who? ');",
    "console.log('P-GOT[' + a + ']');",
    "rl.close();",
  ]);
  const r = await run(["node", "q-promise.mjs"], ["Grace\n"]);
  ok(/P-GOT\[Grace\]/.test(r.answerTo()), "readline/promises awaits the answer: " + JSON.stringify(r.answerTo()));
}

console.log("\n2) several questions in a row — a scaffolder's whole shape");
{
  write("many.mjs", [
    "import readline from 'readline/promises';",
    "const rl = readline.createInterface({ input: process.stdin, output: process.stdout });",
    "const a = await rl.question('a? ');",
    "const b = await rl.question('b? ');",
    "const c = await rl.question('c? ');",
    "console.log('TRIPLE[' + a + ',' + b + ',' + c + ']');",
    "rl.close();",
  ]);
  const r = await run(["node", "many.mjs"], ["one\n", "two\n", "three\n"]);
  ok(/TRIPLE\[one,two,three\]/.test(r.answerTo()), "each question gets its own line: " + JSON.stringify(r.answerTo().slice(-40)));
  // Three answers PASTED as one chunk: the Enter that ends question 1 arrives in the
  // same chunk as answers 2 and 3, so the tail has to be held for the next reader
  // rather than dropped. This is what a user pasting into xterm produces.
  const p = await run(["node", "many.mjs"], ["four\nfive\nsix\n"]);
  ok(/TRIPLE\[four,five,six\]/.test(p.answerTo()), "…including when all three are pasted at once: " + JSON.stringify(p.answerTo().slice(-40)));
}

console.log("\n3) the 'line' event and the async iterator");
{
  write("lines.js", [
    "const readline = require('readline');",
    "const rl = readline.createInterface({ input: process.stdin, output: process.stdout });",
    "let n = 0;",
    "rl.on('line', (l) => { n++; console.log('L' + n + '[' + l + ']'); });",
    "rl.on('close', () => console.log('CLOSED-AFTER[' + n + ']'));",
  ]);
  const r = await run(["node", "lines.js"], ["x\n", "y\n", "\u0004"]);
  ok(/L1\[x\]/.test(r.text) && /L2\[y\]/.test(r.text), "'line' fires per line: " + JSON.stringify(r.text.slice(-60)));
  ok(/CLOSED-AFTER\[2\]/.test(r.text), "Ctrl+D closes the interface: " + JSON.stringify(r.text.slice(-30)));
}
{
  write("iter.mjs", [
    "import readline from 'readline';",
    "const rl = readline.createInterface({ input: process.stdin, output: process.stdout });",
    "let n = 0;",
    "for await (const line of rl) { n++; if (line === 'stop') break; }",
    "console.log('ITER-TOTAL[' + n + ']');",
  ]);
  const r = await run(["node", "iter.mjs"], ["a\n", "b\n", "stop\n"]);
  ok(/ITER-TOTAL\[3\]/.test(r.text), "`for await (const line of rl)` yields every line: " + JSON.stringify(r.text.slice(-30)));
}

console.log("\n4) prompt(), setPrompt() and close()");
{
  write("prompts.js", [
    "const readline = require('readline');",
    "const rl = readline.createInterface({ input: process.stdin, output: process.stdout });",
    "rl.setPrompt('FIRST> ');",
    "console.log('PROMPT-IS[' + rl.getPrompt() + ']');",
    "rl.prompt();",
    "rl.on('line', () => { rl.setPrompt('SECOND> '); rl.prompt(); });",
  ]);
  const r = await run(["node", "prompts.js"], ["go\n", "\u0004"]);
  ok(/PROMPT-IS\[FIRST> \]/.test(r.text), "getPrompt returns what setPrompt set");
  // NOT /FIRST> / against the whole transcript: the line above prints
  // "PROMPT-IS[FIRST> ]", which contains that string, so the assertion passed whether
  // or not prompt() drew anything. Anchored at a line start, and read past the log
  // line, it can only be satisfied by a prompt actually being written.
  ok(/^FIRST> /m.test(r.after("PROMPT-IS[FIRST> ]")), "prompt() draws it at the start of a line: " + JSON.stringify(r.after("PROMPT-IS[FIRST> ]").slice(0, 20)));
  ok(/SECOND> /.test(r.text), "…and a new prompt after a line: " + JSON.stringify(r.text.slice(-25)));
}

console.log("\n5) a pipe is not a terminal — lines yes, echo no");
{
  write("piped.mjs", [
    "import readline from 'readline';",
    "const rl = readline.createInterface({ input: process.stdin });",
    "const got = [];",
    "for await (const line of rl) got.push(line);",
    "console.log('PIPED[' + got.join('|') + ']');",
  ]);
  kernel.writeFile(APP + "/answers.txt", "p\nq\nr\n");
  const r = await kernel.start("sh", ["-c", "cat answers.txt | node piped.mjs"], { cwd: APP, env: ENV, capture: true });
  const out = (r.stdout || "") + (r.stderr || "");
  ok(/PIPED\[p\|q\|r\]/.test(out), "a piped stdin is read line by line: " + JSON.stringify(out.trim()));
  // The echo would appear as the answers drawn back before the result line. There is
  // no terminal here to want them, and a program filtering a file must not have its
  // input mixed into its output.
  const beforeResult = out.slice(0, out.indexOf("PIPED["));
  ok(!/^[pqr]$/m.test(beforeResult), "…and nothing is echoed back: " + JSON.stringify(beforeResult));
}

console.log("\n6) hidden input is not drawn");
{
  write("secret.mjs", [
    "import readline from 'readline/promises';",
    "const rl = readline.createInterface({ input: process.stdin, output: process.stdout });",
    "const pw = await rl.question('pass: ', { hidden: true });",
    "console.log('LEN[' + pw.length + ']');",
    "rl.close();",
  ]);
  const r = await run(["node", "secret.mjs"], ["hunter2\n"]);
  ok(/LEN\[7\]/.test(r.text), "the hidden answer still arrives whole: " + JSON.stringify(r.text.slice(-20)));
  ok(!/hunter2/.test(r.text), "…without ever appearing in the transcript");
}

console.log("\n7) the cursor/clear helpers stay non-throwing — Vite calls them per rebuild");
{
  write("helpers.js", [
    "const readline = require('readline');",
    "let calls = 0;",
    "const cb = () => { calls++; };",
    "readline.clearLine(process.stdout, 0, cb);",
    "readline.clearScreenDown(process.stdout, cb);",
    "readline.cursorTo(process.stdout, 0, cb);",
    "readline.cursorTo(process.stdout, 0, 0, cb);",
    "readline.moveCursor(process.stdout, 0, -1, cb);",
    "readline.emitKeypressEvents(process.stdin);",
    "console.log('HELPERS-OK[' + calls + ']');",
  ]);
  const r = await kernel.start("node", ["helpers.js"], { cwd: APP, env: ENV, capture: true });
  ok(r.code === 0, "they do not throw: exit " + r.code + " " + (r.stderr || "").slice(0, 80));
  ok(/HELPERS-OK\[5\]/.test(r.stdout || ""), "…and each still invokes its callback: " + JSON.stringify((r.stdout || "").trim()));
}

console.log(failed === 0 ? "\nOK: readline reads lines" : `\nFAIL: ${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
