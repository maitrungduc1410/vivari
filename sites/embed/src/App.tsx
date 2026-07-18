import { isCrossOriginIsolated } from "@vivari/core";
import { NodeTerminal } from "./scenarios/NodeTerminal";
import { ReactPreview } from "./scenarios/ReactPreview";
import { NotIsolated } from "./components/ui";

// Focused, real runtime examples embedded in the docs via <iframe>. The scenario
// is selected with ?scenario=node|react.
export function App() {
  const scenario =
    new URLSearchParams(location.search).get("scenario") || "node";

  if (!isCrossOriginIsolated()) return <NotIsolated />;
  return scenario === "react" ? <ReactPreview /> : <NodeTerminal />;
}
