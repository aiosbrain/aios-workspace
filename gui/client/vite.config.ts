import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "dist",
    rollupOptions: {
      output: {
        // Split rarely-changing vendor code from app code so a change to one
        // component doesn't invalidate the whole bundle, and to shrink the single
        // >500kB chunk Vite was warning about.
        manualChunks: {
          "vendor-radix": [
            "@radix-ui/react-dialog",
            "@radix-ui/react-dropdown-menu",
            "@radix-ui/react-popover",
            "@radix-ui/react-scroll-area",
            "@radix-ui/react-slot",
            "@radix-ui/react-tooltip",
          ],
          // @aios-alpha/design is CSS-only (imported via subpath, not a JS entry) —
          // only @aios-alpha/ui has an actual JS module for Rollup to resolve here.
          "vendor-ui": ["@aios-alpha/ui"],
        },
      },
    },
  },
  server: {
    // dev mode: proxy ws + api to a running gui server
    proxy: {
      "/ws": { target: "ws://127.0.0.1:8790", ws: true },
      "/api": "http://127.0.0.1:8790",
    },
  },
});
