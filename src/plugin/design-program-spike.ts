import { parseDesignProgram } from "../shared/design-program";
import { compileDesignProgram } from "../shared/design-program-adapter";
import type { FigmaToolExecutor, NativeGenerationAdoption } from "./figma-tool-executor";
import { renderMultiScreenDesign, type RendererFigmaApi } from "./renderer";
import type { VisualAsset } from "../shared/visual-schema";
import { convergeProgramLayoutSizing, fitProgramScrollBody, inspectProgramGeometry, verifyProgramInstanceMasters, PROGRAM_FINGERPRINT_KEY, PROGRAM_GEOMETRY_KEY, PROGRAM_TASK_KEY, type ProgramGeometryFinding } from "./design-program-geometry";
import { NATIVE_GEOMETRY_VERSION } from "../shared/native-geometry";
import { CONTEXT_COMPONENT_KEY, NATIVE_MASTER_KEY, type ContextReuseFinding, type prepareContextReuse } from "./design-context-reuse";
import { FW4_GEOMETRY_ENABLED, FW4_GEOMETRY_FEATURE, projectNativeLayoutExpectations } from "../shared/fw4-geometry";
import { FW5_VISUAL_QA_ENABLED, FW5_VISUAL_REVIEW_MODE } from "../shared/fw5-visual-qa-feature";
import { fw7Telemetry } from "./fw7-runtime";
import { fw7CorrelationHash } from "../shared/fw7-observability";

const TASK_KEY = "fad.tool.task-id.v1";
const TOOL_REF_KEY = "fad.tool.logical-ref.v1";
const DESIGN_REF_KEY = "fad.design.logical-ref";
const BUILT_KEY = "fad.design.program-built.v1";

function activePageId(api: RendererFigmaApi): string {
  return (api.currentPage as RendererFigmaApi["currentPage"] & { id: string }).id;
}

export type LocalProgramRenderResult =
  | { success: true; batchId: string; roots: Array<{ screenId: string; nodeId: string; ref: string; freshlyCreated?: boolean }>; nodeCount: number; registeredRefs: number; operationIds: string[]; fingerprint: string; geometryVersion: typeof NATIVE_GEOMETRY_VERSION; fontFallback: boolean; geometryRepairs: number; geometryReadbacks: number; contextFindings?: ContextReuseFinding[]; timingsMs: { parse: number; compile: number; render: number; registration: number; persistence: number; geometry: number } }
  | { success: false; code: string; nativeRootNodeId?: string; findings: Array<{ code: string; path: string; message: string; severity: "error" | "warning" }> };

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
  scope: { taskId: string; documentId: string; pageId: string; executor: Pick<FigmaToolExecutor, "registerRenderedGeneration">; assets?: VisualAsset[]; assertCurrentScope?: () => void; requestId?: string; expectedRootNodeId?: string; rootReceipt?: { read(): string; write(nodeId: string): void }; lookupNode?: (nodeId: string) => Promise<BaseNode | null>; contextReuse?: () => ReturnType<typeof prepareContextReuse> },
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
  const parseStarted = Date.now();
  const assets = scope.assets ?? [];
  const allowedBrandAssetIds = new Set(assets.map(({ id }) => id));
  const parsedProgram = parseDesignProgram(value, { allowedBrandAssetIds });
  const parseMs = Math.max(0, Date.now() - parseStarted);
  if (!parsedProgram.success) return { success: false, code: "invalid_program", findings: parsedProgram.findings };
  const compileStarted = Date.now();
  const compiled = compileDesignProgram(value, { assets, allowedBrandAssetIds });
  const compileMs = Math.max(0, Date.now() - compileStarted);
  if (!compiled.success) return { success: false, code: "compile_rejected", findings: compiled.findings };
  const semanticRoles = new Map(compiled.semanticRoles.map(({ logicalRef, role }) => [logicalRef, role]));
  const geometryFindings: ProgramGeometryFinding[] = [];
  const freshlyCreatedScreenIds = new Set<string>();
  let incompleteGeometry = false;
  let geometryMs = 0;
  let geometryRepairs = 0;
  let geometryReadbacks = 0;
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
  let confirmedRootId: string | undefined;
  const trace = (event: string, data: Record<string, unknown> = {}) => {
    console.log("[FAD_NATIVE_PROGRAM] " + JSON.stringify({
      event, atMs: Date.now(), taskId, pageId, requestId: scope.requestId, batchId: compiled.batch.id,
      fingerprint: compiled.fingerprint, ...data,
    }));
  };
  const traceTree = (event: string, root: FrameNode, screenId: string) => {
    const queue: SceneNode[] = [root];
    const nodes = [];
    for (let index = 0; index < queue.length && index < 200; index++) {
      const node = queue[index]!;
      nodes.push({ nodeId: node.id, parentId: node.parent?.id, plannedRef: node.getPluginData(DESIGN_REF_KEY) });
      if ("children" in node) queue.push(...node.children);
    }
    trace(event, { screenId, nodeId: root.id, parentId: root.parent?.id, visible: root.visible, x: root.x, y: root.y, nodes });
  };
  const fail = (code: string, message: string): LocalProgramRenderResult => {
    trace("render_failed", { code, nodeId: confirmedRootId });
    return { success: false, code, nativeRootNodeId: confirmedRootId,
      findings: [{ code, path: "screens", message: message.slice(0, 240), severity: "error" }] };
  };

  try {
    const screenIds = new Set(compiled.batch.screens.map(({ id }) => id));
    const existing = api.currentPage.findAll((node) =>
      node.getPluginData("fad.multi-screen.batch-id") === compiled.batch.id &&
      screenIds.has(node.getPluginData("fad.multi-screen.screen-id")));
    if (existing.length > screenIds.size ||
        new Set(existing.map((node) => node.getPluginData("fad.multi-screen.screen-id"))).size !== existing.length)
      return fail("native_root_identity_conflict", "Multiple native roots match the saved screen. Inspect them before resuming.");
    const receipt = scope.rootReceipt?.read() || undefined;
    const expectedRoot = receipt ?? scope.expectedRootNodeId;
    if (receipt && scope.expectedRootNodeId && receipt !== scope.expectedRootNodeId)
      return fail("native_root_identity_conflict", "Saved native root identities disagree. Inspect the original screen before resuming.");
    if (expectedRoot && !existing.some(({ id }) => id === expectedRoot)) {
      confirmedRootId = expectedRoot;
      const node = scope.lookupNode ? await scope.lookupNode(expectedRoot) : undefined;
      verifyScope();
      trace("expected_root_unresolved", { nodeId: expectedRoot, parentId: node && !node.removed ? node.parent?.id : undefined, found: Boolean(node), removed: node?.removed });
      if (node?.removed) return fail("native_root_removed", "Figma reported that the original native root was removed. No replacement was created.");
      return fail(node ? "native_root_moved_or_retagged" : "native_root_missing",
        node ? "The saved native root exists outside its expected ownership or page. No replacement was created."
          : "The saved native root could not be located. Restore or inspect the original layer before resuming.");
    }
    for (const node of existing) {
      const owner = node.getPluginData(TASK_KEY) || node.getPluginData(PROGRAM_TASK_KEY);
      if (owner === taskId && node.parent?.id !== pageId) {
        confirmedRootId = node.id;
        trace("root_parent_changed", { nodeId: node.id, parentId: node.parent?.id });
        return fail("native_root_moved_or_retagged", "The original native root has a different parent and was retained in place.");
      }
      if (node.type !== "FRAME" || owner !== taskId || !hasIdentity(node))
        return fail("ownership_conflict", "The native batch already has a root outside this task's expected ownership or page.");
      confirmedRootId = node.id;
      if (node.getPluginData("fad.generation.commit") === "pending" && node.getPluginData(BUILT_KEY) !== "1")
        return fail("native_root_partial", "An interrupted native root is still on the page. Inspect it before resuming; no replacement was created.");
    }
    const grounding = !existing.length ? await scope.contextReuse?.() : undefined;
    verifyScope();
    let linkedFills = 0;
    let contextualInstances = 0;
    const renderStarted = Date.now();
    const rendered = await renderMultiScreenDesign(api, compiled.batch, {
      resume: true,
      preserveSelection: true,
      verifyPlacement: true,
      requireComponentMatch: true,
      preserveFailedProgramNodes: true,
      programText: true,
      onNativeApiCall: (operation, screenId) => {
        const counter = operation.startsWith("create-") ? "figmaCreateCalls"
          : operation === "append-child" ? "figmaAppendCalls"
            : operation === "resize" ? "figmaResizeCalls"
              : operation === "remove" ? "figmaRemovalCalls" : undefined;
        fw7Telemetry.record({
          runId: taskId, taskId, screenId,
          boundary: "figma-api", kind: "native_api_call", stage: "native_render", operation,
          result: "started", ...(counter ? { counter } : {}),
        });
      },
      contextRectangle: grounding?.instantiateRectangle,
      bindContextFills: grounding && (async (root) => { linkedFills += await grounding.bindFills(root, verifyScope); }),
      beforeScreen: verifyScope,
      prepareScreen: (root, screenId) => {
        root.setPluginData(PROGRAM_TASK_KEY, taskId);
        root.setPluginData(PROGRAM_FINGERPRINT_KEY, compiled.fingerprint);
        confirmedRootId = root.id;
        scope.rootReceipt?.write(root.id);
        if (root.parent?.id === pageId) {
          fw7Telemetry.record({ runId: taskId, taskId, screenId, boundary: "figma-api", kind: "native_root_attached",
            stage: "native_render", result: "applied", rootNodeHash: fw7CorrelationHash(root.id) });
        }
        trace("root_created", { screenId, nodeId: root.id, parentId: root.parent?.id });
      },
      markScreenBuilt: (root, screenId) => {
        if (parsedProgram.data.screens.find(({ id }) => id === screenId)?.scroll === "vertical") {
          root.clipsContent = true;
          root.overflowDirection = "VERTICAL";
        }
        root.setPluginData(BUILT_KEY, "1");
        traceTree("root_built", root, screenId);
      },
      canRecoverPendingScreen: (root) => hasIdentity(root) && !root.getPluginData(TASK_KEY) && root.getPluginData(BUILT_KEY) === "1",
      verifyScreen: (root, screenId, reused, recovering) => {
        verifyScope();
        if (!reused && !recovering) freshlyCreatedScreenIds.add(screenId);
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
          ...(FW4_GEOMETRY_ENABLED ? { verifyLayoutSizing: true } : {}),
        };
        if (FW4_GEOMETRY_ENABLED)
          trace("fw4_layout_expectation", { screenId, rootNodeId: root.id, gate: FW4_GEOMETRY_FEATURE,
            phase: "compiled-program-preflight", expectedNodeCount: native.children.length });
        fw7Telemetry.record({ runId: taskId, taskId, screenId, boundary: "figma-api", kind: "native_readback_started",
          stage: "program_geometry", result: "started", rootNodeHash: fw7CorrelationHash(root.id), counter: "nativeReadbackOperations" });
        let report = inspectProgramGeometry(root, options);
        geometryReadbacks++;
        geometryMs += report.durationMs;
        fw7Telemetry.record({ runId: taskId, taskId, screenId, boundary: "figma-api", kind: "native_readback_result",
          stage: "program_geometry", result: report.coverage === "complete" && report.findings.length === 0 ? "confirmed" : "unverified",
          rootNodeHash: fw7CorrelationHash(root.id), observedCount: report.measuredNodes,
          reasonCode: report.coverage !== "complete" ? "coverage_incomplete" : report.findings.length ? "geometry_findings" : undefined });
        if (FW4_GEOMETRY_ENABLED)
          trace("fw4_geometry_readback", { screenId, rootNodeId: root.id, gate: FW4_GEOMETRY_FEATURE,
            phase: "native-readback-after-render", coverage: report.coverage,
            layoutFindingCodes: report.findings.filter(({ code }) => code.startsWith("native_layout_")).map(({ code }) => code).slice(0, 8) });
        const body = root.children[0];
        if (!reused && scroll && report.coverage === "complete" && report.findings.length > 0 &&
          report.findings.every(({ code, parentId }) => code === "native_vertical_overflow" && parentId === body?.id) &&
          fitProgramScrollBody(root)) {
          geometryRepairs++;
          fw7Telemetry.record({ runId: taskId, taskId, screenId, boundary: "figma-api", kind: "native_readback_started",
            stage: "program_geometry_recheck", result: "started", rootNodeHash: fw7CorrelationHash(root.id), counter: "nativeReadbackOperations" });
          report = inspectProgramGeometry(root, options);
          geometryReadbacks++;
          geometryMs += report.durationMs;
          fw7Telemetry.record({ runId: taskId, taskId, screenId, boundary: "figma-api", kind: "native_readback_result",
            stage: "program_geometry_recheck", result: report.coverage === "complete" && report.findings.length === 0 ? "confirmed" : "unverified",
            rootNodeHash: fw7CorrelationHash(root.id), observedCount: report.measuredNodes,
            reasonCode: report.coverage !== "complete" ? "coverage_incomplete" : report.findings.length ? "geometry_findings" : undefined });
        }
        if (FW4_GEOMETRY_ENABLED) {
          const convergence = convergeProgramLayoutSizing(root, {
            taskId, pageId, fingerprint: compiled.fingerprint,
            expected: options.expected,
            allowRepair: !reused && !recovering,
            initialReport: report,
            assertCurrentScope: verifyScope,
          });
          report = convergence.report;
          geometryRepairs += convergence.repaired;
          geometryReadbacks += convergence.readbacks;
          geometryMs += report.durationMs;
          if (convergence.readbacks > 0) fw7Telemetry.record({ runId: taskId, taskId, screenId, boundary: "figma-api", kind: "native_readback_result",
            stage: "fw4_convergence_readbacks", result: report.coverage === "complete" && report.findings.length === 0 ? "confirmed" : "unverified",
            rootNodeHash: fw7CorrelationHash(root.id), observedCount: convergence.readbacks, counter: "nativeReadbackOperations", counterDelta: convergence.readbacks });
          trace("fw4_geometry_convergence", { screenId, rootNodeId: root.id, gate: FW4_GEOMETRY_FEATURE,
            phase: convergence.repaired ? "native-readback-after-convergence" : "native-readback-no-convergence",
            attemptedNodes: convergence.attempts, repairedNodes: convergence.repaired,
            beforeFindingCodes: convergence.beforeCodes.slice(0, 8), coverage: report.coverage,
            afterFindingCodes: report.findings.filter(({ code }) => code.startsWith("native_layout_")).map(({ code }) => code).slice(0, 8) });
        }
        const sizingCandidate = report.findings.length === 1 && report.findings[0]?.code === "native_layout_sizing_mismatch"
          ? report.findings[0] : undefined;
        const sizingTarget = sizingCandidate?.nodeId
          ? (() => {
              const pending: SceneNode[] = [root];
              while (pending.length) {
                const candidate = pending.pop()!;
                if (candidate.id === sizingCandidate.nodeId) return candidate;
                if ("children" in candidate) pending.push(...candidate.children);
              }
              return undefined;
            })()
          : undefined;
        const sizingParent = sizingTarget?.parent;
        const oneRepairableVisualSizingMismatch = FW5_VISUAL_QA_ENABLED && FW5_VISUAL_REVIEW_MODE === "review+bounded-repair" &&
          FW4_GEOMETRY_ENABLED && !reused && !recovering && report.coverage === "complete" &&
          Boolean(sizingCandidate?.parentId && sizingCandidate.logicalRef && sizingCandidate.expectedLayout && sizingCandidate.observedLayout &&
            sizingTarget?.type === "FRAME" && sizingParent?.id === sizingCandidate.parentId && "layoutMode" in sizingParent && sizingParent.layoutMode !== "NONE" &&
            (!("layoutPositioning" in sizingTarget) || sizingTarget.layoutPositioning !== "ABSOLUTE") &&
            sizingTarget.getPluginData(CONTEXT_COMPONENT_KEY) !== "1" && !sizingTarget.getPluginData(NATIVE_MASTER_KEY));
        if (report.coverage !== "complete" || (report.findings.length > 0 && !oneRepairableVisualSizingMismatch)) {
          incompleteGeometry ||= report.coverage !== "complete";
          geometryFindings.push(...report.findings);
          trace("geometry_rejected", { screenId, nodeId: root.id, parentId: root.parent?.id, coverage: report.coverage, findings: report.findings.slice(0, 12) });
          throw new Error("Native program geometry did not verify.");
        }
        if (oneRepairableVisualSizingMismatch)
          trace("fw5_sizing_repair_candidate", { screenId, rootNodeId: root.id, finding: report.findings[0]?.code,
            targetNodeId: report.findings[0]?.nodeId, parentId: report.findings[0]?.parentId, readbackReceipt: report.receipt });
        if (!reused) root.setPluginData(PROGRAM_GEOMETRY_KEY, report.receipt);
      },
    });
    verifyScope();
    const renderMs = Math.max(0, Date.now() - renderStarted);
    if (incompleteGeometry)
      return fail("native_geometry_incomplete", "Figma could not measure the complete native screen. Its layers were retained for another read.");
    if (geometryFindings.length)
      return { success: false, code: "native_geometry_failed", nativeRootNodeId: confirmedRootId, findings: geometryFindings.slice(0, 12).map(({ code, nodeId, parentId }) => ({
        code, path: parentId ? `native.${parentId}.${nodeId}` : `native.${nodeId}`, message: "Native geometry or ownership differs from the saved program. The renderer retained its layers.", severity: "error",
      })) };
    if (rendered.failedScreens > 0 || rendered.screens.some((screen) => screen.status !== "generated"))
      return fail("native_render_incomplete", `${rendered.failedScreens} of ${rendered.totalScreens} screens did not render. ${rendered.screens.flatMap((screen) => screen.error ? [`${screen.id}: ${screen.error}`] : []).join(" ")}`);

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
        return { success: false, code: "native_geometry_failed", nativeRootNodeId: root.id, findings: instanceFindings.map(({ code, nodeId }) => ({
          code, path: `native.${nodeId}`, message: "The native instance no longer references its verified local master.", severity: "error",
        })) };
      if (root.getPluginData(TASK_KEY) && root.getPluginData(TASK_KEY) !== taskId)
        return { success: false, code: "ownership_conflict", findings: [{ code: "ownership_conflict", path: `screens.${screen.id}`, message: "Renderer root is already owned by another task.", severity: "error" }] };
      const stack: Array<{ node: SceneNode; generatedRef: string; insideInstance?: boolean }> = [{ node: root, generatedRef: `${parsedProgram.data.id}.${screen.id}.root` }];
      let generatedIndex = 0;
      const screenNodes: NativeGenerationAdoption["roots"][number]["nodes"] = [];
      while (stack.length) {
        const { node, generatedRef, insideInstance } = stack.pop()!;
        if (node.type === "INSTANCE" && node.getPluginData(CONTEXT_COMPONENT_KEY) === "1") contextualInstances++;
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
      const freshlyCreated = freshlyCreatedScreenIds.has(screen.id);
      roots.push({ screenId: screen.id, nodeId: root.id, ref: stableToolRef(`${parsedProgram.data.id}.${screen.id}.root`),
        ...(FW5_VISUAL_QA_ENABLED ? { freshlyCreated } : {}) });
      adoptionRoots.push({ screenId: screen.id, rootNodeId: root.id, nodes: screenNodes,
        ...(FW5_VISUAL_QA_ENABLED ? { freshlyCreated, expectedLayout: projectNativeLayoutExpectations(parsedProgram.data, screen.id) } : {}) });
    }
    const collision = api.currentPage.findAll((candidate) => {
      const expectedId = refOwners.get(candidate.getPluginData(TOOL_REF_KEY));
      return expectedId !== undefined && expectedId !== candidate.id;
    });
    if (collision.length)
      return { success: false, code: "reference_collision", findings: [{ code: "reference_collision", path: "screens", message: "A stable task ref already belongs to another native node.", severity: "error" }] };
    const registrationStarted = Date.now();
    assertCurrentScope?.();
    if (activePageId(api) !== pageId) throw new Error("page_scope_changed");
    const registration = await executor.registerRenderedGeneration({
      taskId,
      documentId,
      pageId,
      batchId: rendered.batchId,
      roots: adoptionRoots,
    });
    const registrationMs = Math.max(0, Date.now() - registrationStarted);
    trace("adoption_acknowledged", { roots, operationIds: registration.operationIds });
    if (registration.registeredRefs !== adoptionRoots.reduce((count, root) => count + root.nodes.length, 0))
      return { success: false, code: "incomplete_ownership_registration", findings: [{ code: "incomplete_ownership_registration", path: "screens", message: "The scoped tool executor did not register every verified renderer node.", severity: "error" }] };
    if (grounding) {
      if (!linkedFills && !contextualInstances && !grounding.findings.length) grounding.findings.push({
        code: "fw2_no_compatible_resource", path: "context", severity: "warning",
        message: "No compatible local reference matched the final program. The planned layers remain editable; no contextual reuse was confirmed.",
      });
      trace("fw2_native_reuse_verified", { linkedFills, contextualInstances, findingCodes: grounding.findings.map(({ code }) => code) });
    }
    return {
      success: true, batchId: rendered.batchId, roots, nodeCount: compiled.nodeCount, registeredRefs: registration.registeredRefs,
      operationIds: registration.operationIds, fingerprint: compiled.fingerprint, geometryVersion: NATIVE_GEOMETRY_VERSION,
      fontFallback: rendered.fontSelections.some(({ fellBack }) => fellBack), geometryRepairs, geometryReadbacks,
      contextFindings: grounding?.findings,
      timingsMs: { parse: parseMs, compile: compileMs, render: renderMs, registration: registrationMs, persistence: registration.persistenceMs, geometry: geometryMs },
    };
  } catch (error) {
    return fail("native_render_error", error instanceof Error ? error.message : "Native renderer failed.");
  } finally {
    activeRenders.delete(api);
  }
}
