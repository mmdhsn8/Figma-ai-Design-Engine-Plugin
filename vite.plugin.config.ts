import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";

const root = process.cwd();
const uiPath = resolve(root, "dist/ui.html");
const controllerPath = resolve(root, "src/plugin/main.ts");

function embedPluginUi(): Plugin {
  return {
    name: "embed-plugin-ui",
    enforce: "pre",
    transform(source, id) {
      if (resolve(id.split("?")[0]) !== controllerPath) return null;

      this.addWatchFile(uiPath);
      const html = readFileSync(uiPath, "utf8");
      const embeddedHtml = JSON.stringify(html).replace(/</g, "\\u003c");
      return source.replace("__html__", () => embeddedHtml);
    },
  };
}

export default defineConfig({
  plugins: [embedPluginUi()],
  build: {
    emptyOutDir: false,
    lib: {
      entry: controllerPath,
      name: "FigmaAIDesignEnginePlugin",
      formats: ["iife"],
      fileName: () => "plugin.js",
    },
  },
});
