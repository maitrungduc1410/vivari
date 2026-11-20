---
"@vivari/core": patch
---

A preview's error page shows in the preview frame. The Service Worker drops `X-Frame-Options` and CSP's `frame-ancestors` (keeping the rest of the policy) from preview responses: Nitro's error handler, which Nuxt's uses, sends `DENY` on every error page, so an app's 500 rendered as the browser's "refused to connect" in the IDE's frame, while the same URL in its own tab showed the error.
