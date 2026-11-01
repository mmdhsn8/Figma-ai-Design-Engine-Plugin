import type { ResolvedTokenTables, ResolvedTypographyToken } from "./token-resolver";

const OWNER_KEY = "fad.design-system.asset";
const FINGERPRINT_KEY = "fad.design-system.fingerprint";

export type StyleRegistryApi = Pick<
  PluginAPI,
  "createPaintStyle" | "createTextStyle" | "getLocalPaintStylesAsync" | "getLocalTextStylesAsync"
>;

export interface StyleRegistryReport {
  created: string[];
  reused: string[];
  updated: string[];
  skipped: string[];
  fallbacks: string[];
  warnings: string[];
}

export interface StyleBindings {
  paintStyleIdByHex: Map<string, string>;
  textStyleIdByToken: Map<string, string>;
  report: StyleRegistryReport;
  rollback(): void;
}

interface FontStyles {
  byToken: Map<string, FontName>;
}

interface StyleUndo {
  style: PaintStyle | TextStyle;
  name: string;
  fingerprint: string;
  restore(): void;
}

function round(value: number): number {
  return Number(value.toFixed(5));
}

function rgbFromHex(hex: string): RGB {
  return {
    r: parseInt(hex.slice(1, 3), 16) / 255,
    g: parseInt(hex.slice(3, 5), 16) / 255,
    b: parseInt(hex.slice(5, 7), 16) / 255,
  };
}

function normalizedHex(hex: string): string {
  return hex.toUpperCase();
}

function paintFingerprint(style: PaintStyle): string {
  const solid = style.paints.length === 1 ? style.paints[0] : undefined;
  if (!solid || solid.type !== "SOLID") return "unsupported-paint";
  return JSON.stringify({
    type: solid.type,
    color: {
      r: round(solid.color.r),
      g: round(solid.color.g),
      b: round(solid.color.b),
    },
    opacity: solid.opacity ?? 1,
  });
}

function desiredPaintFingerprint(hex: string): string {
  const color = rgbFromHex(hex);
  return JSON.stringify({
    type: "SOLID",
    color: { r: round(color.r), g: round(color.g), b: round(color.b) },
    opacity: 1,
  });
}

function textFingerprint(style: TextStyle): string {
  return JSON.stringify({
    fontFamily: style.fontName.family,
    fontStyle: style.fontName.style,
    fontSize: style.fontSize,
    lineHeight: style.lineHeight,
    letterSpacing: style.letterSpacing,
    textDecoration: style.textDecoration,
  });
}

function desiredTextFingerprint(token: ResolvedTypographyToken, font: FontName): string {
  return JSON.stringify({
    fontFamily: font.family,
    fontStyle: font.style,
    fontSize: token.fontSize,
    lineHeight:
      token.lineHeight === undefined
        ? { unit: "AUTO" }
        : { unit: "PIXELS", value: token.lineHeight },
    letterSpacing:
      token.letterSpacing === undefined
        ? { unit: "PIXELS", value: 0 }
        : { unit: "PIXELS", value: token.letterSpacing },
    textDecoration: token.textDecoration?.toUpperCase() ?? "NONE",
  });
}

function tokenAssetId(namespace: string, category: string, token: string): string {
  return `design-system:${namespace}:${category}:${token}`;
}

function managedStyle<T extends PaintStyle | TextStyle>(
  styles: T[],
  assetId: string,
): T | undefined {
  return styles.find((style) => style.getPluginData(OWNER_KEY) === assetId);
}

function uniqueStyleName(base: string, used: Set<string>): string {
  if (!used.has(base)) return base;
  let suffix = 2;
  while (used.has(`${base} (FAD Engine ${suffix})`)) suffix++;
  return `${base} (FAD Engine ${suffix})`;
}

function paintStyleName(namespace: string, token: string): string {
  return `Design System/${namespace}/Color/${token.split(".").slice(1).join("/")}`;
}

function textStyleName(namespace: string, token: string): string {
  return `Design System/${namespace}/Typography/${token.split(".").slice(1).join("/")}`;
}

function setManagedMetadata(style: PaintStyle | TextStyle, assetId: string, fingerprint: string) {
  style.setPluginData(OWNER_KEY, assetId);
  style.setPluginData(FINGERPRINT_KEY, fingerprint);
}

function restoreStyle(
  style: PaintStyle | TextStyle,
  snapshot: PaintStyle | TextStyle,
  owner: string,
  fingerprint: string,
) {
  style.name = snapshot.name;
  if (style.type === "PAINT" && snapshot.type === "PAINT") style.paints = snapshot.paints;
  if (style.type === "TEXT" && snapshot.type === "TEXT") {
    style.fontName = snapshot.fontName;
    style.fontSize = snapshot.fontSize;
    style.lineHeight = snapshot.lineHeight;
    style.letterSpacing = snapshot.letterSpacing;
    style.textDecoration = snapshot.textDecoration;
  }
  style.setPluginData(OWNER_KEY, owner);
  style.setPluginData(FINGERPRINT_KEY, fingerprint);
}

function makePaintSnapshot(style: PaintStyle): PaintStyle {
  return {
    ...style,
    name: style.name,
    paints: style.paints,
    type: "PAINT",
  } as PaintStyle;
}

function makeTextSnapshot(style: TextStyle): TextStyle {
  return {
    ...style,
    name: style.name,
    fontName: style.fontName,
    fontSize: style.fontSize,
    lineHeight: style.lineHeight,
    letterSpacing: style.letterSpacing,
    textDecoration: style.textDecoration,
    type: "TEXT",
  } as TextStyle;
}

function setPaintValue(style: PaintStyle, hex: string): void {
  style.paints = [{ type: "SOLID", color: rgbFromHex(hex) }];
}

function setTextValue(style: TextStyle, token: ResolvedTypographyToken, font: FontName): void {
  style.fontName = font;
  style.fontSize = token.fontSize;
  style.lineHeight =
    token.lineHeight === undefined ? { unit: "AUTO" } : { unit: "PIXELS", value: token.lineHeight };
  style.letterSpacing =
    token.letterSpacing === undefined
      ? { unit: "PIXELS", value: 0 }
      : { unit: "PIXELS", value: token.letterSpacing };
  style.textDecoration = (token.textDecoration?.toUpperCase() as TextDecoration) ?? "NONE";
}

function matchTextDesired(style: TextStyle, fingerprint: string): boolean {
  return textFingerprint(style) === fingerprint;
}

function matchPaintDesired(style: PaintStyle, fingerprint: string): boolean {
  return paintFingerprint(style) === fingerprint;
}

export async function createOrReuseNativeStyles(
  api: StyleRegistryApi,
  namespace: string,
  tokens: ResolvedTokenTables,
  fonts: FontStyles,
  updateOwned: boolean,
): Promise<StyleBindings> {
  const paints = await api.getLocalPaintStylesAsync();
  const texts = await api.getLocalTextStylesAsync();
  const usedPaintNames = new Set(paints.map((style) => style.name));
  const usedTextNames = new Set(texts.map((style) => style.name));
  const created: Array<PaintStyle | TextStyle> = [];
  const undos: StyleUndo[] = [];
  const paintStyleIdByHex = new Map<string, string>();
  const textStyleIdByToken = new Map<string, string>();
  const report: StyleRegistryReport = {
    created: [],
    reused: [],
    updated: [],
    skipped: [],
    fallbacks: [],
    warnings: [],
  };

  const createPaint = (token: string, hex: string) => {
    const assetId = tokenAssetId(namespace, "color", token);
    const desired = desiredPaintFingerprint(hex);
    const existing = managedStyle(paints, assetId);
    if (existing) {
      const actual = paintFingerprint(existing);
      const ownedFingerprint = existing.getPluginData(FINGERPRINT_KEY);
      if (matchPaintDesired(existing, desired)) {
        paintStyleIdByHex.set(normalizedHex(hex), existing.id);
        report.reused.push(token);
        return;
      }
      if (updateOwned && ownedFingerprint && actual === ownedFingerprint) {
        const snapshot = makePaintSnapshot(existing);
        const oldFingerprint = ownedFingerprint;
        const oldOwner = existing.getPluginData(OWNER_KEY);
        undos.push({
          style: existing,
          name: existing.name,
          fingerprint: oldFingerprint,
          restore: () => restoreStyle(existing, snapshot, oldOwner, oldFingerprint),
        });
        setPaintValue(existing, hex);
        setManagedMetadata(existing, assetId, desired);
        paintStyleIdByHex.set(normalizedHex(hex), existing.id);
        report.updated.push(token);
        return;
      }
      report.skipped.push(token);
      report.warnings.push(
        `Owned color style “${token}” differs from the requested value and was left unchanged${ownedFingerprint && actual !== ownedFingerprint ? " because it was edited in Figma" : "; enable Update plugin-owned assets to update it"}.`,
      );
      return;
    }

    const style = api.createPaintStyle();
    created.push(style);
    style.name = uniqueStyleName(paintStyleName(namespace, token), usedPaintNames);
    usedPaintNames.add(style.name);
    setPaintValue(style, hex);
    setManagedMetadata(style, assetId, desired);
    paints.push(style);
    paintStyleIdByHex.set(normalizedHex(hex), style.id);
    report.created.push(token);
  };

  const createText = (token: string, value: ResolvedTypographyToken) => {
    const assetId = tokenAssetId(namespace, "typography", token);
    const font = fonts.byToken.get(token);
    if (!font) {
      report.fallbacks.push(`Typography/${token}`);
      report.warnings.push(
        `Text style “${token}” was skipped because no resolved font was loaded.`,
      );
      return;
    }
    const desired = desiredTextFingerprint(value, font);
    const existing = managedStyle(texts, assetId);
    if (existing) {
      const actual = textFingerprint(existing);
      const ownedFingerprint = existing.getPluginData(FINGERPRINT_KEY);
      if (matchTextDesired(existing, desired)) {
        textStyleIdByToken.set(token, existing.id);
        report.reused.push(token);
        return;
      }
      if (updateOwned && ownedFingerprint && actual === ownedFingerprint) {
        const snapshot = makeTextSnapshot(existing);
        const oldFingerprint = ownedFingerprint;
        const oldOwner = existing.getPluginData(OWNER_KEY);
        undos.push({
          style: existing,
          name: existing.name,
          fingerprint: oldFingerprint,
          restore: () => restoreStyle(existing, snapshot, oldOwner, oldFingerprint),
        });
        setTextValue(existing, value, font);
        setManagedMetadata(existing, assetId, desired);
        textStyleIdByToken.set(token, existing.id);
        report.updated.push(token);
        return;
      }
      report.skipped.push(token);
      report.warnings.push(
        `Owned text style “${token}” differs from the requested value and was left unchanged${ownedFingerprint && actual !== ownedFingerprint ? " because it was edited in Figma" : "; enable Update plugin-owned assets to update it"}.`,
      );
      return;
    }

    const style = api.createTextStyle();
    created.push(style);
    style.name = uniqueStyleName(textStyleName(namespace, token), usedTextNames);
    usedTextNames.add(style.name);
    setTextValue(style, value, font);
    setManagedMetadata(style, assetId, desired);
    texts.push(style);
    textStyleIdByToken.set(token, style.id);
    report.created.push(token);
  };

  try {
    for (const [token, hex] of tokens.colors) createPaint(token, hex);
    for (const [token, style] of tokens.typography) createText(token, style);
  } catch (error) {
    for (const undo of [...undos].reverse()) undo.restore();
    for (const style of [...created].reverse()) {
      try {
        style.remove();
      } catch {
        // Newly created style could have been removed by Figma during rollback.
      }
    }
    throw error;
  }

  const variableFallbackCount = tokens.spacing.size + tokens.radii.size;
  if (variableFallbackCount) {
    report.fallbacks.push(
      `Resolved numeric values (${variableFallbackCount} spacing/radius tokens)`,
    );
  }

  let rolledBack = false;
  return {
    paintStyleIdByHex,
    textStyleIdByToken,
    report,
    rollback() {
      if (rolledBack) return;
      rolledBack = true;
      for (const undo of [...undos].reverse()) undo.restore();
      for (const style of [...created].reverse()) {
        try {
          style.remove();
        } catch {
          // Newly created style could have been removed by Figma during rollback.
        }
      }
    },
  };
}

export function designSystemStylePlan(tokens: ResolvedTokenTables): {
  paintStyles: number;
  textStyles: number;
  numericFallbacks: number;
} {
  return {
    paintStyles: tokens.colors.size,
    textStyles: tokens.typography.size,
    numericFallbacks: tokens.spacing.size + tokens.radii.size,
  };
}

export function stableColorTokenId(namespace: string, token: string): string {
  return tokenAssetId(namespace, "color", token);
}

export function stableTypographyTokenId(namespace: string, token: string): string {
  return tokenAssetId(namespace, "typography", token);
}

export const designSystemAssetPluginDataKey = OWNER_KEY;
export const designSystemFingerprintPluginDataKey = FINGERPRINT_KEY;
