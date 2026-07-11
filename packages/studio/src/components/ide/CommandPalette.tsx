import { useMemo } from "react";
import {
  Plus, Play, TerminalIcon, PanelLeft, Eraser, RefreshCw, RotateCcw, FileCode,
} from "lucide-react";
import {
  CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
} from "@/components/ui/command";
import { useIde } from "./useIde";

const baseName = (rel: string) => rel.split("/").pop() ?? rel;

export function CommandPalette() {
  const { c, snap } = useIde();

  const commands = useMemo(
    () => [
      { label: "New Terminal", icon: Plus, run: () => c.newShellTerminal() },
      { label: "Run Project", icon: Play, run: () => c.runDemo() },
      { label: "Toggle Terminal Panel", icon: TerminalIcon, run: () => c.togglePanel() },
      { label: "Toggle Sidebar", icon: PanelLeft, run: () => c.toggleSidebar() },
      { label: "Clear Active Terminal", icon: Eraser, run: () => c.clearActiveTerminal() },
      { label: "Reload Preview", icon: RefreshCw, run: () => c.reloadPreview() },
      { label: "Reset & Reload (wipe VFS)", icon: RotateCcw, run: () => c.resetAndReload() },
    ],
    [c],
  );

  const run = (fn: () => void) => {
    c.closePalette();
    fn();
  };

  return (
    <CommandDialog open={snap.paletteOpen} onOpenChange={(o) => (o ? undefined : c.closePalette())}>
      <CommandInput
        placeholder={snap.paletteMode === "command" ? "Type a command…" : "Search files…"}
      />
      <CommandList>
        <CommandEmpty>No results.</CommandEmpty>
        {snap.paletteMode === "command" ? (
          <CommandGroup heading="Commands">
            {commands.map((cmd) => (
              <CommandItem key={cmd.label} value={cmd.label} onSelect={() => run(cmd.run)}>
                <cmd.icon /> {cmd.label}
              </CommandItem>
            ))}
          </CommandGroup>
        ) : (
          <CommandGroup heading="Files">
            {snap.files.map((rel) => (
              <CommandItem key={rel} value={rel} onSelect={() => run(() => c.openFile(rel))}>
                <FileCode /> <span>{baseName(rel)}</span>
                <span className="ml-auto text-xs text-muted-foreground">{rel}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  );
}
