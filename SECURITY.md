# Security Policy

## Supported versions

Vivari is pre-1.0 and under active development. Security fixes are applied to the
latest published release of `@vivari/core` and `@vivari/react` and to `master`.

| Version | Supported |
| --- | --- |
| latest `0.x` | :white_check_mark: |
| older `0.x` | :x: |

## Reporting a vulnerability

Please **do not** open a public issue for security vulnerabilities.

Instead, report privately by either:

- Using GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
  ("Report a vulnerability" on the repository's **Security** tab), or
- Emailing **maitrungduc1410@gmail.com** with the details.

Please include:

- A description of the issue and its impact.
- Steps to reproduce (a minimal proof-of-concept if possible).
- Affected package/version and environment.

You can expect an acknowledgement within a few business days. We'll work with you
on a fix and coordinate a disclosure timeline before any public announcement.

## Scope notes

Vivari runs untrusted project code **inside the browser sandbox** using Web
Workers, a Service Worker preview proxy, and Wasm. It relies on the page being
[cross-origin isolated](https://developer.mozilla.org/en-US/docs/Web/API/Window/crossOriginIsolated)
(`COOP: same-origin` + `COEP: require-corp`). Reports that involve escaping that
sandbox, the sync syscall bridge, or the preview isolation model are especially
welcome.
