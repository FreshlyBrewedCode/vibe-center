import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Standalone Vite app for the design mocks: `bun run dev` here, or `bun shoot.ts` to render the
// screenshots. Same React + Tailwind v4 stack as packages/web so a direction ports directly.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { host: "127.0.0.1", port: 5199, strictPort: true },
});
