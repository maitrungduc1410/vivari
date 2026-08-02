import { Vivari, VivariProvider, useVivariFile } from "@vivari/react";
import { Editor } from "../components/Editor";
import { Booting } from "../components/ui";
import {
  APP_JSX,
  REACT_APP_PATH,
  REACT_DEV,
  reactFiles,
} from "../lib/reactTemplate";

// A real Vite + React dev server booted inside the browser. Editing App.jsx
// writes back into the VFS and Vite HMR updates the live preview on the right.
//
// The editor and the <Vivari> embed sit under one <VivariProvider>, so they
// share a single kernel: <Vivari> mounts and runs the project, useVivariFile
// writes into the same VFS.

const FILES = reactFiles(APP_JSX);

function AppEditor() {
  // Debounced write-behind, plus a flush on unmount that the hand-rolled
  // setTimeout this replaced never had. The Editor is uncontrolled, so the
  // file's contents are seeded by `initialDoc` and not read back here.
  const [, setSource, { save }] = useVivariFile(REACT_APP_PATH);

  return (
    <Editor
      initialDoc={APP_JSX}
      onChange={setSource}
      // Cmd/Ctrl+S: cancel the pending debounce and write now, so the in-VM
      // Vite watcher fires HMR right away.
      onSave={(value) => {
        setSource(value);
        void save();
      }}
    />
  );
}

export function ReactPreview() {
  return (
    <VivariProvider>
      <div className="embed">
        <div className="embed__bar">
          <span className="embed__title">react - npm run dev</span>
        </div>
        <div className="split">
          <div className="pane">
            <div className="pane__head">
              src/App.jsx
              <span className="pane__hint">{"\u2318S / Ctrl+S to save"}</span>
            </div>
            <div className="pane__body">
              <AppEditor />
            </div>
          </div>
          <div className="pane">
            <div className="pane__head">Preview</div>
            <div className="pane__body">
              <Vivari
                files={FILES}
                run={REACT_DEV}
                className="preview"
                fallback={
                  <Booting label="Booting Vivari, installing deps, starting Vite..." />
                }
                // `fallback` is the pending slot only — failures come through
                // here instead of hiding behind a spinner that never stops.
                renderError={({ phase, error }) => (
                  <div className="center">
                    <strong>Failed during {phase}.</strong>
                    <p style={{ maxWidth: "32rem", lineHeight: 1.5 }}>
                      {error.message}
                    </p>
                  </div>
                )}
              />
            </div>
          </div>
        </div>
      </div>
    </VivariProvider>
  );
}