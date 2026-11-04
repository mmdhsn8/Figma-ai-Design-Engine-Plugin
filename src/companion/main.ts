import { spawn } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { createDraftStore } from "./draft-store.js";
import {
  COMPANION_HOSTNAME,
  COMPANION_PORT,
  configuredTimeoutMs,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  DEFAULT_STREAM_OVERALL_TIMEOUT_MS,
  MAX_STREAM_IDLE_TIMEOUT_MS,
  MAX_STREAM_OVERALL_TIMEOUT_MS,
} from "./config.js";
import { createCredentialStore } from "./credential-store.js";
import { createInstallationStore } from "./installation-store.js";
import { createCompanionServer } from "./server.js";

const companion = createCompanionServer({
  draftStore: createDraftStore(
    join(
      process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"),
      "Figma AI Design Engine",
      "drafts-v1",
    ),
  ),
  port: COMPANION_PORT,
  streamIdleTimeoutMs: configuredTimeoutMs(
    process.env.FAD_STREAM_IDLE_TIMEOUT_MS,
    DEFAULT_STREAM_IDLE_TIMEOUT_MS,
    MAX_STREAM_IDLE_TIMEOUT_MS,
  ),
  streamOverallTimeoutMs: configuredTimeoutMs(
    process.env.FAD_STREAM_OVERALL_TIMEOUT_MS,
    DEFAULT_STREAM_OVERALL_TIMEOUT_MS,
    MAX_STREAM_OVERALL_TIMEOUT_MS,
  ),
  installationStore: createInstallationStore(),
  credentialStore: createCredentialStore(),
  openBrowser: openSystemBrowser,
});

const handle = await companion.start();
console.log(
  "Figma AI Design Engine local companion is listening on %s:%d",
  COMPANION_HOSTNAME,
  handle.port,
);
console.log(
  "Open the Figma AI Design Engine plugin and choose Continue with ChatGPT. The first connection opens a local approval page in your system browser.",
);
console.log(
  "Press Ctrl+C to stop. Sign-in restores from Windows-protected local storage when available.",
);

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
