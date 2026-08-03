// The language service is plain JavaScript so the offline spike tier can drive
// the exact code the studio ships — Monaco is a parameter of
// registerPythonLanguage rather than an import, precisely so it can. `allowJs` is
// off in the studio, so tsc needs this to resolve the module.
//
// Only the exports the studio imports are declared. The rest are reached from
// .mjs spikes, which need no declarations; add one here when TypeScript starts
// importing it, since a .d.ts replaces the module's inferred types entirely.
// The real shapes live in packages/studio/src/vv/python-language.ts, the typed
// door onto this file.

export declare function registerPythonLanguage(monaco: unknown, host: unknown): unknown;

/** Status-bar text for a service state, or null when there is nothing to say. */
export declare function stateLabel(state: string, detail?: string): string | null;