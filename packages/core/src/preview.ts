// Preview URL helpers.
//
// A server that starts listening on port N inside the VM is reachable, same
// origin, under the Service Worker proxy prefix `/preview/<port>/`. Point an
// <iframe src> at this URL and the SW turns each request into an in-VM HTTP call
// (no network involved).

/** Build the same-origin preview URL for an in-VM port. */
export function previewUrl(port: number, origin?: string): string {
  const base = origin ?? (typeof location !== "undefined" ? location.origin : "");
  return `${base}/preview/${port}/`;
}
