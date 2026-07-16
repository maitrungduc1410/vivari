import { createContext, useContext, useSyncExternalStore } from "react";
import { IdeController, type IdeSnapshot } from "@/vv/controller";

// One kernel worker per page → one controller. A module-level singleton keeps
// React StrictMode's double-mount from spawning a second kernel worker.
let singleton: IdeController | null = null;
export function getController(): IdeController {
  return (singleton ??= new IdeController());
}

export const IdeContext = createContext<IdeController | null>(null);

export function useController(): IdeController {
  const c = useContext(IdeContext);
  if (!c) throw new Error("useController must be used within <IdeProvider>");
  return c;
}

/** Subscribe to the controller's immutable UI snapshot. */
export function useIde(): { c: IdeController; snap: IdeSnapshot } {
  const c = useController();
  const snap = useSyncExternalStore(c.subscribe, c.getSnapshot);
  return { c, snap };
}
