import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Dev mode (`vibe-center start --dev`): Vite serves the SPA with HMR and proxies the API and the
// event socket to the app server, so cookies and origins look the same as in production.
const apiPort = process.env.VC_API_PORT ?? "7880";

export default defineConfig({
  plugins: [tanstackRouter({ target: "react", autoCodeSplitting: true }), react(), tailwindcss()],
  resolve: { alias: { "@": resolve(import.meta.dirname, "src") } },
  server: {
    host: "127.0.0.1",
    // tailscale serve forwards the tailnet hostname
    allowedHosts: [".ts.net", "localhost"],
    proxy: {
      "/api": { target: `http://127.0.0.1:${apiPort}` },
      "/ws": { target: `ws://127.0.0.1:${apiPort}`, ws: true },
    },
  },
});
