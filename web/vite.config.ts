import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// SPA is served by the backend under /app; the dev server proxies the JSON API.
// In Docker, API_PROXY_TARGET points at the backend container (http://nocheh:3000);
// locally it defaults to the host backend. VITE_USE_POLLING enables polling file
// watching for bind-mounted source (needed on some Docker file-sharing backends).
const apiTarget = process.env.API_PROXY_TARGET ?? "http://127.0.0.1:3000";
const usePolling = process.env.VITE_USE_POLLING === "true";
export default defineConfig({
  base: "/app/",
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    port: 5173,
    host: true,
    ...(usePolling ? { watch: { usePolling: true, interval: 300 } } : {}),
    proxy: {
      "/api": apiTarget,
      "/telegram": apiTarget,
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
  },
});
