import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  DYNAMIC_CLIENT_ENTRYPOINT,
  isClientId,
  isLegacyBareHostUuid,
  isSupportedAgentHostId,
} from "./oauth.js";

export interface InstallationMetadata {
  extAgentHostId: string;
  clientId?: string;
  subjectHash?: string;
}

export interface InstallationStore {
  load(): Promise<InstallationMetadata>;
  saveClientId(clientId: string, subjectHash?: string): Promise<void>;
  clearRegistration(): Promise<void>;
}

export function createInstallationStore(directory = defaultDataDirectory()): InstallationStore {
  const filePath = join(directory, "installation.json");
  let cached: InstallationMetadata | undefined;

  async function load(): Promise<InstallationMetadata> {
    if (cached) return { ...cached };
    await mkdir(directory, { recursive: true, mode: 0o700 });
    let raw: string | undefined;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        raw = undefined;
      } else {
        throw new Error("installation_store_invalid", { cause: error });
      }
    }

    if (raw !== undefined) {
      let value: unknown;
      try {
        value = JSON.parse(raw) as unknown;
      } catch (error) {
        throw new Error("installation_store_invalid", { cause: error });
      }
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("installation_store_invalid");
      }
      const record = value as {
        extAgentHostId?: unknown;
        clientId?: unknown;
        subjectHash?: unknown;
      };
      const migratedHostId = isLegacyBareHostUuid(record.extAgentHostId)
        ? `urn:uuid:${record.extAgentHostId}`
        : record.extAgentHostId;
      if (
        !isSupportedAgentHostId(migratedHostId) ||
        (record.clientId !== undefined &&
          (typeof record.clientId !== "string" || !isClientId(record.clientId))) ||
        (record.subjectHash !== undefined &&
          (typeof record.subjectHash !== "string" || !/^[0-9a-f]{64}$/iu.test(record.subjectHash)))
      ) {
        throw new Error("installation_store_invalid");
      }
      cached = {
        extAgentHostId: migratedHostId,
        ...(typeof record.clientId === "string" ? { clientId: record.clientId } : {}),
        ...(typeof record.subjectHash === "string" ? { subjectHash: record.subjectHash } : {}),
      };
      if (migratedHostId !== record.extAgentHostId) await persist(filePath, cached);
      return { ...cached };
    }

    cached = { extAgentHostId: `urn:uuid:${randomUUID()}` };
    await persist(filePath, cached);
    return { ...cached };
  }

  async function saveClientId(clientId: string, subjectHash?: string): Promise<void> {
    if (!isClientId(clientId) || clientId === DYNAMIC_CLIENT_ENTRYPOINT) {
      throw new Error("client_id_invalid");
    }
    if (subjectHash !== undefined && !/^[0-9a-f]{64}$/iu.test(subjectHash)) {
      throw new Error("subject_hash_invalid");
    }
    const current = await load();
    cached = { ...current, clientId, ...(subjectHash ? { subjectHash } : {}) };
    await persist(filePath, cached);
  }

  async function clearRegistration(): Promise<void> {
    const current = await load();
    cached = { extAgentHostId: current.extAgentHostId };
    await persist(filePath, cached);
  }

  return { load, saveClientId, clearRegistration };
}

function defaultDataDirectory(): string {
  const localAppData = process.env.LOCALAPPDATA;
  return join(localAppData || join(homedir(), "AppData", "Local"), "Figma AI Design Engine");
}

async function persist(filePath: string, value: InstallationMetadata): Promise<void> {
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    await rename(temporaryPath, filePath);
  } catch (error) {
    // Windows can reject a rename over an existing file. Remove only this temporary metadata file.
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EEXIST" && code !== "EPERM") throw error;
    await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    const { unlink } = await import("node:fs/promises");
    await unlink(temporaryPath);
  }
}
