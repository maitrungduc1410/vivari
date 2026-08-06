// The kernel program is plain JavaScript so scripts/spike-notebook.mjs can run the
// exact bytes the studio ships under a real CPython; `allowJs` is off here, so tsc
// needs this to resolve the module.

/** The Python program that executes cells. Written into the VM and run as
 *  `python <NB_KERNEL_PATH>`. */
export declare const NB_KERNEL_PY: string;
/** Where it is written in the VM — outside any project, so it never appears in
 *  the Explorer or in a user's git status. */
export declare const NB_KERNEL_PATH: string;
