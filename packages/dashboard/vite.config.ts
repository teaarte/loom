import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The dashboard builds to PREBUILT static assets (`dist/`) that `@loomfsm/server`
// serves verbatim at `/`. `base: "/"` so the emitted index.html references
// `/assets/…` — the exact paths the server's static handler resolves off disk.
// No dev proxy is configured here: the SPA is a client of the SAME-origin API,
// so in `vite dev` you point it at a running `loom serve` via the token field
// (the API base is relative). The server is the production host.
export default defineConfig({
  plugins: [react()],
  base: "/",
  build: {
    outDir: "dist",
    assetsDir: "assets",
    emptyOutDir: true,
    target: "es2022",
  },
});
