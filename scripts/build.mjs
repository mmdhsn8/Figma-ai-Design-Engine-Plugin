import { execFileSync, spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const vite = resolve(root, "node_modules/vite/bin/vite.js");
const dist = resolve(root, "dist");

function buildIdentity() {
  if (process.env.VITE_FW7_BUILD_ID && /^[A-Za-z0-9._:+-]{1,100}$/u.test(process.env.VITE_FW7_BUILD_ID))
    return process.env.VITE_FW7_BUILD_ID;
  try {
    const revision = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim();
    return `git-${revision}${dirty ? "+dirty" : ""}`;
  } catch {
    return "source-unknown";
  }
}

const viteEnv = { ...process.env, VITE_FW7_BUILD_ID: buildIdentity() };

function runVite(config) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      [vite, "build", "--config", config, "--configLoader", "runner"],
      {
        cwd: root,
        stdio: "inherit",
        windowsHide: true,
        env: viteEnv,
      },
    );
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`Vite build failed for ${config} (exit ${code ?? "unknown"}).`));
    });
  });
}

await mkdir(dist, { recursive: true });
await runVite("vite.ui.config.ts");
const bundle = (await readFile(resolve(dist, "ui-bundle.js"), "utf8")).replace(
  /<\/script/gi,
  "<\\/script",
);
const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Figma AI Design Engine</title>
  </head>
  <body>
    <div id="root"></div>
    <script>${bundle}</script>
  </body>
</html>
`;
await writeFile(resolve(dist, "ui.html"), html, "utf8");
await runVite("vite.plugin.config.ts");
console.log("Built dist/ui.html and dist/plugin.js.");
