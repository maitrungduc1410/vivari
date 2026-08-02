import { useCallback, useEffect, useRef, useState } from "react";
import { useSpawn, useVivari } from "@vivari/react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Editor } from "../components/Editor";
import { StatusDot } from "../components/ui";

type Status = "booting" | "ready" | "running";

export type NodeTerminalProps = {
  /** The script mounted at `filename` and run by the Run button. */
  source?: string;
  filename?: string;
  /** ESM by default; a scenario demonstrating CommonJS can override this. */
  packageJson?: string;
};

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

export function NodeTerminal({
  source = INDEX_JS,
  filename = "index.js",
  packageJson = '{ "name": "demo", "type": "module" }',
}: NodeTerminalProps = {}) {
  const codeRef = useRef(source);
  const termHost = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const [mounted, setMounted] = useState(false);

  // No preview iframe here, so no Service Worker to register. Its own key keeps
  // this off the default kernel that the React preview scenario boots.
  const { vivari, status: bootStatus, error: bootError } = useVivari({
    instanceKey: "node-terminal",
    serviceWorkerUrl: false,
  });

  const writeToTerm = useCallback((chunk: string) => termRef.current?.write(chunk), []);

  // Spawning, output streaming, stdin and kill-on-unmount all come from the
  // hook; this scenario used to hand-write every one of them.
  const runner = useSpawn("node", [filename], {
    onOutput: writeToTerm,
    onExit: (code) =>
      termRef.current?.writeln(
        `\r\n\x1b[38;5;244m[process exited with code ${code}]\x1b[0m`,
      ),
    onError: (err) =>
      termRef.current?.writeln(`\r\n\x1b[38;5;203m${err.message}\x1b[0m`),
  });

  const status: Status =
    runner.status === "running" ? "running" : mounted ? "ready" : "booting";

  useEffect(() => {
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

    // Forward keystrokes to the running process so interactive scripts work.
    const onData = term.onData(runner.write);

    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        /* not visible yet */
      }
    });
    if (termHost.current) ro.observe(termHost.current);

    return () => {
      onData.dispose();
      ro.disconnect();
      term.dispose();
      termRef.current = null;
    };
  }, [runner.write]);

  // Mount the project once the shared kernel is up. Teardown is the hook's job:
  // the instance is ref-counted and any running process is killed on unmount.
  useEffect(() => {
    if (!vivari) return;
    let cancelled = false;
    void (async () => {
      try {
        await vivari.mount({
          "package.json": { file: { contents: packageJson } },
          [filename]: { file: { contents: source } },
        });
        if (cancelled) return;
        setMounted(true);
        termRef.current?.writeln(
          `\x1b[38;5;244mReady. Edit ${filename} and press Run.\x1b[0m`,
        );
      } catch (err) {
        if (cancelled) return;
        termRef.current?.writeln(
          `\x1b[38;5;203mFailed to mount: ${err instanceof Error ? err.message : String(err)}\x1b[0m`,
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [vivari, source, filename, packageJson]);

  // A kernel that cannot boot at all (no cross-origin isolation, no workers) is
  // reported with an actionable message rather than a spinner that never stops.
  useEffect(() => {
    if (bootStatus === "error" || bootStatus === "unsupported") {
      termRef.current?.writeln(
        `\x1b[38;5;203mFailed to boot: ${bootError?.message}\x1b[0m`,
      );
    }
  }, [bootStatus, bootError]);

  async function run() {
    const vm = vivari;
    const term = termRef.current;
    if (!vm || !term || !mounted || runner.status === "running") return;

    term.clear();
    term.writeln(`\x1b[38;5;51m$\x1b[0m node ${filename}`);
    try {
      await vm.fs.writeFile(`/${filename}`, codeRef.current);
    } catch (err) {
      term.writeln(
        `\r\n\x1b[38;5;203m${err instanceof Error ? err.message : String(err)}\x1b[0m`,
      );
      return;
    }
    await runner.run();
  }

  return (
    <div className="embed">
      <div className="embed__bar">
        <span className="embed__title">
          <StatusDot state={status} />
          {status === "booting" ? "booting runtime..." : `node - ${filename}`}
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
          <div className="pane__head">
            {filename}
            <span className="pane__hint">{"\u2318S / Ctrl+S to run"}</span>
          </div>
          <div className="pane__body">
            <Editor
              initialDoc={source}
              onChange={(v) => (codeRef.current = v)}
              onSave={(v) => {
                codeRef.current = v;
                void run();
              }}
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