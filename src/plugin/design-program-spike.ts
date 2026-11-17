import { parseDesignProgram } from "../shared/design-program";
import { compileDesignProgram } from "../shared/design-program-adapter";
import type { FigmaToolExecutor, NativeGenerationAdoption } from "./figma-tool-executor";
import { renderMultiScreenDesign, type RendererFigmaApi } from "./renderer";
import type { VisualAsset } from "../shared/visual-schema";
import { fitProgramScrollBody, inspectProgramGeometry, verifyProgramInstanceMasters, PROGRAM_FINGERPRINT_KEY, PROGRAM_GEOMETRY_KEY, PROGRAM_TASK_KEY, type ProgramGeometryFinding } from "./design-program-geometry";
import { NATIVE_GEOMETRY_VERSION } from "../shared/native-geometry";

const TASK_KEY = "fad.tool.task-id.v1";
const TOOL_REF_KEY = "fad.tool.logical-ref.v1";
const DESIGN_REF_KEY = "fad.design.logical-ref";
const BUILT_KEY = "fad.design.program-built.v1";

function activePageId(api: RendererFigmaApi): string {
  return (api.currentPage as RendererFigmaApi["currentPage"] & { id: string }).id;
}

export type LocalProgramRenderResult =
  | { success: true; batchId: string; roots: Array<{ screenId: string; nodeId: string; ref: string }>; nodeCount: number; registeredRefs: number; operationIds: string[]; fingerprint: string; geometryVersion: typeof NATIVE_GEOMETRY_VERSION; fontFallback: boolean; geometryRepairs: number; timingsMs: { parse: number; compile: number; render: number; registration: number; persistence: number; geometry: number } }
  | { success: false; code: string; findings: Array<{ code: string; path: string; message: string; severity: "error" | "warning" }> };

function stableToolRef(logicalRef: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < logicalRef.length; index++) {
    hash ^= logicalRef.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  const readable = logicalRef.replace(/[^A-Za-z0-9._-]/gu, "-").slice(0, 48);
  return `dp-${readable}-${(hash >>> 0).toString(16)}`;
}

const activeRenders = new WeakSet<RendererFigmaApi>();

/**
 * Chat adoption seam for the Phase 2 declarative renderer. It creates one
 * bounded program through the existing native renderer and registers the
 * verified editable subtree with the existing task-scoped executor.
 */
export async function renderDesignProgramLocal(
  api: RendererFigmaApi,
  value: unknown,
  scope: { taskId: string; documentId: string; pageId: string; executor: Pick<FigmaToolExecutor, "registerRenderedGeneration">; assets?: VisualAsset[]; assertCurrentScope?: () => void },
): Promise<LocalProgramRenderResult> {
  const { taskId, documentId, pageId, executor, assertCurrentScope } = scope;
  if (!/^[A-Za-z0-9_-]{8,60}$/u.test(taskId))
    return { success: false, code: "invalid_task_scope", findings: [{ code: "invalid_task_scope", path: "taskId", message: "A stable task id is required for local ownership tagging.", severity: "error" }] };
  try {
    assertCurrentScope?.();
    if (activePageId(api) !== pageId) throw new Error("page_scope_changed");
  } catch {
    return { success: false, code: "stale_document_scope", findings: [{ code: "stale_document_scope", path: "documentId", message: "The active Figma document or page changed before native rendering.", severity: "error" }] };
  }
  const parseStarted = performance.now();
  const assets = scope.assets ?? [];
  const allowedBrandAssetIds = new Set(assets.map(({ id }) => id));
  const parsedProgram = parseDesignProgram(value, { allowedBrandAssetIds });
  const parseMs = Math.max(0, performance.now() - parseStarted);
  if (!parsedProgram.success) return { success: false, code: "invalid_program", findings: parsedProgram.findings };
  const compileStarted = performance.now();
  const compiled = compileDesignProgram(value, { assets, allowedBrandAssetIds });
  const compileMs = Math.max(0, performance.now() - compileStarted);
  if (!compiled.success) return { success: false, code: "compile_rejected", findings: compiled.findings };
  const semanticRoles = new Map(compiled.semanticRoles.map(({ logicalRef, role }) => [logicalRef, role]));
  const geometryFindings: ProgramGeometryFinding[] = [];
  let geometryMs = 0;
  let geometryRepairs = 0;
  if (activeRenders.has(api))
    return { success: false, code: "native_render_busy", findings: [{ code: "native_render_busy", path: "renderer", message: "Another native program is settling. The saved program can be resumed.", severity: "error" }] };
  activeRenders.add(api);
  const verifyScope = () => {
    assertCurrentScope?.();
    if (activePageId(api) !== pageId) throw new Error("page_scope_changed");
  };
  const hasIdentity = (root: FrameNode) =>
    root.parent?.id === pageId && root.getPluginData(PROGRAM_TASK_KEY) === taskId &&
    root.getPluginData(PROGRAM_FINGERPRINT_KEY) === compiled.fingerprint;

  try {
    for (const node of api.currentPage.children) {
      if (node.getPluginData("fad.multi-screen.batch-id") !== compiled.batch.id) continue;
      const owner = node.getPluginData(TASK_KEY) || node.getPluginData(PROGRAM_TASK_KEY);
      if (owner && owner !== taskId)
        return { success: false, code: "ownership_conflict", findings: [{ code: "ownership_conflict", path: "screens", message: "The native batch already belongs to another task.", severity: "error" }] };
    }
    const renderStarted = performance.now();
    const rendered = await renderMultiScreenDesign(api, compiled.batch, {
      resume: true,
      preserveSelection: true,
      verifyPlacement: true,
      requireComponentMatch: true,
      programText: true,
      beforeScreen: verifyScope,
      prepareScreen: (root) => {
        root.setPluginData(PROGRAM_TASK_KEY, taskId);
        root.setPluginData(PROGRAM_FINGERPRINT_KEY, compiled.fingerprint);
      },
      canDiscardPendingScreen: (root) => hasIdentity(root) && !root.getPluginData(TASK_KEY) && root.children.length === 0,
      markScreenBuilt: (root, screenId) => {
        if (parsedProgram.data.screens.find(({ id }) => id === screenId)?.scroll === "vertical") {
          root.clipsContent = true;
          root.overflowDirection = "VERTICAL";
        }
        root.setPluginData(BUILT_KEY, "1");
      },
      canRecoverPendingScreen: (root) => hasIdentity(root) && !root.getPluginData(TASK_KEY) && root.getPluginData(BUILT_KEY) === "1",
      verifyScreen: (root, screenId, reused, recovering) => {
        verifyScope();
        const source = parsedProgram.data.screens.find(({ id }) => id === screenId)!;
        const native = compiled.batch.screens.find(({ id }) => id === screenId)!;
        const owner = root.getPluginData(TASK_KEY);
        if ((owner && owner !== taskId) || (reused && root.getPluginData(PROGRAM_TASK_KEY) && !hasIdentity(root))) {
          geometryFindings.push({ code: "native_ownership_conflict", nodeId: root.id });
          throw new Error("Native program identity does not match the saved task.");
        }
        const scroll = source.scroll === "vertical";
        const options = {
          taskId, pageId, expected: { width: native.width, height: native.height, scroll, children: native.children, assets, compareText: !reused, components: compiled.batch.designSystem?.components },
          checkReceipt: (reused || recovering) && Boolean(source.compositionV1 && root.getPluginData(PROGRAM_GEOMETRY_KEY)),
        };
        let report = inspectProgramGeometry(root, options);
        geometryMs += report.durationMs;
        const body = root.children[0];
        if (!reused && scroll && report.coverage === "complete" && report.findings.length > 0 &&
          report.findings.every(({ code, parentId }) => code === "native_vertical_overflow" && parentId === body?.id) &&
          fitProgramScrollBody(root)) {
          geometryRepairs++;
          report = inspectProgramGeometry(root, options);
          geometryMs += report.durationMs;
        }
        if (report.coverage !== "complete" || report.findings.length) {
          geometryFindings.push(...report.findings);
          throw new Error("Native program geometry did not verify.");
        }
        if (!reused) root.setPluginData(PROGRAM_GEOMETRY_KEY, report.receipt);
      },
    });
    verifyScope();
    const renderMs = Math.max(0, performance.now() - renderStarted);
    if (geometryFindings.length)
      return { success: false, code: "native_geometry_failed", findings: geometryFindings.slice(0, 12).map(({ code, nodeId, parentId }) => ({
        code, path: parentId ? `native.${parentId}.${nodeId}` : `native.${nodeId}`, message: "Native geometry or ownership differs from the saved program.", severity: "error",
      })) };
    if (rendered.failedScreens > 0 || rendered.screens.some((screen) => screen.status !== "generated"))
      return { success: false, code: "native_render_incomplete", findings: [{ code: "native_render_incomplete", path: "screens", message: `${rendered.failedScreens} of ${rendered.totalScreens} screens did not render. ${rendered.screens.flatMap((screen) => screen.error ? [`${screen.id}: ${screen.error}`] : []).join(" ")}`.slice(0, 500), severity: "error" }] };

    const roots: Array<{ screenId: string; nodeId: string; ref: string }> = [];
    const adoptionRoots: NativeGenerationAdoption["roots"] = [];
    const refOwners = new Map<string, string>();
    for (const screen of parsedProgram.data.screens) {
      const result = rendered.screens.find((candidate) => candidate.id === screen.id);
      const matches = result?.nodeId ? api.currentPage.children.filter((node) => node.id === result.nodeId) : [];
      if (matches.length !== 1 || matches[0]?.type !== "FRAME")
        return { success: false, code: "ambiguous_rendered_root", findings: [{ code: "ambiguous_rendered_root", path: `screens.${screen.id}`, message: "A unique native Frame root could not be verified.", severity: "error" }] };
      const root = matches[0]!;
      const instanceFindings = await verifyProgramInstanceMasters(root);
      verifyScope();
      if (instanceFindings.length)
        return { success: false, code: "native_geometry_failed", findings: instanceFindings.map(({ code, nodeId }) => ({
          code, path: `native.${nodeId}`, message: "The native instance no longer references its verified local master.", severity: "error",
        })) };
      if (root.getPluginData(TASK_KEY) && root.getPluginData(TASK_KEY) !== taskId)
        return { success: false, code: "ownership_conflict", findings: [{ code: "ownership_conflict", path: `screens.${screen.id}`, message: "Renderer root is already owned by another task.", severity: "error" }] };
      const stack: Array<{ node: SceneNode; generatedRef: string; insideInstance?: boolean }> = [{ node: root, generatedRef: `${parsedProgram.data.id}.${screen.id}.root` }];
      let generatedIndex = 0;
      const screenNodes: NativeGenerationAdoption["roots"][number]["nodes"] = [];
      while (stack.length) {
        const { node, generatedRef, insideInstance } = stack.pop()!;
        if (node.getPluginData(TASK_KEY) && node.getPluginData(TASK_KEY) !== taskId)
          return { success: false, code: "ownership_conflict", findings: [{ code: "ownership_conflict", path: `screens.${screen.id}`, message: "A descendant is already owned by another task.", severity: "error" }] };
        const nativeRef = node.id === root.id || insideInstance
          ? generatedRef
          : node.getPluginData(DESIGN_REF_KEY) || generatedRef;
        const ref = stableToolRef(nativeRef);
        const previous = refOwners.get(ref);
        if (previous && previous !== node.id)
          return { success: false, code: "duplicate_stable_reference", findings: [{ code: "duplicate_stable_reference", path: nativeRef, message: "Two rendered nodes produced the same stable tool ref.", severity: "error" }] };
        refOwners.set(ref, node.id);
        const role = semanticRoles.get(nativeRef) ?? (node.id === root.id ? "screen" : "generated-native-node");
        screenNodes.push({ nodeId: node.id, ref, semanticRole: role });
        if (node.type === "FRAME" || node.type === "INSTANCE")
          for (let index = node.children.length - 1; index >= 0; index--) {
            generatedIndex++;
            const child = node.children[index]!;
            stack.push({ node: child, generatedRef: `${parsedProgram.data.id}.${screen.id}.native-${generatedIndex}`, insideInstance: insideInstance || node.type === "INSTANCE" });
          }
      }
      roots.push({ screenId: screen.id, nodeId: root.id, ref: stableToolRef(`${parsedProgram.data.id}.${screen.id}.root`) });
      adoptionRoots.push({ screenId: screen.id, rootNodeId: root.id, nodes: screenNodes });
    }
    const collision = api.currentPage.findAll((candidate) => {
      const expectedId = refOwners.get(candidate.getPluginData(TOOL_REF_KEY));
      return expectedId !== undefined && expectedId !== candidate.id;
    });
    if (collision.length)
      return { success: false, code: "reference_collision", findings: [{ code: "reference_collision", path: "screens", message: "A stable task ref already belongs to another native node.", severity: "error" }] };
    const registrationStarted = performance.now();
    assertCurrentScope?.();
    if (activePageId(api) !== pageId) throw new Error("page_scope_changed");
    const registration = await executor.registerRenderedGeneration({
      taskId,
      documentId,
      pageId,
      batchId: rendered.batchId,
      roots: adoptionRoots,
    });
    const registrationMs = Math.max(0, performance.now() - registrationStarted);
    if (registration.registeredRefs !== adoptionRoots.reduce((count, root) => count + root.nodes.length, 0))
      return { success: false, code: "incomplete_ownership_registration", findings: [{ code: "incomplete_ownership_registration", path: "screens", message: "The scoped tool executor did not register every verified renderer node.", severity: "error" }] };
    return {
      success: true, batchId: rendered.batchId, roots, nodeCount: compiled.nodeCount, registeredRefs: registration.registeredRefs,
      operationIds: registration.operationIds, fingerprint: compiled.fingerprint, geometryVersion: NATIVE_GEOMETRY_VERSION,
      fontFallback: rendered.fontSelections.some(({ fellBack }) => fellBack), geometryRepairs,
      timingsMs: { parse: parseMs, compile: compileMs, render: renderMs, registration: registrationMs, persistence: registration.persistenceMs, geometry: geometryMs },
    };
  } catch (error) {
    return { success: false, code: "native_render_error", findings: [{ code: "native_render_error", path: "renderer", message: error instanceof Error ? error.message.slice(0, 500) : "Native renderer failed.", severity: "error" }] };
  } finally {
    activeRenders.delete(api);
  }
}
