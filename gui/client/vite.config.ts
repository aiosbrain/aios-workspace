import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { outDir: "dist" },
  server: {
    // dev mode: proxy ws + api to a running gui server
    proxy: {
      "/ws": { target: "ws://127.0.0.1:8790", ws: true },
      "/api": "http://127.0.0.1:8790",
    },
  },
});
