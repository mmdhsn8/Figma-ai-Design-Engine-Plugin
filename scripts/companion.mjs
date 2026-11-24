import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { computeBuildIdentity } from "./build-identity.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const validBuildId = (value) => typeof value === "string" && /^[A-Za-z0-9._:+-]{1,100}$/u.test(value);
const sourceBuildId = computeBuildIdentity(root);
const buildId = validBuildId(process.env.FW7_BUILD_ID)
  ? process.env.FW7_BUILD_ID
  : sourceBuildId;
let activeChild;

function run(args, env = process.env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      stdio: "inherit",
      windowsHide: true,
      env,
    });
    activeChild = child;
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      activeChild = undefined;
      if (code === 0) resolvePromise();
      else reject(new Error(`Companion command failed (exit ${code ?? signal ?? "unknown"}).`));
    });
  });
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => activeChild?.kill(signal));
}

try {
  await run([resolve(root, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.companion.json"]);
  if (computeBuildIdentity(root) !== sourceBuildId)
    throw new Error("Source changed during Companion compilation. Run npm run companion again.");
  console.log(`Starting Companion build ${buildId}.`);
  await run([resolve(root, "dist-companion/companion/main.js")], {
    ...process.env,
    FW7_BUILD_ID: buildId,
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : "Companion startup failed.");
  process.exitCode = 1;
}
