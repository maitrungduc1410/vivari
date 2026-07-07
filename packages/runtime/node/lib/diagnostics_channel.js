// diagnostics_channel — minimal stub (Phase 2 #7).
//
// net.js publishes connection lifecycle events to named channels. With no
// subscribers the publish paths are inert, so we provide channels that report
// no subscribers and tracing channels that just run the wrapped work.
export default function (exports, require, module, process, internalBinding, primordials) {
  "use strict";

  class Channel {
    constructor(name) {
      this.name = name;
    }
    get hasSubscribers() {
      return false;
    }
    publish() {}
    subscribe() {}
    unsubscribe() {
      return false;
    }
    bindStore() {}
    unbindStore() {}
    runStores(ctx, fn, thisArg, ...args) {
      return fn.apply(thisArg, args);
    }
  }

  const channels = new Map();
  const channel = (name) => {
    let c = channels.get(name);
    if (!c) {
      c = new Channel(name);
      channels.set(name, c);
    }
    return c;
  };

  const tracingChannel = (nameOrChannels) => {
    const run = (ctx, fn, thisArg, ...args) => fn.apply(thisArg, args);
    return {
      subscribe() {},
      unsubscribe() {
        return false;
      },
      hasSubscribers: false,
      start: channel("start"),
      end: channel("end"),
      asyncStart: channel("asyncStart"),
      asyncEnd: channel("asyncEnd"),
      error: channel("error"),
      traceSync(fn, ctx, thisArg, ...args) {
        return fn.apply(thisArg, args);
      },
      traceCallback(fn, position, ctx, thisArg, ...args) {
        return fn.apply(thisArg, args);
      },
      tracePromise(fn, ctx, thisArg, ...args) {
        return fn.apply(thisArg, args);
      },
    };
  };

  module.exports = {
    Channel,
    channel,
    hasSubscribers: () => false,
    subscribe: () => {},
    unsubscribe: () => false,
    tracingChannel,
  };
}
