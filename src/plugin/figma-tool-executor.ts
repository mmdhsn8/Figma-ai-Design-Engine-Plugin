import { z } from "zod";
import type { FigmaToolAction, FigmaToolBatch, FigmaToolOperation } from "../shared/figma-tools";
import type { PluginToUIMessage, UIToPluginMessage } from "../shared/messages";
import { utf8Bytes } from "../shared/generation-limits";
import { planCanvasPlacements } from "./canvas-placement";
import { placeTopLevelNode, readTopLevelCanvasObstacles } from "./figma-canvas-adapter";

const STORAGE_PREFIX = "fad.figma-tools.v1";
const REF_PLUGIN_KEY = "fad.tool.logical-ref.v1";
const OP_PLUGIN_KEY = "fad.tool.operation-id.v1";
const FINGERPRINT_PLUGIN_KEY = "fad.tool.operation-fingerprint.v1";
const MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_RESULT_BYTES = 48 * 1024;
const MAX_STORED_OPERATIONS = 400;
const OPERATION_TIMEOUT_MS = 10_000;

const StoredStateSchema = z
  .object({
    version: z.literal(1),
    refs: z.record(
      z.string().max(80),
      z.object({ nodeId: z.string().max(100), pageId: z.string().max(200) }).strict(),
    ),
    operations: z.record(
      z.string().max(100),
      z
        .object({
          operationId: z.string().max(100),
          idempotencyKey: z.string().max(120),
          fingerprint: z.string().length(32),
          status: z.enum(["running", "completed", "failed"]),
          updatedAt: z.number().int().nonnegative(),
          result: z
            .object({
              operationId: z.string().max(100),
              success: z.boolean(),
              replayed: z.boolean(),
              logicalRef: z.string().max(80).optional(),
              summary: z.string().max(300).optional(),
              error: z.string().max(400).optional(),
            })
            .strict()
            .optional(),
        })
        .strict(),
    ),
  })
  .strict();

type StoredState = z.infer<typeof StoredStateSchema>;
type StoredOperationResult = NonNullable<StoredState["operations"][string]["result"]>;
type OperationResult = {
  operationId: string;
  success: boolean;
  replayed: boolean;
  logicalRef?: string;
  summary?: string;
  data?: Record<string, unknown>;
  error?: string;
};
type ToolSend = (message: PluginToUIMessage) => void;
type ToolLayout = Extract<FigmaToolAction, { tool: "set_auto_layout" }>["layout"];

function isMutatingAction(tool: FigmaToolAction["tool"]): boolean {
  return [
    "create_frame",
    "create_text",
    "create_rectangle",
    "set_auto_layout",
    "set_properties",
    "append_child",
    "reparent_node",
    "delete_node",
  ].includes(tool);
}

function color(hex: string): RGB {
  const value = hex.slice(1);
  return {
    r: Number.parseInt(value.slice(0, 2), 16) / 255,
    g: Number.parseInt(value.slice(2, 4), 16) / 255,
    b: Number.parseInt(value.slice(4, 6), 16) / 255,
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function actionFingerprint(action: FigmaToolAction): string {
  const input = stableJson(action);
  const hashes = [2166136261, 2246822519, 3266489917, 668265263];
  for (let index = 0; index < input.length; index++) {
    const code = input.charCodeAt(index);
    for (let hashIndex = 0; hashIndex < hashes.length; hashIndex++)
      hashes[hashIndex] = Math.imul(hashes[hashIndex]! ^ code, 16777619) >>> 0;
  }
  return hashes.map((hash) => hash.toString(16).padStart(8, "0")).join("");
}

function belongsToPage(node: BaseNode, page: PageNode): boolean {
  let current: BaseNode | null = node;
  while (current && current.type !== "PAGE") current = current.parent;
  return current?.id === page.id;
}

function asContainer(node: BaseNode): PageNode | FrameNode | ComponentNode {
  if (node.type === "PAGE" || node.type === "FRAME" || node.type === "COMPONENT") return node;
  throw new Error("The parent must be the current page, a frame, or a component.");
}

function withTimeout<T>(
  promise: Promise<T>,
  label: string,
  timeoutMs = OPERATION_TIMEOUT_MS,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () =>
        reject(
          new Error(`${label} timed out after ${timeoutMs} ms; no further operation was started.`),
        ),
      timeoutMs,
    );
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

function summarizeNode(node: SceneNode, ref?: string) {
  return {
    ...(ref ? { ref } : {}),
    type: node.type,
    name: node.name.slice(0, 100),
    x: Math.round(node.x),
    y: Math.round(node.y),
    width: Math.round(node.width),
    height: Math.round(node.height),
    visible: node.visible,
    ...(node.type === "TEXT" ? { text: node.characters.slice(0, 120) } : {}),
    ...(node.type === "FRAME" || node.type === "COMPONENT"
      ? { layout: node.layoutMode.toLowerCase(), childCount: node.children.length }
      : {}),
  };
}

function directChildren(node: SceneNode): readonly SceneNode[] {
  return "children" in node ? node.children : [];
}

function randomToken(): string {
  const cryptoApi = typeof crypto === "undefined" ? undefined : crypto;
  if (!cryptoApi || typeof cryptoApi.getRandomValues !== "function")
    throw new Error("Secure random values are unavailable; deletion consent cannot be issued.");
  const bytes = cryptoApi.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomLocalRef(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
}

function compactResult(result: OperationResult): StoredOperationResult {
  return {
    operationId: result.operationId,
    success: result.success,
    replayed: result.replayed,
    ...(result.logicalRef ? { logicalRef: result.logicalRef } : {}),
    ...(result.summary ? { summary: result.summary } : {}),
    ...(result.error ? { error: result.error } : {}),
  };
}

function boundResults(results: OperationResult[]): void {
  while (utf8Bytes(JSON.stringify(results) ?? "") > MAX_RESULT_BYTES) {
    let largest: OperationResult | undefined;
    let largestBytes = 0;
    for (const result of results) {
      if (!result.data) continue;
      const size = utf8Bytes(JSON.stringify(result.data) ?? "");
      if (size > largestBytes) {
        largest = result;
        largestBytes = size;
      }
    }
    if (!largest) return;
    delete largest.data;
    largest.summary = `${largest.summary ?? "Operation completed."} Detailed output omitted to stay within the response-size limit.`;
  }
}

export function createFigmaToolExecutor(
  api: PluginAPI,
  send: ToolSend,
  options: { operationTimeoutMs?: number } = {},
) {
  const operationTimeoutMs =
    Number.isSafeInteger(options.operationTimeoutMs) && options.operationTimeoutMs! > 0
      ? Math.min(options.operationTimeoutMs!, OPERATION_TIMEOUT_MS)
      : OPERATION_TIMEOUT_MS;
  const timed = <T>(promise: Promise<T>, label: string): Promise<T> =>
    withTimeout(promise, label, operationTimeoutMs);
  let queue: Promise<void> = Promise.resolve();
  let pendingBatches = 0;
  const cancellation = new Map<string, { cancelled: boolean }>();
  const deleteConsents = new Map<string, { token: string; ref: string; expiresAt: number }>();
  const startedOperations: number[] = [];

  const documentPageKey = (pageId = api.currentPage.id): string => {
    let documentId = api.root.getPluginData("fad.document-id");
    if (!documentId) {
      documentId = `doc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
      api.root.setPluginData("fad.document-id", documentId);
    }
    const fileId = api.fileKey ?? documentId;
    return `${STORAGE_PREFIX}:${fileId}:${pageId.replaceAll(":", "_")}`;
  };

  const loadState = async (pageId = api.currentPage.id): Promise<StoredState> => {
    const raw: unknown = await timed(
      api.clientStorage.getAsync(documentPageKey(pageId)),
      "Tool state read",
    );
    if (raw === undefined) return { version: 1, refs: {}, operations: {} };
    let serialized: string;
    try {
      serialized = JSON.stringify(raw);
    } catch {
      throw new Error("Saved tool references are not readable; refusing to resolve them.");
    }
    if (!serialized || utf8Bytes(serialized) > 256 * 1024)
      throw new Error("Saved tool state exceeds its safety limit; refusing to resolve it.");
    const parsed = StoredStateSchema.safeParse(raw);
    if (!parsed.success)
      throw new Error("Saved tool references are invalid; refusing to resolve them.");
    if (
      Object.keys(parsed.data.refs).length > 500 ||
      Object.keys(parsed.data.operations).length > 400
    )
      throw new Error("Saved tool state exceeds its record limit; refusing to resolve it.");
    return parsed.data;
  };

  const saveState = async (state: StoredState, pageId = api.currentPage.id): Promise<void> => {
    const operations = Object.fromEntries(
      Object.entries(state.operations)
        .sort(([, a], [, b]) => b.updatedAt - a.updatedAt)
        .slice(0, MAX_STORED_OPERATIONS),
    );
    await timed(
      api.clientStorage.setAsync(documentPageKey(pageId), { ...state, operations }),
      "Tool state save",
    );
  };

  const resolveRef = async (
    state: StoredState,
    ref: string,
    pageId = api.currentPage.id,
  ): Promise<SceneNode> => {
    if (api.currentPage.id !== pageId)
      throw new Error(
        "Figma page changed during the operation; no node was targeted on the new page.",
      );
    const entry = state.refs[ref];
    if (!entry || entry.pageId !== pageId)
      throw new Error(`Logical reference “${ref}” is missing or belongs to another page.`);
    const node = await timed(api.getNodeByIdAsync(entry.nodeId), "Node reference lookup");
    if (
      api.currentPage.id !== pageId ||
      !node ||
      !("type" in node) ||
      node.type === "DOCUMENT" ||
      node.type === "PAGE" ||
      !belongsToPage(node, api.currentPage) ||
      (node as SceneNode).getPluginData(REF_PLUGIN_KEY) !== ref
    )
      throw new Error(`Logical reference “${ref}” is stale; no node was changed.`);
    return node as SceneNode;
  };

  const resolveParent = async (
    state: StoredState,
    parent: Extract<FigmaToolAction, { tool: "create_frame" }>["parent"],
    pageId: string,
  ): Promise<PageNode | FrameNode | ComponentNode> => {
    if (api.currentPage.id !== pageId)
      throw new Error(
        "Figma page changed during the operation; no node was targeted on the new page.",
      );
    if (parent.kind === "page") return api.currentPage;
    const node = await resolveRef(state, parent.ref, pageId);
    return asContainer(node);
  };

  const registerLogicalRef = (state: StoredState, node: SceneNode, pageId: string): string => {
    if (api.currentPage.id !== pageId || !belongsToPage(node, api.currentPage))
      throw new Error(
        "Figma page changed during inspection; no other page was tagged or inspected.",
      );
    const existing = Object.entries(state.refs).find(
      ([, entry]) => entry.nodeId === node.id && entry.pageId === pageId,
    );
    if (existing) {
      if (node.getPluginData(REF_PLUGIN_KEY) !== existing[0])
        node.setPluginData(REF_PLUGIN_KEY, existing[0]);
      return existing[0];
    }
    if (Object.keys(state.refs).length >= 500)
      throw new Error(
        "This page already has 500 retained logical references; inspection stopped safely.",
      );
    const storedRef = node.getPluginData(REF_PLUGIN_KEY);
    const ref =
      storedRef && /^[A-Za-z][A-Za-z0-9._-]{0,79}$/u.test(storedRef) && !state.refs[storedRef]
        ? storedRef
        : `inspected-${randomLocalRef()}`;
    node.setPluginData(REF_PLUGIN_KEY, ref);
    state.refs[ref] = { nodeId: node.id, pageId };
    return ref;
  };

  const loadFont = async (requested: FontName): Promise<{ font: FontName; fallback: boolean }> => {
    const fonts = await timed(api.listAvailableFontsAsync(), "Font discovery");
    const available = fonts
      .map(({ fontName }) => fontName)
      .sort((a, b) => `${a.family}/${a.style}`.localeCompare(`${b.family}/${b.style}`));
    const candidates = [requested, { family: "Inter", style: "Regular" }, available[0]].filter(
      (font): font is FontName => Boolean(font),
    );
    const selected = candidates.find((candidate) =>
      available.some((font) => font.family === candidate.family && font.style === candidate.style),
    );
    if (!selected) throw new Error("No available font can be loaded for editable text.");
    await timed(api.loadFontAsync(selected), "Font loading");
    return {
      font: selected,
      fallback: selected.family !== requested.family || selected.style !== requested.style,
    };
  };

  const actionResult = async (
    state: StoredState,
    operation: FigmaToolOperation,
    pageId: string,
  ): Promise<{ summary: string; logicalRef?: string; data?: Record<string, unknown> }> => {
    if (api.currentPage.id !== pageId)
      throw new Error(
        "Figma page changed during the operation; no node was targeted on the new page.",
      );
    const action = operation.action;
    if (action.tool === "get_document_context") {
      const selection = api.currentPage.selection.slice(0, 10).map((node) => summarizeNode(node));
      const [paintStyles, textStyles] = await Promise.all([
        timed(api.getLocalPaintStylesAsync(), "Paint token lookup"),
        timed(api.getLocalTextStylesAsync(), "Text token lookup"),
      ]);
      const [variables, collections] = await Promise.all([
        timed(api.variables.getLocalVariablesAsync(), "Local variable token lookup"),
        timed(api.variables.getLocalVariableCollectionsAsync(), "Variable collection lookup"),
      ]);
      if (api.currentPage.id !== pageId)
        throw new Error("Figma page changed while reading context; no other page was inspected.");
      const collectionNames = new Map(
        collections.map(({ id, name, defaultModeId }) => [id, { name, defaultModeId }]),
      );
      const variableTokens = variables.slice(0, 20).map((variable) => {
        const collection = collectionNames.get(variable.variableCollectionId);
        const value = collection ? variable.valuesByMode[collection.defaultModeId] : undefined;
        const colorValue =
          value && typeof value === "object" && "r" in value && "g" in value && "b" in value
            ? `#${[value.r, value.g, value.b]
                .map((channel) =>
                  Math.round(Number(channel) * 255)
                    .toString(16)
                    .padStart(2, "0"),
                )
                .join("")}`
            : undefined;
        return {
          id: variable.id,
          name: variable.name.slice(0, 100),
          type: variable.resolvedType,
          ...(collection ? { collection: collection.name.slice(0, 100) } : {}),
          ...((colorValue ??
          (typeof value === "string" || typeof value === "number" ? value : undefined) !==
            undefined)
            ? { value: colorValue ?? value }
            : {}),
        };
      });
      return {
        summary: `Current page “${api.currentPage.name}” has ${api.currentPage.children.length} top-level layers and ${api.currentPage.selection.length} selected layer(s).`,
        data: {
          page: { name: api.currentPage.name },
          viewport: { center: api.viewport.center },
          selection,
          tokens: {
            paintStyles: paintStyles
              .slice(0, 20)
              .map(({ id, name }) => ({ id, name: name.slice(0, 100) })),
            textStyles: textStyles
              .slice(0, 20)
              .map(({ id, name }) => ({ id, name: name.slice(0, 100) })),
            variables: variableTokens,
          },
        },
      };
    }
    if (action.tool === "inspect_nodes") {
      const roots = action.refs.length
        ? await Promise.all(action.refs.map((ref) => resolveRef(state, ref, pageId)))
        : api.currentPage.selection;
      if (api.currentPage.id !== pageId)
        throw new Error("Figma page changed while resolving inspection targets.");
      const seen = new Set<string>();
      const result: Array<Record<string, unknown>> = [];
      const visit = (node: SceneNode, depth: number): string | undefined => {
        if (seen.has(node.id) || result.length >= action.maxNodes) return undefined;
        seen.add(node.id);
        const ref = registerLogicalRef(state, node, pageId);
        const summary = summarizeNode(node, ref) as Record<string, unknown>;
        result.push(summary);
        if (depth < action.depth && directChildren(node).length)
          summary.children = directChildren(node)
            .slice(0, action.maxNodes - result.length)
            .map((child) => visit(child, depth + 1))
            .filter((childRef): childRef is string => Boolean(childRef));
        return ref;
      };
      roots.slice(0, action.maxNodes).forEach((node) => visit(node, 0));
      return {
        summary: `Inspected ${result.length} node(s) within depth ${action.depth}.`,
        data: { nodes: result },
      };
    }
    if (action.tool === "get_operation_status") {
      const saved = state.operations[action.operationId];
      if (!saved) throw new Error(`Operation “${action.operationId}” has no saved status.`);
      return {
        summary: `Operation ${saved.status}.`,
        data: {
          operationId: saved.operationId,
          status: saved.status,
          updatedAt: saved.updatedAt,
          ...(saved.result ? { result: saved.result } : {}),
        },
      };
    }
    if (
      action.tool === "create_frame" ||
      action.tool === "create_rectangle" ||
      action.tool === "create_text"
    ) {
      if (state.refs[action.ref])
        throw new Error(`Logical reference “${action.ref}” is already reserved.`);
      if (Object.keys(state.refs).length >= 500)
        throw new Error(
          "This page already has 500 retained logical references; start a new page-scoped tool session.",
        );
      const parent = await resolveParent(state, action.parent, pageId);
      const isPageParent = parent.type === "PAGE";
      if (
        action.tool === "create_text" &&
        (action.horizontalSizing === "FILL" || action.verticalSizing === "FILL") &&
        (isPageParent ||
          (parent.type !== "FRAME" && parent.type !== "COMPONENT") ||
          parent.layoutMode === "NONE")
      )
        throw new Error("FILL text sizing requires an Auto Layout frame or component parent.");
      const x = "x" in action ? action.x : undefined;
      const y = "y" in action ? action.y : undefined;
      if ((x === undefined) !== (y === undefined))
        throw new Error(
          "Set both x and y for explicit placement, or omit both to use safe canvas placement.",
        );
      const placement =
        isPageParent && (x === undefined || y === undefined)
          ? planCanvasPlacements(
              [{ id: action.ref, width: action.size.width, height: action.size.height }],
              readTopLevelCanvasObstacles(api.currentPage),
            )[0]
          : undefined;
      let created: SceneNode;
      let fontFallback: boolean | undefined;
      let createdNode: SceneNode | undefined;
      try {
        if (action.tool === "create_text") {
          const loaded = await loadFont({ family: action.font.family, style: action.font.style });
          if (api.currentPage.id !== pageId)
            throw new Error("Figma page changed while loading the font; text was not created.");
          fontFallback = loaded.fallback;
          const text = api.createText();
          createdNode = text;
          text.setPluginData(REF_PLUGIN_KEY, action.ref);
          text.setPluginData(OP_PLUGIN_KEY, operation.operationId);
          text.setPluginData(FINGERPRINT_PLUGIN_KEY, actionFingerprint(action));
          text.name = action.name;
          text.fontName = loaded.font;
          text.fontSize = action.fontSize;
          text.characters = action.text;
          text.fills = [{ type: "SOLID", color: color(action.color) }];
          text.textAlignHorizontal =
            action.align ?? (action.direction === "RTL" ? "RIGHT" : "LEFT");
          text.textAutoResize = "HEIGHT";
          text.resize(action.size.width, action.size.height);
        } else if (action.tool === "create_frame") {
          const frame = api.createFrame();
          createdNode = frame;
          frame.setPluginData(REF_PLUGIN_KEY, action.ref);
          frame.setPluginData(OP_PLUGIN_KEY, operation.operationId);
          frame.setPluginData(FINGERPRINT_PLUGIN_KEY, actionFingerprint(action));
          frame.name = action.name;
          frame.resize(action.size.width, action.size.height);
          frame.fills = action.fill ? [{ type: "SOLID", color: color(action.fill) }] : [];
          frame.strokes = action.stroke ? [{ type: "SOLID", color: color(action.stroke) }] : [];
          frame.cornerRadius = action.cornerRadius;
          if (action.autoLayout) applyLayout(frame, action.autoLayout);
        } else {
          const rectangle = api.createRectangle();
          createdNode = rectangle;
          rectangle.setPluginData(REF_PLUGIN_KEY, action.ref);
          rectangle.setPluginData(OP_PLUGIN_KEY, operation.operationId);
          rectangle.setPluginData(FINGERPRINT_PLUGIN_KEY, actionFingerprint(action));
          rectangle.name = action.name;
          rectangle.resize(action.size.width, action.size.height);
          rectangle.fills = [{ type: "SOLID", color: color(action.fill) }];
          rectangle.strokes = action.stroke ? [{ type: "SOLID", color: color(action.stroke) }] : [];
          rectangle.strokeWeight = action.strokeWeight;
          rectangle.cornerRadius = action.cornerRadius;
        }
        created = createdNode!;
        if (!isPageParent) parent.appendChild(created);
        if (isPageParent && placement)
          placeTopLevelNode(
            created,
            { x: created.x, y: created.y, width: created.width, height: created.height },
            placement,
          );
        else if (x !== undefined && y !== undefined) {
          created.x = x;
          created.y = y;
        }
        if (
          action.tool === "create_text" &&
          !isPageParent &&
          (parent.type === "FRAME" || parent.type === "COMPONENT") &&
          parent.layoutMode !== "NONE"
        ) {
          const child = created as TextNode;
          const verticalLayout = parent.layoutMode === "VERTICAL";
          if (verticalLayout) {
            if (action.horizontalSizing === "FILL") parent.counterAxisSizingMode = "FIXED";
            if (action.verticalSizing === "FILL") parent.primaryAxisSizingMode = "FIXED";
          } else {
            if (action.horizontalSizing === "FILL") parent.primaryAxisSizingMode = "FIXED";
            if (action.verticalSizing === "FILL") parent.counterAxisSizingMode = "FIXED";
          }
          child.layoutSizingHorizontal = action.horizontalSizing;
          child.layoutSizingVertical = action.verticalSizing;
        }
      } catch (error) {
        createdNode?.remove();
        throw error;
      }
      state.refs[action.ref] = { nodeId: created.id, pageId };
      const summary = `${action.tool === "create_text" ? "Editable text" : action.tool === "create_frame" ? "Frame" : "Rectangle"} “${created.name}” created.`;
      return {
        summary: fontFallback
          ? `${summary} Requested font unavailable; used ${(created as TextNode).fontName as FontName}.`
          : summary,
        logicalRef: action.ref,
        data: {
          node: summarizeNode(created, action.ref),
          ...(fontFallback ? { fontFallback: true } : {}),
        },
      };
    }
    if (action.tool === "set_auto_layout") {
      const node = await resolveRef(state, action.ref, pageId);
      if (node.type !== "FRAME" && node.type !== "COMPONENT")
        throw new Error("Auto Layout can only be set on a frame or component.");
      if (action.layout.counterAlign === "BASELINE" && action.layout.direction !== "horizontal")
        throw new Error(
          "Baseline counter-axis alignment is only valid for horizontal Auto Layout.",
        );
      if (new Set(action.children.map(({ ref }) => ref)).size !== action.children.length)
        throw new Error("Auto Layout child rules must use unique logical references.");
      const children = action.children.map((rule) => {
        const child = state.refs[rule.ref];
        if (!child) throw new Error(`Child reference “${rule.ref}” does not exist.`);
        return rule;
      });
      const childNodes: Array<{ rule: (typeof children)[number]; node: SceneNode }> = [];
      for (const rule of children) {
        const child = await resolveRef(state, rule.ref, pageId);
        if (child.parent?.id !== node.id)
          throw new Error(`“${rule.ref}” is not a direct child of “${action.ref}”.`);
        const horizontal =
          action.layout.direction === "vertical" && rule.align === "STRETCH"
            ? "FILL"
            : rule.horizontal;
        const vertical =
          action.layout.direction === "horizontal" && rule.align === "STRETCH"
            ? "FILL"
            : rule.vertical;
        const supportsHug =
          child.type === "TEXT" ||
          ((child.type === "FRAME" || child.type === "COMPONENT") && child.layoutMode !== "NONE");
        if ((horizontal === "HUG" || vertical === "HUG") && !supportsHug)
          throw new Error(
            `HUG sizing requires editable text or an Auto Layout frame (${rule.ref}).`,
          );
        childNodes.push({ rule, node: child });
      }
      const verticalLayout = action.layout.direction === "vertical";
      const primaryFill = childNodes.some(
        ({ rule }) =>
          rule.grow === 1 || (verticalLayout ? rule.vertical : rule.horizontal) === "FILL",
      );
      const counterFill = childNodes.some(
        ({ rule }) =>
          rule.align === "STRETCH" || (verticalLayout ? rule.horizontal : rule.vertical) === "FILL",
      );
      const layout = {
        ...action.layout,
        primarySizing: primaryFill ? ("FIXED" as const) : action.layout.primarySizing,
        counterSizing: counterFill ? ("FIXED" as const) : action.layout.counterSizing,
      };
      if (api.currentPage.id !== pageId)
        throw new Error("Figma page changed before Auto Layout was applied.");
      applyLayout(node, layout);
      const normalized: string[] = [];
      for (const { rule, node: child } of childNodes) {
        const autoChild = child as SceneNode & AutoLayoutChildrenMixin & LayoutMixin;
        if (rule.align) autoChild.layoutAlign = rule.align;
        if (rule.grow !== undefined) autoChild.layoutGrow = rule.grow;
        const horizontal =
          layout.direction === "vertical" && rule.align === "STRETCH" ? "FILL" : rule.horizontal;
        const vertical =
          layout.direction === "horizontal" && rule.align === "STRETCH" ? "FILL" : rule.vertical;
        if (horizontal) autoChild.layoutSizingHorizontal = horizontal;
        if (vertical) autoChild.layoutSizingVertical = vertical;
        if (
          (horizontal !== rule.horizontal && rule.horizontal) ||
          (vertical !== rule.vertical && rule.vertical)
        )
          normalized.push(rule.ref);
      }
      return {
        summary: normalized.length
          ? `Auto Layout set; stretch sizing was normalized for ${normalized.join(", ")}.`
          : primaryFill || counterFill
            ? "Auto Layout set; parent sizing was normalized to fixed where FILL/stretch children require it."
            : `Auto Layout set to ${layout.direction.toLowerCase()} with ${childNodes.length} child rule(s).`,
        data: {
          direction: layout.direction.toLowerCase(),
          normalizedStretchRefs: normalized,
          normalizedPrimarySizing: primaryFill,
          normalizedCounterSizing: counterFill,
        },
      };
    }
    if (action.tool === "set_properties") {
      const node = await resolveRef(state, action.ref, pageId);
      const properties = action.properties;
      if (properties.fill !== undefined && properties.paintStyleId !== undefined)
        throw new Error(
          "Choose either a literal fill color or an existing paint token in one operation.",
        );
      if (
        properties.textStyleId &&
        (properties.fontSize !== undefined || properties.color !== undefined)
      )
        throw new Error(
          "Choose an existing text style or explicit font/color changes in one operation.",
        );
      const changesText =
        properties.text !== undefined ||
        properties.fontSize !== undefined ||
        properties.color !== undefined ||
        properties.align !== undefined;
      if (changesText && node.type !== "TEXT")
        throw new Error("Text properties can only target an editable text node.");
      if (
        (properties.width !== undefined || properties.height !== undefined) &&
        !("resize" in node)
      )
        throw new Error("This node type does not support dimensions.");
      if (
        (properties.fill !== undefined || properties.paintStyleId !== undefined) &&
        !("fills" in node)
      )
        throw new Error("This node type does not support a fill color.");
      const paintStyle = properties.paintStyleId
        ? (await timed(api.getLocalPaintStylesAsync(), "Paint token lookup")).find(
            ({ id }) => id === properties.paintStyleId,
          )
        : undefined;
      if (properties.paintStyleId && !paintStyle)
        throw new Error(
          "The requested paint token is not present in this document's local styles.",
        );
      const textStyle = properties.textStyleId
        ? (await timed(api.getLocalTextStylesAsync(), "Text token lookup")).find(
            ({ id }) => id === properties.textStyleId,
          )
        : undefined;
      if (properties.textStyleId && (node.type !== "TEXT" || !textStyle))
        throw new Error(
          "The requested text token is unavailable or the target is not editable text.",
        );
      const loadedFont =
        changesText && !textStyle
          ? await loadFont(
              (node as TextNode).fontName === api.mixed
                ? { family: "Inter", style: "Regular" }
                : ((node as TextNode).fontName as FontName),
            )
          : undefined;
      if (api.currentPage.id !== pageId)
        throw new Error("Figma page changed before properties were updated.");
      if (properties.name !== undefined) node.name = properties.name;
      if (properties.visible !== undefined) node.visible = properties.visible;
      if (properties.width !== undefined || properties.height !== undefined)
        (node as SceneNode & { resize: (width: number, height: number) => void }).resize(
          properties.width ?? node.width,
          properties.height ?? node.height,
        );
      if (properties.fill !== undefined) {
        (node as SceneNode & { fills: readonly Paint[] }).fills = [
          { type: "SOLID", color: color(properties.fill) },
        ];
      }
      if (paintStyle)
        await timed(
          (node as GeometryMixin).setFillStyleIdAsync(paintStyle.id),
          "Paint token apply",
        );
      if (textStyle)
        await timed((node as TextNode).setTextStyleIdAsync(textStyle.id), "Text token apply");
      if (changesText) {
        const text = node as TextNode;
        if (loadedFont) text.fontName = loadedFont.font;
        if (properties.text !== undefined) text.characters = properties.text;
        if (properties.fontSize !== undefined) text.fontSize = properties.fontSize;
        if (properties.color !== undefined)
          text.fills = [{ type: "SOLID", color: color(properties.color) }];
        if (properties.align !== undefined) text.textAlignHorizontal = properties.align;
      }
      return {
        summary: `Updated only the requested properties on “${node.name}”.`,
        logicalRef: action.ref,
        data: { node: summarizeNode(node, action.ref) },
      };
    }
    if (action.tool === "append_child" || action.tool === "reparent_node") {
      const childRef = action.tool === "append_child" ? action.childRef : action.ref;
      const child = await resolveRef(state, childRef, pageId);
      const parentNode = await resolveRef(state, action.parentRef, pageId);
      const parent = asContainer(parentNode);
      if (parent.type === "PAGE")
        throw new Error("Use an explicit frame/component reference as the destination parent.");
      if (child.id === parent.id) throw new Error("A node cannot be parented to itself.");
      if (action.tool === "append_child" && child.parent?.type !== "PAGE")
        throw new Error(
          "append_child only accepts a node currently at the page root; use reparent_node for an intentional move.",
        );
      let ancestor: BaseNode | null = parent;
      while (ancestor && ancestor.type !== "PAGE") {
        if (ancestor.id === child.id)
          throw new Error("Reparenting would create a parent-child cycle.");
        ancestor = ancestor.parent;
      }
      if (child.parent?.id !== parent.id) parent.appendChild(child);
      return {
        summary: `“${child.name}” is now a child of “${parent.name}”.`,
        logicalRef: childRef,
        data: { parentRef: action.parentRef },
      };
    }
    if (action.tool === "delete_node") {
      const consent = deleteConsents.get(action.consentToken);
      if (
        !consent ||
        consent.token !== action.consentToken ||
        consent.ref !== action.ref ||
        consent.expiresAt < Date.now()
      )
        throw new Error(
          "Deletion requires a fresh, matching user confirmation for this logical reference.",
        );
      deleteConsents.delete(action.consentToken);
      const node = await resolveRef(state, action.ref, pageId);
      const subtreeIds = new Set<string>([node.id]);
      const collect = (child: SceneNode): void =>
        directChildren(child).forEach((nested) => {
          subtreeIds.add(nested.id);
          collect(nested);
        });
      collect(node);
      node.remove();
      return {
        summary: `Deleted “${node.name}” and its ${subtreeIds.size - 1} descendant(s) after scoped confirmation.`,
      };
    }
    throw new Error("Unsupported Figma tool.");
  };

  const applyLayout = (frame: FrameNode | ComponentNode, layout: ToolLayout) => {
    frame.layoutMode = layout.direction === "horizontal" ? "HORIZONTAL" : "VERTICAL";
    frame.primaryAxisSizingMode = layout.primarySizing;
    frame.counterAxisSizingMode = layout.counterSizing;
    frame.primaryAxisAlignItems = layout.primaryAlign;
    frame.counterAxisAlignItems = layout.counterAlign;
    frame.itemSpacing = layout.gap;
    frame.paddingTop = layout.padding.top;
    frame.paddingRight = layout.padding.right;
    frame.paddingBottom = layout.padding.bottom;
    frame.paddingLeft = layout.padding.left;
  };

  const executeOperation = async (
    state: StoredState,
    operation: FigmaToolOperation,
    pageId: string,
  ): Promise<OperationResult> => {
    if (api.currentPage.id !== pageId)
      return {
        operationId: operation.operationId,
        success: false,
        replayed: false,
        error: "Figma page changed during the batch; no operation was applied to the new page.",
      };
    const fingerprint = actionFingerprint(operation.action);
    const priorByKey = Object.values(state.operations).find(
      (saved) => saved.idempotencyKey === operation.idempotencyKey,
    );
    const prior = state.operations[operation.operationId] ?? priorByKey;
    if (prior) {
      if (
        prior.operationId !== operation.operationId ||
        prior.fingerprint !== fingerprint ||
        prior.idempotencyKey !== operation.idempotencyKey
      )
        return {
          operationId: operation.operationId,
          success: false,
          replayed: true,
          error: "Operation ID or idempotency key was already used with different input.",
        };
      if (prior.status === "completed" && prior.result)
        return { ...(prior.result as unknown as OperationResult), replayed: true };
      if (prior.status === "failed" && prior.result)
        return { ...(prior.result as unknown as OperationResult), replayed: true };
      if (
        prior.status === "running" &&
        (operation.action.tool === "create_frame" ||
          operation.action.tool === "create_rectangle" ||
          operation.action.tool === "create_text")
      ) {
        const recovered = api.currentPage.findAll(
          (node) => node.getPluginData(OP_PLUGIN_KEY) === operation.operationId,
        )[0];
        if (
          recovered &&
          recovered.getPluginData(REF_PLUGIN_KEY) === operation.action.ref &&
          recovered.getPluginData(FINGERPRINT_PLUGIN_KEY) === fingerprint
        ) {
          state.refs[operation.action.ref] = { nodeId: recovered.id, pageId };
          const result: OperationResult = {
            operationId: operation.operationId,
            success: true,
            replayed: true,
            logicalRef: operation.action.ref,
            summary: `Recovered completed creation “${recovered.name}”.`,
            data: { node: summarizeNode(recovered, operation.action.ref) },
          };
          state.operations[operation.operationId] = {
            ...prior,
            status: "completed",
            updatedAt: Date.now(),
            result: compactResult(result),
          };
          await saveState(state, pageId);
          return result;
        }
        const result: OperationResult = {
          operationId: operation.operationId,
          success: false,
          replayed: true,
          error:
            "The operation was interrupted; inspect the canvas before retrying with a new operation ID.",
        };
        state.operations[operation.operationId] = {
          ...prior,
          status: "failed",
          updatedAt: Date.now(),
          result: compactResult(result),
        };
        await saveState(state, pageId);
        return result;
      }
      if (prior.status === "running") {
        const result: OperationResult = {
          operationId: operation.operationId,
          success: false,
          replayed: true,
          error:
            "The operation was interrupted and may have partially applied; inspect the canvas before retrying with a new operation ID.",
        };
        state.operations[operation.operationId] = {
          ...prior,
          status: "failed",
          updatedAt: Date.now(),
          result: compactResult(result),
        };
        await saveState(state, pageId);
        return result;
      }
    }
    if (
      !prior &&
      (operation.action.tool === "create_frame" ||
        operation.action.tool === "create_rectangle" ||
        operation.action.tool === "create_text")
    ) {
      const recovered = api.currentPage.findAll(
        (node) => node.getPluginData(OP_PLUGIN_KEY) === operation.operationId,
      )[0];
      if (recovered) {
        if (
          recovered.getPluginData(REF_PLUGIN_KEY) !== operation.action.ref ||
          recovered.getPluginData(FINGERPRINT_PLUGIN_KEY) !== fingerprint
        )
          return {
            operationId: operation.operationId,
            success: false,
            replayed: true,
            error: "This operation ID is already attached to a different native node.",
          };
        state.refs[operation.action.ref] = { nodeId: recovered.id, pageId };
        const result: OperationResult = {
          operationId: operation.operationId,
          success: true,
          replayed: true,
          logicalRef: operation.action.ref,
          summary: `Recovered prior creation “${recovered.name}”.`,
        };
        state.operations[operation.operationId] = {
          operationId: operation.operationId,
          idempotencyKey: operation.idempotencyKey,
          fingerprint,
          status: "completed",
          updatedAt: Date.now(),
          result: compactResult(result),
        };
        await saveState(state, pageId);
        return result;
      }
    }
    const now = Date.now();
    while (startedOperations.length && startedOperations[0]! < now - 60_000)
      startedOperations.shift();
    if (startedOperations.length >= 40)
      return {
        operationId: operation.operationId,
        success: false,
        replayed: false,
        error: "Local tool rate limit reached; wait one minute and retry with a new operation ID.",
      };
    startedOperations.push(now);
    state.operations[operation.operationId] = {
      operationId: operation.operationId,
      idempotencyKey: operation.idempotencyKey,
      fingerprint,
      status: "running",
      updatedAt: now,
    };
    await saveState(state, pageId);
    let result: OperationResult;
    try {
      const output = await actionResult(state, operation, pageId);
      result = { operationId: operation.operationId, success: true, replayed: false, ...output };
      if (
        [
          "create_frame",
          "create_text",
          "create_rectangle",
          "set_auto_layout",
          "set_properties",
          "append_child",
          "reparent_node",
          "delete_node",
        ].includes(operation.action.tool)
      )
        api.commitUndo();
      if (api.currentPage.id !== pageId)
        throw new Error("Figma page changed before the operation status was saved.");
      state.operations[operation.operationId] = {
        ...state.operations[operation.operationId]!,
        status: "completed",
        updatedAt: Date.now(),
        result: compactResult(result),
      };
      await saveState(state, pageId);
    } catch (error) {
      result = {
        operationId: operation.operationId,
        success: false,
        replayed: false,
        error: (error instanceof Error ? error.message : "Figma operation failed safely.").slice(
          0,
          400,
        ),
      };
      state.operations[operation.operationId] = {
        ...state.operations[operation.operationId]!,
        status: "failed",
        updatedAt: Date.now(),
        result: compactResult(result),
      };
      await saveState(state, pageId);
    }
    return result;
  };

  const executeBatch = async (
    batch: FigmaToolBatch,
    token: { cancelled: boolean },
  ): Promise<void> => {
    const results: OperationResult[] = [];
    const committedOperationIds: string[] = [];
    const partialOperationIds: string[] = [];
    let currentOperation: FigmaToolOperation | undefined;
    try {
      const pageId = api.currentPage.id;
      const parsed = JSON.stringify(batch);
      const duplicatedIds =
        new Set(batch.operations.map(({ operationId }) => operationId)).size !==
        batch.operations.length;
      const duplicatedKeys =
        new Set(batch.operations.map(({ idempotencyKey }) => idempotencyKey)).size !==
        batch.operations.length;
      if (!parsed || utf8Bytes(parsed) > MAX_PAYLOAD_BYTES || duplicatedIds || duplicatedKeys) {
        send({
          type: "tool-result",
          protocolVersion: 1,
          batchId: batch.batchId,
          success: false,
          cancelled: false,
          committedOperationIds: [],
          partialOperationIds: [],
          results: [
            {
              operationId: batch.operations[0]!.operationId,
              success: false,
              replayed: false,
              error:
                duplicatedIds || duplicatedKeys
                  ? "Operation IDs and idempotency keys must be unique within a batch."
                  : "Tool batch exceeds the 64 KiB safety limit.",
            },
          ],
        });
        return;
      }
      let state = await loadState(pageId);
      for (const [index, operation] of batch.operations.entries()) {
        if (token.cancelled) break;
        send({
          type: "tool-progress",
          protocolVersion: 1,
          batchId: batch.batchId,
          operationId: operation.operationId,
          index,
          total: batch.operations.length,
          status: "running",
          message: `Running ${operation.action.tool.replaceAll("_", " ")}…`,
        });
        currentOperation = operation;
        const result = await executeOperation(state, operation, pageId);
        currentOperation = undefined;
        results.push(result);
        boundResults(results);
        if (
          result.success &&
          !result.replayed &&
          [
            "create_frame",
            "create_text",
            "create_rectangle",
            "set_auto_layout",
            "set_properties",
            "append_child",
            "reparent_node",
            "delete_node",
          ].includes(operation.action.tool)
        )
          committedOperationIds.push(operation.operationId);
        if (!result.success && isMutatingAction(operation.action.tool))
          partialOperationIds.push(operation.operationId);
        send({
          type: "tool-progress",
          protocolVersion: 1,
          batchId: batch.batchId,
          operationId: operation.operationId,
          index,
          total: batch.operations.length,
          status: result.success ? "completed" : "failed",
          message: result.success
            ? (result.summary ?? "Operation completed.")
            : (result.error ?? "Operation failed."),
          ...(result.logicalRef ? { logicalRef: result.logicalRef } : {}),
        });
        if (!result.success) break;
        state = await loadState(pageId);
      }
      const cancelled = token.cancelled;
      if (cancelled && results.length < batch.operations.length) {
        const operation = batch.operations[results.length]!;
        send({
          type: "tool-progress",
          protocolVersion: 1,
          batchId: batch.batchId,
          operationId: operation.operationId,
          index: results.length,
          total: batch.operations.length,
          status: "cancelled",
          message: "Cancelled before this operation; earlier commits remain on the canvas.",
        });
      }
      send({
        type: "tool-result",
        protocolVersion: 1,
        batchId: batch.batchId,
        success:
          !cancelled &&
          results.length === batch.operations.length &&
          results.every(({ success }) => success),
        cancelled,
        committedOperationIds,
        partialOperationIds,
        results: results.slice(0, 10),
      });
    } catch (error) {
      const operation = currentOperation ?? batch.operations[results.length];
      if (currentOperation && isMutatingAction(currentOperation.action.tool))
        partialOperationIds.push(currentOperation.operationId);
      if (operation)
        results.push({
          operationId: operation.operationId,
          success: false,
          replayed: false,
          error: (error instanceof Error ? error.message : "Tool batch failed safely.").slice(
            0,
            400,
          ),
        });
      boundResults(results);
      send({
        type: "tool-result",
        protocolVersion: 1,
        batchId: batch.batchId,
        success: false,
        cancelled: token.cancelled,
        committedOperationIds,
        partialOperationIds,
        results: results.slice(0, 10),
      });
    }
  };

  return async (
    message: Extract<
      UIToPluginMessage,
      { type: "tool-execute" | "tool-cancel" | "tool-delete-consent" }
    >,
  ): Promise<void> => {
    if (message.type === "tool-cancel") {
      const active = cancellation.get(message.batchId);
      if (active) active.cancelled = true;
      return;
    }
    if (message.type === "tool-delete-consent") {
      try {
        const pageId = api.currentPage.id;
        const state = await loadState(pageId);
        await resolveRef(state, message.ref, pageId);
        if (message.confirmation !== `DELETE ${message.ref}`)
          throw new Error(
            `Type “DELETE ${message.ref}” to confirm deleting this node and all descendants.`,
          );
        const token = randomToken();
        deleteConsents.set(token, { token, ref: message.ref, expiresAt: Date.now() + 120_000 });
        send({
          type: "tool-delete-consent-result",
          protocolVersion: 1,
          requestId: message.requestId,
          success: true,
          consentToken: token,
          message: `Deletion of “${message.ref}” and descendants is authorized once for two minutes.`,
        });
      } catch (error) {
        send({
          type: "tool-delete-consent-result",
          protocolVersion: 1,
          requestId: message.requestId,
          success: false,
          message: (error instanceof Error
            ? error.message
            : "Deletion consent could not be issued."
          ).slice(0, 300),
        });
      }
      return;
    }
    if (pendingBatches >= 4) {
      send({
        type: "tool-result",
        protocolVersion: 1,
        batchId: message.batchId,
        success: false,
        cancelled: false,
        committedOperationIds: [],
        partialOperationIds: [],
        results: [
          {
            operationId: message.operations[0]!.operationId,
            success: false,
            replayed: false,
            error: "The local tool queue is full; try again after the current batch completes.",
          },
        ],
      });
      return;
    }
    const token = { cancelled: false };
    cancellation.set(message.batchId, token);
    pendingBatches++;
    const next = queue
      .then(() => executeBatch(message, token))
      .finally(() => {
        cancellation.delete(message.batchId);
        pendingBatches--;
      });
    queue = next.catch(() => undefined);
    await next;
  };
}
