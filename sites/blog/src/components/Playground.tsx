import React from "react";
import useDocusaurusContext from "@docusaurus/useDocusaurusContext";

// Embeds a real, running Vivari example via an <iframe> pointing at the sibling
// /embed/ app (a cross-origin isolated page on the same origin). Because the blog
// is served cross-origin isolated too (see scripts/assemble-site.mjs), the iframe
// inherits isolation and the runtime's SharedArrayBuffer is available. The COEP
// that buys us this also means every image in a post must be same-origin.
//
// Kept in sync with sites/docs/src/components/Playground.tsx — the two sites are
// separate Docusaurus builds and cannot share a component tree.
//
// `scenario` is a free-form key resolved at runtime by the embed app's registry
// (sites/embed/src/scenarios/registry.tsx) rather than a union checked here, so
// that adding a demo to a blog post does not require editing this component.
// An unknown key renders a visible "unknown example" panel, not a silent
// fallback.
//
// The example only runs on the deployed site (or the assembled build served with
// _headers). Under a plain `docusaurus start` there is no /embed/ route, so we
// show a link to the Studio as a graceful fallback.

export default function Playground({
  scenario,
  height = 460,
  title,
}: {
  scenario: string;
  height?: number;
  title?: string;
}): React.JSX.Element {
  const { siteConfig } = useDocusaurusContext();
  const label = title ?? "Live example";

  return (
    <div className="vv-playground">
      <div className="vv-playground__bar">
        <span className="vv-playground__dot" aria-hidden="true" />
        <span className="vv-playground__label">{label}</span>
        <span style={{ flex: 1 }} />
        <a
          className="vv-playground__link"
          href={`${siteConfig.url}/studio/`}
          target="_blank"
          rel="noreferrer"
        >
          Open in Studio ↗
        </a>
      </div>
      <iframe
        className="vv-playground__frame"
        src={`/embed/?scenario=${encodeURIComponent(scenario)}`}
        title={label}
        loading="lazy"
        allow="cross-origin-isolated"
        style={{ height }}
      />
    </div>
  );
}
