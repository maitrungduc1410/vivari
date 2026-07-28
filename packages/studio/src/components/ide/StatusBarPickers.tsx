// The three VS Code-style quick picks the status bar opens: Go to Line
// ("Ln x, Col y"), indentation ("Spaces: n") and language mode.
//
// All three reuse the command-palette primitives so they look and keyboard-drive
// exactly like ⌘P. Go to Line filters nothing (its input is a line number); the
// other two lean on cmdk's own matching, with each row's `value` carrying the
// text worth searching.

import { useEffect, useState, useSyncExternalStore } from "react";
import { LANGUAGE_MODES } from "@/vv/controller";
import {
  Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem,
  CommandList, CommandSeparator, CommandShortcut,
} from "@/components/ui/command";
import { FileIcon } from "./fileIcon";
import { useIde } from "./useIde";

export type StatusPicker = "goto" | "indent" | "language" | null;

// Tab sizes offered by the "change view" indentation actions, matching the range
// VS Code's own quick pick offers.
const TAB_SIZES = [1, 2, 3, 4, 5, 6, 7, 8];

export function StatusBarPickers({ open, onClose }: { open: StatusPicker; onClose: () => void }) {
  return (
    <>
      <GoToLinePicker open={open === "goto"} onClose={onClose} />
      <IndentationPicker open={open === "indent"} onClose={onClose} />
      <LanguageModePicker open={open === "language"} onClose={onClose} />
    </>
  );
}

/** Subscribe to the controller's cursor / indentation / language readouts. */
function useEditorStatus() {
  const { c } = useIde();
  return useSyncExternalStore(c.editorStatus.subscribe, c.editorStatus.getSnapshot);
}

// ── Go to Line ───────────────────────────────────────────────────────────────

// "42" or "42:8" — the same `line[:col]` shape quick-open's suffix accepts.
function parseLineCol(raw: string): { line: number; column: number } | null {
  const m = raw.trim().match(/^(\d+)(?::(\d+))?$/);
  if (!m) return null;
  return { line: parseInt(m[1], 10), column: m[2] ? parseInt(m[2], 10) : 1 };
}

function GoToLinePicker({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { c } = useIde();
  const { cursor, lineCount } = useEditorStatus();
  const [raw, setRaw] = useState("");

  useEffect(() => {
    if (open) setRaw("");
  }, [open]);

  const parsed = parseLineCol(raw);
  const valid = parsed != null && parsed.line >= 1 && parsed.line <= lineCount;
  const hint = `Type a line number between 1 and ${lineCount} to navigate to.`;

  return (
    <CommandDialog open={open} onOpenChange={(o) => (o ? undefined : onClose())} title="Go to Line" finalFocus={false}>
      <Command shouldFilter={false}>
        <CommandInput value={raw} onValueChange={setRaw} placeholder={hint} />
        <CommandList>
          <CommandItem
            value="goto-line"
            disabled={!valid}
            onSelect={() => {
              if (!parsed) return;
              onClose();
              c.gotoLine(parsed.line, parsed.column);
            }}
          >
            {valid && parsed ? (
              <span>
                Go to line {parsed.line}
                {parsed.column > 1 && ` and character ${parsed.column}`}
              </span>
            ) : raw.trim() === "" && cursor ? (
              <span>
                Current Line: {cursor.line}, Character: {cursor.column}. {hint}
              </span>
            ) : (
              <span>{hint}</span>
            )}
          </CommandItem>
        </CommandList>
      </Command>
    </CommandDialog>
  );
}

// ── Indentation ──────────────────────────────────────────────────────────────

// The actions that ask for a tab size before they apply.
type SizedAction = "spaces" | "tabs" | "display";

function IndentationPicker({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { c } = useIde();
  const { indent } = useEditorStatus();
  // Second level: which size-taking action we're choosing a tab size for.
  const [sizing, setSizing] = useState<SizedAction | null>(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (open) {
      setSizing(null);
      setSearch("");
    }
  }, [open]);

  const drillInto = (action: SizedAction) => {
    setSizing(action);
    setSearch("");
  };

  const run = (fn: () => void) => {
    onClose();
    fn();
  };

  const applySize = (size: number) =>
    run(() => {
      if (sizing === "spaces") c.setIndentation({ insertSpaces: true, tabSize: size });
      else if (sizing === "tabs") c.setIndentation({ insertSpaces: false, tabSize: size });
      else c.setIndentation({ tabSize: size });
    });

  return (
    <CommandDialog open={open} onOpenChange={(o) => (o ? undefined : onClose())} title="Indentation" finalFocus={false}>
      <Command>
        <CommandInput
          value={search}
          onValueChange={setSearch}
          placeholder={
            sizing === "display"
              ? "Select Tab Display Size for Current File"
              : sizing
                ? "Select Tab Size for Current File"
                : "Select Action"
          }
        />
        <CommandList>
          <CommandEmpty>No results.</CommandEmpty>
          {sizing ? (
            <CommandGroup>
              {TAB_SIZES.map((size) => (
                <CommandItem
                  key={size}
                  value={String(size)}
                  data-checked={indent?.tabSize === size}
                  onSelect={() => applySize(size)}
                >
                  {size}
                </CommandItem>
              ))}
            </CommandGroup>
          ) : (
            <>
              <CommandGroup>
                <CommandItem value="Indent Using Spaces" onSelect={() => drillInto("spaces")}>
                  Indent Using Spaces
                  <CommandShortcut>change view</CommandShortcut>
                </CommandItem>
                <CommandItem value="Indent Using Tabs" onSelect={() => drillInto("tabs")}>
                  Indent Using Tabs
                </CommandItem>
                <CommandItem value="Change Tab Display Size" onSelect={() => drillInto("display")}>
                  Change Tab Display Size
                </CommandItem>
              </CommandGroup>
              <CommandSeparator />
              <CommandGroup>
                <CommandItem
                  value="Detect Indentation from Content"
                  onSelect={() => run(() => c.detectIndentation())}
                >
                  Detect Indentation from Content
                  <CommandShortcut>convert file</CommandShortcut>
                </CommandItem>
                <CommandItem
                  value="Convert Indentation to Spaces"
                  onSelect={() => run(() => c.runEditorAction("editor.action.indentationToSpaces"))}
                >
                  Convert Indentation to Spaces
                </CommandItem>
                <CommandItem
                  value="Convert Indentation to Tabs"
                  onSelect={() => run(() => c.runEditorAction("editor.action.indentationToTabs"))}
                >
                  Convert Indentation to Tabs
                </CommandItem>
                <CommandItem
                  value="Trim Trailing Whitespace"
                  onSelect={() => run(() => c.runEditorAction("editor.action.trimTrailingWhitespace"))}
                >
                  Trim Trailing Whitespace
                </CommandItem>
              </CommandGroup>
            </>
          )}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}

// ── Language mode ────────────────────────────────────────────────────────────

// A representative filename per language, so the picker reuses the existing
// vscode-icons file-type icons instead of importing twenty more. Anything absent
// falls back to the generic document icon.
const SAMPLE_FILE: Record<string, string> = {
  typescript: "a.ts",
  css: "a.css",
  scss: "a.scss",
  less: "a.less",
  html: "a.html",
  json: "a.json",
  markdown: "a.md",
  python: "a.py",
  plaintext: "a.txt",
};

function LanguageModePicker({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { c } = useIde();
  const { language } = useEditorStatus();

  const select = (id: string | null) => {
    onClose();
    c.setLanguageMode(id);
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={(o) => (o ? undefined : onClose())}
      title="Select Language Mode"
      finalFocus={false}
    >
      <Command>
        <CommandInput placeholder="Select Language Mode" />
        <CommandList>
          <CommandEmpty>No matching language mode.</CommandEmpty>
          <CommandGroup>
            <CommandItem value="Auto Detect" onSelect={() => select(null)}>
              Auto Detect
            </CommandItem>
            {LANGUAGE_MODES.map((m) => (
              // The value carries both label and id so typing either one matches.
              <CommandItem
                key={m.id}
                value={`${m.label} ${m.id}`}
                data-checked={m.id === language}
                onSelect={() => select(m.id)}
              >
                <FileIcon name={SAMPLE_FILE[m.id] ?? "a"} className="size-4 shrink-0" />
                <span>{m.label}</span>
                <span className="text-xs text-muted-foreground">({m.id})</span>
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </Command>
    </CommandDialog>
  );
}