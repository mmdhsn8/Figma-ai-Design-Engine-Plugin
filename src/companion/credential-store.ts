import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { isClientId } from "./oauth.js";

const FILE_NAME = "credentials.v1.dpapi";
const FILE_PREFIX = "FADP1:";
const MAX_STORE_BYTES = 256 * 1_024;
const MAX_TOKEN_LENGTH = 16_384;
const DPAPI_ENTROPY = "Figma AI Design Engine credential vault v1";

export interface StoredOAuthSession {
  subject: string;
  subjectHash: string;
  clientId: string;
  accessToken: string;
  refreshToken?: string;
  scopes: string[];
  expiresAt: number;
}

export interface StoredPairingGrant {
  id: string;
  secretHash: string;
  createdAt: number;
}

export interface CredentialState {
  version: 1;
  oauthSession?: StoredOAuthSession;
  reauthorizationRequired?: boolean;
  pairingGrants: StoredPairingGrant[];
}

export interface CredentialStore {
  load(): Promise<CredentialState>;
  save(state: CredentialState): Promise<void>;
  protectText(value: string): Promise<string>;
  unprotectText(value: string): Promise<string>;
}

export function createCredentialStore(directory = defaultDataDirectory()): CredentialStore {
  const filePath = join(directory, FILE_NAME);

  async function protectText(value: string): Promise<string> {
    return protectWithWindowsDpapi(value);
  }

  async function unprotectText(value: string): Promise<string> {
    return unprotectWithWindowsDpapi(value);
  }

  async function load(): Promise<CredentialState> {
    let contents: string;
    try {
      contents = await readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyCredentialState();
      throw new Error("credential_store_unavailable", { cause: error });
    }
    if (!contents.startsWith(FILE_PREFIX) || contents.length > MAX_STORE_BYTES) {
      throw new Error("credential_store_corrupt");
    }
    let plaintext: string;
    try {
      plaintext = await unprotectText(contents.slice(FILE_PREFIX.length).trim());
    } catch (error) {
      if (error instanceof Error && error.message === "secure_storage_profile_unavailable") {
        throw error;
      }
      throw new Error("credential_store_corrupt", { cause: error });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(plaintext) as unknown;
    } catch (error) {
      throw new Error("credential_store_corrupt", { cause: error });
    }
    return parseCredentialState(parsed);
  }

  async function save(state: CredentialState): Promise<void> {
    const checked = parseCredentialState(state);
    const plaintext = JSON.stringify(checked);
    if (Buffer.byteLength(plaintext, "utf8") > MAX_STORE_BYTES) {
      throw new Error("credential_store_unavailable");
    }
    const protectedValue = await protectText(plaintext);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${FILE_PREFIX}${protectedValue}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    try {
      await rename(temporaryPath, filePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "EPERM") {
        await unlink(temporaryPath).catch(() => undefined);
        throw new Error("credential_store_unavailable", { cause: error });
      }
      try {
        await writeFile(filePath, `${FILE_PREFIX}${protectedValue}\n`, {
          encoding: "utf8",
          mode: 0o600,
        });
      } catch (writeError) {
        await unlink(temporaryPath).catch(() => undefined);
        throw new Error("credential_store_unavailable", { cause: writeError });
      }
      await unlink(temporaryPath);
    }
  }

  return { load, save, protectText, unprotectText };
}

/** Test-only process-memory storage; production always injects the DPAPI-backed implementation. */
export function createMemoryCredentialStore(): CredentialStore {
  let state = emptyCredentialState();
  return {
    async load() {
      return cloneCredentialState(state);
    },
    async save(next) {
      state = parseCredentialState(next);
    },
    async protectText(value) {
      return Buffer.from(value, "utf8").toString("base64");
    },
    async unprotectText(value) {
      if (!/^[A-Za-z0-9+/]+=*$/u.test(value)) throw new Error("invalid_ticket");
      return Buffer.from(value, "base64").toString("utf8");
    },
  };
}

export function emptyCredentialState(): CredentialState {
  return { version: 1, pairingGrants: [] };
}

export function parseCredentialState(value: unknown): CredentialState {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.pairingGrants)) {
    throw new Error("credential_store_corrupt");
  }
  if (value.pairingGrants.length > 64) throw new Error("credential_store_corrupt");
  const oauthSession =
    value.oauthSession === undefined ? undefined : parseOAuthSession(value.oauthSession);
  if (
    value.reauthorizationRequired !== undefined &&
    typeof value.reauthorizationRequired !== "boolean"
  ) {
    throw new Error("credential_store_corrupt");
  }
  if (oauthSession && value.reauthorizationRequired) throw new Error("credential_store_corrupt");
  const pairingGrants = value.pairingGrants.map(parsePairingGrant);
  if (new Set(pairingGrants.map((grant) => grant.id)).size !== pairingGrants.length) {
    throw new Error("credential_store_corrupt");
  }
  return {
    version: 1,
    ...(oauthSession ? { oauthSession } : {}),
    ...(value.reauthorizationRequired ? { reauthorizationRequired: true } : {}),
    pairingGrants,
  };
}

function parseOAuthSession(value: unknown): StoredOAuthSession {
  if (!isRecord(value)) throw new Error("credential_store_corrupt");
  const { subject, subjectHash, clientId, accessToken, refreshToken, scopes, expiresAt } = value;
  if (
    typeof subject !== "string" ||
    subject.length < 1 ||
    subject.length > 512 ||
    typeof subjectHash !== "string" ||
    !/^[0-9a-f]{64}$/iu.test(subjectHash) ||
    typeof clientId !== "string" ||
    !isClientId(clientId) ||
    typeof accessToken !== "string" ||
    accessToken.length < 1 ||
    accessToken.length > MAX_TOKEN_LENGTH ||
    (refreshToken !== undefined &&
      (typeof refreshToken !== "string" ||
        refreshToken.length < 1 ||
        refreshToken.length > MAX_TOKEN_LENGTH)) ||
    !Array.isArray(scopes) ||
    scopes.length > 32 ||
    scopes.some((scope) => typeof scope !== "string" || scope.length > 200) ||
    typeof expiresAt !== "number" ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= 0
  ) {
    throw new Error("credential_store_corrupt");
  }
  return {
    subject,
    subjectHash,
    clientId,
    accessToken,
    ...(typeof refreshToken === "string" ? { refreshToken } : {}),
    scopes: [...scopes] as string[],
    expiresAt,
  };
}

function parsePairingGrant(value: unknown): StoredPairingGrant {
  if (!isRecord(value)) throw new Error("credential_store_corrupt");
  const { id, secretHash, createdAt } = value;
  if (
    typeof id !== "string" ||
    !/^[A-Za-z0-9_-]{22}$/u.test(id) ||
    typeof secretHash !== "string" ||
    !/^[0-9a-f]{64}$/iu.test(secretHash) ||
    typeof createdAt !== "number" ||
    !Number.isFinite(createdAt) ||
    createdAt <= 0
  ) {
    throw new Error("credential_store_corrupt");
  }
  return { id, secretHash, createdAt };
}

function cloneCredentialState(state: CredentialState): CredentialState {
  return parseCredentialState(JSON.parse(JSON.stringify(state)) as unknown);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defaultDataDirectory(): string {
  const localAppData = process.env.LOCALAPPDATA;
  return join(localAppData || join(homedir(), "AppData", "Local"), "Figma AI Design Engine");
}

function protectWithWindowsDpapi(value: string): Promise<string> {
  return runPowerShellDpapi("protect", value);
}

function unprotectWithWindowsDpapi(value: string): Promise<string> {
  return runPowerShellDpapi("unprotect", value);
}

function runPowerShellDpapi(action: "protect" | "unprotect", value: string): Promise<string> {
  if (process.platform !== "win32") return Promise.reject(new Error("secure_storage_unavailable"));
  if (Buffer.byteLength(value, "utf8") > MAX_STORE_BYTES) {
    return Promise.reject(new Error("secure_storage_unavailable"));
  }
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "try {",
    "  [System.Reflection.Assembly]::LoadWithPartialName('System.Security') | Out-Null",
    "  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)",
    "  $inputText = [Console]::In.ReadToEnd()",
    "  $separator = $inputText.IndexOf([char]10)",
    "  if ($separator -lt 0) { throw 'invalid_input' }",
    "  $action = $inputText.Substring(0, $separator)",
    "  $payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($inputText.Substring($separator + 1)))",
    "  if ($action -eq 'protect') {",
    "    $bytes = [Text.Encoding]::UTF8.GetBytes($payload)",
    "  } elseif ($action -eq 'unprotect') {",
    "    $bytes = [Convert]::FromBase64String($payload)",
    "  } else { throw 'invalid_action' }",
    `  $entropy = [Text.Encoding]::UTF8.GetBytes('${DPAPI_ENTROPY}')`,
    "  if ($action -eq 'protect') {",
    "    $result = [Security.Cryptography.ProtectedData]::Protect($bytes, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)",
    "  } elseif ($action -eq 'unprotect') {",
    "    $result = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)",
    "  } else { throw 'invalid_action' }",
    "  [Console]::Out.Write([Convert]::ToBase64String($result))",
    "} catch {",
    "  if ($_.Exception.ToString() -match 'user profile|data protection operation was unsuccessful') { [Console]::Error.WriteLine('secure_storage_profile_unavailable'); exit 2 }",
    "  [Console]::Error.WriteLine('secure_storage_failed'); exit 1",
    "}",
  ].join("\n");
  const encodedScript = Buffer.from(script, "utf16le").toString("base64");
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedScript],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let failed = false;
    const timeout = setTimeout(() => {
      failed = true;
      child.kill();
      reject(new Error("secure_storage_timeout"));
    }, 15_000);
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_STORE_BYTES * 2) {
        failed = true;
        child.kill();
        clearTimeout(timeout);
        reject(new Error("secure_storage_failed"));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.resume();
    child.once("error", () => {
      if (failed) return;
      failed = true;
      clearTimeout(timeout);
      reject(new Error("secure_storage_unavailable"));
    });
    child.once("close", (code) => {
      if (failed) return;
      clearTimeout(timeout);
      if (code === 2) {
        reject(new Error("secure_storage_profile_unavailable"));
        return;
      }
      if (code !== 0) {
        reject(
          new Error(
            action === "unprotect" ? "secure_storage_corrupt" : "secure_storage_unavailable",
          ),
        );
        return;
      }
      const output = Buffer.concat(stdout).toString("utf8").trim();
      if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(output)) {
        reject(new Error("secure_storage_failed"));
        return;
      }
      resolve(action === "protect" ? output : Buffer.from(output, "base64").toString("utf8"));
    });
    child.stdin.end(`${action}\n${Buffer.from(value, "utf8").toString("base64")}`);
  });
}
