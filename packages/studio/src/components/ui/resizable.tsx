"use client"

import * as ResizablePrimitive from "react-resizable-panels"

import { cn } from "@/lib/utils"

function ResizablePanelGroup({
  className,
  ...props
}: ResizablePrimitive.GroupProps) {
  return (
    <ResizablePrimitive.Group
      data-slot="resizable-panel-group"
      className={cn(
        "flex h-full w-full aria-[orientation=vertical]:flex-col",
        className
      )}
      {...props}
    />
  )
}

function ResizablePanel({ ...props }: ResizablePrimitive.PanelProps) {
  return <ResizablePrimitive.Panel data-slot="resizable-panel" {...props} />
}

function ResizableHandle({
  withHandle,
  className,
  ...props
}: ResizablePrimitive.SeparatorProps & {
  withHandle?: boolean
}) {
  return (
    <ResizablePrimitive.Separator
      data-slot="resizable-handle"
      className={cn(
        // The VS Code-blue hover/drag highlight lives in index.css, keyed off the
        // library's data-separator=inactive|hover|active state.
        // A vertical separator splits panels left/right, so it drags horizontally
        // (col-resize); a horizontal one drags vertically (row-resize).
        // `z-10` is what makes the 4px `after:` grab strip actually grabbable. The
        // separator is a 1px sibling of the panels, so at `z-index: auto` the next
        // panel's own stacking content (Monaco's margin overlays, the preview's
        // inset-0 layer) paints over the outer half of the strip and eats the
        // pointer: only 3 of the 4px hit-tested to the handle, all on one side.
        // Must stay under the ScrollArea scrollbar's z-30 and the z-40/z-50 overlays.
        "relative z-10 flex w-px cursor-col-resize items-center justify-center bg-border ring-offset-background aria-[orientation=horizontal]:cursor-row-resize after:absolute after:inset-y-0 after:left-1/2 after:w-1 after:-translate-x-1/2 focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden aria-[orientation=horizontal]:h-px aria-[orientation=horizontal]:w-full aria-[orientation=horizontal]:after:left-0 aria-[orientation=horizontal]:after:h-1 aria-[orientation=horizontal]:after:w-full aria-[orientation=horizontal]:after:translate-x-0 aria-[orientation=horizontal]:after:-translate-y-1/2 [&[aria-orientation=horizontal]>div]:rotate-90",
        className
      )}
      {...props}
    >
      {withHandle && (
        <div className="z-10 flex h-6 w-1 shrink-0 rounded-lg bg-border" />
      )}
    </ResizablePrimitive.Separator>
  )
}

export { ResizableHandle, ResizablePanel, ResizablePanelGroup }