import { useEffect, useRef } from "react";
import { EditorView, basicSetup } from "codemirror";
import { keymap } from "@codemirror/view";
import { EditorState, Prec } from "@codemirror/state";
import { javascript } from "@codemirror/lang-javascript";
import { oneDark } from "@codemirror/theme-one-dark";

// A tiny CodeMirror 6 editor. Created once (uncontrolled) — the editor is the
// source of truth and reports edits through onChange; the parent writes those
// into the VFS. Cmd/Ctrl+S is captured (browser save dialog suppressed) and
// routed to onSave so the visitor can save-to-HMR like a real editor.
export function Editor({
  initialDoc,
  onChange,
  onSave,
}: {
  initialDoc: string;
  onChange: (value: string) => void;
  onSave?: (value: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;

  useEffect(() => {
    if (!host.current) return;
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: initialDoc,
        extensions: [
          // Highest precedence so Cmd/Ctrl+S wins over the browser and any
          // default binding; preventDefault stops the OS "save page" dialog.
          Prec.highest(
            keymap.of([
              {
                key: "Mod-s",
                preventDefault: true,
                run: (v) => {
                  onSaveRef.current?.(v.state.doc.toString());
                  return true;
                },
              },
            ]),
          ),
          basicSetup,
          javascript({ jsx: true }),
          oneDark,
          EditorView.theme({ "&": { height: "100%" } }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current(u.state.doc.toString());
          }),
        ],
      }),
    });
    return () => view.destroy();
    // Create once; initialDoc/onChange/onSave are read via refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div className="editor" ref={host} />;
}
