import { useEffect, useState } from "react";
import { Vivari, type BootOptions } from "@vivari/core";

export type VivariStatus = "booting" | "ready" | "error";

export interface UseVivariResult {
  /** The booted instance, or `null` until `status === "ready"`. */
  vivari: Vivari | null;
  status: VivariStatus;
  error: Error | null;
}

/**
 * Boot a {@link Vivari} instance for the lifetime of the component.
 *
 * The instance is torn down on unmount. Options are read once, on the first
 * render — change them by remounting (e.g. with a React `key`).
 */
export function useVivari(options?: BootOptions): UseVivariResult {
  const [vivari, setVivari] = useState<Vivari | null>(null);
  const [status, setStatus] = useState<VivariStatus>("booting");
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let cancelled = false;
    let instance: Vivari | null = null;
    setStatus("booting");
    Vivari.boot(options)
      .then((v) => {
        instance = v;
        if (cancelled) {
          v.teardown();
          return;
        }
        setVivari(v);
        setStatus("ready");
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e : new Error(String(e)));
        setStatus("error");
      });
    return () => {
      cancelled = true;
      instance?.teardown();
      setVivari(null);
    };
    // Boot exactly once; option changes require a remount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { vivari, status, error };
}
