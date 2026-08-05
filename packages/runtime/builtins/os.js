// A stubbed `os` module. Values are plausible constants — enough to satisfy the
// libraries that sniff the environment (StackBlitz does the same).
//
// `constants` is the exception: it is not plausible-looking, it is the host's real
// table (see node/bindings/constants.js), because these are read as numbers and
// used in bitmasks and kill(2) arguments. It used to be three empty objects, so
// `os.constants.signals.SIGKILL` was `undefined` — and `undefined` reaches kill()
// as a signal nobody sent.

import { OS_SIGNALS, OS_ERRNO, OS_PRIORITY, OS_DLOPEN, UV_UDP_REUSEADDR } from "../node/bindings/constants.js";

export function createOs() {
  return {
    EOL: "\n",
    platform: () => "linux",
    arch: () => "wasm32",
    type: () => "Linux",
    release: () => "6.0.0-vivari",
    version: () => "#1 Vivari",
    hostname: () => "vivari",
    homedir: () => "/home/user",
    tmpdir: () => "/tmp",
    cpus: () => [
      {
        model: "Vivari VCPU",
        speed: 0,
        times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 },
      },
    ],
    // Modern tools (npm/pnpm/pacote) size their worker pools with this; a missing
    // function throws. Report the host's concurrency when available, else 1.
    availableParallelism: () => Math.max(1, globalThis.navigator?.hardwareConcurrency | 0 || 1),
    totalmem: () => 1024 * 1024 * 1024,
    freemem: () => 512 * 1024 * 1024,
    uptime: () => 0,
    loadavg: () => [0, 0, 0],
    endianness: () => "LE",
    networkInterfaces: () => ({}),
    userInfo: () => ({
      username: "user",
      uid: 1000,
      gid: 1000,
      shell: "/bin/sh",
      homedir: "/home/user",
    }),
    constants: {
      UV_UDP_REUSEADDR,
      dlopen: OS_DLOPEN,
      errno: OS_ERRNO,
      signals: OS_SIGNALS,
      priority: OS_PRIORITY,
    },
  };
}
