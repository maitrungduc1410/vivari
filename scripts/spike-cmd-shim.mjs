// Spike (OFFLINE): unit-test the pnpm/cmd-shim bin unwrap parser.
//
// pnpm installs a package's bin as a `#!/bin/sh` cmd-shim (an `exec node
// "<…>/foo.js" "$@"` wrapper) instead of the POSIX symlink-to-the-.js that npm
// uses. Our synchronous loader can't run shell, so runMain() unwraps the shim to
// the .js it execs (packages/runtime/module.js `resolveCmdShim` →
// `parseShellShimTarget`). Regression guard for the "SyntaxError: missing )
// after argument list" crash when the shim was (wrongly) compiled as JavaScript.
//
//   run:  node scripts/spike-cmd-shim.mjs   (pure — no kernel, no network)
import { parseShellShimTarget } from "../packages/runtime/module.js";

let pass = 0;
let fail = 0;
function check(label, got, want) {
  const ok = got === want;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}  ->  ${JSON.stringify(got)}`);
  if (ok) pass++;
  else {
    fail++;
    console.log(`       expected ${JSON.stringify(want)}`);
  }
}

// The exact POSIX shim pnpm v9 writes for a bin (two exec branches, $basedir).
const PNPM_VITE_SHIM = `#!/bin/sh
basedir=$(dirname "$(echo "$0" | sed -e 's,\\\\,/,g')")

case \`uname\` in
    *CYGWIN*) basedir=\`cygpath -w "$basedir"\`;;
esac

if [ -x "$basedir/node" ]; then
  exec "$basedir/node"  "$basedir/../vite/bin/vite.js" "$@"
else
  exec node  "$basedir/../vite/bin/vite.js" "$@"
fi
`;

console.log("── parseShellShimTarget ──");
// pnpm's real shim → the wrapped vite.js (with $basedir still un-expanded).
check("pnpm vite shim", parseShellShimTarget(PNPM_VITE_SHIM), "$basedir/../vite/bin/vite.js");
// .cjs / .mjs targets are unwrapped too.
check(
  "bare exec node target.cjs",
  parseShellShimTarget("#!/bin/sh\nexec node  \"$basedir/../foo/bin/cli.cjs\" \"$@\"\n"),
  "$basedir/../foo/bin/cli.cjs",
);
check(
  "bash wrapper .mjs",
  parseShellShimTarget("#!/usr/bin/env bash\nexec node \"$basedir/x.mjs\" \"$@\"\n"),
  "$basedir/x.mjs",
);
// A real node bin is NOT a shim — leave it for the JS compiler.
check("node env bin", parseShellShimTarget("#!/usr/bin/env node\nconsole.log(1)\n"), null);
check("node abs bin", parseShellShimTarget("#!/usr/local/bin/node\nrequire('x')\n"), null);
// Non-shebang / non-shell / no .js target → null.
check("no shebang", parseShellShimTarget("exec node foo.js\n"), null);
check("python shebang", parseShellShimTarget("#!/usr/bin/python\nprint(1)\n"), null);
check("shell but no js target", parseShellShimTarget("#!/bin/sh\necho hello\n"), null);
check("non-string", parseShellShimTarget(null), null);

const ok = fail === 0;
console.log(`\nRESULT: ${ok ? `PASS — ${pass} cases` : `FAIL — ${fail}/${pass + fail} cases`}`);
process.exit(ok ? 0 : 1);
