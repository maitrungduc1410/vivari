import { useEffect, useRef, useState } from "react";
import { Vivari } from "@vivari/core";
import type { VivariProcess } from "@vivari/core";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Editor } from "../components/Editor";
import { StatusDot } from "../components/ui";

type Status = "booting" | "ready" | "running";

// A real Node script the visitor can edit and run: it uses Node core modules
// (os, crypto, process) that genuinely execute inside the browser VM.
const INDEX_JS = `import os from "node:os";
import { createHash } from "node:crypto";

console.log("Node", process.version, "running in", os.platform());

const digest = createHash("sha256").update("hello from vivari").digest("hex");
console.log("sha256:", digest.slice(0, 32) + "...");

let total = 0;
for (let i = 1; i <= 5; i++) {
  total += i;
  console.log("tick", i, "sum", total);
}

console.log("done - edit me and hit Run again!");
`;

const TERM_THEME = {
  background: "#05070c",
  foreground: "#dfe4f0",
  cursor: "#22d3ee",
  selectionBackground: "#264f78",
};

export function NodeTerminal() {
  const [status, setStatus] = useState<Status>("booting");
  const codeRef = useRef(INDEX_JS);
  const termHost = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const vivariRef = useRef<Vivari | null>(null);
  const procRef = useRef<VivariProcess | null>(null);

  useEffect(() => {
    let disposed = false;
    const term = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontFamily:
        'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace',
      fontSize: 12.5,
      theme: TERM_THEME,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    if (termHost.current) term.open(termHost.current);
    fit.fit();
    termRef.current = term;

    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        /* not visible yet */
      }
    });
    if (termHost.current) ro.observe(termHost.current);

    (async () => {
      try {
        const vivari = await Vivari.boot({ serviceWorkerUrl: false });
        if (disposed) {
          vivari.teardown();
          return;
        }
        await vivari.mount({
          "package.json": {
            file: { contents: '{ "name": "demo", "type": "module" }' },
          },
          "index.js": { file: { contents: INDEX_JS } },
        });
        vivariRef.current = vivari;
        setStatus("ready");
        term.writeln("\x1b[38;5;244mReady. Edit index.js and press Run.\x1b[0m");
      } catch (err) {
        term.writeln(
          "\x1b[38;5;203mFailed to boot: " +
            (err instanceof Error ? err.message : String(err)) +
            "\x1b[0m",
        );
      }
    })();

    return () => {
      disposed = true;
      ro.disconnect();
      procRef.current?.kill();
      vivariRef.current?.teardown();
      term.dispose();
    };
  }, []);

  async function run() {
    const vivari = vivariRef.current;
    const term = termRef.current;
    if (!vivari || !term || status === "running") return;
    setStatus("running");
    term.clear();
    term.writeln("\x1b[38;5;51m$\x1b[0m node index.js");

    try {
      await vivari.fs.writeFile("/index.js", codeRef.current);
      const proc = await vivari.spawn("node", ["index.js"]);
      procRef.current = proc;

      // Forward keystrokes to the process so interactive scripts work too.
      const writer = proc.input.getWriter();
      const onData = term.onData((d) => void writer.write(d));

      await proc.output.pipeTo(
        new WritableStream({ write: (chunk) => term.write(chunk) }),
      );
      const code = await proc.exit;
      onData.dispose();
      await writer.close().catch(() => {});
      term.writeln(
        `\r\n\x1b[38;5;244m[process exited with code ${code}]\x1b[0m`,
      );
    } catch (err) {
      term.writeln(
        "\r\n\x1b[38;5;203m" +
          (err instanceof Error ? err.message : String(err)) +
          "\x1b[0m",
      );
    } finally {
      procRef.current = null;
      setStatus("ready");
    }
  }

  return (
    <div className="embed">
      <div className="embed__bar">
        <span className="embed__title">
          <StatusDot state={status} />
          {status === "booting" ? "booting runtime..." : "node - index.js"}
        </span>
        <span className="embed__spacer" />
        <button
          className="btn btn--primary"
          onClick={run}
          disabled={status !== "ready"}
        >
          {status === "running" ? "Running..." : "\u25B6 Run"}
        </button>
      </div>
      <div className="split">
        <div className="pane">
          <div className="pane__head">index.js</div>
          <div className="pane__body">
            <Editor
              initialDoc={INDEX_JS}
              onChange={(v) => (codeRef.current = v)}
            />
          </div>
        </div>
        <div className="pane">
          <div className="pane__head">Terminal</div>
          <div className="pane__body">
            <div className="term" ref={termHost} />
          </div>
        </div>
      </div>
    </div>
  );
}
