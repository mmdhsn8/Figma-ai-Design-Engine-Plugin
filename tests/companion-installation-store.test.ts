import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createInstallationStore } from "../src/companion/installation-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("companion installation metadata", () => {
  it("keeps a stable host ID and the dynamically issued public client ID, without storing tokens", async () => {
    const directory = await mkdtemp(join(tmpdir(), "figma-companion-"));
    temporaryDirectories.push(directory);
    const store = createInstallationStore(directory);
    const first = await store.load();
    await store.saveClientId("issued-public-client-id");
    const reloaded = createInstallationStore(directory);
    const saved = await reloaded.load();
    const file = await readFile(join(directory, "installation.json"), "utf8");

    expect(saved.extAgentHostId).toBe(first.extAgentHostId);
    expect(saved.clientId).toBe("issued-public-client-id");
    expect(file).not.toContain("access_token");
    expect(file).not.toContain("refresh_token");
    await reloaded.clearRegistration();
    const cleared = await createInstallationStore(directory).load();
    expect(cleared.extAgentHostId).toBe(first.extAgentHostId);
    expect(cleared.clientId).toBeUndefined();
    expect(cleared.subjectHash).toBeUndefined();
  });

  it("rejects invalid client IDs before writing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "figma-companion-"));
    temporaryDirectories.push(directory);
    const store = createInstallationStore(directory);
    await expect(store.saveClientId("dynamic_agent_client")).rejects.toThrow("client_id_invalid");
  });
});
