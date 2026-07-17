import React from "react";
import useDocusaurusContext from "@docusaurus/useDocusaurusContext";

// Embeds a real, running Vivari example via an <iframe> pointing at the sibling
// /embed/ app (a cross-origin isolated page on the same origin). Because the docs
// site is served cross-origin isolated too (see scripts/assemble-site.mjs), the
// iframe inherits isolation and the runtime's SharedArrayBuffer is available.
//
// The example only runs on the deployed site (or the assembled build served with
// _headers). Under a plain `docusaurus start` there is no /embed/ route, so we
// show a link to the Studio as a graceful fallback.

type Scenario = "node" | "react";

export default function Playground({
  scenario,
  height = scenario === "react" ? 520 : 460,
  title,
}: {
  scenario: Scenario;
  height?: number;
  title?: string;
}): React.JSX.Element {
  const { siteConfig } = useDocusaurusContext();
  const label =
    title ?? (scenario === "react" ? "Live React dev server" : "Live Node terminal");

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
        src={`/embed/?scenario=${scenario}`}
        title={label}
        loading="lazy"
        allow="cross-origin-isolated"
        style={{ height }}
      />
    </div>
  );
}
