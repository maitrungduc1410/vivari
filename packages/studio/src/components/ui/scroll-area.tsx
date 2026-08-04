import { ScrollArea as ScrollAreaPrimitive } from "@base-ui/react/scroll-area"

import { cn } from "@/lib/utils"

function ScrollArea({
  className,
  children,
  ...props
}: ScrollAreaPrimitive.Root.Props) {
  return (
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      className={cn("relative", className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        // This `data-slot` is the one that is load-bearing at RUNTIME, not just a styling
        // hook: the Explorer's `revealRow` finds the scrollport by it to set
        // `scroll-padding-top`. Rename it and that lookup silently stops matching — no
        // error, no build failure, and rows revealed behind the sticky headers again.
        data-slot="scroll-area-viewport"
        className="size-full rounded-[inherit] transition-[color,box-shadow] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1"
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar />
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  )
}

function ScrollBar({
  className,
  orientation = "vertical",
  ...props
}: ScrollAreaPrimitive.Scrollbar.Props) {
  return (
    <ScrollAreaPrimitive.Scrollbar
      data-slot="scroll-area-scrollbar"
      data-orientation={orientation}
      orientation={orientation}
      className={cn(
        // `z-30` keeps the scrollbar above the content it scrolls. `Root` is
        // `position: relative; z-index: auto`, so it is NOT a stacking context, and the
        // scrollbar is `position: absolute; z-index: auto` — so any positioned child of
        // the viewport that carries a z-index (the Explorer's `sticky` tree rows) paints
        // over the scrollbar AND takes the pointer events meant for the thumb. Sits
        // above those rows but below the app's z-40/z-50 overlays (Home, menus, dialogs).
        "z-30 flex touch-none p-px transition-colors select-none data-horizontal:h-2.5 data-horizontal:flex-col data-horizontal:border-t data-horizontal:border-t-transparent data-vertical:h-full data-vertical:w-2.5 data-vertical:border-l data-vertical:border-l-transparent",
        className
      )}
      {...props}
    >
      <ScrollAreaPrimitive.Thumb
        data-slot="scroll-area-thumb"
        className="relative flex-1 rounded-full bg-border"
      />
    </ScrollAreaPrimitive.Scrollbar>
  )
}

export { ScrollArea, ScrollBar }