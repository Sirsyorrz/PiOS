import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Phones reach the dev server over the LAN or Tailscale, not through
  // localhost, and the hostname differs per machine. The dev server serves
  // static assets only; the daemon is the thing with auth on every route.
  server: { host: true, port: 5173, allowedHosts: true },
  build: { target: "es2022" },
});
