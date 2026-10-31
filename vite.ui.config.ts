import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { defineConfig } from "vite";

const root = process.cwd();

export default defineConfig({
  plugins: [react()],
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    emptyOutDir: false,
    minify: true,
    lib: {
      entry: resolve(root, "src/ui/main.tsx"),
      name: "FigmaAIDesignEngineUI",
      formats: ["iife"],
      fileName: () => "ui-bundle.js",
    },
  },
});
