import { useEffect, useRef } from "react";
import { EditorView, basicSetup } from "codemirror";
import { EditorState } from "@codemirror/state";
import { javascript } from "@codemirror/lang-javascript";
import { oneDark } from "@codemirror/theme-one-dark";

// A tiny CodeMirror 6 editor. Created once (uncontrolled) — the editor is the
// source of truth and reports edits through onChange; the parent writes those
// into the VFS.
export function Editor({
  initialDoc,
  onChange,
}: {
  initialDoc: string;
  onChange: (value: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!host.current) return;
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: initialDoc,
        extensions: [
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
    // Create once; initialDoc/onChange are read via refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div className="editor" ref={host} />;
}
