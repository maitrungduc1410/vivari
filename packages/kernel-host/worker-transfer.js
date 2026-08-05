// What a Process Worker's `init` message must TRANSFER rather than clone.
//
// Every environment that can host processes builds that message itself — the browser
// kernel worker, the headless spike harness, and the standalone spikes that predate
// it — because each opens its own MessageChannel to its File System Worker. What
// they must not each decide for themselves is the transfer list, and for a long time
// they did: the browser path handled ports embedded in `workerData`, and the
// harnesses transferred only the fs port and the thread's parentPort.
//
// The gap is invisible until something puts a MessagePort in `workerData`, which is
// exactly what a worker POOL does — tinypool (vitest), piscina, synckit's
// createSyncFn. Then `postMessage` throws DataCloneError ("Object that needs
// transfer was found in message but not listed in transferList") inside the HOST,
// where the guest cannot catch it: vitepress died there, and vitest quietly exited 0
// having run no tests, because the pool's handshake never completed and its loop had
// nothing left to wait on.
//
// One function decides, so there is one answer to be right.

// MessagePort(s) embedded anywhere in a spawned thread's workerData. A port cannot be
// cloned, so each one has to be named in the transfer list. Bounded by a depth cap
// and a visited set: workerData is user data and may be cyclic or huge.
export function collectWorkerDataPorts(workerData) {
  const MP = globalThis.MessagePort;
  const out = [];
  if (!MP) return out;
  const seen = new Set();
  const visited = new WeakSet();
  const scan = (v, depth) => {
    if (!v || typeof v !== "object" || depth > 6) return;
    if (v instanceof MP) {
      if (!seen.has(v)) {
        seen.add(v);
        out.push(v);
      }
      return;
    }
    if (visited.has(v)) return;
    visited.add(v);
    if (Array.isArray(v)) {
      for (const x of v) scan(x, depth + 1);
      return;
    }
    for (const k of Object.keys(v)) {
      let child;
      try {
        child = v[k];
      } catch {
        // A throwing getter is the caller's problem, not a reason to fail the spawn.
        continue;
      }
      scan(child, depth + 1);
    }
  };
  scan(workerData, 0);
  return out;
}

// The complete transfer list for a process worker's `init`: the fs doorbell, the
// parentPort of a spawned thread, and any ports its creator embedded in workerData.
// SharedArrayBuffers are absent on purpose — they are shared by reference and ride
// along in the payload; transferring one would be an error.
export function initTransferList(info, fsPort) {
  const transfer = [fsPort];
  if (info && info.threadPort) transfer.push(info.threadPort);
  for (const p of collectWorkerDataPorts(info && info.spec && info.spec.workerData)) {
    transfer.push(p);
  }
  return transfer;
}
