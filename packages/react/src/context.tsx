"use client";

// Share one booted instance across a React tree.
//
// Without this every consumer has to smuggle the instance out of <Vivari> via an
// `onReady` callback into a ref — which gives it no reactive access to status at
// all. Studio hit the same need and built the same shape (a provider plus a
// `useController()` that throws outside it): see
// packages/studio/src/components/ide/{IdeProvider.tsx,useIde.ts}.

import { createContext, useContext, type ReactNode } from "react";
import type { Vivari as VivariInstance } from "@vivari/core";
import { useVivari, type UseVivariOptions, type UseVivariResult } from "./useVivari";

const VivariContext = createContext<UseVivariResult | null>(null);

export interface VivariProviderProps extends UseVivariOptions {
  children?: ReactNode;
}

/**
 * Boot an instance and publish it to the subtree. Renders no DOM of its own.
 *
 *   <VivariProvider compress={false}>
 *     <Editor />
 *     <VivariPreview port={5173} />
 *   </VivariProvider>
 */
export function VivariProvider({ children, ...options }: VivariProviderProps) {
  // useVivari already memoises its result, so the context value is stable and a
  // provider re-render does not cascade into every consumer.
  const state = useVivari(options);
  return <VivariContext.Provider value={state}>{children}</VivariContext.Provider>;
}

/** Read the nearest provider's state. Throws when there isn't one. */
export function useVivariContext(): UseVivariResult;
/** Read the nearest provider's state, or `null` when there isn't one. */
export function useVivariContext(options: { optional: true }): UseVivariResult | null;
export function useVivariContext(options?: { optional?: boolean }): UseVivariResult | null {
  const ctx = useContext(VivariContext);
  if (!ctx && !options?.optional) {
    throw new Error("useVivariContext() must be used inside a <VivariProvider>.");
  }
  return ctx;
}

/**
 * Resolve the instance a hook should act on: an explicitly passed one, else the
 * nearest provider's. Returns `null` until the VM is ready, so hooks can always
 * be called unconditionally and simply idle until there is something to act on.
 */
export function useVivariInstance(explicit?: VivariInstance | null): VivariInstance | null {
  const ctx = useVivariContext({ optional: true });
  return explicit ?? ctx?.vivari ?? null;
}