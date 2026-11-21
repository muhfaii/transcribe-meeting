import { defineConfig } from "vite";

// Browser bundle only; the Worker is bundled by wrangler.
export default defineConfig({
  root: "src/web",
  build: { outDir: "../../dist/web", emptyOutDir: true, target: "es2022" },
});
