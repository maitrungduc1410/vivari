// @vivari/react — React bindings for the Vivari WebContainer SDK.
//
//   import { Vivari } from "@vivari/react";
//
//   <Vivari
//     files={{ "index.js": { file: { contents: "…" } } }}
//     run="npm run dev"
//     style={{ width: "100%", height: 480, border: 0 }}
//   />
//
// Or drive it yourself with the hook:
//
//   const { vivari, status } = useVivari();

export { Vivari } from "./Vivari";
export type { VivariProps, VivariStatus } from "./Vivari";
export { useVivari } from "./useVivari";
export type { UseVivariResult } from "./useVivari";

// Re-export the core types consumers commonly need at the call site.
export type {
  BootOptions,
  FileSystemTree,
  SpawnOptions,
  Vivari as VivariInstance,
} from "@vivari/core";
