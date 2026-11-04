import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { createDesignPlan } from "../shared/design-generation.js";
import {
  DraftManifestSchema,
  MAX_PROJECT_BYTES,
  MAX_SCREEN_BYTES,
  validateDraftScreen,
  type DraftManifest,
  type SavedDraft,
} from "../shared/generation-draft.js";

// A file per screen makes commits incremental; rename never overwrites the last good record in place.
export function createDraftStore(directory: string) {
  const sizeIndexes = new Map<string, Map<string, number>>();
  let queue: Promise<unknown> = Promise.resolve();
  let pending = 0;
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    if (pending >= 8) return Promise.reject(new Error("draft_storage_busy"));
    pending++;
    const next = queue.then(work, work).finally(() => {
      pending--;
    });
    queue = next.catch(() => {
      sizeIndexes.clear();
    });
    return next;
  };
  const projectPath = (owner: string, documentId: string) =>
    join(directory, createHash("sha256").update(`${owner}:${documentId}`).digest("hex"));
  const atomic = async (path: string, data: unknown) => {
    const text = JSON.stringify(data);
    const envelope = JSON.stringify({
      version: 1,
      checksum: createHash("sha256").update(text).digest("hex"),
      data,
    });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(envelope, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  };
  const read = async (path: string, maximum = MAX_SCREEN_BYTES * 2) => {
    if ((await stat(path)).size > maximum) throw new Error("draft_record_too_large");
    const record = JSON.parse(await readFile(path, "utf8"));
    if (
      record.version !== 1 ||
      record.checksum !== createHash("sha256").update(JSON.stringify(record.data)).digest("hex")
    )
      throw new Error("draft_corrupt_or_unsupported_version");
    return record.data;
  };
  const manifestAt = async (path: string) =>
    DraftManifestSchema.parse(await read(join(path, "manifest.json"), 32 * 1024));
  const sizesAt = async (path: string) => {
    let sizes = sizeIndexes.get(path);
    if (!sizes) {
      const entries = await readdir(path);
      sizes = new Map(
        await Promise.all(
          entries.map(async (entry) => [entry, (await stat(join(path, entry))).size] as const),
        ),
      );
      sizeIndexes.set(path, sizes);
    }
    return sizes;
  };
  return {
    start: (owner: string, input: DraftManifest) =>
      serial(async () => {
        const manifest = DraftManifestSchema.parse(input);
        if (!createDesignPlan(manifest.request).success) throw new Error("draft_plan_invalid");
        if (Buffer.byteLength(JSON.stringify(manifest)) > 16 * 1024)
          throw new Error("draft_manifest_16KiB_limit");
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const path = projectPath(owner, manifest.documentId);
        const projects = await readdir(directory, { withFileTypes: true });
        if (
          !projects.some((entry) => join(directory, entry.name) === path) &&
          projects.filter((entry) => entry.isDirectory()).length >= 8
        )
          throw new Error("draft_retention_full_delete_old_project");
        await mkdir(path, { recursive: true, mode: 0o700 });
        try {
          const existing = await manifestAt(path);
          if (existing.generationId !== manifest.generationId)
            throw new Error("draft_exists_clear_before_new_generation");
          if (JSON.stringify(existing) !== JSON.stringify(manifest))
            throw new Error("draft_contract_mismatch");
          return;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        await atomic(join(path, "manifest.json"), manifest);
        sizeIndexes.delete(path);
      }),
    saveScreen: (
      owner: string,
      documentId: string,
      generationId: string,
      value: unknown,
      nodeId?: string,
    ) =>
      serial(async () => {
        const path = projectPath(owner, documentId);
        const manifest = await manifestAt(path);
        if (manifest.generationId !== generationId) throw new Error("draft_generation_mismatch");
        const design = validateDraftScreen(manifest, value);
        const screenId = design.screens[0]!.id;
        const fileName = `screen-${screenId}.json`;
        const filePath = join(path, fileName);
        const sizes = await sizesAt(path);
        let used = [...sizes].reduce(
          (sum, [name, bytes]) => sum + (name === fileName ? 0 : bytes),
          0,
        );
        const sibling = [...sizes.keys()].find(
          (entry) =>
            entry.startsWith("screen-") &&
            entry.endsWith(".json") &&
            entry !== `screen-${screenId}.json`,
        );
        if (sibling) {
          let established: unknown;
          try {
            established = (await read(join(path, sibling))).design;
          } catch {
            /* Corrupt siblings are reported on load, not used as a palette contract. */
          }
          if (established) {
            const previous = established as typeof design;
            if (
              previous.projectName !== design.projectName ||
              JSON.stringify(previous.palette) !== JSON.stringify(design.palette)
            )
              throw new Error("draft_shared_palette_mismatch");
          }
        }
        const record = { design, rendered: Boolean(nodeId), ...(nodeId ? { nodeId } : {}) };
        const recordBytes = Buffer.byteLength(JSON.stringify(record)) + 128;
        if (used + recordBytes > MAX_PROJECT_BYTES) throw new Error("draft_project_64MiB_limit");
        // Replayed writes cannot silently replace a validated screen with different content.
        try {
          const previous = await read(filePath);
          if (JSON.stringify(previous.design) !== JSON.stringify(design))
            throw new Error("draft_screen_conflict");
        } catch (error) {
          if (
            error instanceof SyntaxError ||
            (error instanceof Error && error.message === "draft_corrupt_or_unsupported_version")
          ) {
            await rename(filePath, `${filePath}.corrupt`);
            const bytes = (await stat(`${filePath}.corrupt`)).size;
            used += bytes;
            sizes.delete(fileName);
            sizes.set(`${fileName}.corrupt`, bytes);
          } else if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if (used + recordBytes > MAX_PROJECT_BYTES) throw new Error("draft_project_64MiB_limit");
        await atomic(filePath, record);
        sizes.set(fileName, (await stat(filePath)).size);
      }),
    load: (owner: string, documentId: string): Promise<SavedDraft | null> =>
      serial(async () => {
        const path = projectPath(owner, documentId);
        // Recovery refreshes disk accounting, including externally changed/corrupt staging files.
        sizeIndexes.delete(path);
        let manifest: DraftManifest;
        try {
          manifest = await manifestAt(path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw error;
        }
        const screens: SavedDraft["screens"] = [];
        const warnings: string[] = [];
        let used = 0;
        for (const [entry, bytes] of await sizesAt(path)) {
          used += bytes;
          if (used > MAX_PROJECT_BYTES) throw new Error("draft_project_64MiB_limit");
          if (!entry.endsWith(".json") || entry === "manifest.json") continue;
          try {
            const record = await read(join(path, entry));
            const design = validateDraftScreen(manifest, record.design);
            if (entry !== `screen-${design.screens[0]!.id}.json`)
              throw new Error("draft_screen_identity_mismatch");
            screens.push({
              design,
              rendered: record.rendered === true,
              ...(typeof record.nodeId === "string" ? { nodeId: record.nodeId } : {}),
            });
          } catch {
            warnings.push(
              `Checkpoint ${entry} is corrupt or invalid; that screen must be regenerated. Original file retained.`,
            );
          }
        }
        const plan = createDesignPlan(manifest.request);
        if (!plan.success) throw new Error("draft_plan_invalid");
        const order = new Map(plan.data.screens.map((screen) => [screen.id, screen.order]));
        screens.sort(
          (a, b) => order.get(a.design.screens[0]!.id)! - order.get(b.design.screens[0]!.id)!,
        );
        return { manifest, screens, warnings };
      }),
    clear: (owner: string, documentId: string) =>
      serial(() => {
        const path = projectPath(owner, documentId);
        sizeIndexes.delete(path);
        return rm(path, { recursive: true, force: true });
      }),
  };
}
export type DraftStore = ReturnType<typeof createDraftStore>;
