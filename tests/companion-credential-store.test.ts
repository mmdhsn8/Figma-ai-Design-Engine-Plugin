import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCredentialStore,
  emptyCredentialState,
  type CredentialState,
} from "../src/companion/credential-store.js";
import { PLAN_USE_SCOPE } from "../src/companion/oauth.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function createDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "figma-credential-store-"));
  directories.push(directory);
  return directory;
}

describe("protected companion credential storage", () => {
  it("treats missing persisted credentials as a signed-out installation", async () => {
    const store = createCredentialStore(await createDirectory());
    await expect(store.load()).resolves.toEqual(emptyCredentialState());
  });

  it("reports corrupt state instead of silently replacing it", async () => {
    const directory = await createDirectory();
    await writeFile(join(directory, "credentials.v1.dpapi"), "not-protected-data\n", "utf8");
    await expect(createCredentialStore(directory).load()).rejects.toThrow(
      "credential_store_corrupt",
    );
    expect(await readFile(join(directory, "credentials.v1.dpapi"), "utf8")).toBe(
      "not-protected-data\n",
    );
  });

  it.skipIf(process.platform !== "win32")(
    "round-trips OAuth tokens through current-user DPAPI without plaintext on disk",
    async ({ skip }) => {
      const directory = await createDirectory();
      const store = createCredentialStore(directory);
      const state: CredentialState = {
        version: 1,
        oauthSession: {
          subject: "opaque-subject",
          subjectHash: "a".repeat(64),
          clientId: "issued-public-client-id",
          accessToken: "access-secret-fixture",
          refreshToken: "refresh-secret-fixture",
          scopes: ["openid", "offline_access", PLAN_USE_SCOPE],
          expiresAt: Date.now() + 60_000,
        },
        pairingGrants: [{ id: "A".repeat(22), secretHash: "b".repeat(64), createdAt: Date.now() }],
      };
      try {
        await store.save(state);
      } catch (error) {
        if (error instanceof Error && error.message === "secure_storage_profile_unavailable") {
          skip("Current Windows process has no loaded user profile for DPAPI CurrentUser.");
        }
        throw error;
      }
      const persisted = await readFile(join(directory, "credentials.v1.dpapi"), "utf8");
      expect(persisted.startsWith("FADP1:")).toBe(true);
      expect(persisted).not.toContain("access-secret-fixture");
      expect(persisted).not.toContain("refresh-secret-fixture");
      await expect(store.load()).resolves.toEqual(state);

      const sealed = await store.protectText("Figma plugin ticket fixture");
      expect(sealed).not.toContain("Figma plugin ticket fixture");
      await expect(store.unprotectText(sealed)).resolves.toBe("Figma plugin ticket fixture");
    },
    30_000,
  );
});
