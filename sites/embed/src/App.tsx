import { isCrossOriginIsolated } from "@vivari/core";
import { NotIsolated } from "./components/ui";
import { DEFAULT_SCENARIO, SCENARIOS } from "./scenarios/registry";

// Focused, real runtime examples embedded in the docs and the blog via
// <iframe>. The example is selected with ?scenario=<key>; see
// scenarios/registry.tsx for the full list.
export function App() {
  const requested =
    new URLSearchParams(location.search).get("scenario") || DEFAULT_SCENARIO;

  if (!isCrossOriginIsolated()) return <NotIsolated />;

  const scenario = SCENARIOS[requested];
  // A typo in a post's `scenario` prop would otherwise silently fall back to
  // the default example and look intentional. Say so instead.
  if (!scenario) return <UnknownScenario requested={requested} />;

  return <>{scenario.render()}</>;
}

function UnknownScenario({ requested }: { requested: string }) {
  return (
    <div className="center">
      <strong>Unknown example “{requested}”.</strong>
      <p style={{ maxWidth: "32rem", lineHeight: 1.5 }}>
        Available examples: {Object.keys(SCENARIOS).join(", ")}.
      </p>
      <a className="btn" href="/studio/" target="_blank" rel="noreferrer">
        Open the Studio
      </a>
    </div>
  );
}
