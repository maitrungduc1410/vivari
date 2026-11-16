---
"@vivari/core": patch
---

A vendor manifest whose body is cut off mid-transfer is now reported as a transient, dim line instead of a red "this build was assembled without it" error that names a build command. Only a body that arrives and fails to parse (an SPA fallback page, for example) is still reported as a build defect.
