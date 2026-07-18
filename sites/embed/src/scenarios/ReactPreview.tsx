import { useRef } from "react";
import { Vivari, type VivariInstance } from "@vivari/react";
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
export function ReactPreview() {
  const instance = useRef<VivariInstance | null>(null);
  const files = useRef(reactFiles(APP_JSX)).current;
  const debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  function onChange(value: string) {
    if (!instance.current) return;
    clearTimeout(debounce.current);
    debounce.current = setTimeout(() => {
      instance.current?.fs.writeFile(REACT_APP_PATH, value).catch(() => {});
    }, 250);
  }

  // Cmd/Ctrl+S: write immediately (cancel the pending debounce) so the in-VM
  // Vite watcher fires HMR right away.
  function onSave(value: string) {
    if (!instance.current) return;
    clearTimeout(debounce.current);
    instance.current.fs.writeFile(REACT_APP_PATH, value).catch(() => {});
  }

  return (
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
            <Editor initialDoc={APP_JSX} onChange={onChange} onSave={onSave} />
          </div>
        </div>
        <div className="pane">
          <div className="pane__head">Preview</div>
          <div className="pane__body">
            <Vivari
              files={files}
              run={REACT_DEV}
              onReady={(v) => {
                instance.current = v;
              }}
              className="preview"
              fallback={
                <Booting label="Booting Vivari, installing deps, starting Vite..." />
              }
            />
          </div>
        </div>
      </div>
    </div>
  );
}
