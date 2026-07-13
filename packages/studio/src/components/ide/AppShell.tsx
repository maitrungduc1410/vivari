import { useEffect } from "react";
import {
  ResizableHandle, ResizablePanel, ResizablePanelGroup,
} from "@/components/ui/resizable";
import { TitleBar } from "./TitleBar";
import { ActivityBar } from "./ActivityBar";
import { Explorer } from "./Explorer";
import { SearchPane } from "./SearchPane";
import { EditorGroup } from "./EditorGroup";
import { TerminalPanel } from "./TerminalPanel";
import { PreviewPanel } from "./PreviewPanel";
import { StatusBar } from "./StatusBar";
import { CommandPalette } from "./CommandPalette";
import { HomeView } from "./Home";
import { useIde } from "./useIde";

export function AppShell() {
  const { c, snap } = useIde();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      if (e.shiftKey && k === "p") {
        e.preventDefault();
        c.openPalette("command");
      } else if (k === "p") {
        e.preventDefault();
        c.openPalette("file");
      } else if (k === "`") {
        e.preventDefault();
        c.togglePanel();
      } else if (k === "b") {
        e.preventDefault();
        c.toggleSidebar();
      } else if (k === "j") {
        e.preventDefault();
        c.togglePanel();
      } else if (k === "s") {
        e.preventDefault();
        c.saveActiveFile();
      } else if (e.shiftKey && k === "c") {
        e.preventDefault();
        c.newShellTerminal();
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [c]);

  // Guard the browser tab close (⌘W / ⌃W): browsers reserve that shortcut, so we
  // can't repurpose it to close an editor tab — instead warn before the whole
  // session (VFS + running dev server) is torn down. Only nag once a project is
  // live or there are unsaved edits.
  useEffect(() => {
    const shouldWarn = snap.projectTitle != null || snap.dirty.length > 0;
    if (!shouldWarn) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    addEventListener("beforeunload", onBeforeUnload);
    return () => removeEventListener("beforeunload", onBeforeUnload);
  }, [snap.projectTitle, snap.dirty.length]);

  return (
    <div className="flex h-full w-full flex-col overflow-hidden text-foreground">
      <TitleBar />
      <div className="flex min-h-0 flex-1">
        <ActivityBar />
        <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
          {!snap.sidebarCollapsed && (
            <>
              <ResizablePanel id="explorer" defaultSize="16%" minSize="10%" maxSize="30%">
                {snap.activeView === "search" ? <SearchPane /> : <Explorer />}
              </ResizablePanel>
              <ResizableHandle />
            </>
          )}
          <ResizablePanel id="center" defaultSize="52%" minSize="25%">
            <ResizablePanelGroup orientation="vertical">
              <ResizablePanel id="editor" defaultSize="65%" minSize="20%">
                <EditorGroup />
              </ResizablePanel>
              {!snap.panelCollapsed && (
                <>
                  <ResizableHandle />
                  <ResizablePanel id="terminal" defaultSize="35%" minSize="10%">
                    <TerminalPanel />
                  </ResizablePanel>
                </>
              )}
            </ResizablePanelGroup>
          </ResizablePanel>
          <ResizableHandle />
          <ResizablePanel id="preview" defaultSize="32%">
            <PreviewPanel />
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
      <StatusBar />
      <CommandPalette />
      {/* Home overlays the (kept-mounted) IDE so the editor/terminals survive a
          round-trip to Home and back. */}
      {snap.view === "home" && <HomeView />}
    </div>
  );
}
