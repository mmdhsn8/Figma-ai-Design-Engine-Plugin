import assert from "node:assert/strict";
import { buildContentFingerprint } from "./build-identity.mjs";

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
}
