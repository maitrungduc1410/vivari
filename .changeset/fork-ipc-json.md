---
"@vivari/core": patch
---

`child_process.fork` messages now travel as JSON, as Node's default `serialization: 'json'` does, and as structured clone with `'advanced'`. Sending used to structured-clone every message, which throws on a Proxy, and `send()` swallowed the throw: Nuxt's CLI sends its citty args (a Proxy) to the fork it hard-restarts into, and that fork waited for them forever, so `nuxt dev`'s `r` hung at "Restarting Nuxt in a new process...". A message JSON cannot encode (a BigInt) now throws out of `send()`, as in Node, instead of being dropped.
