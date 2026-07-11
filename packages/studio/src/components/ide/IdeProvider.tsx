import { useEffect, type ReactNode } from "react";
import { IdeContext, getController } from "./useIde";

export function IdeProvider({ children }: { children: ReactNode }) {
  const controller = getController();
  useEffect(() => {
    controller.start();
    // Dev-only handle for debugging + headless parity tests.
    if (import.meta.env.DEV) (window as unknown as { __ide: unknown }).__ide = controller;
  }, [controller]);
  return <IdeContext.Provider value={controller}>{children}</IdeContext.Provider>;
}
