import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MotionConfig } from "motion/react";
import "./index.css";
import App from "./App.tsx";

// `reducedMotion="user"` makes every motion/react animation on the page honour
// prefers-reduced-motion, which the stylesheet alone cannot do: the global
// @media block in index.css only reaches CSS animations and transitions, so the
// JS-driven ones kept sliding for users who had asked them not to: Reveal's
// scroll-in on every section, the Hero's staggered entrance, Nav's slide-down
// and CTA's scale-in. motion still runs opacity fades under this setting and
// drops transforms, so nothing appears or disappears without warning.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MotionConfig reducedMotion="user">
      <App />
    </MotionConfig>
  </StrictMode>,
);
