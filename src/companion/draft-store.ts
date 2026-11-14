import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { createDesignPlan } from "../shared/design-generation.js";
import { GenerationTransactionSchema } from "../shared/generation-transaction.js";
import {
  DraftManifestSchema,
  MAX_PROJECT_BYTES,
  MAX_SCREEN_BYTES,
  validateDraftSection,
  validateDraftScreen,
  type DraftManifest,
  type SavedDraft,
  type SavedSection,
} from "../shared/generation-draft.js";

// A file per screen makes commits incremental; rename never overwrites the last good record in place.
export function createDraftStore(directory: string) {
  const sizeIndexes = new Map<string, Map<string, number>>();
  const sizeTotals = new Map<string, number>();
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
      sizeTotals.clear();
    });
    return next;
  };
  const projectPath = (owner: string, documentId: string) =>
    join(directory, createHash("sha256").update(`${owner}:${documentId}`).digest("hex"));
  const envelopeFor = (data: unknown) => {
    const text = JSON.stringify(data);
    return JSON.stringify({
      version: 1,
      checksum: createHash("sha256").update(text).digest("hex"),
      data,
    });
  };
  const atomic = async (path: string, data: unknown) => {
    const envelope = envelopeFor(data);
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
      sizeTotals.set(
        path,
        [...sizes.values()].reduce((sum, bytes) => sum + bytes, 0),
      );
    }
    return sizes;
  };
  const setIndexedSize = (
    path: string,
    sizes: Map<string, number>,
    name: string,
    bytes?: number,
  ) => {
    const oldSize = sizes.get(name) ?? 0;
    if (bytes === undefined) sizes.delete(name);
    else sizes.set(name, bytes);
    sizeTotals.set(path, (sizeTotals.get(path) ?? 0) + (bytes ?? 0) - oldSize);
  };
  return {
    start: (owner: string, input: DraftManifest) =>
      serial(async () => {
        const manifest = DraftManifestSchema.parse(input);
        if (!createDesignPlan(manifest.request, manifest.brandKit).success)
          throw new Error("draft_plan_invalid");
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
        sizeTotals.delete(path);
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
        let used = (sizeTotals.get(path) ?? 0) - (sizes.get(fileName) ?? 0);
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
        const recordBytes = Buffer.byteLength(envelopeFor(record));
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
            setIndexedSize(path, sizes, fileName);
            setIndexedSize(path, sizes, `${fileName}.corrupt`, bytes);
          } else if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if (used + recordBytes > MAX_PROJECT_BYTES) throw new Error("draft_project_64MiB_limit");
        await atomic(filePath, record);
        setIndexedSize(path, sizes, fileName, (await stat(filePath)).size);
      }),
    saveSection: (
      owner: string,
      documentId: string,
      generationId: string,
      transactionValue: unknown,
      value: unknown,
    ) =>
      serial(async () => {
        const path = projectPath(owner, documentId);
        const manifest = await manifestAt(path);
        if (manifest.generationId !== generationId) throw new Error("draft_generation_mismatch");
        const { transaction, design } = validateDraftSection(manifest, transactionValue, value);
        const fileName = `section-${transaction.screen_id}-${transaction.sequence}.json`;
        const filePath = join(path, fileName);
        const sizes = await sizesAt(path);
        const previousFile = transaction.sequence
          ? join(path, `section-${transaction.screen_id}-${transaction.sequence - 1}.json`)
          : undefined;
        if (previousFile) {
          try {
            const previous = await read(previousFile);
            if (previous.transaction.idempotency_key !== transaction.dependencies[0])
              throw new Error("draft_section_dependency_mismatch");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT")
              throw new Error("draft_section_sequence_gap", { cause: error });
            throw error;
          }
        }
        const record = { transaction, design, rendered: false };
        const recordBytes = Buffer.byteLength(envelopeFor(record));
        let used = (sizeTotals.get(path) ?? 0) - (sizes.get(fileName) ?? 0);
        try {
          const previous = await read(filePath);
          if (
            JSON.stringify(previous.transaction) !== JSON.stringify(transaction) ||
            JSON.stringify(previous.design) !== JSON.stringify(design)
          )
            throw new Error("draft_section_conflict");
          return;
        } catch (error) {
          if (
            error instanceof SyntaxError ||
            (error instanceof Error && error.message === "draft_corrupt_or_unsupported_version")
          ) {
            await rename(filePath, `${filePath}.corrupt`);
            const bytes = (await stat(`${filePath}.corrupt`)).size;
            used += bytes;
            setIndexedSize(path, sizes, fileName);
            setIndexedSize(path, sizes, `${fileName}.corrupt`, bytes);
          } else if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if (used + recordBytes > MAX_PROJECT_BYTES) throw new Error("draft_project_64MiB_limit");
        await atomic(filePath, record);
        setIndexedSize(path, sizes, fileName, (await stat(filePath)).size);
      }),
    markSectionApplied: (
      owner: string,
      documentId: string,
      generationId: string,
      transactionValue: unknown,
      nodeId: string,
    ) =>
      serial(async () => {
        const transactionInput = GenerationTransactionSchema.parse(transactionValue);
        const path = projectPath(owner, documentId);
        const manifest = await manifestAt(path);
        if (manifest.generationId !== generationId) throw new Error("draft_generation_mismatch");
        const recordValue = await read(
          join(path, `section-${transactionInput.screen_id}-${transactionInput.sequence}.json`),
        );
        const { transaction, design } = validateDraftSection(
          manifest,
          transactionInput,
          recordValue.design,
        );
        if (JSON.stringify(transaction) !== JSON.stringify(recordValue.transaction))
          throw new Error("draft_section_conflict");
        const fileName = `section-${transaction.screen_id}-${transaction.sequence}.json`;
        const filePath = join(path, fileName);
        const sizes = await sizesAt(path);
        if (!/^[A-Za-z0-9:_-]{1,100}$/u.test(nodeId))
          throw new Error("draft_node_identity_invalid");
        const updated = { transaction, design, rendered: true, nodeId };
        const recordBytes = Buffer.byteLength(envelopeFor(updated));
        const used = (sizeTotals.get(path) ?? 0) - (sizes.get(fileName) ?? 0);
        if (used + recordBytes > MAX_PROJECT_BYTES) throw new Error("draft_project_64MiB_limit");
        await atomic(filePath, updated);
        setIndexedSize(path, sizes, fileName, (await stat(filePath)).size);
      }),
    load: (owner: string, documentId: string): Promise<SavedDraft | null> =>
      serial(async () => {
        const path = projectPath(owner, documentId);
        // Recovery refreshes disk accounting, including externally changed/corrupt staging files.
        sizeIndexes.delete(path);
        sizeTotals.delete(path);
        let manifest: DraftManifest;
        try {
          manifest = await manifestAt(path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw error;
        }
        const screens: SavedDraft["screens"] = [];
        const transactions: SavedSection[] = [];
        const warnings: string[] = [];
        let used = 0;
        for (const [entry, bytes] of await sizesAt(path)) {
          used += bytes;
          if (used > MAX_PROJECT_BYTES) throw new Error("draft_project_64MiB_limit");
          if (!entry.endsWith(".json") || entry === "manifest.json") continue;
          try {
            const record = await read(join(path, entry));
            if (entry.startsWith("section-")) {
              const { transaction, design } = validateDraftSection(
                manifest,
                record.transaction,
                record.design,
              );
              if (entry !== `section-${transaction.screen_id}-${transaction.sequence}.json`)
                throw new Error("draft_section_identity_mismatch");
              transactions.push({
                transaction,
                design,
                rendered: record.rendered === true,
                ...(typeof record.nodeId === "string" ? { nodeId: record.nodeId } : {}),
              });
              continue;
            }
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
        const plan = createDesignPlan(manifest.request, manifest.brandKit);
        if (!plan.success) throw new Error("draft_plan_invalid");
        const order = new Map(plan.data.screens.map((screen) => [screen.id, screen.order]));
        transactions.sort(
          (a, b) =>
            (order.get(a.transaction.screen_id) ?? Number.MAX_SAFE_INTEGER) -
              (order.get(b.transaction.screen_id) ?? Number.MAX_SAFE_INTEGER) ||
            a.transaction.sequence - b.transaction.sequence,
        );
        const completeTransactions: SavedSection[] = [];
        const lastTransactionByScreen = new Map<string, SavedSection>();
        for (const transaction of transactions) {
          const previous = lastTransactionByScreen.get(transaction.transaction.screen_id);
          if (
            transaction.transaction.sequence !==
              (previous ? previous.transaction.sequence + 1 : 0) ||
            (previous &&
              transaction.transaction.dependencies[0] !== previous.transaction.idempotency_key)
          ) {
            warnings.push(
              `Section checkpoint ${transaction.transaction.screen_id}/${transaction.transaction.section_id} has a missing or conflicting dependency; later sections were not resumed.`,
            );
            continue;
          }
          completeTransactions.push(transaction);
          lastTransactionByScreen.set(transaction.transaction.screen_id, transaction);
        }
        const transactionsByScreen = new Map<string, SavedSection[]>();
        for (const transaction of completeTransactions) {
          const group = transactionsByScreen.get(transaction.transaction.screen_id) ?? [];
          group.push(transaction);
          transactionsByScreen.set(transaction.transaction.screen_id, group);
        }
        for (const [screenId, group] of transactionsByScreen) {
          if (screens.some(({ design }) => design.screens[0]!.id === screenId)) continue;
          const first = group[0]!;
          screens.push({
            design: {
              ...first.design,
              screens: [
                {
                  ...first.design.screens[0]!,
                  children: group.flatMap((item) => item.design.screens[0]!.children),
                },
              ],
            },
            rendered: group.every(({ rendered }) => rendered),
            ...(group.at(-1)?.nodeId ? { nodeId: group.at(-1)!.nodeId } : {}),
          });
        }
        screens.sort(
          (a, b) => order.get(a.design.screens[0]!.id)! - order.get(b.design.screens[0]!.id)!,
        );
        return { manifest, screens, transactions: completeTransactions, warnings };
      }),
    clear: (owner: string, documentId: string) =>
      serial(() => {
        const path = projectPath(owner, documentId);
        sizeIndexes.delete(path);
        sizeTotals.delete(path);
        return rm(path, { recursive: true, force: true });
      }),
  };
}
export type DraftStore = ReturnType<typeof createDraftStore>;
