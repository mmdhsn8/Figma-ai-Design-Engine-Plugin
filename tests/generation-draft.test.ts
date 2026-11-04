import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDraftStore } from "../src/companion/draft-store";
import { DraftManifestSchema } from "../src/shared/generation-draft";
import { draftFixture } from "./generation-fixture";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "fad-draft-test-"));
  directories.push(directory);
  return { directory, store: createDraftStore(directory) };
}

describe("durable per-screen draft checkpoints", () => {
  it("survives restart, replays writes without duplicates, and binds account/document/generation", async () => {
    const { manifest, design } = draftFixture();
    const { directory, store } = await setup();
    await store.start("owner-a", manifest);
    await Promise.all([
      store.saveScreen("owner-a", manifest.documentId, manifest.generationId, design),
      store.saveScreen("owner-a", manifest.documentId, manifest.generationId, design),
    ]);
    const reopened = createDraftStore(directory);
    const restored = await reopened.load("owner-a", manifest.documentId);
    expect(restored?.screens).toHaveLength(1);
    expect(restored?.screens[0]?.design).toEqual(design);
    expect(await reopened.load("owner-b", manifest.documentId)).toBeNull();
    expect(await reopened.load("owner-a", "another-document")).toBeNull();
    await expect(
      reopened.saveScreen("owner-a", manifest.documentId, "wrong-generation", design),
    ).rejects.toThrow("draft_generation_mismatch");
    await reopened.saveScreen(
      "owner-a",
      manifest.documentId,
      manifest.generationId,
      design,
      "node:1",
    );
    expect((await reopened.load("owner-a", manifest.documentId))?.screens[0]).toMatchObject({
      rendered: true,
      nodeId: "node:1",
    });
    await expect(
      reopened.saveScreen("owner-a", manifest.documentId, manifest.generationId, {
        ...design,
        projectName: "changed",
      }),
    ).rejects.toThrow("draft_screen_conflict");
    await reopened.clear("owner-b", manifest.documentId);
    expect((await reopened.load("owner-a", manifest.documentId))?.screens).toHaveLength(1);
  });

  it("ignores interrupted staging writes, detects corruption, and rejects unknown versions/credentials", async () => {
    const { manifest, design } = draftFixture();
    const { directory, store } = await setup();
    await store.start("owner", manifest);
    await store.saveScreen("owner", manifest.documentId, manifest.generationId, design);
    const path = join(
      directory,
      createHash("sha256").update(`owner:${manifest.documentId}`).digest("hex"),
    );
    await writeFile(join(path, "detail.json.interrupted.tmp"), "partial private text");
    expect(
      (await createDraftStore(directory).load("owner", manifest.documentId))?.screens,
    ).toHaveLength(1);
    await writeFile(join(path, "screen-home.json"), '{"version":1,"checksum":"wrong","data":{}}');
    const recovered = await store.load("owner", manifest.documentId);
    expect(recovered?.screens).toEqual([]);
    expect(recovered?.warnings[0]).toContain("corrupt");
    expect(await readFile(join(path, "screen-home.json"), "utf8")).toContain("wrong");
    await store.saveScreen("owner", manifest.documentId, manifest.generationId, design);
    expect((await store.load("owner", manifest.documentId))?.screens).toHaveLength(1);
    expect(await readFile(join(path, "screen-home.json.corrupt"), "utf8")).toContain("wrong");
    expect(DraftManifestSchema.safeParse({ ...manifest, version: 0 }).success).toBe(false);
    expect(
      DraftManifestSchema.safeParse({ ...manifest, accessToken: "never store credentials" })
        .success,
    ).toBe(false);
    await expect(
      store.saveScreen("owner", manifest.documentId, manifest.generationId, {
        ...design,
        screens: [{ id: "../unsafe", children: [] }],
      }),
    ).rejects.toThrow("draft_screen_invalid");
    await store.clear("owner", manifest.documentId);
    expect(await store.load("owner", manifest.documentId)).toBeNull();
  });

  it("commits and reloads a hundred-screen plan incrementally", async () => {
    const { manifest, design } = draftFixture();
    manifest.request.screenCount = 100;
    manifest.request.screenNames = Array.from({ length: 100 }, (_, index) => `Screen ${index}`);
    const { directory, store } = await setup();
    await store.start("owner", manifest);
    for (let index = 0; index < 100; index++)
      await store.saveScreen("owner", manifest.documentId, manifest.generationId, {
        ...design,
        screens: [{ id: `screen-${index}`, children: [] }],
      });
    const loaded = await createDraftStore(directory).load("owner", manifest.documentId);
    expect(loaded?.screens).toHaveLength(100);
    const project = (await readdir(directory))[0]!;
    expect(
      (await readdir(join(directory, project))).filter((name) => name.endsWith(".tmp")),
    ).toEqual([]);
  }, 30_000);

  it("bounds retention without silently deleting old projects and rejects unsupported assets", async () => {
    const { manifest, design } = draftFixture();
    const { store } = await setup();
    for (let index = 0; index < 8; index++)
      await store.start("owner", { ...manifest, documentId: `document-test-${index}` });
    await expect(
      store.start("owner", { ...manifest, documentId: "document-over-cap" }),
    ).rejects.toThrow("draft_retention_full");
    expect((await store.load("owner", "document-test-0"))?.manifest.documentId).toBe(
      "document-test-0",
    );
    await store.clear("owner", "document-test-0");
    await store.start("owner", manifest);
    await expect(
      store.saveScreen("owner", manifest.documentId, manifest.generationId, {
        ...design,
        assets: [{ id: "missing", url: "https://untrusted.invalid" }],
      }),
    ).rejects.toThrow("draft_screen_invalid");
  });

  it("keeps a screen named Manifest separate from the project manifest and restores plan order", async () => {
    const { manifest, design } = draftFixture();
    manifest.request.screenNames = ["Manifest", "Detail"];
    const { store } = await setup();
    await store.start("owner", manifest);
    for (const id of ["detail", "manifest"])
      await store.saveScreen("owner", manifest.documentId, manifest.generationId, {
        ...design,
        screens: [{ id, children: [] }],
      });
    const saved = await store.load("owner", manifest.documentId);
    expect(saved?.manifest).toEqual(manifest);
    expect(saved?.screens.map(({ design }) => design.screens[0]!.id)).toEqual([
      "manifest",
      "detail",
    ]);
  });
});
