import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";
import { trackViewport } from "./viewport.ts";
import "./styles.css";

trackViewport();

const container = document.getElementById("root");
if (!container) throw new Error("missing #root");

// Dev serves modules unbundled, so a shell cache there would only serve stale
// code; in a build it is what makes an iOS relaunch paint without a round trip.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js").catch(() => {
      // Insecure origin or a blocked registration: the app works uncached.
    });
  });
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
