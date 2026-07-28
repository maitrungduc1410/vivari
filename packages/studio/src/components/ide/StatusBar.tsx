// VS Code-style status bar.
//
// Left:  the active folder's git branch (when it is a repo) + live TS/JS
//        diagnostics from the language-service worker.
// Right: the active editor's cursor position, indentation and language mode.
//        Each opens a quick pick (see StatusBarPickers).
//
// The right-hand readouts come from `c.editorStatus`, a store of their own, so a
// cursor move doesn't re-render every useIde() consumer in the IDE.

import { useState, useSyncExternalStore } from "react";
import CircleX from "~icons/lucide/circle-x";
import TriangleAlert from "~icons/lucide/triangle-alert";
import GitBranch from "~icons/lucide/git-branch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { languageLabel } from "@/vv/controller";
import { StatusBarPickers, type StatusPicker } from "./StatusBarPickers";
import { useIde } from "./useIde";

export function StatusBar() {
  const { c, snap } = useIde();
  const { errors, warnings } = snap.problems;
  const scm = useSyncExternalStore(c.scm.subscribe, c.scm.getSnapshot);
  const editor = useSyncExternalStore(c.editorStatus.subscribe, c.editorStatus.getSnapshot);
  const [picker, setPicker] = useState<StatusPicker>(null);

  // VS Code shows one repository at a time: the one owning the active file, else
  // the focused workspace folder, else the only repo there is.
  const repos = scm.repos.filter((r) => r.isRepo);
  const activeRoot = snap.workspaceFolders.find((f) => f.id === snap.activeFolderId)?.rootPath;
  const repo =
    (snap.activeTab
      ? repos.find((r) => snap.activeTab === r.root || snap.activeTab?.startsWith(r.root + "/"))
      : undefined) ??
    repos.find((r) => r.root === activeRoot) ??
    (repos.length === 1 ? repos[0] : undefined);
  const branch = repo ? (repo.currentBranch ?? "(detached)") : null;

  const { cursor, indent, language } = editor;

  return (
    <>
      <div className="flex h-6 shrink-0 items-center bg-[#007acc] px-1 text-xs text-white">
        {branch && (
          <StatusItem label="Current branch" onClick={() => c.setActiveView("scm")}>
            <GitBranch className="size-3.5" />
            <span className="max-w-40 truncate">{branch}</span>
          </StatusItem>
        )}
        {/* Live TS/JS diagnostics from the language-service worker. Not clickable:
            there's no Problems panel to open (markers surface in the editor). */}
        <StatusItem
          label={`${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}`}
        >
          <CircleX className="size-3.5" />
          {errors}
          <TriangleAlert className="ml-1 size-3.5" />
          {warnings}
        </StatusItem>

        <span className="flex-1" />

        {cursor && (
          <StatusItem label="Go to Line/Column" onClick={() => setPicker("goto")}>
            Ln {cursor.line}, Col {cursor.column}
            {cursor.selections > 1
              ? ` (${cursor.selections} selections)`
              : cursor.selected > 0 && ` (${cursor.selected} selected)`}
          </StatusItem>
        )}
        {indent && (
          <StatusItem label="Select Indentation" onClick={() => setPicker("indent")}>
            {indent.insertSpaces ? "Spaces" : "Tab Size"}: {indent.tabSize}
          </StatusItem>
        )}
        {language && (
          <StatusItem label="Select Language Mode" onClick={() => setPicker("language")}>
            {languageLabel(language)}
          </StatusItem>
        )}
      </div>
      <StatusBarPickers open={picker} onClose={() => setPicker(null)} />
    </>
  );
}

/** One status-bar cell. With `onClick` it's a button carrying VS Code's hover
 * highlight; without one it's a plain readout. */
function StatusItem({
  label, onClick, children,
}: {
  label: string; onClick?: () => void; children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={onClick ? undefined : <span />}
        onClick={onClick}
        className={cn(
          "flex h-6 items-center gap-1 whitespace-nowrap px-2",
          onClick && "transition-colors hover:bg-white/20",
        )}
      >
        {children}
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  );
}