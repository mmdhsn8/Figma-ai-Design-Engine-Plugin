import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

function runBuild() {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [resolve(root, "scripts/build.mjs")], {
      cwd: root,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`Vite command failed (exit ${code ?? "unknown"}).`));
    });
  });
}

let building = false;
let rebuildQueued = false;
let debounceTimer;

async function rebuild() {
  if (building) {
    rebuildQueued = true;
    return;
  }
  building = true;
  try {
    await runBuild();
  } catch {
    // Keep watching so the next save can recover from a transient build error.
  } finally {
    building = false;
    if (rebuildQueued) {
      rebuildQueued = false;
      void rebuild();
    }
  }
}

await rebuild();
console.log(
  "Watching src/ for changes. Import manifest.json once, then reload the development plugin in Figma after rebuilds.",
);
const watcher = watch(resolve(root, "src"), { recursive: true }, () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => void rebuild(), 180);
});

function stop() {
  clearTimeout(debounceTimer);
  watcher.close();
  process.exit(0);
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
