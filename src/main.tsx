import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { applyMode, getStoredMode } from "./lib/themes";
// Font Awesome free — all UI icons (webfonts are bundled by Vite, works offline)
import "@fortawesome/fontawesome-free/css/all.min.css";
import "./styles.css";

// Apply the stored mode before first paint so a light app doesn't flash dark.
applyMode(getStoredMode(), false);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
