// How a command-line filter selects a spike. One line, and it lives here because
// TWO files have to agree on it: scripts/run-spikes.mjs, which does the selecting,
// and scripts/spike-ci-tiers.mjs, which checks that ci.yml's filters still name
// something. If those two ever disagree, the gate stops modelling the runner while
// still reporting green — the exact failure spike-ci-tiers.mjs exists to prevent.
//
// A module of its own rather than an export from run-spikes.mjs, because that file
// RUNS the spikes on import (top-level await over the selection), which is also why
// spike-ci-tiers.mjs parses the registry instead of importing it. And not in
// lib/spike-harness.mjs either: gate 1 of spike-ci-tiers.mjs scopes on the harness
// import, and that file names npmInstall(), bootSpikeKernel({ npm: true }) and
// loadRealNpm() in its own assertion strings — so taking a string helper from the
// harness would make ci-tiers fail its own gate on all three counts. This file
// imports nothing, so either side can take it for free.

/**
 * Match a spike name against one filter argument.
 *
 * Substring by default, deliberately: `bun` is how the verify job also re-runs
 * bun-offline and bun-templates. A trailing `$` anchors the filter to the whole
 * name, which is the one thing a substring cannot say — a bare `lit` is also
 * sqlite and pglite.
 */
export const matchesFilter = (name, f) => (f.endsWith("$") ? name === f.slice(0, -1) : name.includes(f));