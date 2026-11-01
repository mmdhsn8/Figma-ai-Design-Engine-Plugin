import { randomUUID } from "node:crypto";
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
    expect(first.extAgentHostId).toMatch(
      /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
    );
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

  it("migrates the app's prior bare UUIDv4 in place without changing its host identity", async () => {
    const directory = await mkdtemp(join(tmpdir(), "figma-companion-"));
    temporaryDirectories.push(directory);
    const oldUuid = randomUUID();
    const oldMetadata = {
      extAgentHostId: oldUuid,
      clientId: "issued-public-client-id",
      subjectHash: "a".repeat(64),
    };
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(directory, "installation.json"), JSON.stringify(oldMetadata));

    const migrated = await createInstallationStore(directory).load();
    const persisted = JSON.parse(await readFile(join(directory, "installation.json"), "utf8")) as {
      extAgentHostId: string;
      clientId: string;
      subjectHash: string;
    };

    expect(migrated).toEqual({
      extAgentHostId: "urn:uuid:" + oldUuid,
      clientId: oldMetadata.clientId,
      subjectHash: oldMetadata.subjectHash,
    });
    expect(persisted).toEqual(migrated);
  });

  it("does not silently replace invalid persisted host identity data", async () => {
    const directory = await mkdtemp(join(tmpdir(), "figma-companion-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "installation.json");
    const invalid = { extAgentHostId: "guessed-host-id", clientId: "issued-public-client-id" };
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path, JSON.stringify(invalid));

    await expect(createInstallationStore(directory).load()).rejects.toThrow(
      "installation_store_invalid",
    );
    expect(await readFile(path, "utf8")).toBe(JSON.stringify(invalid));
  });
});
