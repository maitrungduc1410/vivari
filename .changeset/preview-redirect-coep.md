---
"@vivari/core": patch
"@vivari/react": patch
---

Previews now load on Safari and every iOS browser. The preview Service Worker's first redirect (which takes the routing token off the preview URL) carried no headers, and WebKit refused it inside a cross-origin isolated page ("Redirection was blocked by Cross-Origin-Embedder-Policy"), so the preview stayed blank; it now carries the same COEP/CORP as the preview document.
