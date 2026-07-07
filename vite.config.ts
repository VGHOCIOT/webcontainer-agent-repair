import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// WebContainers needs the page to be cross-origin isolated (SharedArrayBuffer)
// to boot, both in dev and in `vite preview`.
const crossOriginIsolationHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

export default defineConfig({
  plugins: [react()],
  server: { headers: crossOriginIsolationHeaders },
  preview: { headers: crossOriginIsolationHeaders },
});
