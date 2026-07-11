// A stubbed `os` module. Values are plausible constants — enough to satisfy the
// libraries that sniff the environment (StackBlitz does the same).

export function createOs() {
  return {
    EOL: "\n",
    platform: () => "linux",
    arch: () => "wasm32",
    type: () => "Linux",
    release: () => "6.0.0-opencontainer",
    version: () => "#1 OpenContainer",
    hostname: () => "opencontainer",
    homedir: () => "/home/user",
    tmpdir: () => "/tmp",
    cpus: () => [
      {
        model: "OpenContainer VCPU",
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
    constants: { signals: {}, errno: {}, priority: {} },
  };
}
