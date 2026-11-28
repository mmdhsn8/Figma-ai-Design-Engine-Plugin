import { describe, expect, it } from "vitest";
import { canonicalDesignProgram, normalizeDesignProgramLayout, parseDesignProgram, fingerprintDesignProgram, type DesignProgramNode, type DesignProgramV1 } from "../src/shared/design-program";
import { compileDesignProgram } from "../src/shared/design-program-adapter";
import type { DesignNode } from "../src/shared/schema";
import { compileDesignProgramOperations } from "../src/shared/design-program-operations";
import { FigmaToolBatchSchema, FigmaToolOperationSchema } from "../src/shared/figma-tools";
import { parseMultiScreenValue } from "../src/shared/multi-screen-schema";
import { auditVisualQuality } from "../src/shared/visual-quality";
import { UIToPluginSchema, type PluginToUIMessage, type UIToPluginMessage } from "../src/shared/messages";
import { createFigmaToolExecutor } from "../src/plugin/figma-tool-executor";
import { renderDesignProgramLocal } from "../src/plugin/design-program-spike";
import { renderMultiScreenDesign } from "../src/plugin/renderer";
import { inspectProgramGeometry, inspectProgramGeometrySettled } from "../src/plugin/design-program-geometry";
import { createMockApi, type MockNode } from "./figma-mock";
import { designProgramFixtures } from "./fixtures/design-programs";

const education = designProgramFixtures[0]!;
const booking = designProgramFixtures[1]!;
const analytics = designProgramFixtures[2]!;
const civic = designProgramFixtures[3]!;
const taskId = "phase2-local-task";
const documentId = "file-test-56-page_current";

function copy<T>(value: T): T {
  return structuredClone(value);
}

function nativeSnapshot(node: MockNode): unknown {
  return {
    type: node.type,
    name: node.name,
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height,
    characters: node.type === "TEXT" ? node.characters : undefined,
    layoutMode: node.layoutMode,
    fills: JSON.stringify(node.fills),
    strokes: JSON.stringify(node.strokes),
    clipsContent: node.clipsContent,
    overflowDirection: node.overflowDirection,
    pluginData: [...node.pluginData.entries()].sort(([a], [b]) => a.localeCompare(b)),
    children: node.children.map(nativeSnapshot),
  };
}

function localGeometryViolations(root: MockNode): string[] {
  const violations: string[] = [];
  const pending = [root];
  while (pending.length) {
    const parent = pending.pop()!;
    pending.push(...parent.children);
    if (parent.type !== "FRAME" || parent.layoutMode === "NONE") continue;
    for (const child of parent.children) {
      if (child.x < Number(parent.paddingLeft) - 0.5 || child.x + child.width > parent.width - Number(parent.paddingRight) + 0.5)
        violations.push(`${parent.name}/${child.name}: horizontal ${child.x},${child.width} exceeds ${parent.width}`);
      if (!(parent.clipsContent && parent.overflowDirection === "VERTICAL") &&
        (child.y < Number(parent.paddingTop) - 0.5 || child.y + child.height > parent.height - Number(parent.paddingBottom) + 0.5))
        violations.push(`${parent.name}/${child.name}: vertical ${child.y},${child.height} exceeds ${parent.height}`);
    }
  }
  return violations;
}

function countProgramRegions(program: { screens: Array<{ root: { type: string; children?: unknown[] } }> }): number {
  let count = 0;
  const visit = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const typed = node as { type?: string; children?: unknown[] };
    if (typed.type === "container") count++;
    typed.children?.forEach(visit);
  };
  program.screens.forEach(({ root }) => visit(root));
  return count;
}

function taskNativeRequest(message: unknown) {
  return UIToPluginSchema.parse(message) as Extract<UIToPluginMessage, { type: "task-native-inspect" }>;
}

function resultFor(messages: PluginToUIMessage[], batchId: string) {
  return [...messages].reverse().find((message) => message.type === "tool-result" && message.batchId === batchId);
}

async function runOperationBatch(
  executor: ReturnType<typeof createFigmaToolExecutor>,
  batch: ReturnType<typeof FigmaToolBatchSchema.parse>,
) {
  await executor(batch);
}

describe("DesignProgramV1 local cross-domain spike", () => {
  it("validates and fingerprints one generic contract across three domains and an unseen fourth", () => {
    for (const fixture of designProgramFixtures) {
      const parsed = parseDesignProgram(fixture);
      expect(parsed.success, JSON.stringify(parsed.success ? [] : parsed.findings)).toBe(true);
      if (parsed.success) {
        expect(parsed.fingerprint).toMatch(/^dpv1-[a-f0-9]{16}$/u);
        expect(fingerprintDesignProgram(parsed.data)).toBe(parsed.fingerprint);
        const reordered = Object.fromEntries(Object.entries(parsed.data).reverse());
        expect(fingerprintDesignProgram(reordered as typeof parsed.data)).toBe(parsed.fingerprint);
      }
    }

    const malformed = copy(education) as Record<string, unknown>;
    malformed.programVersion = 2;
    expect(parseDesignProgram(malformed)).toMatchObject({ success: false, findings: [{ code: "invalid_schema" }] });

    const duplicate = copy(education) as unknown as { screens: Array<{ root: { children: unknown[] } }> };
    duplicate.screens[0]!.root.children.push(copy(duplicate.screens[0]!.root.children[0]));
    expect(parseDesignProgram(duplicate)).toMatchObject({ success: false, findings: [{ code: "duplicate_id" }] });

    const cycle = copy(education) as unknown as { screens: Array<Record<string, unknown>> };
    cycle.screens.push({ ...copy(cycle.screens[0]!), id: "second", order: 1, dependsOn: [cycle.screens[0]!.id] });
    cycle.screens[0]!.dependsOn = ["second"];
    expect(parseDesignProgram(cycle)).toMatchObject({ success: false, findings: expect.arrayContaining([expect.objectContaining({ code: "dependency_cycle" })]) });

    const missingDependency = copy(education) as unknown as { screens: Array<Record<string, unknown>> };
    missingDependency.screens[0]!.dependsOn = ["missing-screen"];
    expect(parseDesignProgram(missingDependency)).toMatchObject({ success: false, findings: [{ code: "missing_dependency" }] });

    const tooManyScreens = copy(education) as unknown as { screens: unknown[] };
    tooManyScreens.screens = Array.from({ length: 11 }, (_, index) => ({ ...copy(education.screens[0]), id: `screen-${index}`, order: index }));
    expect(parseDesignProgram(tooManyScreens)).toMatchObject({ success: false, findings: [{ code: "invalid_schema" }] });

    const deep = copy(education) as unknown as { screens: Array<{ root: unknown }> };
    let deepRoot: unknown = { type: "text", id: "deep-leaf", name: "Deep leaf", semanticRole: "content", width: { mode: "fixed", value: 20 }, height: { mode: "fixed", value: 20 }, text: "Leaf", color: "#111111" };
    for (let index = 0; index < 9; index++) deepRoot = { type: "container", id: `deep-${index}`, name: `Deep ${index}`, semanticRole: "region", width: { mode: "fixed", value: 100 }, height: { mode: "fixed", value: 100 }, layout: { axis: "column" }, children: [deepRoot] };
    deep.screens[0]!.root = deepRoot;
    expect(parseDesignProgram(deep)).toMatchObject({ success: false, findings: expect.arrayContaining([expect.objectContaining({ code: "depth_limit" })]) });

    const dense = copy(education) as unknown as { screens: Array<{ root: { children: unknown[] } }> };
    dense.screens[0]!.root.children = Array.from({ length: 4 }, (_, groupIndex) => ({
      type: "container", id: `dense-${groupIndex}`, name: `Dense ${groupIndex}`, semanticRole: "region",
      width: { mode: "fixed", value: 100 }, height: { mode: "fixed", value: 100 }, layout: { axis: "column" },
      children: Array.from({ length: 80 }, (_, nodeIndex) => ({ type: "text", id: `dense-${groupIndex}-${nodeIndex}`, name: "Dense item", semanticRole: "data", width: { mode: "fixed", value: 80 }, height: { mode: "hug", value: 16, min: 16 }, text: "Value", color: "#111111" })),
    }));
    expect(parseDesignProgram(dense)).toMatchObject({ success: false, findings: expect.arrayContaining([expect.objectContaining({ code: "node_limit" })]) });

    const unverified = copy(education) as unknown as Record<string, unknown>;
    unverified.references = [{ kind: "component", ref: "shared/button", verified: false, authorized: false }];
    expect(parseDesignProgram(unverified)).toMatchObject({ success: false, findings: expect.arrayContaining([expect.objectContaining({ code: "reference_unverified" }), expect.objectContaining({ code: "unsupported_component_reference" })]) });

    const unsupportedVariable = copy(education) as unknown as Record<string, unknown>;
    unsupportedVariable.references = [{ kind: "variable", ref: "workspace/color/brand", verified: true, authorized: true }];
    expect(parseDesignProgram(unsupportedVariable)).toMatchObject({ success: false, findings: [{ code: "unsupported_variable_reference" }] });

    const unsafe = copy(education) as unknown as { screens: Array<{ root: { children: Array<Record<string, unknown>> } }> };
    unsafe.screens[0]!.root.children.push({ type: "image", id: "external-image", name: "External", semanticRole: "image", width: { mode: "fixed", value: 80 }, height: { mode: "fixed", value: 80 }, asset: { source: "placeholder", label: "Image" }, url: "https://example.invalid/asset.png" });
    expect(parseDesignProgram(unsafe)).toMatchObject({ success: false, findings: [{ code: "invalid_schema" }] });

    const unsupported = copy(education) as unknown as { screens: Array<{ scroll: string }> };
    unsupported.screens[0]!.scroll = "horizontal";
    expect(parseDesignProgram(unsupported)).toMatchObject({ success: false, findings: [{ code: "unsupported_horizontal_scroll" }] });

    const tooSmall = copy(education) as unknown as { screens: Array<{ root: { children: Array<Record<string, unknown>> } }> };
    tooSmall.screens[0]!.root.children.push({ type: "text", id: "tiny-action", name: "Tiny action", semanticRole: "action", interaction: "button", width: { mode: "fixed", value: 32 }, height: { mode: "fixed", value: 32 }, text: "Go", color: "#111111" });
    expect(parseDesignProgram(tooSmall)).toMatchObject({ success: false, findings: expect.arrayContaining([expect.objectContaining({ code: "touch_target_below_minimum" })]) });

    const unsupportedAsset = copy(education) as unknown as { screens: Array<{ root: { children: Array<Record<string, unknown>> } }> };
    unsupportedAsset.screens[0]!.root.children.push({ type: "image", id: "private-image", name: "Private image", semanticRole: "image", width: { mode: "fixed", value: 100 }, height: { mode: "fixed", value: 100 }, asset: { source: "authorized-existing-file", assetRef: "asset:123", label: "Existing file image", verified: false, authorized: false } });
    expect(parseDesignProgram(unsupportedAsset)).toMatchObject({ success: false, findings: expect.arrayContaining([expect.objectContaining({ code: "asset_provenance_unverified" }), expect.objectContaining({ code: "unsupported_asset_source" })]) });
  });

  it("budgets fixed axes, wrapped rows and Figma HUG/FILL constraints without repairing intentional non-scroll overflow", () => {
    const overflowing = copy(education) as unknown as DesignProgramV1;
    const root = overflowing.screens[0]!.root;
    if (root.type !== "container") throw new Error("Fixture needs a container.");
    root.height = { ...root.height, value: 500 };
    expect(parseDesignProgram(overflowing)).toMatchObject({
      success: false,
      findings: expect.arrayContaining([expect.objectContaining({
        code: "layout_axis_overflow",
        path: "screens.student-home.root.overview",
        message: expect.stringContaining("needs at least 632 px"),
      })]),
    });
    const normalized = normalizeDesignProgramLayout(overflowing);
    expect(normalized.repairs).toEqual([{
      path: "screens.student-home.root.overview.height",
      before: 500,
      after: 632,
      required: 632,
    }]);
    expect(parseDesignProgram(normalized.program).success).toBe(true);
    expect(normalizeDesignProgramLayout(normalized.program)).toEqual({ program: normalized.program, repairs: [] });

    const intentional = copy(overflowing);
    intentional.screens[0]!.scroll = "none";
    expect(normalizeDesignProgramLayout(intentional)).toEqual({ program: intentional, repairs: [] });
    expect(parseDesignProgram(intentional).findings).toContainEqual(expect.objectContaining({ code: "layout_axis_overflow" }));

    const wrapped = copy(booking) as unknown as DesignProgramV1;
    const wrappedRoot = wrapped.screens[0]!.root;
    if (wrappedRoot.type !== "container") throw new Error("Fixture needs a container.");
    const dates = wrappedRoot.children.find((node) => node.id === "dates");
    if (dates?.type !== "container") throw new Error("Fixture needs wrapped date choices.");
    dates.layout.wrap = true;
    dates.height = { ...dates.height, value: 100 };
    for (const child of dates.children) child.width = { mode: "fixed", value: 150 };
    expect(parseDesignProgram(wrapped).findings).toContainEqual(expect.objectContaining({
      code: "layout_cross_axis_overflow",
      path: "screens.appointment.root.dates",
      message: expect.stringContaining("wrapped row heights"),
    }));

    const invalidSizing = copy(education) as unknown as DesignProgramV1;
    const sizingRoot = invalidSizing.screens[0]!.root;
    if (sizingRoot.type !== "container") throw new Error("Fixture needs a container.");
    sizingRoot.width = { mode: "hug", value: sizingRoot.width.value };
    sizingRoot.children[0]!.width = { mode: "fill", value: 318 };
    expect(parseDesignProgram(invalidSizing).findings).toContainEqual(expect.objectContaining({ code: "fill_sizing_under_hug_parent" }));
    sizingRoot.width = { mode: "fixed", value: 342 };
    sizingRoot.children[0]!.width = { mode: "hug", value: 318 };
    sizingRoot.children[0]!.height = { mode: "fixed", value: 32 };
    expect(parseDesignProgram(invalidSizing).findings).toContainEqual(expect.objectContaining({ code: "text_hug_width_requires_hug_height" }));
    sizingRoot.children[0]!.width = { mode: "fixed", value: 318 };
    sizingRoot.children[2]!.width = { mode: "hug", value: 318 };
    expect(parseDesignProgram(invalidSizing).findings).toContainEqual(expect.objectContaining({ code: "unsupported_hug_sizing" }));

    const hugText = copy(education) as unknown as DesignProgramV1;
    const hugRoot = hugText.screens[0]!.root;
    if (hugRoot.type !== "container") throw new Error("Fixture needs a container.");
    const heading = hugRoot.children[0]!;
    heading.height = { mode: "hug", value: 80, min: 80 };
    hugRoot.children = [heading];
    hugRoot.height = { mode: "fixed", value: 90 };
    expect(parseDesignProgram(hugText).findings).toContainEqual(expect.objectContaining({
      code: "layout_axis_overflow",
      message: expect.stringContaining("needs at least 104 px"),
    }));
    expect(normalizeDesignProgramLayout(hugText).repairs).toEqual([{
      path: "screens.student-home.root.overview.height",
      before: 90,
      after: 104,
      required: 104,
    }]);
  });

  it("uses one text-sizing contract across axes, languages, screen counts, bounds and scrolling", () => {
    const getFirstText = (nodes: DesignProgramNode[]): Extract<DesignProgramNode, { type: "text" }> => {
      for (const node of nodes) {
        if (node.type === "text") return node;
        if (node.type === "container") {
          const nested = getFirstText(node.children);
          if (nested) return nested;
        }
      }
      throw new Error("Fixture needs native text.");
    };
    for (const direction of ["rtl", "ltr"] as const) {
      for (const screenCount of [1, 2, 3, 10] as const) {
        const program = copy(education) as unknown as DesignProgramV1;
        program.locale = { language: direction === "rtl" ? "fa-IR" : "en-US", direction };
        const sourceScreen = copy(education.screens[0]!) as unknown as DesignProgramV1["screens"][number];
        program.screens = Array.from({ length: screenCount }, (_, index) => ({
          ...sourceScreen, id: `screen-${String(index + 1).padStart(2, "0")}`, title: `Learning overview ${index + 1}`, order: index, dependsOn: [],
        }));
        const title = getFirstText([program.screens[0]!.root]);
        title.text = direction === "rtl" ? "سلام و خوش آمدید" : "Welcome home";
        expect(parseDesignProgram(program).success, `${direction}/${screenCount}`).toBe(true);
        const compiled = compileDesignProgram(program);
        expect(compiled.success, `${direction}/${screenCount}: ${JSON.stringify(compiled.success ? [] : compiled.findings)}`).toBe(true);
        if (!compiled.success) continue;
        expect(compiled.batch.screens).toHaveLength(screenCount);
        expect(compiled.batch.screens[0]?.metadata).toMatchObject({ direction });
      }
    }

    for (const parentAxis of ["row", "column"] as const) {
      for (const direction of ["rtl", "ltr"] as const) {
        for (const widthMode of ["fixed", "hug", "fill"] as const) {
          for (const heightMode of ["fixed", "hug", "fill"] as const) {
            const program = copy(education) as unknown as DesignProgramV1;
            program.locale = { language: direction === "rtl" ? "fa-IR" : "en-US", direction };
            const screen = program.screens[0]!;
            if (screen.root.type !== "container") throw new Error("Fixture needs a screen container.");
            screen.root.layout.axis = parentAxis;
            const text = getFirstText([screen.root]);
            screen.root.children = [text];
            const multiline = widthMode === "fixed" && heightMode === "fixed";
            text.text = direction === "rtl"
              ? multiline ? "خانه\nخوش آمدید" : "خانه"
              : multiline ? "Home\nWelcome" : "Home";
            text.align = undefined;
            text.fontSize = 12;
            text.width = { mode: widthMode, value: widthMode === "hug" ? 64 : 120 };
            text.height = heightMode === "fixed"
              ? { mode: "fixed", value: 24, max: multiline ? 32 : 24 }
              : { mode: heightMode, value: 24 };

            const normalized = normalizeDesignProgramLayout(program);
            if (heightMode === "fixed") {
              expect(normalized.repairs).toContainEqual(expect.objectContaining({
                kind: "text-height", path: `screens.${screen.id}.root.overview.${text.id}.height`, before: "fixed", after: "hug", preservedMinimum: 24,
              }));
              expect(getFirstText([normalized.program.screens[0]!.root])).toMatchObject({ height: { mode: "hug", min: 24 } });
            } else if (heightMode === "fill") {
              expect(normalized.repairs).toEqual([]);
              expect(parseDesignProgram(normalized.program).findings).toContainEqual(expect.objectContaining({ code: "text_height_fill_unsupported" }));
              continue;
            } else {
              expect(normalized.repairs).toEqual([]);
            }
            expect(parseDesignProgram(normalized.program).success, `${parentAxis}/${direction}/${widthMode}/${heightMode}`).toBe(true);
            expect(normalizeDesignProgramLayout(normalized.program)).toEqual({ program: normalized.program, repairs: [] });
            const compiled = compileDesignProgram(normalized.program);
            expect(compiled.success, `${parentAxis}/${direction}/${widthMode}/${heightMode}`).toBe(true);
            if (!compiled.success) continue;
            const allNative = compiled.batch.screens[0]!.children.flatMap((root) => root.type === "frame" ? root.children : []);
            const findText = (nodes: readonly DesignNode[]): Extract<DesignNode, { type: "text" }> | undefined => {
              for (const node of nodes) {
                if (node.type === "text") return node;
                if (node.type === "frame") {
                  const nested = findText(node.children);
                  if (nested) return nested;
                }
              }
              return undefined;
            };
            expect(findText(allNative), `${parentAxis}/${direction}/${widthMode}/${heightMode}`).toMatchObject({
              textAutoResize: widthMode === "hug" ? "width-and-height" : "height",
              textAlign: direction === "rtl" ? "right" : "left",
              sizing: { width: widthMode, height: "hug" },
            });
          }
        }
      }
    }

    const boundedParent = copy(education) as unknown as DesignProgramV1;
    const boundedRoot = boundedParent.screens[0]!.root;
    if (boundedRoot.type !== "container") throw new Error("Fixture needs a screen container.");
    const fillText = getFirstText([boundedRoot]);
    boundedRoot.width = { mode: "hug", value: boundedRoot.width.value };
    fillText.width = { mode: "fill", value: 120 };
    fillText.height = { mode: "hug", value: 24 };
    expect(parseDesignProgram(boundedParent).findings).toContainEqual(expect.objectContaining({ code: "fill_sizing_under_hug_parent" }));

    const capped = copy(education) as unknown as DesignProgramV1;
    const cappedText = getFirstText([capped.screens[0]!.root]);
    cappedText.width = { mode: "hug", value: 8, max: 8 };
    cappedText.height = { mode: "hug", value: 24 };
    expect(parseDesignProgram(capped).findings).toContainEqual(expect.objectContaining({ code: "text_content_exceeds_max_width" }));

    const cappedHeight = copy(education) as unknown as DesignProgramV1;
    const cappedHeightText = getFirstText([cappedHeight.screens[0]!.root]);
    cappedHeightText.text = "This paragraph must wrap into several lines inside its bounded text width.";
    cappedHeightText.width = { mode: "fixed", value: 48 };
    cappedHeightText.height = { mode: "hug", value: 24, max: 24 };
    expect(parseDesignProgram(cappedHeight).findings).toContainEqual(expect.objectContaining({ code: "text_content_exceeds_max_height" }));

    const longContent = copy(education) as unknown as DesignProgramV1;
    longContent.screens[0]!.scroll = "vertical";
    const longRoot = longContent.screens[0]!.root;
    if (longRoot.type !== "container") throw new Error("Fixture needs a screen container.");
    longRoot.height = { mode: "fixed", value: 180 };
    const paragraph = getFirstText([longRoot]);
    paragraph.text = longContent.locale.direction === "rtl"
      ? "هذا نص طويل للتأكد من التفاف السطر وامتداد المحتوى داخل منطقة قابلة للتمرير مع بقاء جميع الكلمات قابلة للتحرير والقراءة."
      : "This deliberately long paragraph checks that wrapping can grow inside a vertical scroll body while preserving the full editable copy.";
    paragraph.width = { mode: "fill", value: 318 };
    paragraph.height = { mode: "hug", value: 24 };
    const scrolled = normalizeDesignProgramLayout(longContent);
    expect(scrolled.repairs.some((repair) => "required" in repair && repair.after > repair.before)).toBe(true);
    expect(parseDesignProgram(scrolled.program).success).toBe(true);
    const scrollCompile = compileDesignProgram(scrolled.program);
    expect(scrollCompile.success).toBe(true);
    if (scrollCompile.success) {
      const screen = scrollCompile.batch.screens[0]!;
      const wrapper = screen.children[0];
      if (wrapper?.type !== "frame") throw new Error("Expected scroll content wrapper.");
      expect(wrapper.children[0]).toMatchObject({ type: "frame" });
      expect(screen.metadata?.scroll).toBe("vertical");
    }
  });

  it.each([["rtl", "start", "end"], ["rtl", "end", "start"], ["ltr", "start", "start"]] as const)(
    "maps %s column cross-axis %s to native %s for a fixed-width child", (direction, crossAlign, expected) => {
      const parsed = parseDesignProgram(copy(direction === "rtl" ? education : analytics));
      if (!parsed.success) throw new Error(JSON.stringify(parsed.findings));
      const root = parsed.data.screens[0]!.root;
      if (root.type !== "container") throw new Error("Fixture needs a container.");
      root.layout = { ...root.layout, axis: "column", crossAlign };
      root.height = { ...root.height, value: 1_644 };
      const compiled = compileDesignProgram(parsed.data);
      if (!compiled.success) throw new Error(JSON.stringify(compiled.findings));
      const wrapper = compiled.batch.screens[0]!.children[0];
      if (wrapper?.type !== "frame") throw new Error("Expected a native content wrapper.");
      expect(wrapper.children[0]).toMatchObject({ type: "frame", layout: { mode: "vertical", counterAxisAlign: expected } });
    },
  );

  it("compiles the same native adapter for education, booking, analytics, and unseen civic services", () => {
    const compiled = designProgramFixtures.map((fixture) => compileDesignProgram(fixture));
    expect(compiled.every((result) => result.success), JSON.stringify(compiled.map((result) => result.success ? [] : result.findings))).toBe(true);
    const batches = compiled.map((result) => {
      if (!result.success) throw new Error(JSON.stringify(result.findings));
      return result.batch;
    });
    expect(batches.map(({ screens }) => screens[0]!.metadata?.direction)).toEqual(["rtl", "rtl", "ltr", "ltr"]);
    expect(batches.map(({ screens }) => screens[0]!.devicePreset)).toEqual(["mobile", "mobile", "desktop", "mobile"]);
    expect(batches.map(({ screens }) => screens[0]!.children[0]!.type)).toEqual(["frame", "frame", "frame", "frame"]);
    expect(new Set(batches.map(({ id }) => id)).size).toBe(4);
    expect(compiled.every((result) => result.success && result.semanticRoles.length > 0)).toBe(true);
    expect(compiled.every((result) => result.success && !result.findings.some(({ code }) => code === "quality_low-contrast" || code === "quality_small-touch-target")), JSON.stringify(compiled.map((result) => result.success ? result.findings : result.findings))).toBe(true);
    expect((batches[0]!.screens[0]!.children[0] as { height: number }).height).toBeGreaterThan(batches[0]!.screens[0]!.height);
    const roles = compiled.map((result) => result.success ? new Set(result.semanticRoles.map(({ role }) => role)) : new Set<string>());
    expect(roles[0]!.has("lesson-navigation")).toBe(true);
    expect(roles[1]!.has("date-options") && roles[1]!.has("time-options")).toBe(true);
    expect(roles[2]!.has("navigation-region") && roles[2]!.has("kpi-group") && roles[2]!.has("data-table")).toBe(true);
    expect(roles[3]!.has("document-checklist")).toBe(true);

    const placeholderProgram = copy(civic) as unknown as { screens: Array<{ root: { children: unknown[] } }> };
    placeholderProgram.screens[0]!.root.children.push({ type: "image", id: "approved-placeholder", name: "Service illustration", semanticRole: "illustration", width: { mode: "fixed", value: 260 }, height: { mode: "fixed", value: 120 }, asset: { source: "placeholder", label: "Resident service illustration" } });
    const placeholderAdapter = compileDesignProgram(placeholderProgram);
    expect(placeholderAdapter.success).toBe(true);
    if (placeholderAdapter.success) {
      const content = placeholderAdapter.batch.screens[0]!.children[0];
      expect(content?.type).toBe("frame");
      if (content?.type === "frame") {
        const programRoot = content.children.find((node) => node.name === "Resident service dashboard");
        expect(programRoot?.type).toBe("frame");
        if (programRoot?.type === "frame") expect(programRoot.children.at(-1)).toMatchObject({ type: "frame", children: [{ type: "text", text: "Placeholder · Resident service illustration" }] });
      }
      const placeholderToolPlan = compileDesignProgramOperations(placeholderProgram, { documentId, pageId: "page:current", taskId });
      expect(placeholderToolPlan.success).toBe(true);
      if (placeholderToolPlan.success) expect(placeholderToolPlan.operations.some(({ action }) => action.tool === "create_text" && action.text.includes("Placeholder ·"))).toBe(true);
    }
  });

  it("executes Candidate B through the existing scoped typed-tool executor and safely replays after restart", async () => {
    for (const [index, fixture] of designProgramFixtures.entries()) {
      const plan = compileDesignProgramOperations(fixture, { documentId, pageId: "page:current", taskId });
      expect(plan.success, JSON.stringify(plan.success ? [] : plan.findings)).toBe(true);
      if (!plan.success) continue;
      for (const operation of plan.operations) {
        if (operation.action.tool !== "create_text") continue;
        expect(operation.action.verticalSizing).toBe("HUG");
        expect(operation.action.textAutoResize).toBe(
          operation.action.horizontalSizing === "HUG" ? "WIDTH_AND_HEIGHT" : "HEIGHT",
        );
      }
      expect(plan.batches.every((batch) => batch.length <= 10)).toBe(true);
      const mock = createMockApi();
      const messages: PluginToUIMessage[] = [];
      let executor = createFigmaToolExecutor(mock.api, (message) => messages.push(message));
      const firstBatchId = `dpb${String(index).padStart(2, "0")}000000`;
      const firstBatch = FigmaToolBatchSchema.parse({ type: "tool-execute", protocolVersion: 1, batchId: firstBatchId, operations: plan.operations.slice(0, 1) });
      await runOperationBatch(executor, firstBatch);
      expect(resultFor(messages, firstBatch.batchId)).toMatchObject({ type: "tool-result", success: true, committedOperationIds: [plan.operations[0]!.operationId] });
      const nodeCountAfterFirstNativeWrite = mock.nodes.length;
      expect(nodeCountAfterFirstNativeWrite).toBeGreaterThan(0);

      // Model an interruption after the first committed native operation, then restart and replay it.
      executor = createFigmaToolExecutor(mock.api, (message) => messages.push(message));
      await runOperationBatch(executor, firstBatch);
      expect(resultFor(messages, firstBatch.batchId)).toMatchObject({ type: "tool-result", success: true, results: [{ replayed: true }] });
      expect(mock.nodes).toHaveLength(nodeCountAfterFirstNativeWrite);

      const remainingOperations = plan.operations.slice(1);
      const remainingBatches = Array.from({ length: Math.ceil(remainingOperations.length / 10) }, (_, batchIndex) => FigmaToolBatchSchema.parse({
        type: "tool-execute", protocolVersion: 1,
        batchId: `dpb${String(index).padStart(2, "0")}${String(batchIndex + 1).padStart(6, "0")}`,
        operations: remainingOperations.slice(batchIndex * 10, batchIndex * 10 + 10),
      }));
      for (const batch of remainingBatches) {
        await runOperationBatch(executor, batch);
        expect(resultFor(messages, batch.batchId), JSON.stringify(resultFor(messages, batch.batchId))).toMatchObject({ type: "tool-result", success: true });
      }
      const nodeCountAfter = mock.nodes.length;
      expect(nodeCountAfter).toBeGreaterThan(0);
      expect(mock.nodes).toHaveLength(nodeCountAfter);
      expect(mock.nodes.filter((node) => node.parent?.type === "PAGE")).toHaveLength(1);
    }

    const vectorProgram = copy(education) as unknown as { screens: Array<{ root: { children: unknown[] } }> };
    vectorProgram.screens[0]!.root.children.push({ type: "vector", id: "vector-mark", name: "Vector mark", semanticRole: "illustration", interaction: "none", width: { mode: "fixed", value: 24 }, height: { mode: "fixed", value: 24 }, pathData: "M 0 0 L 24 0 L 24 24 Z", fill: "#3457D5" });
    const rejected = compileDesignProgramOperations(vectorProgram, { documentId, pageId: "page:current", taskId });
    expect(rejected).toMatchObject({ success: false, findings: [{ code: "unsupported_tool_primitive" }] });

    const badScope = compileDesignProgramOperations(education, { documentId: "other-document", pageId: "page:current", taskId });
    expect(badScope.success).toBe(true);
    if (badScope.success) {
      const mock = createMockApi();
      const messages: PluginToUIMessage[] = [];
      const executor = createFigmaToolExecutor(mock.api, (message) => messages.push(message));
      const batch = FigmaToolBatchSchema.parse({ type: "tool-execute", protocolVersion: 1, batchId: "wrong-doc-0001", operations: badScope.batches[0] });
      await runOperationBatch(executor, batch);
      expect(resultFor(messages, batch.batchId)).toMatchObject({ type: "tool-result", success: false });
      expect(mock.nodes).toHaveLength(0);
    }
  });

  it("rejects a forged renderer node ref outside the completed screen subtree without collateral writes", async () => {
    const compiled = compileDesignProgram(education);
    expect(compiled.success).toBe(true);
    if (!compiled.success) return;
    const mock = createMockApi();
    await renderMultiScreenDesign(mock.api, compiled.batch, { resume: true });
    const root = mock.api.currentPage.children[0] as unknown as MockNode;
    const beforeNodeCount = mock.nodes.length;
    const executor = createFigmaToolExecutor(mock.api, () => undefined);
    await expect(executor.registerRenderedGeneration({
      taskId,
      documentId,
      pageId: "page:current",
      batchId: compiled.batch.id,
      roots: [{ screenId: "student-home", rootNodeId: root.id, nodes: [{ nodeId: "foreign-or-forged-node", ref: "forged-native-ref", semanticRole: "heading" }] }],
    })).rejects.toThrow("subtree changed");
    expect(mock.nodes).toHaveLength(beforeNodeCount);
    expect(mock.nodes.every((node) => node.getPluginData("fad.tool.task-id.v1") === "")).toBe(true);
    expect(mock.nodes.every((node) => node.getPluginData("fad.tool.logical-ref.v1") === "")).toBe(true);
    expect(mock.storage.size).toBe(0);
  });

  it("rolls back task-ref claims when adoption persistence fails, then resumes the same root", async () => {
    const mock = createMockApi();
    const executor = createFigmaToolExecutor(mock.api, () => undefined);
    const storage = (mock.api as unknown as { clientStorage: { setAsync(key: string, value: unknown): Promise<void> } }).clientStorage;
    const originalSet = storage.setAsync.bind(storage);
    let rejectFirstWrite = true;
    storage.setAsync = async (key, value) => {
      if (rejectFirstWrite) {
        rejectFirstWrite = false;
        throw new Error("Simulated adoption checkpoint rejection");
      }
      await originalSet(key, value);
    };

    const interrupted = await renderDesignProgramLocal(mock.api, education, { taskId, documentId, pageId: "page:current", executor });
    expect(interrupted).toMatchObject({ success: false, code: "native_render_error" });
    const rootsAfterFailure = mock.nodes.filter((node) => node.parent?.type === "PAGE" && node.getPluginData("fad.multi-screen.batch-id"));
    expect(rootsAfterFailure).toHaveLength(1);
    expect(mock.nodes.every((node) => node.getPluginData("fad.tool.task-id.v1") === "")).toBe(true);
    expect(mock.nodes.every((node) => node.getPluginData("fad.tool.logical-ref.v1") === "")).toBe(true);
    expect(mock.storage.size).toBe(0);

    const resumed = await renderDesignProgramLocal(mock.api, education, { taskId, documentId, pageId: "page:current", executor });
    expect(resumed.success).toBe(true);
    const rootsAfterResume = mock.nodes.filter((node) => node.parent?.type === "PAGE" && node.getPluginData("fad.multi-screen.batch-id"));
    expect(rootsAfterResume).toHaveLength(1);
    expect(mock.nodes.filter((node) => node.getPluginData("fad.tool.task-id.v1") === taskId).length).toBeGreaterThan(0);
    expect(mock.storage.size).toBe(1);
  });

  it("treats Figma's null render bounds for intentionally invisible text as non-rendered ink, not incomplete geometry", async () => {
    const mock = createMockApi();
    const executor = createFigmaToolExecutor(mock.api, () => undefined);
    const compiled = compileDesignProgram(education);
    expect(compiled.success).toBe(true);
    if (!compiled.success) return;
    const result = await renderDesignProgramLocal(mock.api, education, { taskId, documentId, pageId: "page:current", executor });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const root = mock.nodes.find(({ id }) => id === result.roots[0]!.nodeId)!;
    const text = mock.nodes.find((node) => node.type === "TEXT")!;
    text.visible = false;
    Object.defineProperty(text, "absoluteRenderBounds", { configurable: true, get: () => null });
    const native = compiled.batch.screens[0]!;
    const report = inspectProgramGeometry(root as unknown as FrameNode, {
      taskId, pageId: "page:current",
      expected: { width: native.width, height: native.height, scroll: true, children: native.children, assets: [], compareText: true },
      verifyLayoutSizing: true,
    });
    expect(report.coverage).toBe("complete");
    expect(report.findings.map(({ code }) => code)).not.toContain("native_text_bounds_unavailable");
  });

  it("waits for the same attached root's text bounds to settle instead of failing a new render", async () => {
    const mock = createMockApi();
    const originalCreateText = mock.api.createText.bind(mock.api);
    mock.api.createText = (() => {
      const text = originalCreateText();
      const bounds = Object.getOwnPropertyDescriptor(text, "absoluteRenderBounds")!;
      let unavailableReads = 2;
      Object.defineProperty(text, "absoluteRenderBounds", {
        configurable: true,
        get() {
          if (unavailableReads > 0) { unavailableReads--; return null; }
          return bounds.get!.call(text);
        },
      });
      return text;
    }) as typeof mock.api.createText;
    const executor = createFigmaToolExecutor(mock.api, () => undefined);
    const result = await renderDesignProgramLocal(mock.api, education, { taskId, documentId, pageId: "page:current", executor });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.geometryReadbacks).toBeGreaterThan(1);
    const roots = mock.nodes.filter((node) => node.type === "FRAME" && node.parent?.type === "PAGE" && node.getPluginData("fad.multi-screen.batch-id"));
    expect(roots).toHaveLength(1);
    expect(roots[0]!.id).toBe(result.roots[0]!.nodeId);
  });

  it("retains a permanently unmeasurable root with exact diagnostics and reuses the same ID on Resume", async () => {
    const mock = createMockApi();
    const originalCreateText = mock.api.createText.bind(mock.api);
    mock.api.createText = (() => {
      const text = originalCreateText();
      Object.defineProperty(text, "absoluteRenderBounds", { configurable: true, get: () => null });
      return text;
    }) as typeof mock.api.createText;
    const executor = createFigmaToolExecutor(mock.api, () => undefined);
    const first = await renderDesignProgramLocal(mock.api, education, { taskId, documentId, pageId: "page:current", executor });
    expect(first).toMatchObject({ success: false, code: "native_geometry_incomplete", screenId: "student-home", attachedNodeCount: expect.any(Number) });
    if (first.success) return;
    const originalRootId = first.nativeRootNodeId;
    expect(first.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "native_text_bounds_unavailable", path: expect.stringContaining("student-home"), message: expect.stringContaining("nodeId=") }),
    ]));
    const originalNodeIds = mock.nodes.map(({ id }) => id).sort();
    const retried = await renderDesignProgramLocal(mock.api, education, { taskId, documentId, pageId: "page:current", executor, expectedRootNodeId: originalRootId });
    expect(retried).toMatchObject({ success: false, code: "native_geometry_incomplete", nativeRootNodeId: originalRootId });
    expect(mock.nodes.filter((node) => node.parent?.type === "PAGE" && node.getPluginData("fad.multi-screen.batch-id"))).toHaveLength(1);
    expect(mock.nodes.map(({ id }) => id).sort()).toEqual(originalNodeIds);
  });

  it.each(["moved", "removed"] as const)("fails same-root re-read if a native child is %s after creation", async (mutation) => {
    const mock = createMockApi();
    const executor = createFigmaToolExecutor(mock.api, () => undefined);
    const compiled = compileDesignProgram(education);
    expect(compiled.success).toBe(true);
    if (!compiled.success) return;
    const rendered = await renderDesignProgramLocal(mock.api, education, { taskId, documentId, pageId: "page:current", executor });
    expect(rendered.success).toBe(true);
    if (!rendered.success) return;
    const root = mock.nodes.find(({ id }) => id === rendered.roots[0]!.nodeId)!;
    const native = compiled.batch.screens[0]!;
    const target = mock.nodes.find((node) => node.type === "TEXT")!;
    const bounds = Object.getOwnPropertyDescriptor(target, "absoluteRenderBounds")!;
    let unavailable = true;
    Object.defineProperty(target, "absoluteRenderBounds", {
      configurable: true,
      get() { if (unavailable) { unavailable = false; return null; } return bounds.get!.call(target); },
    });
    const report = await inspectProgramGeometrySettled(root as unknown as FrameNode, {
      taskId, pageId: "page:current",
      expected: { width: native.width, height: native.height, scroll: true, children: native.children, assets: [], compareText: false },
      verifyLayoutSizing: true,
    }, {
      delaysMs: [0],
      wait: async () => {
        if (mutation === "removed") target.remove();
        else {
          const frame = mock.nodes.find((node) => node.type === "FRAME" && node.id !== target.parent?.id && node.parent?.id === target.parent?.id)!;
          frame.appendChild(target);
        }
      },
    });
    expect(report.coverage).toBe("incomplete");
    expect(report.findings).toEqual([expect.objectContaining({ code: "native_tree_changed", nodeId: target.id })]);
    expect(root.removed).toBe(false);
  });

  it("renders A through the native mock, resumes without duplicate roots, and H edits one scoped heading only", async () => {
    const mock = createMockApi();
    const messages: PluginToUIMessage[] = [];
    const executor = createFigmaToolExecutor(mock.api, (message) => messages.push(message));
    const programs = [education, booking, analytics];
    const rendered = [];
    for (const program of programs) {
      const result = await renderDesignProgramLocal(mock.api, program, { taskId, documentId, pageId: "page:current", executor });
      expect(result.success, JSON.stringify(result.success ? [] : result.findings)).toBe(true);
      if (result.success) rendered.push(result);
    }
    expect(rendered).toHaveLength(3);
    const rootNodes = rendered.flatMap(({ roots }) => roots.map(({ nodeId }) => mock.nodes.find((node) => node.id === nodeId)!));
    expect(rootNodes).toHaveLength(3);
    expect(rootNodes.every((node) => node.type === "FRAME")).toBe(true);
    expect(rootNodes.slice(0, 2).every((node) => node.clipsContent && node.overflowDirection === "VERTICAL")).toBe(true);
    expect(rootNodes[2]!.width).toBe(1440);
    for (const root of rootNodes) expect(localGeometryViolations(root)).toEqual([]);
    expect(rootNodes[0]!.children[0]!.height).toBeGreaterThan(rootNodes[0]!.height);
    for (let first = 0; first < rootNodes.length; first++)
      for (let second = first + 1; second < rootNodes.length; second++) {
        const a = rootNodes[first]!.absoluteBoundingBox!;
        const b = rootNodes[second]!.absoluteBoundingBox!;
        expect(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y).toBe(true);
      }

    const rootRefs = rendered.flatMap(({ roots }) => roots.map(({ ref }) => ref));
    await executor(taskNativeRequest({ type: "task-native-inspect", requestId: "phase2-inspect", documentId, taskId, refs: rootRefs }));
    expect(messages.at(-1)).toMatchObject({ type: "task-native-inspection-result", success: true, unresolvedRefs: [] });
    const target = mock.find("Welcome heading")!;
    expect(target.type).toBe("TEXT");
    const targetRef = target.getPluginData("fad.tool.logical-ref.v1");
    expect(targetRef).toBeTruthy();
    expect(target.getPluginData("fad.design.semantic-role")).toBe("heading");
    const otherSnapshots = rootNodes.slice(1).map(nativeSnapshot);
    const beforeText = target.characters;
    const edit = FigmaToolOperationSchema.parse({
      operationId: "phase2-heading-edit", idempotencyKey: "phase2:heading-edit:1", taskId, documentId,
      action: { tool: "set_properties", pageId: "page:current", ref: targetRef, properties: { text: "ادامه مسیر یادگیری" } },
    });
    const editBatch = FigmaToolBatchSchema.parse({ type: "tool-execute", protocolVersion: 1, batchId: "phase2-hybrid-edit", operations: [edit] });
    const editStarted = performance.now();
    await runOperationBatch(executor, editBatch);
    const editMs = performance.now() - editStarted;
    expect(resultFor(messages, editBatch.batchId), JSON.stringify(resultFor(messages, editBatch.batchId))).toMatchObject({ type: "tool-result", success: true, committedOperationIds: ["phase2-heading-edit"] });
    expect(target.characters).not.toBe(beforeText);
    expect(rootNodes.slice(1).map(nativeSnapshot)).toEqual(otherSnapshots);

    const thirdTitle = mock.find("Report title")!;
    const afterFirstEdit = rootNodes.slice(0, 2).map(nativeSnapshot);
    const thirdRef = thirdTitle.getPluginData("fad.tool.logical-ref.v1");
    const thirdEdit = (owner: string, operationId: string) => FigmaToolOperationSchema.parse({
      operationId, idempotencyKey: `${operationId}:1`, taskId: owner, documentId,
      action: { tool: "set_properties", pageId: "page:current", ref: thirdRef, properties: { text: "Activity overview" } },
    });
    const thirdBefore = nativeSnapshot(rootNodes[2]!);
    const foreignEdit = FigmaToolBatchSchema.parse({ type: "tool-execute", protocolVersion: 1, batchId: "phase2-foreign-edit", operations: [thirdEdit("unrelated-task", "phase2-wrong-task")] });
    await runOperationBatch(executor, foreignEdit);
    expect(resultFor(messages, foreignEdit.batchId)).toMatchObject({ success: false });
    expect(nativeSnapshot(rootNodes[2]!)).toEqual(thirdBefore);
    const permittedEdit = FigmaToolBatchSchema.parse({ type: "tool-execute", protocolVersion: 1, batchId: "phase2-third-edit", operations: [thirdEdit(taskId, "phase2-title-edit")] });
    await runOperationBatch(executor, permittedEdit);
    expect(resultFor(messages, permittedEdit.batchId)).toMatchObject({ success: true });
    expect(thirdTitle.characters).toBe("Activity overview");
    expect(rootNodes.slice(0, 2).map(nativeSnapshot)).toEqual(afterFirstEdit);

    const beforeReplayRootIds = mock.nodes.filter((node) => node.parent?.type === "PAGE" && node.getPluginData("fad.multi-screen.batch-id")).map((node) => node.id);
    const replay = await renderDesignProgramLocal(mock.api, education, { taskId, documentId, pageId: "page:current", executor });
    expect(replay.success).toBe(true);
    expect(mock.nodes.filter((node) => node.parent?.type === "PAGE" && node.getPluginData("fad.multi-screen.batch-id")).map((node) => node.id)).toEqual(beforeReplayRootIds);
    expect(mock.nodes.filter((node) => node.parent?.type === "PAGE" && node.getPluginData("fad.multi-screen.batch-id")).length).toBe(3);
    const nativeNodes = rootNodes.reduce((count, root) => {
      const visit = (node: MockNode): number => 1 + node.children.reduce((sum, child) => sum + visit(child), 0);
      return count + visit(root);
    }, 0);
    console.info(`DESIGN_PROGRAM_HYBRID ${JSON.stringify({ screenRoots: rootNodes.length, nativeNodes, editedNodes: 1, editOperationCount: 1, editAndPersistMs: editMs, unaffectedScreenSnapshotsEqual: true, rootsAfterResume: beforeReplayRootIds.length, evidenceClass: "LOCAL_MOCK_SINGLE_RUN" })}`);
  });

  it("records one isolated local measurement sample per fixture without estimating provider or Desktop time", async () => {
    for (const [index, fixture] of designProgramFixtures.entries()) {
      const serialized = JSON.stringify(fixture);
      const programBytes = new TextEncoder().encode(serialized).length;
      let started = performance.now();
      const parsed = parseDesignProgram(fixture);
      const parseMs = performance.now() - started;
      expect(parsed.success).toBe(true);
      if (!parsed.success) continue;

      started = performance.now();
      const canonicalBytes = new TextEncoder().encode(canonicalDesignProgram(parsed.data)).length;
      const canonicalMs = performance.now() - started;

      started = performance.now();
      const compiled = compileDesignProgram(fixture);
      const adapterCompileMs = performance.now() - started;
      expect(compiled.success).toBe(true);
      if (!compiled.success) continue;

      started = performance.now();
      const normalized = parseMultiScreenValue(compiled.batch);
      const normalizeMs = performance.now() - started;
      expect(normalized.success).toBe(true);

      started = performance.now();
      const quality = auditVisualQuality(compiled.batch);
      const preflightMs = performance.now() - started;

      const aMock = createMockApi();
      const aMessages: PluginToUIMessage[] = [];
      const aExecutor = createFigmaToolExecutor(aMock.api, (message) => aMessages.push(message));
      const aStorage = (aMock.api as unknown as { clientStorage: { setAsync(key: string, value: unknown): Promise<void> } }).clientStorage;
      const aSet = aStorage.setAsync.bind(aStorage);
      let aPersistenceMs = 0;
      aStorage.setAsync = async (key, value) => {
        const persistenceStarted = performance.now();
        await aSet(key, value);
        aPersistenceMs += performance.now() - persistenceStarted;
      };
      const aResult = await renderDesignProgramLocal(aMock.api, fixture, { taskId: `${taskId}-${index}`, documentId, pageId: "page:current", executor: aExecutor });
      expect(aResult.success).toBe(true);
      if (!aResult.success) continue;

      const qaOperation = FigmaToolOperationSchema.parse({
        operationId: `dpqa${String(index).padStart(6, "0")}`,
        idempotencyKey: `dpqa:${index}:verify`,
        taskId: `${taskId}-${index}`,
        documentId,
        action: { tool: "inspect_nodes", pageId: "page:current", refs: [aResult.roots[0]!.ref], purpose: "structural_verification", depth: 4, maxNodes: 25 },
      });
      const qaBatch = FigmaToolBatchSchema.parse({ type: "tool-execute", protocolVersion: 1, batchId: `dpqa-batch-${String(index).padStart(4, "0")}`, operations: [qaOperation] });
      started = performance.now();
      await runOperationBatch(aExecutor, qaBatch);
      const verificationMs = performance.now() - started;
      const qaResult = resultFor(aMessages, qaBatch.batchId);
      const coverage = qaResult?.type === "tool-result" ? (qaResult.results[0]?.data as { qualityCoverage?: { complete: boolean; nodeCount: number; findingCount: number }; findings?: Array<{ code: string }> } | undefined) : undefined;
      expect(coverage?.qualityCoverage).toMatchObject({ complete: true, findingCount: 0 });

      const bPlanStart = performance.now();
      const bPlan = compileDesignProgramOperations(fixture, { documentId, pageId: "page:current", taskId: `${taskId}-${index}` });
      const bPlanMs = performance.now() - bPlanStart;
      expect(bPlan.success).toBe(true);
      if (!bPlan.success) continue;
      const bMock = createMockApi();
      const bMessages: PluginToUIMessage[] = [];
      const bExecutor = createFigmaToolExecutor(bMock.api, (message) => bMessages.push(message));
      const bStorage = (bMock.api as unknown as { clientStorage: { setAsync(key: string, value: unknown): Promise<void> } }).clientStorage;
      const bSet = bStorage.setAsync.bind(bStorage);
      let bPersistenceMs = 0;
      bStorage.setAsync = async (key, value) => {
        const persistenceStarted = performance.now();
        await bSet(key, value);
        bPersistenceMs += performance.now() - persistenceStarted;
      };
      let bCommittedOperationCount = 0;
      started = performance.now();
      for (const [batchIndex, operations] of bPlan.batches.entries()) {
        const batch = FigmaToolBatchSchema.parse({ type: "tool-execute", protocolVersion: 1, batchId: `dpb${String(index).padStart(2, "0")}${String(batchIndex).padStart(6, "0")}`, operations });
        await runOperationBatch(bExecutor, batch);
        const result = resultFor(bMessages, batch.batchId);
        if (result?.type === "tool-result") bCommittedOperationCount += result.committedOperationIds.length;
        expect(result).toMatchObject({ type: "tool-result", success: true });
      }
      const bExecutionMs = performance.now() - started;

      const metric = {
        fixtureId: parsed.data.id,
        providerRequests: 0,
        programBytes: { rawUtf8: programBytes, canonicalUtf8: canonicalBytes },
        programNodes: parsed.nodeCount,
        programRegions: countProgramRegions(parsed.data),
        candidateA: {
          adapterBatchBytes: new TextEncoder().encode(JSON.stringify(compiled.batch)).length,
          screenRoots: aResult.roots.length,
          nativeNodes: aMock.nodes.length,
          localStyles: { paint: (await aMock.api.getLocalPaintStylesAsync()).length - 1, text: (await aMock.api.getLocalTextStylesAsync()).length - 1 },
          timingsMs: { schemaParse: parseMs, canonicalizeAndFingerprint: canonicalMs, adapterCompile: adapterCompileMs, multiScreenNormalize: normalizeMs, qualityPreflight: preflightMs, render: aResult.timingsMs.render, ownershipRegistration: aResult.timingsMs.registration, persistence: aPersistenceMs, structuralVerification: verificationMs },
          structuralCoverage: coverage?.qualityCoverage ?? null,
          nativeFindingCodes: coverage?.findings?.map(({ code }) => code) ?? [],
          qualityFindingCodes: quality.diagnostics.map(({ code }) => code),
        },
        candidateB: {
          typedOperations: bPlan.operations.length,
          toolBatches: bPlan.batches.length,
          nativeNodes: bMock.nodes.length,
          committedOperations: bCommittedOperationCount,
          planBytes: new TextEncoder().encode(JSON.stringify(bPlan.operations)).length,
          timingsMs: { boundedPlanCompile: bPlanMs, executorBatchApply: bExecutionMs, persistence: bPersistenceMs },
        },
        candidateH: { laterScopedEditOperations: 1, providerRequests: 0, measuredWithSeparateThreeDomainEdit: true },
        evidenceClass: "LOCAL_MOCK_SINGLE_RUN",
      };
      console.info(`DESIGN_PROGRAM_METRIC ${JSON.stringify(metric)}`);
    }
  });
});
