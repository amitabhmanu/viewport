import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Built into dist/, which viewportd serves. Asset paths are absolute because every
// client route (/map/..., /ledger) falls back to index.html.
export default defineConfig({
  plugins: [react()],
  base: "/",
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 2000 },
});
