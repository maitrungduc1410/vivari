// Ambient background: three drifting aurora blobs behind a fine dot-grid, plus a
// vignette so foreground text stays readable. Pure CSS animation (GPU transforms
// only), disabled under prefers-reduced-motion via the global stylesheet.
export function Background() {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      <div className="absolute inset-0 bg-bg" />

      <div className="absolute -top-40 -left-40 h-[42rem] w-[42rem] animate-aurora rounded-full bg-brand/25 blur-[120px]" />
      <div
        className="absolute top-1/3 -right-48 h-[38rem] w-[38rem] animate-aurora rounded-full bg-brand-2/20 blur-[120px]"
        style={{ animationDelay: "-6s" }}
      />
      <div
        className="absolute -bottom-56 left-1/4 h-[40rem] w-[40rem] animate-aurora rounded-full bg-brand-3/15 blur-[130px]"
        style={{ animationDelay: "-12s" }}
      />

      <div
        className="absolute inset-0 opacity-[0.18]"
        style={{
          backgroundImage:
            "radial-gradient(circle at 1px 1px, rgba(255,255,255,0.35) 1px, transparent 0)",
          backgroundSize: "38px 38px",
          maskImage:
            "radial-gradient(ellipse 100% 60% at 50% 0%, #000 40%, transparent 100%)",
        }}
      />

      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 80% 50% at 50% -10%, transparent, var(--color-bg) 75%)",
        }}
      />
    </div>
  );
}
