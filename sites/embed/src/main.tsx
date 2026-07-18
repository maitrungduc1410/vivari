import { createRoot } from "react-dom/client";
import "@xterm/xterm/css/xterm.css";
import "./index.css";
import { App } from "./App";

// No StrictMode: its dev-only double-invoke of effects would boot the heavy
// runtime worker twice. This is a leaf iframe app, so the trade-off isn't worth it.
createRoot(document.getElementById("root")!).render(<App />);
