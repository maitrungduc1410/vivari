// Small presentational helpers shared by the scenarios.

export function Booting({ label }: { label: string }) {
  return (
    <div className="center">
      <div className="spinner" />
      <div>{label}</div>
    </div>
  );
}

export function NotIsolated() {
  return (
    <div className="center">
      <strong>This example needs a cross-origin isolated page.</strong>
      <p style={{ maxWidth: "32rem", lineHeight: 1.5 }}>
        Vivari&apos;s runtime relies on <code>SharedArrayBuffer</code>, which the
        browser only exposes on pages served with COOP + COEP. Open the full
        environment in the Studio instead.
      </p>
      <a className="btn" href="/studio/" target="_blank" rel="noreferrer">
        Open the Studio
      </a>
    </div>
  );
}

export function StatusDot({ state }: { state: "booting" | "ready" | "running" }) {
  const cls =
    state === "ready"
      ? "embed__dot embed__dot--ready"
      : "embed__dot embed__dot--busy";
  return <span className={cls} />;
}
