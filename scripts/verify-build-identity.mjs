import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContentFingerprint, computeBuildIdentity } from "./build-identity.mjs";

export function verifyBuildIdentityRegression() {
  const base = [
    ["src/main.ts", "const value = 1;"],
    ["manifest.json", '{"main":"dist/plugin.js"}'],
  ];
  const sameInputsReordered = [...base].reverse();
  const changedSource = [
    ["src/main.ts", "const value = 2;"],
    base[1],
  ];
  assert.equal(buildContentFingerprint(base), buildContentFingerprint(sameInputsReordered));
  assert.notEqual(buildContentFingerprint(base), buildContentFingerprint(changedSource));
  assert.notEqual(
    buildContentFingerprint(base, { VITE_FW4_GEOMETRY: "off" }),
    buildContentFingerprint(base, { VITE_FW4_GEOMETRY: "fw4-geometry-v1" }),
  );

  const exported = mkdtempSync(join(tmpdir(), "fad-build-identity-"));
  const source = join(exported, "src");
  const entry = join(source, "ایجاد.ts");
  mkdirSync(source);
  try {
    const empty = computeBuildIdentity(exported, {});
    writeFileSync(entry, "export const version = 1;");
    const first = computeBuildIdentity(exported, {});
    assert.notEqual(first, empty);
    assert.equal(first, computeBuildIdentity(exported, {}));
    writeFileSync(entry, "export const version = 2;");
    assert.notEqual(first, computeBuildIdentity(exported, {}));
    unlinkSync(entry);
    assert.equal(empty, computeBuildIdentity(exported, {}));
  } finally {
    if (existsSync(entry)) unlinkSync(entry);
    rmdirSync(source);
    rmdirSync(exported);
  }
}
