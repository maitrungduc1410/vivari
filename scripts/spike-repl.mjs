// Spike (OFFLINE): the interactive REPLs — `node` with no script and `bun repl`.
//
// WHY THIS EXISTS. Both prompts are driven by keystrokes, and every interesting
// thing about them is a property of the KEYSTROKE PATH rather than of the
// evaluator: whether the character comes back echoed, whether the event loop is
// still turning while the prompt waits, whether Ctrl+C reaches the process as a
// signal or as a byte, whether Ctrl+D ends it. None of that is observable from a
// unit test of the transform, and all of it is what was wrong before:
//
//   • `node` with no arguments printed "node: missing script" and exited 1 — not
//     because a script was missing, but because the shim was a two-way branch
//     between `-e` and a file and the third case had never been written.
//   • `bun repl` refused, saying the sandbox "has pipes rather than a terminal
//     device". process.stdin has been a flowing TTY with isTTY set since the
//     interactive shell landed, so the stated reason was not true.
//   • `bun -e` handed its source straight to eval, so the one place in the shim
//     where TypeScript did not work was the flag whose whole audience is people
//     pasting TypeScript one-liners. (Pinned in spike-bun-cli.mjs, next to the
//     other -e behaviour.)
//
// HOW IT IS DRIVEN. `kernel.launch` + `kernel.sendStdin`, which is exactly what
// the browser terminal does with an xterm keystroke (see probe-term.mjs, and
// kernel-worker.ts's `term-input`). Ctrl+C is the exception and is sent as a
// SIGNAL, because that is what actually reaches a foreground child: the
// interactive `sh` turns \x03 into a SIGINT for the job and forwards no byte.
//
//   run:  node scripts/spike-repl.mjs

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

// A REPL session: launch, type, collect everything the process wrote. `type`
// waits a beat after each chunk because the answer is produced on a later turn of
// the guest's loop (that is the point — see the setTimeout case).
async function session(command, args) {
  const from = h.out.length;
  const pid = kernel.launch(command, args, { cwd: APP, env: ENV });
  if (pid < 0) throw new Error("could not launch " + command);
  // launch() hands back a pid rather than a promise, so the status is taken from
  // the proc's own exit callback — the same one start() wires to its promise.
  let code;
  kernel.procs.get(pid).onExit = (r) => { code = r && r.code; };
  await sleep(1200); // banner + first prompt
  return {
    pid,
    text: () => h.out.slice(from).join(""),
    since(mark) { return h.out.slice(mark).join(""); },
    mark: () => h.out.length,
    // Everything the REPL wrote after the ECHO of the line just typed. The echo is
    // the input verbatim and ends at the \n that submit() writes, so anything a
    // check cares about lives past it — which is what keeps an assertion from
    // matching the keystrokes instead of the answer.
    answerTo(mark) { const s = h.out.slice(mark).join(""); const nl = s.indexOf("\n"); return nl < 0 ? "" : s.slice(nl + 1); },
    code: () => code,
    async type(s, ms = 600) { kernel.sendStdin(pid, s); await sleep(ms); },
    async interrupt(ms = 900) { kernel.signal(pid, "SIGINT"); await sleep(ms); },
    alive: () => !!kernel.procs.get(pid),
    async end(ms = 800) { kernel.sendStdin(pid, "\x04"); await sleep(ms); },
  };
}

console.log("\n1) `node` with no script is a REPL, not an error");
{
  const s = await session("node", []);
  ok(/Welcome to Node\.js/.test(s.text()), "it opens with a banner: " + JSON.stringify(s.text().split("\n")[0]));
  ok(/> $|> /.test(s.text()), "…and a prompt");

  let m = s.mark();
  await s.type("1+1\r");
  // Local echo is the REPL's own doing: nothing between xterm and the guest
  // echoes a keystroke, so an unechoed prompt is a prompt you cannot see yourself
  // typing at.
  ok(/1\+1/.test(s.since(m)), "the keystrokes are echoed back: " + JSON.stringify(s.since(m)));
  ok(/\n2\b/.test(s.since(m)), "…and the expression is evaluated: " + JSON.stringify(s.since(m).replace(/\r/g, "")));

  m = s.mark();
  await s.type("_ + 40\r");
  ok(/\n42\b/.test(s.since(m)), "`_` is the last result, as in every REPL: " + JSON.stringify(s.since(m)));

  m = s.mark();
  await s.type('"hi"\r');
  // The runtime's util.inspect returns a TOP-LEVEL string unquoted (right for
  // console.log). A REPL that does the same cannot tell 1 from '1'.
  ok(/'hi'/.test(s.since(m)), "a string result is quoted, so it is distinguishable from a number: " + JSON.stringify(s.since(m)));

  m = s.mark();
  await s.type("nope()\r");
  ok(/ReferenceError/.test(s.since(m)), "an error is reported…");
  ok(!/internal\/streams|at globalEval|addChunk/.test(s.since(m)), "…without the REPL's own plumbing in the stack: " + JSON.stringify(s.since(m).slice(0, 90)));

  await s.end();
  ok(!s.alive(), "Ctrl+D (\\x04) ends the session — the shell forwards that byte untouched");
}

console.log("\n2) state persists across lines, which is what makes it a session");
{
  const s = await session("node", []);
  // An indirect eval's `let`/`const` live in a lexical environment that is thrown
  // away with the call, so these only persist because the kit hoists them.
  await s.type("let a = 5\r");
  let m = s.mark();
  await s.type("a * 3\r");
  ok(/\n15\b/.test(s.since(m)), "`let` survives to the next line: " + JSON.stringify(s.since(m)));

  await s.type("const { x, y } = { x: 1, y: 2 }\r");
  m = s.mark();
  await s.type("x + y\r");
  ok(/\n3\b/.test(s.since(m)), "…and so does every name a destructuring pattern binds");

  await s.type("class K { v() { return 9 } }\r");
  m = s.mark();
  await s.type("new K().v()\r");
  ok(/\n9\b/.test(s.since(m)), "…and a class, which is lexical too");

  m = s.mark();
  await s.type("let a = 6\r");
  ok(!/SyntaxError/.test(s.since(m)), "a redeclaration is allowed (the documented cost of hoisting): " + JSON.stringify(s.since(m)));

  await s.end();
}

console.log("\n3) multi-line input, decided BEFORE the transform runs");
{
  const s = await session("node", []);
  let m = s.mark();
  await s.type("function f(n) {\r");
  ok(/\.\.\./.test(s.since(m)), "an unfinished statement switches to the continuation prompt: " + JSON.stringify(s.since(m)));
  await s.type("  return n * 3\r");
  await s.type("}\r");
  m = s.mark();
  await s.type("f(4)\r");
  // Paren-wrapping anything that merely parses as an expression turned this
  // DECLARATION into an expression that binds nothing, and f was gone by here.
  ok(/\n12\b/.test(s.since(m)), "the whole function is evaluated and the declaration binds: " + JSON.stringify(s.since(m)));

  m = s.mark();
  await s.type("{ q: 41 }\r");
  // Anchored on the \n, because the observation window opens with the ECHO of the
  // keystrokes and the echo is the input verbatim. Matching /q:\s*1/ against it
  // passed whether the REPL printed the object, printed undefined, or reported a
  // SyntaxError — the same echo collision as the timer marker below.
  ok(/\n\{ q: 41 \}/.test(s.since(m)), "a leading brace is an object literal, not a block: " + JSON.stringify(s.since(m)));
  m = s.mark();
  await s.type("{ let z = 7; z }\r");
  ok(/\n7\b/.test(s.since(m)), "…but a real block is still a block: " + JSON.stringify(s.since(m)));

  await s.end();
}

console.log("\n3b) a template literal is a MODE, not a bracket");
{
  // The continuation predicate counted a backtick as an open bracket in the opening
  // direction only, so a COMPLETE template raised its depth by two and every one of
  // these wedged the prompt at `... ` with no way out but Ctrl+C. Everyday syntax,
  // and the symptom was silence rather than an error.
  const s = await session("node", []);
  let m = s.mark();
  await s.type("`hello`\r");
  ok(/\n'hello'/.test(s.since(m)), "a single-line template evaluates: " + JSON.stringify(s.since(m)));
  ok(!/\.\.\./.test(s.since(m)), "…and does NOT open a continuation prompt");

  m = s.mark();
  await s.type("const who = 'bun'\r");
  await s.type("`hi ${who}`\r");
  ok(/\n'hi bun'/.test(s.since(m)), "a substitution is interpolated: " + JSON.stringify(s.since(m)));

  m = s.mark();
  await s.type("`a { b`\r");
  // Inside a template the text is TEXT: that brace is not an open brace.
  ok(/\n'a \{ b'/.test(s.since(m)), "a brace inside template text is not a bracket: " + JSON.stringify(s.since(m)));

  m = s.mark();
  await s.type("`${ [1,2].map(x => `<${x}>`).join('') }`\r");
  ok(/\n'<1><2>'/.test(s.since(m)), "a template nested inside a substitution works: " + JSON.stringify(s.since(m)));

  // A genuinely unfinished template still continues, which is the other half.
  m = s.mark();
  await s.type("`line one\r");
  ok(/\.\.\./.test(s.since(m)), "an UNCLOSED template does open a continuation: " + JSON.stringify(s.since(m)));
  m = s.mark();
  await s.type("line two`\r");
  ok(/\n'line one\\nline two'/.test(s.since(m)), "…and closing it evaluates the whole multi-line string: " + JSON.stringify(s.since(m)));

  // .break has to work from a continuation prompt, which is the one state where it
  // means anything. Gated on an empty buffer it was unreachable dead code.
  await s.type("`still open\r");
  m = s.mark();
  await s.type(".break\r");
  ok(!/\.\.\.\s*$/.test(s.since(m)), ".break escapes a continuation prompt: " + JSON.stringify(s.since(m)));
  m = s.mark();
  await s.type("1+1\r");
  ok(/\n2\b/.test(s.since(m)), "…back to evaluating on a fresh line: " + JSON.stringify(s.since(m)));

  await s.end();
}

console.log("\n4) the event loop turns WHILE the prompt waits");
{
  const s = await session("node", []);
  const m = s.mark();
  // The whole reason this reads a flowing stdin instead of the blocking
  // OP_READ_STDIN syscall the Python REPL uses. Parked on Atomics.wait, no timer
  // would fire, no socket would be served and no promise would settle until the
  // user typed another line.
  //
  // The marker is CONCATENATED at run time on purpose. Spelling it as a literal
  // matches the echo of the line being typed, so the assertion passes the instant
  // the keystrokes arrive and proves nothing about the timer at all — which is
  // exactly what the first version of this check did.
  await s.type('setTimeout(() => console.log("TIMER" + "-FIRED"), 1000)\r', 400);
  ok(!/TIMER-FIRED/.test(s.since(m)), "…nothing 400ms in: " + JSON.stringify(s.since(m).slice(0, 60)));
  await sleep(1400);
  ok(/TIMER-FIRED/.test(s.since(m)), "a timer armed at the prompt fires on its own, with nothing else typed");

  const m2 = s.mark();
  await s.type("await Promise.resolve(41) + 1\r", 900);
  ok(/\n42\b/.test(s.since(m2)), "top-level await resolves and keeps its value: " + JSON.stringify(s.since(m2)));

  const m3 = s.mark();
  await s.type("const w = await Promise.resolve(7)\r", 900);
  await s.type("w\r");
  ok(/\n7\b/.test(s.since(m3)), "…and a declaration awaiting a value still persists: " + JSON.stringify(s.since(m3)));

  await s.end();
}

console.log("\n5) Ctrl+C abandons the line; it does not kill the process");
{
  const s = await session("node", []);
  await s.type("this line will be abandoned");
  await s.interrupt();
  ok(s.alive(), "the process survives the first SIGINT");
  let m = s.mark();
  await s.type("6*7\r");
  ok(/\n42\b/.test(s.since(m)), "…back at a working prompt, with the abandoned text gone: " + JSON.stringify(s.since(m)));

  // The second one is the real test. A caught-but-unanswered signal escalates to
  // a force-kill (Kernel#signal), so a REPL has to stand that window down with
  // __ocSignalHandled — otherwise the second Ctrl+C at a prompt is an execution.
  await s.interrupt();
  ok(s.alive(), "…and the SECOND one too, because the REPL stands the force-kill window down");
  m = s.mark();
  await s.type("1+2\r");
  ok(/\n3\b/.test(s.since(m)), "…still evaluating after two interrupts");

  await s.end();
  ok(!s.alive(), "and Ctrl+D still ends it");
}

console.log("\n5b) a WEDGED eval is still killable from the terminal");
{
  // The counterpart to the case above, and the one that matters more: the REPL must
  // NOT vouch for itself while an eval is outstanding. It used to stand the
  // force-kill window down unconditionally, which cleared proc.sigUnhandled and the
  // grace timer on every Ctrl+C — so the escalation in Kernel#signal could never
  // fire and `await new Promise(() => {})` made the process, and the terminal tab
  // holding it, unkillable. Ctrl+C is the only way a user has to end a foreground
  // child; there is no `kill` builtin.
  const s = await session("node", []);
  await s.type("await new Promise(() => {})\r", 800);
  ok(s.alive(), "the REPL is alive and wedged on a promise that never settles");

  await s.interrupt(600);
  // First interrupt: the REPL is busy, so it deliberately does NOT answer. The
  // kernel now holds an unanswered SIGINT and an armed grace window.
  await s.interrupt(1500);
  ok(!s.alive(), "a second Ctrl+C escalates and the kernel reaps it: alive=" + s.alive());
}

console.log("\n5c) …but a SLOW eval that recovers is not reaped");
{
  // The other side of the same condition. Answering "not yet" and leaving it there
  // would let the grace timer collect a healthy REPL seconds after a Ctrl+C it had
  // already recovered from, so the interrupt is remembered and answered when the
  // prompt actually returns.
  const s = await session("node", []);
  await s.type("await new Promise(r => setTimeout(r, 1500))\r", 300);
  await s.interrupt(400);              // lands mid-eval, before the promise settles
  await sleep(2000);                   // the eval finishes and the prompt comes back
  ok(s.alive(), "still alive once the slow eval completes");
  // signalGraceMs is 5000, so outliving it proves the late stand-down disarmed the
  // timer rather than the timer simply not having fired yet.
  await sleep(4500);
  ok(s.alive(), "…and past the grace window, because the stand-down was sent on return to the prompt");
  const m = s.mark();
  await s.type("7*6\r");
  ok(/\n42\b/.test(s.since(m)), "…with a working prompt: " + JSON.stringify(s.since(m)));

  await s.end();
}

console.log("\n5d) process.exit() leaves without a word");
{
  // The try/catch around the eval is the widest net in the process, and it used to
  // catch the EXIT: process.exit() unwinds by throwing an Error that carries
  // __processExit, so the prompt reported "Error: process.exit called" plus two
  // frames of runtime internals, then drew one more prompt on its way out. Node
  // exits silently. Recognised by the property, the way every other layer that owns
  // this sentinel recognises it — loop.js, runtime/index.js, python.js, bun.js.
  for (const [label, args] of [["node", []], ["bun repl", ["repl"]]]) {
    const s = await session(label === "node" ? "node" : "bun", args);
    const m = s.mark();
    await s.type("process.exit()\r", 1400);
    // answerTo() drops the echoed keystrokes, so this is the REPL's own output and
    // nothing else. Silence means silence: not "no Error", but nothing at all.
    ok(s.answerTo(m) === "", label + ": process.exit() prints nothing at all: " + JSON.stringify(s.answerTo(m)));
    ok(!s.alive(), label + ": …and the process is gone");
    ok(s.code() === 0, label + ": …with status 0: " + s.code());
  }

  // The code has to survive too, or the silence would be worth nothing.
  {
    const s = await session("node", []);
    const m = s.mark();
    await s.type("process.exit(3)\r", 1400);
    ok(s.answerTo(m) === "", "process.exit(3) is just as quiet: " + JSON.stringify(s.answerTo(m)));
    ok(s.code() === 3, "…and the status reaches the kernel: " + s.code());
  }

  // A second path to the same sentinel, one turn later: this rejects the async
  // wrapper instead of throwing through it, so it needs its own guard.
  {
    const s = await session("node", []);
    const m = s.mark();
    await s.type("await Promise.resolve(1); process.exit(4)\r", 1400);
    ok(s.answerTo(m) === "", "an exit AFTER an await is quiet too: " + JSON.stringify(s.answerTo(m)));
    ok(s.code() === 4, "…and keeps its status: " + s.code());
  }

  // And the shell is what actually reads that status. `sh` has no $?, so `||` is the
  // observation: it runs the right-hand side only on a non-zero exit.
  {
    const sh = await session("sh", []);
    await sh.type("node || echo SAW-NONZERO\r", 1600);
    let m = sh.mark();
    await sh.type("process.exit(3)\r", 1600);
    ok(/SAW-NONZERO/.test(sh.answerTo(m)), "the shell sees a non-zero REPL exit: " + JSON.stringify(sh.answerTo(m)));
    await sh.type("node || echo SHOULD-NOT-PRINT\r", 1600);
    m = sh.mark();
    await sh.type("process.exit(0)\r", 1600);
    ok(!/SHOULD-NOT-PRINT/.test(sh.answerTo(m)), "…and a zero exit as success: " + JSON.stringify(sh.answerTo(m)));
  }
}

console.log("\n5e) an async mistake is reported, not fatal");
{
  // A throw from a callback armed at the prompt does not pass through the eval's
  // try/catch — that call returned long ago — so with no listener the loop applied
  // its default and KILLED the session, reporting through itself and therefore with
  // the internal frames (at runCallback, at runDueTimers, at Object.drive) that
  // printError exists to strip. A REPL is a place to make mistakes.
  const s = await session("node", []);
  let m = s.mark();
  await s.type("setTimeout(() => { throw new Error('ASYNC' + '-BOOM') }, 300)\r", 1500);
  const after = s.answerTo(m);
  ok(/Uncaught Error: ASYNC-BOOM/.test(after), "an async throw is reported: " + JSON.stringify(after.slice(-60)));
  ok(!/runCallback|runDueTimers|Object\.drive/.test(after), "…with our own frames stripped, as a sync throw would be");
  ok(s.alive(), "…and the session survives it");
  m = s.mark();
  await s.type("1+1\r");
  ok(/\n2\b/.test(s.since(m)), "…still evaluating: " + JSON.stringify(s.since(m)));

  // Same for a rejection nobody handled, which reaches the loop by the other route.
  m = s.mark();
  await s.type("setTimeout(() => { Promise.reject(new Error('REJ' + '-BOOM')) }, 300)\r", 1500);
  ok(/Uncaught Error: REJ-BOOM/.test(s.answerTo(m)), "an unhandled rejection is reported: " + JSON.stringify(s.answerTo(m).slice(-60)));
  ok(s.alive(), "…and is not fatal either");

  await s.end();
  ok(s.code() === 0, "Ctrl+D still exits 0: " + s.code());
}

console.log("\n6) a captured process is NOT a terminal, and must not open a prompt");
{
  // spawnSync and internal kernel.start calls are captured: the only party who could
  // type is parked waiting for this process to exit. A prompt there is a hang.
  //
  // What bare `node` does instead is READ ITS SCRIPT FROM STDIN, because a pipe is
  // what fd 0 is here — the same answer real node gives, where `node < /dev/null`
  // runs an empty program and exits 0. It used to be `node: missing script`, exit 1,
  // which this spike pinned; that message was the third case of the argv parser never
  // having been written, not a decision. The load-bearing half of the assertion is
  // unchanged and is the one below: it must not WAIT.
  const r = await Promise.race([
    kernel.start("node", [], { cwd: APP, env: ENV, capture: true }),
    sleep(8000).then(() => ({ code: "TIMEOUT" })),
  ]);
  ok(r.code === 0, "captured `node` with no script reads an empty program rather than waiting forever: " + r.code);
  ok(!/>/.test(r.stdout || "") && !/Welcome to Node/.test(r.stdout || ""), "…and draws no prompt at a terminal that is not there: " + JSON.stringify((r.stdout || "").trim()));

  // -i is how you ask for one anyway, which is what it means in real Node. Driven
  // over a pipe here, which the kit handles: a \n is an Enter just as a \r is, and
  // the \x04 at the end is the Ctrl+D that closes the session. Without that last
  // byte a captured REPL waits forever, because nothing else will ever end its
  // stdin — which is the whole reason bare `node` refuses to open one.
  const forcedPid = kernel.launch("node", ["-i"], { cwd: APP, env: ENV });
  const mark = h.out.length;
  await sleep(1000);
  kernel.sendStdin(forcedPid, "2+3\n\x04");
  await sleep(1200);
  const forced = h.out.slice(mark).join("");
  ok(/\n5\b/.test(forced), "`node -i` opens a REPL and evaluates: " + JSON.stringify(forced.slice(-40)));
  ok(!kernel.procs.get(forcedPid), "…and the trailing \\x04 ends it");
}

console.log("\n7) `bun repl` — the same kit, with Bun's semantics on top");
{
  const s = await session("bun", ["repl"]);
  ok(/Welcome to Bun v/.test(s.text()), "it opens with Bun's banner: " + JSON.stringify(s.text().split("\n")[0]));

  let m = s.mark();
  await s.type("const n: number = 41\r");
  await s.type("n + 1\r");
  ok(/\n42\b/.test(s.since(m)), "TypeScript at the prompt, because bun has no JS-only mode: " + JSON.stringify(s.since(m)));

  m = s.mark();
  await s.type("interface P { a: string }\r");
  await s.type('const p: P = { a: "ok" }\r');
  await s.type("p.a\r");
  ok(/'ok'/.test(s.since(m)), "…including a type-only declaration, which must vanish entirely");

  m = s.mark();
  await s.type("typeof Bun\r");
  ok(/'object'/.test(s.since(m)), "the Bun global is installed in the prompt's scope: " + JSON.stringify(s.since(m)));
  m = s.mark();
  await s.type("Bun.version\r");
  ok(/\d+\.\d+\.\d+/.test(s.since(m)), "…and it is the real shim Bun, not a stub: " + JSON.stringify(s.since(m)));

  m = s.mark();
  await s.type('import { basename } from "path"\r', 900);
  ok(!/Cannot use import|SyntaxError/.test(s.since(m)), "a statement-level `import` is rewritten to a dynamic one: " + JSON.stringify(s.since(m).slice(0, 80)));
  ok(!/toNamespacedPath/.test(s.since(m)), "…and answers undefined, not the whole module namespace");
  m = s.mark();
  await s.type('basename("/a/b.txt")\r');
  ok(/'b\.txt'/.test(s.since(m)), "…with the binding usable on the next line: " + JSON.stringify(s.since(m)));

  // The shape people PASTE, and the one the rewrite used to miss entirely: it ran
  // per line with a ^…$ anchor. isIncomplete herds you into it too, since `import {`
  // opens a continuation prompt — so the statement that arrived at the evaluator was
  // a real statement-level import, i.e. "Cannot use import statement outside a
  // module".
  m = s.mark();
  await s.type("import {\r");
  ok(/\.\.\./.test(s.since(m)), "a multi-line import opens a continuation: " + JSON.stringify(s.since(m)));
  await s.type("  extname,\r");
  await s.type("  dirname\r");
  await s.type('} from "path"\r', 900);
  ok(!/SyntaxError|Cannot use import/.test(s.since(m)), "…and is rewritten, not rejected: " + JSON.stringify(s.since(m).slice(-70)));
  m = s.mark();
  await s.type('extname("a.md") + dirname("/x/y")\r');
  ok(/'\.md\/x'/.test(s.since(m)), "…binding every name in the clause: " + JSON.stringify(s.since(m)));

  // Two imports, two lines. Each rewrite is terminated, because they all start with
  // '(' and ASI does not fire before one — unterminated, the first parsed as a call
  // of the second and threw a TypeError from source nobody wrote.
  m = s.mark();
  await s.type('import { sep } from "path"\r', 700);
  await s.type('import { format } from "util"\r', 900);
  ok(!/TypeError|SyntaxError/.test(s.since(m)), "consecutive imports do not collide: " + JSON.stringify(s.since(m).slice(-70)));
  m = s.mark();
  await s.type('format("%s|%s", sep, typeof format)\r');
  ok(/'\/\|function'/.test(s.since(m)), "…and both bindings are live: " + JSON.stringify(s.since(m)));

  // Two on ONE line is left alone rather than mis-rewritten. It used to swallow
  // everything between the quotes into the module name and drop the second import
  // silently, which is the "subtly wrong rewrite" the code says it refuses to emit.
  m = s.mark();
  await s.type('import a from "x"; import b from "y"\r', 900);
  ok(/Error/.test(s.since(m)), "two imports on one line report an error instead of inventing a specifier: " + JSON.stringify(s.since(m).slice(-90)));
  ok(!/import\("x\\"/.test(s.since(m)), "…and specifically not a specifier with the second import baked into it");

  m = s.mark();
  await s.type("nope()\r");
  ok(/ReferenceError/.test(s.since(m)), "an error is reported…");
  m = s.mark();
  await s.type("_error instanceof ReferenceError\r");
  ok(/\ntrue\b/.test(s.since(m)), "…and bound to `_error`, which is Bun's: " + JSON.stringify(s.since(m)));

  m = s.mark();
  await s.type(".copy\r");
  // Refused by name, the way `bun publish` and `bun patch` are.
  ok(/not implemented in the Vivari shim/.test(s.since(m)), ".copy refuses by name rather than pretending: " + JSON.stringify(s.since(m).slice(0, 70)));
  ok(/clipboard/.test(s.since(m)), "…naming the reason, so the refusal is actionable");

  await s.end();
  ok(!s.alive(), "Ctrl+D ends the Bun session too");
}

console.log("\n8) `bun` with no arguments still prints help and exits 0");
{
  // Real bun does this — it is `bun repl` that opens a prompt, not bare `bun`.
  const r = await kernel.start("bun", [], { cwd: APP, env: ENV, capture: true });
  ok(r.code === 0, "bare `bun` exits 0: " + r.code);
  ok(/Usage: bun/.test(r.stdout || ""), "…having printed the help, as the binary does");
  ok(/bun repl/.test(r.stdout || ""), "…which now lists repl among the commands");
}

console.log(failed ? `\nFAIL: ${failed} check(s) failed` : "\nOK: the node and bun REPLs read, evaluate, print and loop");
process.exit(failed ? 1 : 0);
