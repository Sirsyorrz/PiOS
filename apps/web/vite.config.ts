import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Set by `pnpm sandbox`: the daemon's own origin. Proxying it keeps the app
// and the API on one origin, so the dev build needs no CORS and no endpoint
// picker, exactly like the deployed daemon that serves both itself.
const sandboxTarget = process.env.PIOS_SANDBOX_TARGET;

const API_PATHS = [
  "/pair",
  "/health",
  "/sessions",
  "/push",
  "/usage",
  "/dirs",
  "/file",
  "/files",
  "/upload",
  "/git",
];

const proxy = sandboxTarget
  ? {
      "/ws": { target: sandboxTarget, ws: true },
      ...Object.fromEntries(API_PATHS.map((path) => [path, { target: sandboxTarget }])),
    }
  : undefined;

export default defineConfig({
  plugins: [react()],
  // A compile-time constant, not `import.meta.env.DEV`: DEV follows NODE_ENV,
  // which a machine can have set to production globally. This flag is true
  // only when the sandbox started the dev server, so the one-step pairing
  // bootstrap cannot survive into any other build.
  define: { __PIOS_SANDBOX__: JSON.stringify(Boolean(sandboxTarget)) },
  // Phones reach the dev server over the LAN or Tailscale, not through
  // localhost, and the hostname differs per machine. The dev server serves
  // static assets only; the daemon is the thing with auth on every route.
  server: { host: true, port: 5173, allowedHosts: true, proxy },
  build: { target: "es2022" },
});
