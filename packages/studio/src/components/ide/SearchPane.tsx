import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ChevronRight from "~icons/lucide/chevron-right";
import ChevronDown from "~icons/lucide/chevron-down";
import CaseSensitive from "~icons/lucide/case-sensitive";
import WholeWord from "~icons/lucide/whole-word";
import Regex from "~icons/lucide/regex";
import CaseUpper from "~icons/lucide/case-upper";
import Replace from "~icons/lucide/replace";
import ReplaceAll from "~icons/lucide/replace-all";
import Ellipsis from "~icons/lucide/ellipsis";
import X from "~icons/lucide/x";
import Loader from "~icons/lucide/loader-circle";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { FileIcon } from "./fileIcon";
import { useIde } from "./useIde";
import type { SearchDone, SearchFileResult } from "@/vv/controller";

const baseName = (rel: string) => rel.split("/").pop() ?? rel;
const dirName = (rel: string) => {
  const i = rel.lastIndexOf("/");
  return i <= 0 ? "" : rel.slice(0, i);
};

// A small VS Code-style toggle (Aa / whole-word / .* / preserve-case).
function Toggle({
  active, onClick, title, children,
}: {
  active: boolean; onClick: () => void; title: string; children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-accent/60 hover:text-foreground",
        active && "bg-primary/25 text-foreground",
      )}
    >
      {children}
    </button>
  );
}

// Render one result line: leading indentation trimmed, the match span highlighted.
function MatchLine({ preview, column, length }: { preview: string; column: number; length: number }) {
  const leading = preview.length - preview.trimStart().length;
  const text = preview.trimStart();
  const col = column - 1 - leading; // 0-based within the trimmed text
  if (col < 0 || col + length > text.length || length === 0) {
    return <span className="truncate">{text.slice(0, 240)}</span>;
  }
  return (
    <span className="truncate">
      {text.slice(0, col)}
      <span className="rounded-[2px] bg-yellow-500/30 text-foreground">{text.slice(col, col + length)}</span>
      {text.slice(col + length)}
    </span>
  );
}

export function SearchPane() {
  const { c, snap } = useIde();

  const [query, setQuery] = useState("");
  const [replaceText, setReplaceText] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [regex, setRegex] = useState(false);
  const [preserveCase, setPreserveCase] = useState(false);
  const [includeGlob, setIncludeGlob] = useState("");
  const [excludeGlob, setExcludeGlob] = useState("");
  const [showReplace, setShowReplace] = useState(false);
  const [showDetails, setShowDetails] = useState(false);

  const [results, setResults] = useState<SearchFileResult[]>([]);
  const [summary, setSummary] = useState<SearchDone | null>(null);
  const [searching, setSearching] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const cancelRef = useRef<(() => void) | null>(null);

  // Validate the regex client-side so a bad pattern shows an error instead of
  // firing a doomed search.
  const regexError = useMemo(() => {
    if (!regex || !query) return null;
    try {
      // eslint-disable-next-line no-new
      new RegExp(query);
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : "Invalid regular expression";
    }
  }, [regex, query]);

  const hasRoots = snap.workspaceFolders.length > 0;

  // Debounced search: re-run whenever the query or any option changes.
  useEffect(() => {
    cancelRef.current?.();
    cancelRef.current = null;
    const q = query;
    if (!q || regexError || !hasRoots) {
      setResults([]);
      setSummary(null);
      setSearching(false);
      return;
    }
    const t = setTimeout(() => {
      setResults([]);
      setSummary(null);
      setSearching(true);
      cancelRef.current = c.runSearch(
        { query: q, matchCase, wholeWord, regex, includeGlob, excludeGlob },
        {
          onBatch: (files) => setResults((prev) => prev.concat(files)),
          onDone: (d) => { setSummary(d); setSearching(false); },
        },
      );
    }, 250);
    return () => clearTimeout(t);
    // treeVersion re-runs the search after a replace/file change refreshes the VFS.
  }, [c, query, matchCase, wholeWord, regex, includeGlob, excludeGlob, hasRoots, regexError, snap.treeVersion]);

  // Cancel any in-flight search when the pane unmounts.
  useEffect(() => () => cancelRef.current?.(), []);

  const replaceOpts = useMemo(
    () => ({ query, matchCase, wholeWord, regex, replacement: replaceText, preserveCase }),
    [query, matchCase, wholeWord, regex, replaceText, preserveCase],
  );
  const totalMatches = summary?.matchCount ?? results.reduce((n, f) => n + f.matches.length, 0);

  const doReplaceAll = useCallback(async () => {
    const files = results.map((f) => f.file);
    if (!files.length) return;
    await c.replace({ ...replaceOpts, files });
    // The vv-fs-changed bump re-runs the search via treeVersion.
  }, [c, results, replaceOpts]);

  const doReplaceFile = useCallback(async (file: string) => {
    await c.replace({ ...replaceOpts, files: [file] });
  }, [c, replaceOpts]);

  const doReplaceMatch = useCallback(async (file: string, m: SearchFileResult["matches"][number]) => {
    await c.replace({ ...replaceOpts, match: { file, line: m.line, column: m.column, length: m.length } });
  }, [c, replaceOpts]);

  const toggleCollapsed = (file: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(file)) next.delete(file); else next.add(file);
      return next;
    });

  const dismissFile = (file: string) => setResults((prev) => prev.filter((f) => f.file !== file));

  return (
    <div className="flex h-full flex-col bg-sidebar">
      <div className="flex h-8 shrink-0 items-center px-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Search
      </div>

      {/* query + replace + include/exclude */}
      <div className="flex items-start gap-1 px-2 pb-2">
        <button
          type="button"
          title={showReplace ? "Hide Replace" : "Toggle Replace"}
          onClick={() => setShowReplace((v) => !v)}
          className="mt-1 flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-accent/60 hover:text-foreground"
        >
          {showReplace ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        </button>

        <div className="flex min-w-0 flex-1 flex-col gap-1">
          {/* search input row */}
          <div
            className={cn(
              "flex items-center gap-1 rounded border bg-background px-1.5 py-1",
              regexError && "border-destructive",
            )}
          >
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search"
              className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
            />
            <Toggle active={matchCase} onClick={() => setMatchCase((v) => !v)} title="Match Case">
              <CaseSensitive className="size-3.5" />
            </Toggle>
            <Toggle active={wholeWord} onClick={() => setWholeWord((v) => !v)} title="Match Whole Word">
              <WholeWord className="size-3.5" />
            </Toggle>
            <Toggle active={regex} onClick={() => setRegex((v) => !v)} title="Use Regular Expression">
              <Regex className="size-3.5" />
            </Toggle>
          </div>

          {regexError && <div className="px-0.5 text-[11px] text-destructive">{regexError}</div>}

          {/* replace input row */}
          {showReplace && (
            <div className="flex items-center gap-1">
              <div className="flex min-w-0 flex-1 items-center gap-1 rounded border bg-background px-1.5 py-1">
                <input
                  value={replaceText}
                  onChange={(e) => setReplaceText(e.target.value)}
                  placeholder="Replace"
                  className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
                />
                <Toggle active={preserveCase} onClick={() => setPreserveCase((v) => !v)} title="Preserve Case">
                  <CaseUpper className="size-3.5" />
                </Toggle>
              </div>
              <button
                type="button"
                title="Replace All"
                disabled={totalMatches === 0}
                onClick={doReplaceAll}
                className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent/60 hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
              >
                <ReplaceAll className="size-4" />
              </button>
            </div>
          )}
        </div>

        <button
          type="button"
          title="Toggle Search Details"
          aria-pressed={showDetails}
          onClick={() => setShowDetails((v) => !v)}
          className={cn(
            "mt-1 flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-accent/60 hover:text-foreground",
            showDetails && "bg-primary/25 text-foreground",
          )}
        >
          <Ellipsis className="size-4" />
        </button>
      </div>

      {showDetails && (
        <div className="flex flex-col gap-1 px-2 pb-2">
          <label className="px-0.5 text-[11px] text-muted-foreground">files to include</label>
          <input
            value={includeGlob}
            onChange={(e) => setIncludeGlob(e.target.value)}
            placeholder="e.g. src/**, *.ts"
            className="rounded border bg-background px-2 py-1 text-xs outline-none placeholder:text-muted-foreground"
          />
          <label className="px-0.5 text-[11px] text-muted-foreground">files to exclude</label>
          <input
            value={excludeGlob}
            onChange={(e) => setExcludeGlob(e.target.value)}
            placeholder="e.g. **/*.test.ts"
            className="rounded border bg-background px-2 py-1 text-xs outline-none placeholder:text-muted-foreground"
          />
        </div>
      )}

      {/* summary */}
      {query && !regexError && hasRoots && (
        <div className="flex items-center gap-1.5 px-3 pb-1 text-[11px] text-muted-foreground">
          {searching && <Loader className="size-3 animate-spin" />}
          {results.length > 0
            ? `${totalMatches} result${totalMatches === 1 ? "" : "s"} in ${results.length} file${results.length === 1 ? "" : "s"}`
            : searching
              ? "Searching…"
              : summary?.error
                ? summary.error
                : "No results found."}
          {summary?.limitHit && <span className="text-yellow-500">· results limited</span>}
        </div>
      )}

      {/* results */}
      <ScrollArea className="flex-1">
        <div className="pb-4">
          {!hasRoots ? (
            <div className="px-3 py-2 text-xs text-muted-foreground">Open a project to search.</div>
          ) : !query ? (
            <div className="px-3 py-2 text-xs text-muted-foreground">
              Search across all files in the workspace.
            </div>
          ) : (
            results.map((f) => {
              const isCollapsed = collapsed.has(f.file);
              const rel = f.root && f.file.startsWith(f.root + "/") ? f.file.slice(f.root.length + 1) : f.file;
              return (
                <div key={f.file}>
                  <div className="group flex items-center gap-1 pr-2 pl-1 hover:bg-accent/40">
                    <button
                      type="button"
                      onClick={() => toggleCollapsed(f.file)}
                      className="flex min-w-0 flex-1 items-center gap-1 py-0.5 text-left"
                    >
                      {isCollapsed ? <ChevronRight className="size-3.5 shrink-0" /> : <ChevronDown className="size-3.5 shrink-0" />}
                      <FileIcon name={baseName(rel)} className="size-3.5 shrink-0" />
                      <span className="truncate text-xs text-foreground">{baseName(rel)}</span>
                      <span className="truncate text-[10px] text-muted-foreground/70">{dirName(rel)}</span>
                    </button>
                    <div className="flex shrink-0 items-center gap-0.5">
                      {showReplace && (
                        <button
                          type="button"
                          title="Replace All in File"
                          onClick={() => doReplaceFile(f.file)}
                          className="hidden size-4 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground group-hover:flex"
                        >
                          <Replace className="size-3" />
                        </button>
                      )}
                      <button
                        type="button"
                        title="Dismiss"
                        onClick={() => dismissFile(f.file)}
                        className="hidden size-4 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground group-hover:flex"
                      >
                        <X className="size-3" />
                      </button>
                      <span className="ml-0.5 inline-flex min-w-4 items-center justify-center rounded-full bg-muted px-1 text-[10px] text-muted-foreground group-hover:hidden">
                        {f.matches.length}
                      </span>
                    </div>
                  </div>

                  {!isCollapsed &&
                    f.matches.map((m, i) => (
                      <div
                        key={`${m.line}:${m.column}:${i}`}
                        className="group/m flex items-center gap-1 py-px pr-2 pl-6 text-xs text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                      >
                        <button
                          type="button"
                          onClick={() => c.openFileAt(f.file, m.line, m.column, m.length)}
                          className="flex min-w-0 flex-1 items-center text-left"
                          title={`${rel}:${m.line}:${m.column}`}
                        >
                          <MatchLine preview={m.preview} column={m.column} length={m.length} />
                        </button>
                        {showReplace && (
                          <button
                            type="button"
                            title="Replace"
                            onClick={() => doReplaceMatch(f.file, m)}
                            className="hidden size-4 shrink-0 items-center justify-center rounded hover:bg-accent group-hover/m:flex"
                          >
                            <Replace className="size-3" />
                          </button>
                        )}
                      </div>
                    ))}
                </div>
              );
            })
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
