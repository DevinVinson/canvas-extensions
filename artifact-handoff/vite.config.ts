import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    cssCodeSplit: false,
    emptyOutDir: true,
    lib: {
      entry: resolve(import.meta.dirname, "src/extension.ts"),
      formats: ["es"],
      fileName: () => "extension.js",
    },
    outDir: "dist",
    rollupOptions: { output: { codeSplitting: false } },
    sourcemap: false,
  },
});
