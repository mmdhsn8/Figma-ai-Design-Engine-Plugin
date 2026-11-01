import { spawn } from "node:child_process";
import { createInstallationStore } from "./installation-store.js";
import { createCompanionServer } from "./server.js";

const companion = createCompanionServer({
  port: 1_455,
  installationStore: createInstallationStore(),
  openBrowser: openSystemBrowser,
});

const handle = await companion.start();
console.log("Figma AI Design Engine local companion is listening on 127.0.0.1:%d", handle.port);
console.log(
  "One-time Figma pairing code (enter it in the plugin; do not share it):\n%s",
  handle.pairingCode,
);
console.log("Press Ctrl+C to stop. OAuth tokens are held in memory only and cleared on exit.");

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await handle.close();
  process.exit(0);
}

process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());

function openSystemBrowser(url: string): Promise<void> {
  const command =
    process.platform === "win32"
      ? { file: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url] }
      : process.platform === "darwin"
        ? { file: "open", args: [url] }
        : { file: "xdg-open", args: [url] };
  return new Promise((resolve, reject) => {
    const child = spawn(command.file, command.args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", () => reject(new Error("system_browser_unavailable")));
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
