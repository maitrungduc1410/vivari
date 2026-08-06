import { useEffect } from "react";
import { useTheme } from "next-themes";
import {
  ResizableHandle, ResizablePanel, ResizablePanelGroup,
} from "@/components/ui/resizable";
import { TitleBar } from "./TitleBar";
import { ActivityBar } from "./ActivityBar";
import { Explorer } from "./Explorer";
import { SearchPane } from "./SearchPane";
import { DebugPanel } from "./DebugPanel";
import { SourceControlPanel } from "./SourceControlPanel";
import { EditorGroup } from "./EditorGroup";
import { TerminalPanel } from "./TerminalPanel";
import { PreviewPanel } from "./PreviewPanel";
import { StatusBar } from "./StatusBar";
import { CommandPalette } from "./CommandPalette";
import { HomeView } from "./Home";
import { ShareLoadingOverlay } from "./ShareLoadingOverlay";
import { ImportRemoteDialog } from "./ImportRemoteDialog";
import { useIde } from "./useIde";
import { isWordWrapChord } from "@/vv/editor-prefs";

export function AppShell() {
  const { c, snap } = useIde();
  const { resolvedTheme } = useTheme();

  // Mirror next-themes' resolved theme onto the editor + terminals, which manage
  // their own (non-CSS) theming.
  useEffect(() => {
    if (resolvedTheme === "light" || resolvedTheme === "dark") {
      c.applyUiTheme(resolvedTheme);
    }
  }, [c, resolvedTheme]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Alt+Z / ⌥Z, ABOVE the ⌘/Ctrl gate below, because it is the one binding here
      // with no ⌘/Ctrl in it. Monaco embedded on its own has no such keybinding — Alt+Z
      // is VS Code's, a layer this app does not have — so there is nothing to inherit
      // and the shortcut has to be declared here.
      //
      // NOT with editor.addCommand: that would only fire while the editor has focus,
      // and VS Code's is global. One window listener also covers the diff editor for
      // free, and keeps the matching in one place rather than depending on how Monaco
      // resolves an Option chord on a macOS layout.
      //
      // preventDefault matters on macOS even outside the editor: ⌥Z composes "Ω", and
      // an editor with focus would otherwise type it into the file.
      if (isWordWrapChord(e)) {
        // …but not while a terminal has focus, because the key belongs to whatever the
        // cursor is in and word wrap does nothing to a terminal. What it means there
        // differs by platform: on Windows and Linux Alt+<key> is the meta prefix
        // readline reads as ESC z, which is genuinely the shell's; on macOS it is NOT,
        // since xterm defaults macOptionIsMeta to false and makeTerm does not change
        // it, so the shell just receives the composed "Ω". That second case is how
        // every Option chord has always behaved here and is not this shortcut's to
        // fix — but neither is it a reason to take the key. The palette entry reaches
        // word wrap from a terminal. Mirror of the terminal's own ⌘K, which is scoped
        // to the focused xterm so it never clobbers the editor (see makeTerm).
        if (document.activeElement?.closest(".vv-term-host")) return;
        e.preventDefault();
        c.toggleWordWrap();
        return;
      }
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      if (e.shiftKey && k === "e") {
        e.preventDefault();
        c.setActiveView("explorer");
      } else if (e.shiftKey && k === "f") {
        e.preventDefault();
        c.setActiveView("search");
      } else if (e.shiftKey && k === "g") {
        e.preventDefault();
        c.setActiveView("scm");
      } else if (e.shiftKey && k === "p") {
        e.preventDefault();
        c.openPalette("command");
      } else if (k === "p") {
        e.preventDefault();
        c.openPalette("file");
      } else if (k === "`") {
        e.preventDefault();
        c.togglePanel();
      } else if (e.altKey && (k === "b" || e.code === "KeyB")) {
        // VS Code's secondary side bar shortcut, mapped to the preview. Matched on
        // `code` as well as `key` because holding Option on macOS can compose the
        // character (⌥B → "∫"), which would otherwise miss and fall through to the
        // plain ⌘B branch below and toggle the wrong panel.
        e.preventDefault();
        c.togglePreview();
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
                {snap.activeView === "search" ? (
                  <SearchPane />
                ) : snap.activeView === "debug" ? (
                  <DebugPanel />
                ) : snap.activeView === "scm" ? (
                  <SourceControlPanel />
                ) : (
                  <Explorer />
                )}
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
          {!snap.previewCollapsed && (
            <>
              <ResizableHandle />
              <ResizablePanel id="preview" defaultSize="32%">
                <PreviewPanel />
              </ResizablePanel>
            </>
          )}
        </ResizablePanelGroup>
      </div>
      <StatusBar />
      <CommandPalette />
      <ImportRemoteDialog />
      {/* Home overlays the (kept-mounted) IDE so the editor/terminals survive a
          round-trip to Home and back. */}
      {snap.view === "home" && <HomeView />}
      {/* Full-screen blocking spinner while a shared link bootstraps (over the
          workspace, since a #share= link never lands on Home). */}
      {snap.shareLoading && <ShareLoadingOverlay />}
    </div>
  );
}