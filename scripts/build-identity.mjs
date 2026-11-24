import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { posix, resolve } from "node:path";

const OVERRIDE_PATTERN = /^[A-Za-z0-9._:+-]{1,100}$/u;
const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;

export function buildContentFingerprint(inputs, environment = {}) {
  const hash = createHash("sha256");
  for (const [rawPath, contents] of [...inputs].sort(([left], [right]) => compare(left, right))) {
    hash.update(rawPath.replaceAll("\\", "/"));
    hash.update("\0");
    hash.update(contents);
    hash.update("\0");
  }
  for (const [key, value] of Object.entries(environment)
    .filter(([name]) => name.startsWith("VITE_") && name !== "VITE_FW7_BUILD_ID")
    .sort(([left], [right]) => compare(left, right))) {
    hash.update(key);
    hash.update("\0");
    hash.update(value ?? "");
    hash.update("\0");
  }
  return hash.digest("hex");
}

function sourcePaths(root, directory) {
  return readdirSync(resolve(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = posix.join(directory, entry.name);
    return entry.isDirectory() ? sourcePaths(root, path) : [path];
  });
}

function buildInputPaths(root) {
  const configuration = [
    "manifest.json",
    "package.json",
    "package-lock.json",
    "npm-shrinkwrap.json",
    "tsconfig.json",
    "tsconfig.companion.json",
    "scripts/build.mjs",
    "scripts/build-identity.mjs",
    "scripts/companion.mjs",
    "vite.plugin.config.ts",
    "vite.ui.config.ts",
    "node_modules/.package-lock.json",
    ".env",
    ".env.local",
    ".env.production",
    ".env.production.local",
  ].filter((path) => existsSync(resolve(root, path)));
  return [...configuration, ...sourcePaths(root, "src")];
}

export function computeBuildIdentity(root, environment = process.env) {
  const override = environment.VITE_FW7_BUILD_ID;
  if (override && OVERRIDE_PATTERN.test(override)) return override;

  let revision = "source";
  try {
    revision = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    // A source fingerprint still distinguishes builds outside a Git checkout.
  }

  const inputs = buildInputPaths(root).map((path) => [path, readFileSync(resolve(root, path))]);
  const fingerprint = buildContentFingerprint(inputs, environment);
  return `${revision === "source" ? "source" : `git-${revision}`}-${fingerprint}`;
}
