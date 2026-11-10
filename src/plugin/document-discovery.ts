import { utf8Bytes } from "../shared/generation-limits";
import { DOCUMENT_DISCOVERY_LIMITS } from "../shared/figma-tools";

const STORAGE_PREFIX = "fad.document-discovery.v1";
const FRAME_TYPES = new Set(["FRAME", "COMPONENT", "INSTANCE"]);
const TOOL_TASK_PLUGIN_KEY = "fad.tool.task-id.v1";

type PageMeta = { id: string; name: string };
type PageStats = {
  status: "complete" | "inaccessible";
  nodesVisited: number;
  framesDiscovered: number;
  matchingFrames: number;
  exactNameMatches: number;
  framesInspected: number;
  inspectionNodesVisited: number;
  pageLoadMs: number;
  revision: number;
  reason?: string;
};
type StackEntry = { nodeId: string; nextChildIndex: number; root?: boolean };
type CurrentStats = Omit<PageStats, "status" | "revision"> & { pageId: string };
type DiscoveryCacheEntry = { key: string; bytes: number; accessedAt: number; complete: boolean };
type DiscoveryCacheRegistry = { version: 1; entries: DiscoveryCacheEntry[] };
type ScanCursor = {
  version: 2;
  documentKey: string;
  sessionId: string;
  queryKey: string;
  inspectionOnly: boolean;
  requestedPageId?: string;
  pages: PageMeta[];
  pageIndex: number;
  stack: StackEntry[];
  currentStats?: CurrentStats;
  pageResults: Record<string, PageStats>;
  samples: Array<Record<string, unknown>>;
  slices: number;
  adaptiveNodesPerSlice: number;
  maxNodesPerSliceObserved: number;
  sliceElapsedMsTotal: number;
  sliceElapsedMsMax: number;
  nodesVisitedTotal: number;
  startedAt: number;
  complete: boolean;
  paused: boolean;
  truncationReason?: string;
  revalidatedAfterRestart: boolean;
  invalidatedPages: number;
  pageSetChangedDuringScan: boolean;
};

export type ProgressiveDiscoverySnapshot = {
  pages: Array<{ id: string; name: string; current: boolean }>;
  frames: Array<Record<string, unknown>>;
  discovery: Record<string, unknown>;
};

export type ProgressiveDiscoveryOptions = {
  api: PluginAPI;
  documentKey: string;
  query?: string;
  taskId?: string;
  pageId?: string;
  inspectionOnly: boolean;
  isCancelled: () => boolean;
  isPauseRequested: () => boolean;
  progress: (message: string) => void;
  loadState: (pageId: string, inspectionOnly: boolean) => Promise<Record<string, unknown>>;
  saveState: (state: Record<string, unknown>, pageId: string, inspectionOnly: boolean) => Promise<void>;
  registerInspectionRef: (
    state: Record<string, unknown>,
    node: SceneNode,
    pageId: string,
    taskId?: string,
    inspectionOnly?: boolean,
  ) => string;
};

export function createProgressiveDiscoveryScanner(api: PluginAPI) {
  const sessionId = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  let cacheHits = 0;
  let cacheMisses = 0;
  let resumedCursors = 0;
  const loadedPages = new Set<string>([api.currentPage.id]);
  const revisions = new Map<string, number>();
  const dirtyPages = new Set<string>();
  const listeners = new Map<string, { page: PageNode; listener: (event: NodeChangeEvent) => void }>();
  let documentChangeListener: ((event: DocumentChangeEvent) => void) | undefined;
  let documentDirty = false;

  const markLoaded = (pageId: string) => {
    loadedPages.delete(pageId);
    loadedPages.add(pageId);
    while (loadedPages.size > DOCUMENT_DISCOVERY_LIMITS.pageCacheEntries)
      loadedPages.delete(loadedPages.values().next().value as string);
  };

  const enableDocumentInvalidation = () => {
    if (documentChangeListener || typeof api.on !== "function") return;
    documentChangeListener = () => { documentDirty = true; };
    api.on("documentchange", documentChangeListener);
  };

  const addListener = (page: PageNode) => {
    if (listeners.has(page.id)) return;
    if (listeners.size >= DOCUMENT_DISCOVERY_LIMITS.pageChangeListeners) {
      enableDocumentInvalidation();
      return;
    }
    const pageId = page.id;
    const listener = () => {
      revisions.set(pageId, (revisions.get(pageId) ?? 0) + 1);
      dirtyPages.add(pageId);
    };
    page.on("nodechange", listener);
    listeners.set(pageId, { page, listener });
    if (listeners.size >= DOCUMENT_DISCOVERY_LIMITS.pageChangeListeners) enableDocumentInvalidation();
  };
  const loadPage = (page: PageNode, isCancelled: () => boolean, isPauseRequested: () => boolean) =>
    new Promise<void>((resolve, reject) => {
      const startedAt = Date.now();
      let settled = false;
      let pollTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (pollTimer) clearTimeout(pollTimer);
        if (error) reject(error);
        else resolve();
      };
      const poll = () => {
        if (isCancelled()) return finish(new Error("Read-only discovery was cancelled."));
        if (isPauseRequested()) return finish(new Error("Read-only discovery paused at a page-load boundary."));
        if (Date.now() - startedAt >= DOCUMENT_DISCOVERY_LIMITS.pageLoadTimeoutMs)
          return finish(new Error("page_load_timeout"));
        pollTimer = setTimeout(poll, DOCUMENT_DISCOVERY_LIMITS.cancellationPollMs);
      };
      pollTimer = setTimeout(poll, DOCUMENT_DISCOVERY_LIMITS.cancellationPollMs);
      page.loadAsync().then(
        () => finish(),
        () => finish(new Error("page_load_failed")),
      );
    });

  return async function scan(options: ProgressiveDiscoveryOptions): Promise<ProgressiveDiscoverySnapshot> {
    const {
      documentKey,
      query,
      taskId,
      pageId: requestedPageId,
      inspectionOnly,
      isCancelled,
      isPauseRequested,
      progress,
    } = options;
    const originalPageId = api.currentPage.id;
    const normalizedQuery = (query ?? "").normalize("NFKC").toLocaleLowerCase().replace(/\s+/gu, " ").trim();
    const queryKey = normalizedQuery || "<all>";
    const hash = (value: string) => {
      let valueHash = 2166136261;
      for (let index = 0; index < value.length; index++) {
        valueHash ^= value.charCodeAt(index);
        valueHash = Math.imul(valueHash, 16777619);
      }
      return (valueHash >>> 0).toString(16).padStart(8, "0");
    };
    const storageKey =
      STORAGE_PREFIX + ":" + hash(documentKey) + ":" + (inspectionOnly ? "readonly" : (taskId ?? "ad-hoc").slice(0, 60)) + ":" +
      hash(JSON.stringify([queryKey, inspectionOnly, requestedPageId ?? "all"]));
    const registryKey = STORAGE_PREFIX + ":index:" + hash(documentKey);
    const getPages = (): PageMeta[] =>
      api.root.children
        .filter((page) => !requestedPageId || page.id === requestedPageId)
        .map(({ id, name }) => ({ id, name: name.slice(0, 100) }));
    const signature = (pages: PageMeta[]) => JSON.stringify(pages.map(({ id, name }) => [id, name]));
    const empty = (pages: PageMeta[]): ScanCursor => ({
      version: 2,
      documentKey,
      sessionId,
      queryKey,
      inspectionOnly,
      ...(requestedPageId ? { requestedPageId } : {}),
      pages,
      pageIndex: 0,
      stack: [],
      pageResults: {},
      samples: [],
      slices: 0,
      adaptiveNodesPerSlice: DOCUMENT_DISCOVERY_LIMITS.nodesPerSlice,
      maxNodesPerSliceObserved: 0,
      sliceElapsedMsTotal: 0,
      sliceElapsedMsMax: 0,
      nodesVisitedTotal: 0,
      startedAt: Date.now(),
      complete: pages.length === 0,
      paused: false,
      revalidatedAfterRestart: false,
      invalidatedPages: 0,
      pageSetChangedDuringScan: false,
    });
    let cursor = empty(getPages());
    let resumedCursor = false;
    let checkpointAvailable = true;
    const storage = api.clientStorage;
    let cacheRegistry: DiscoveryCacheRegistry = { version: 1, entries: [] };
    try {
      const rawRegistry: unknown = await storage.getAsync(registryKey);
      if (
        rawRegistry && typeof rawRegistry === "object" && !Array.isArray(rawRegistry) &&
        (rawRegistry as Partial<DiscoveryCacheRegistry>).version === 1 &&
        Array.isArray((rawRegistry as Partial<DiscoveryCacheRegistry>).entries)
      ) {
        const entries = (rawRegistry as DiscoveryCacheRegistry).entries.filter((entry) =>
          typeof entry?.key === "string" && entry.key.startsWith(STORAGE_PREFIX + ":") &&
          Number.isSafeInteger(entry.bytes) && entry.bytes >= 0 && Number.isSafeInteger(entry.accessedAt) &&
          typeof entry.complete === "boolean",
        );
        cacheRegistry = { version: 1, entries };
      } else if (typeof storage.keysAsync === "function") {
        const legacyKeys = (await storage.keysAsync()).filter(
          (key) => key.startsWith(STORAGE_PREFIX + ":") && key !== registryKey && !key.includes(":index:"),
        );
        for (const key of legacyKeys) {
          const value: unknown = await storage.getAsync(key);
          if (!value || typeof value !== "object" || Array.isArray(value)) continue;
          const serialized = JSON.stringify(value);
          const saved = value as Partial<ScanCursor>;
          cacheRegistry.entries.push({
            key,
            bytes: utf8Bytes(serialized),
            accessedAt: Number.isSafeInteger(saved.startedAt) ? saved.startedAt! : 0,
            complete: saved.complete === true,
          });
        }
      }
    } catch {
      // Legacy cache enumeration is best effort; discovery must still run without it.
    }
    try {
      const raw: unknown = await storage.getAsync(storageKey);
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        const saved = raw as Partial<ScanCursor>;
        const valid =
          saved.version === 2 && saved.documentKey === documentKey && saved.queryKey === queryKey &&
          saved.inspectionOnly === inspectionOnly && saved.requestedPageId === requestedPageId &&
          Array.isArray(saved.pages) && Array.isArray(saved.stack) && Array.isArray(saved.samples) &&
          saved.pageResults && typeof saved.pageResults === "object" &&
          Number.isSafeInteger(saved.pageIndex) && Number.isSafeInteger(saved.slices);
        if (valid && saved.sessionId === sessionId) {
          cursor = saved as ScanCursor;
          resumedCursor = true;
          cursor.adaptiveNodesPerSlice = Number.isSafeInteger(saved.adaptiveNodesPerSlice)
            ? Math.max(16, Math.min(DOCUMENT_DISCOVERY_LIMITS.nodesPerSlice, saved.adaptiveNodesPerSlice!))
            : DOCUMENT_DISCOVERY_LIMITS.nodesPerSlice;
          cursor.paused = false;
        } else if (valid) {
          cursor = empty(getPages());
          cursor.revalidatedAfterRestart = true;
        }
      }
    } catch {
      checkpointAvailable = false;
      cursor.truncationReason = "discovery_checkpoint_unavailable";
    }

    const persist = async () => {
      if (!checkpointAvailable) return false;
      cursor.sessionId = sessionId;
      const serialized = JSON.stringify(cursor);
      if (utf8Bytes(serialized) > DOCUMENT_DISCOVERY_LIMITS.checkpointBytes) {
        cursor.truncationReason = "discovery_checkpoint_budget_reached";
        checkpointAvailable = false;
        return false;
      }
      try {
        const currentBytes = utf8Bytes(serialized);
        let entries = cacheRegistry.entries.filter((entry) => entry.key !== storageKey);
        entries.push({ key: storageKey, bytes: currentBytes, accessedAt: Date.now(), complete: cursor.complete });
        const cacheBytes = () => entries.reduce((sum, entry) => sum + entry.bytes, 0);
        while (
          entries.length > DOCUMENT_DISCOVERY_LIMITS.cacheEntries ||
          cacheBytes() > DOCUMENT_DISCOVERY_LIMITS.cacheBytes
        ) {
          const candidate = entries
            .filter((entry) => entry.key !== storageKey && entry.complete)
            .sort((left, right) => left.accessedAt - right.accessedAt || left.key.localeCompare(right.key))[0];
          if (!candidate) {
            cursor.truncationReason = "discovery_cache_budget_reached";
            checkpointAvailable = false;
            return false;
          }
          await storage.deleteAsync(candidate.key);
          entries = entries.filter((entry) => entry.key !== candidate.key);
        }
        await storage.setAsync(storageKey, cursor);
        cacheRegistry = { version: 1, entries };
        await storage.setAsync(registryKey, cacheRegistry);
        return true;
      } catch {
        cursor.truncationReason = "discovery_checkpoint_unavailable";
        checkpointAvailable = false;
        return false;
      }
    };
    const childrenOf = (node: PageNode | SceneNode): readonly SceneNode[] =>
      "children" in node ? node.children : [];
    const pageTotals = () => {
      const all = [...Object.values(cursor.pageResults), ...(cursor.currentStats ? [cursor.currentStats] : [])];
      return {
        pagesScanned: Object.values(cursor.pageResults).filter((item) => item.status === "complete").length,
        inaccessiblePages: Object.values(cursor.pageResults).filter((item) => item.status === "inaccessible").length,
        nodesVisited: all.reduce((sum, item) => sum + item.nodesVisited, 0),
        framesDiscovered: all.reduce((sum, item) => sum + item.framesDiscovered, 0),
        matchingFrames: all.reduce((sum, item) => sum + item.matchingFrames, 0),
        exactNameMatches: all.reduce((sum, item) => sum + item.exactNameMatches, 0),
        framesInspected: all.reduce((sum, item) => sum + item.framesInspected, 0),
        inspectionNodesVisited: all.reduce((sum, item) => sum + item.inspectionNodesVisited, 0),
        pageLoadMs: all.reduce((sum, item) => sum + item.pageLoadMs, 0),
      };
    };
    const reconcile = () => {
      const fresh = getPages();
      if (documentDirty) {
        cursor.invalidatedPages += Object.keys(cursor.pageResults).length + (cursor.currentStats ? 1 : 0);
        cursor.pageResults = {};
        cursor.samples = [];
        cursor.currentStats = undefined;
        cursor.stack = [];
        dirtyPages.clear();
        documentDirty = false;
      }
      const old = new Map(cursor.pages.map((item) => [item.id, item]));
      const ids = new Set(fresh.map((item) => item.id));
      for (const id of Object.keys(cursor.pageResults)) if (!ids.has(id)) {
        delete cursor.pageResults[id];
        cursor.samples = cursor.samples.filter((sample) => sample.pageId !== id);
      }
      for (const item of fresh) {
        const prior = old.get(item.id);
        if (!prior || prior.name !== item.name) {
          if (cursor.pageResults[item.id]) {
            delete cursor.pageResults[item.id];
            cursor.samples = cursor.samples.filter((sample) => sample.pageId !== item.id);
            cursor.invalidatedPages++;
          }
          if (cursor.currentStats?.pageId === item.id) {
            cursor.currentStats = undefined;
            cursor.stack = [];
          }
        }
      }
      cursor.pageSetChangedDuringScan ||= signature(fresh) !== signature(cursor.pages);
      cursor.pages = fresh;
      for (const id of dirtyPages) {
        cursor.samples = cursor.samples.filter((sample) => sample.pageId !== id);
        if (cursor.pageResults[id]) {
          delete cursor.pageResults[id];
          cursor.invalidatedPages++;
        }
        if (cursor.currentStats?.pageId === id) {
          cursor.currentStats = undefined;
          cursor.stack = [];
        }
        dirtyPages.delete(id);
      }
      const firstMissing = fresh.findIndex((item) => !cursor.pageResults[item.id]);
      cursor.pageIndex = firstMissing < 0 ? fresh.length : firstMissing;
      cursor.complete = cursor.pageIndex >= fresh.length;
      return fresh;
    };
    const isFrame = (node: SceneNode) => FRAME_TYPES.has(node.type);
    const matchesQuery = (node: SceneNode, page: PageNode) => {
      if (!normalizedQuery) return true;
      let metadata: Record<string, unknown> = {};
      try {
        const value: unknown = JSON.parse(node.getPluginData("fad.multi-screen.metadata"));
        if (value && typeof value === "object" && !Array.isArray(value)) metadata = value as Record<string, unknown>;
      } catch {
        // Malformed legacy metadata cannot establish a match.
      }
      const values = [
        node.id, node.name, page.name,
        node.getPluginData("fad.design.name.v1"),
        node.getPluginData("fad.design.task-id.v1"),
        node.getPluginData("fad.design.chat-id.v1"),
        node.getPluginData("fad.task-id.v1"),
        node.getPluginData(TOOL_TASK_PLUGIN_KEY),
        node.getPluginData("fad.multi-screen.batch-id"),
        node.getPluginData("fad.multi-screen.screen-id"),
        metadata.batchName, metadata.screenName, metadata.title, metadata.role,
      ];
      const searchable = values.filter((value): value is string => typeof value === "string")
        .join(" ").normalize("NFKC").toLocaleLowerCase().replace(/\s+/gu, " ");
      const terms = normalizedQuery.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
      return searchable.includes(normalizedQuery) || (terms.length > 0 && terms.every((term) => searchable.includes(term)));
    };
    const nativePreview = (node: SceneNode, maxChildSamples = 3) => {
      const children = childrenOf(node);
      return {
        id: node.id, type: node.type, name: node.name.slice(0, 100),
        x: node.x, y: node.y, width: node.width, height: node.height,
        visible: node.visible, locked: node.locked, childCount: children.length,
        childSamples: children.slice(0, maxChildSamples).map((child) => ({
          id: child.id, type: child.type, name: child.name.slice(0, 80),
          x: child.x, y: child.y, width: child.width, height: child.height,
          visible: child.visible, locked: child.locked,
        })),
        childSamplesTruncated: children.length > maxChildSamples,
      };
    };
    let directTargetResolved = false;
    let directTargetPaused = false;
    const directIdMatch = normalizedQuery.match(/^\d+:\d+$/u);
    if (directIdMatch) {
      try {
        const direct = await api.getNodeByIdAsync(query!.trim());
        if (direct && "type" in direct && direct.type !== "DOCUMENT" && direct.type !== "PAGE") {
          let ancestor: BaseNode | null = direct.parent;
          while (ancestor && ancestor.type !== "PAGE") ancestor = ancestor.parent;
          const directPage = ancestor?.type === "PAGE" ? ancestor as PageNode : undefined;
          if (directPage && (!requestedPageId || directPage.id === requestedPageId)) {
            const directLoadStartedAt = Date.now();
            if (!loadedPages.has(directPage.id)) {
              await loadPage(directPage, isCancelled, isPauseRequested);
              markLoaded(directPage.id);
            }
            addListener(directPage);
            const verifiedNode = await api.getNodeByIdAsync(query!.trim());
            let verifiedPage: BaseNode | null =
              verifiedNode && "type" in verifiedNode && verifiedNode.type !== "DOCUMENT" && verifiedNode.type !== "PAGE"
                ? verifiedNode.parent
                : null;
            while (verifiedPage && verifiedPage.type !== "PAGE") verifiedPage = verifiedPage.parent;
            const isVerifiedFrame = verifiedPage?.id === directPage.id &&
              verifiedNode && "type" in verifiedNode && verifiedNode.type !== "DOCUMENT" && verifiedNode.type !== "PAGE";
            if (verifiedNode && isVerifiedFrame && isFrame(verifiedNode as SceneNode)) {
              const node = verifiedNode as SceneNode;
              let ref: string | undefined;
              if (cursor.samples.length < 2) {
                const refState = await options.loadState(directPage.id, inspectionOnly);
                try { ref = options.registerInspectionRef(refState, node, directPage.id, taskId, inspectionOnly); } catch { /* The target remains native evidence; an editable ref is optional. */ }
                await options.saveState(refState, directPage.id, inspectionOnly);
              }
              const preview = inspectionOnly ? nativePreview(node) : undefined;
              cursor.pages = [{ id: directPage.id, name: directPage.name.slice(0, 100) }];
              cursor.pageIndex = 1;
              cursor.currentStats = undefined;
              cursor.stack = [];
              cursor.pageResults = {
                [directPage.id]: {
                  status: "complete", nodesVisited: 1, framesDiscovered: 1,
                  matchingFrames: 1, exactNameMatches: node.name.normalize("NFKC").toLocaleLowerCase().replace(/\s+/gu, " ").trim() === normalizedQuery ? 1 : 0,
                  framesInspected: preview ? 1 : 0,
                  inspectionNodesVisited: preview ? 1 + Math.min(childrenOf(node).length, 3) : 0,
                  pageLoadMs: Math.max(0, Date.now() - directLoadStartedAt), revision: revisions.get(directPage.id) ?? 0,
                },
              };
              cursor.samples = [{
                pageId: directPage.id, pageName: directPage.name.slice(0, 100), nodeId: node.id,
                ...(node.parent?.type !== "PAGE" && node.parent ? { parentNodeId: node.parent.id, parentName: node.parent.name.slice(0, 100) } : {}),
                ...(ref ? { ref } : {}), depth: 0, type: node.type, name: node.name.slice(0, 100),
                x: node.x, y: node.y, width: node.width, height: node.height,
                visible: node.visible, locked: node.locked, editable: Boolean(ref),
                ...(preview ? { nativeInspected: true, nativeInspection: preview } : {}),
              }];
              cursor.slices = 1;
              cursor.maxNodesPerSliceObserved = 4;
              cursor.sliceElapsedMsTotal = 0;
              cursor.sliceElapsedMsMax = 0;
              cursor.complete = true;
              await persist();
              directTargetResolved = true;
            }
          }
        }
      } catch (error) {
        if (isCancelled()) {
          await persist();
          throw new Error("Read-only discovery was cancelled.", { cause: error });
        }
        if (isPauseRequested()) {
          cursor.paused = true;
          await persist();
          directTargetPaused = true;
        }
        // If Figma cannot resolve an unloaded ID directly, the safe progressive scan remains available.
      }
    }
    const summary = (cacheHit: boolean, paused: boolean) => {
      const totals = pageTotals();
      const remaining = Math.max(0, cursor.pages.length - Object.keys(cursor.pageResults).length);
      const complete = cursor.complete && totals.inaccessiblePages === 0 && !cursor.truncationReason && !paused;
      return {
        pagesVisited: totals.pagesScanned,
        pagesAvailable: directTargetResolved ? api.root.children.length : cursor.pages.length,
        pagesLoaded: totals.pagesScanned + (cursor.currentStats ? 1 : 0),
        loadedPageCacheEntries: loadedPages.size,
        trackedPageListeners: listeners.size,
        globalInvalidationFallback: Boolean(documentChangeListener),
        discoveryCacheEntries: cacheRegistry.entries.length,
        discoveryCacheBytes: cacheRegistry.entries.reduce((sum, entry) => sum + entry.bytes, 0),
        pagesRemaining: remaining,
        nodesVisited: totals.nodesVisited,
        nodesVisitedTotal: cursor.nodesVisitedTotal,
        inspectionNodesVisited: totals.inspectionNodesVisited,
        framesDiscovered: totals.framesDiscovered,
        framesInspected: totals.framesInspected,
        framesReturned: cursor.samples.length,
        matchCount: totals.matchingFrames,
        exactNameMatchCount: totals.exactNameMatches,
        truncated: !complete,
        complete,
        continuationAvailable: (!cursor.complete || totals.inaccessiblePages > 0) && checkpointAvailable,
        truncationReason: cursor.truncationReason ?? (totals.inaccessiblePages ? "one_or_more_pages_inaccessible" : undefined),
        inaccessiblePages: totals.inaccessiblePages,
        inaccessiblePageSamples: Object.entries(cursor.pageResults)
          .filter(([, result]) => result.status === "inaccessible")
          .slice(0, 24)
          .map(([id, result]) => ({
            id,
            name: cursor.pages.find((page) => page.id === id)?.name ?? "",
            ...(result.reason ? { reason: result.reason } : {}),
          })),
        nativeInspection: {
          complete: inspectionOnly && complete && totals.framesInspected === totals.matchingFrames,
          framesInspected: totals.framesInspected,
          framesExpected: totals.matchingFrames,
          inspectionNodesVisited: totals.inspectionNodesVisited,
          sampleFramesReturned: cursor.samples.length,
        },
        scanElapsedMs: cursor.sliceElapsedMsTotal,
        sliceCount: cursor.slices,
        nodesPerSliceBudget: DOCUMENT_DISCOVERY_LIMITS.nodesPerSlice,
        maxNodesPerSliceObserved: cursor.maxNodesPerSliceObserved,
        adaptiveNodesPerSlice: cursor.adaptiveNodesPerSlice,
        targetSliceMs: DOCUMENT_DISCOVERY_LIMITS.targetSliceMs,
        hardSliceMs: DOCUMENT_DISCOVERY_LIMITS.hardSliceMs,
        averageSliceMs: cursor.slices ? Math.round(cursor.sliceElapsedMsTotal / cursor.slices) : 0,
        maxSliceMs: cursor.sliceElapsedMsMax,
        pageLoadMs: totals.pageLoadMs,
        pagesPerCheckpoint: DOCUMENT_DISCOVERY_LIMITS.pagesPerCheckpoint,
        pagesPerYield: DOCUMENT_DISCOVERY_LIMITS.pagesPerYield,
        cacheLookups: cacheHits + cacheMisses + resumedCursors,
        cacheHits,
        cacheHitRate: cacheHits + cacheMisses + resumedCursors === 0
          ? 0
          : cacheHits / (cacheHits + cacheMisses + resumedCursors),
        resumedCursors,
        scope: directTargetResolved ? "exact_node" : requestedPageId ? "requested_page" : "all_accessible_pages",
        cacheHit,
        revalidatedAfterRestart: cursor.revalidatedAfterRestart,
        invalidatedPages: cursor.invalidatedPages,
        pageSetChangedDuringScan: cursor.pageSetChangedDuringScan,
        paused,
        ...(query ? {
          query,
          matchStatus: totals.exactNameMatches === 1 && cursor.samples.some((frame) =>
            typeof frame.name === "string" && frame.name.normalize("NFKC").toLocaleLowerCase().replace(/\s+/gu, " ").trim() === normalizedQuery && typeof frame.ref === "string",
          ) ? "unique" : totals.exactNameMatches === 1 ? "uneditable" :
            totals.exactNameMatches > 1 ? "ambiguous" : totals.matchingFrames === 1 && cursor.samples[0]?.ref ? "unique" :
            totals.matchingFrames === 1 ? "uneditable" : totals.matchingFrames > 1 ? "ambiguous" :
              complete ? "no_match" : "no_match_truncated",
        } : { matchStatus: "not_queried" }),
        sampleFramesTruncated: totals.matchingFrames > cursor.samples.length,
        ...(requestedPageId ? { requestedPageId } : {}),
      };
    };
    const snapshot = (cacheHit: boolean, paused: boolean): ProgressiveDiscoverySnapshot => ({
      pages: cursor.pages.slice(0, 24).map((page) => ({ ...page, current: page.id === originalPageId })),
      frames: cursor.samples.slice(0, DOCUMENT_DISCOVERY_LIMITS.resultFrames),
      discovery: summary(cacheHit, paused),
    });

    if (directTargetPaused) return snapshot(false, true);
    if (directTargetResolved) return snapshot(false, false);

    let currentPages = reconcile();
    if (cursor.complete && Object.values(cursor.pageResults).some((page) => page.status === "inaccessible")) {
      for (const [id, result] of Object.entries(cursor.pageResults))
        if (result.status === "inaccessible") delete cursor.pageResults[id];
      cursor.complete = false;
      cursor.truncationReason = undefined;
      currentPages = reconcile();
    }
    if (requestedPageId && currentPages.length === 0) {
      cursor.complete = true;
      cursor.truncationReason = "requested_page_unavailable";
      await persist();
      return snapshot(false, false);
    }
    if (cursor.complete && !cursor.truncationReason && currentPages.every((page) => !dirtyPages.has(page.id))) {
      cacheHits++;
      const cacheEntry = cacheRegistry.entries.find((entry) => entry.key === storageKey);
      if (cacheEntry) {
        cacheEntry.accessedAt = Date.now();
        try { await storage.setAsync(registryKey, cacheRegistry); } catch { /* Cache-hit metadata is optional. */ }
      }
      return snapshot(true, false);
    }
    if (resumedCursor) resumedCursors++;
    else cacheMisses++;

    let lastProgressAt = Date.now();
    let lastEventLoopYieldAt = Date.now();
    let pagesSinceEventLoopYield = 0;
    let stalled = 0;
    let completedPagesSinceCheckpoint = 0;
    while (!cursor.complete) {
      if (isCancelled()) {
        await persist();
        throw new Error("Read-only discovery was cancelled.");
      }
      const pages = reconcile();
      if (cursor.pageIndex >= pages.length) {
        cursor.complete = true;
        await persist();
        break;
      }
      const meta = pages[cursor.pageIndex]!;
      const page = api.root.children.find((candidate) => candidate.id === meta.id);
      if (!page) {
        cursor.pageResults[meta.id] = {
                  status: "inaccessible", nodesVisited: 0, framesDiscovered: 0, matchingFrames: 0, exactNameMatches: 0,
          framesInspected: 0, inspectionNodesVisited: 0, pageLoadMs: 0,
          revision: revisions.get(meta.id) ?? 0, reason: "page_removed_during_scan",
        };
        cursor.pageIndex++;
        completedPagesSinceCheckpoint++;
        if (completedPagesSinceCheckpoint >= DOCUMENT_DISCOVERY_LIMITS.pagesPerCheckpoint) {
          await persist();
          completedPagesSinceCheckpoint = 0;
        }
        continue;
      }
      const loadStartedAt = Date.now();
      try {
        if (!loadedPages.has(page.id)) {
          await loadPage(page, isCancelled, isPauseRequested);
          markLoaded(page.id);
        }
        addListener(page);
      } catch (error) {
        if (isCancelled()) {
          await persist();
          throw new Error("Read-only discovery was cancelled.", { cause: error });
        }
        if (isPauseRequested()) {
          cursor.paused = true;
          await persist();
          break;
        }
        cursor.pageResults[page.id] = {
          status: "inaccessible", nodesVisited: 0, framesDiscovered: 0, matchingFrames: 0, exactNameMatches: 0,
          framesInspected: 0, inspectionNodesVisited: 0, pageLoadMs: Date.now() - loadStartedAt,
          revision: revisions.get(page.id) ?? 0,
          reason: error instanceof Error && error.message === "page_load_timeout" ? "page_load_timeout" : "page_load_failed",
        };
        cursor.pageIndex++;
        await persist();
        progress("Page " + page.name.slice(0, 80) + " could not be loaded; continuing.");
        continue;
      }
      if (!cursor.currentStats || cursor.currentStats.pageId !== page.id) {
        cursor.currentStats = {
          pageId: page.id, nodesVisited: 0, framesDiscovered: 0, matchingFrames: 0, exactNameMatches: 0,
          framesInspected: 0, inspectionNodesVisited: 0, pageLoadMs: Date.now() - loadStartedAt,
        };
        cursor.stack = [{ nodeId: page.id, nextChildIndex: 0, root: true }];
      }
      const stackNodes = new Map<string, PageNode | SceneNode>([[page.id, page]]);
      let validStack = cursor.stack[0]?.root === true && cursor.stack[0]?.nodeId === page.id;
      for (let index = 1; validStack && index < cursor.stack.length; index++) {
        const previous = cursor.stack[index - 1]!;
        const parent = stackNodes.get(previous.nodeId);
        const expectedIndex = previous.nextChildIndex - 1;
        const savedNode = await api.getNodeByIdAsync(cursor.stack[index]!.nodeId);
        if (!parent || !savedNode || !("type" in savedNode) || savedNode.type === "DOCUMENT" || savedNode.type === "PAGE" ||
          expectedIndex < 0 || childrenOf(parent).at(expectedIndex)?.id !== savedNode.id || savedNode.parent?.id !== parent.id) {
          validStack = false;
        } else stackNodes.set(savedNode.id, savedNode as SceneNode);
      }
      if (!validStack) {
        cursor.invalidatedPages++;
        cursor.currentStats = {
          pageId: page.id, nodesVisited: 0, framesDiscovered: 0, matchingFrames: 0, exactNameMatches: 0,
          framesInspected: 0, inspectionNodesVisited: 0, pageLoadMs: cursor.currentStats.pageLoadMs,
        };
        cursor.stack = [{ nodeId: page.id, nextChildIndex: 0, root: true }];
        stackNodes.clear();
        stackNodes.set(page.id, page);
      }

      const before = JSON.stringify([cursor.pageIndex, cursor.stack]);
      const sliceStartedAt = Date.now();
      const sliceNodeBudget = cursor.adaptiveNodesPerSlice;
      let nodesThisSlice = 0;
      let workUnitsThisSlice = 0;
      let pageCompleted = false;
      while (cursor.stack.length && workUnitsThisSlice < sliceNodeBudget &&
        Date.now() - sliceStartedAt < DOCUMENT_DISCOVERY_LIMITS.targetSliceMs &&
        Date.now() - sliceStartedAt < DOCUMENT_DISCOVERY_LIMITS.hardSliceMs) {
        if (isCancelled()) break;
        const top = cursor.stack[cursor.stack.length - 1]!;
        const parent = stackNodes.get(top.nodeId);
        if (!parent) break;
        const children = childrenOf(parent);
        if (top.nextChildIndex >= children.length) {
          cursor.stack.pop();
          stackNodes.delete(top.nodeId);
          if (!cursor.stack.length) pageCompleted = true;
          continue;
        }
        const node = children[top.nextChildIndex++]!;
        nodesThisSlice++;
        workUnitsThisSlice++;
        cursor.nodesVisitedTotal++;
        cursor.currentStats!.nodesVisited++;
        if (isFrame(node)) {
          cursor.currentStats!.framesDiscovered++;
          if (matchesQuery(node, page)) {
            cursor.currentStats!.matchingFrames++;
            const exactNameMatch = node.name.normalize("NFKC").toLocaleLowerCase().replace(/\s+/gu, " ").trim() === normalizedQuery;
            if (exactNameMatch) cursor.currentStats!.exactNameMatches++;
            const matchIndex = cursor.currentStats!.matchingFrames +
              Object.entries(cursor.pageResults).filter(([id]) => id !== page.id).reduce((sum, [, result]) => sum + result.matchingFrames, 0);
            let ref: string | undefined;
            if (normalizedQuery && (matchIndex <= 2 || exactNameMatch)) {
              const refState = await options.loadState(page.id, inspectionOnly);
              const beforeRefs = JSON.stringify(refState.refs);
              try { ref = options.registerInspectionRef(refState, node, page.id, taskId, inspectionOnly); } catch { /* References are optional evidence; native scan results remain valid. */ }
              if (JSON.stringify(refState.refs) !== beforeRefs) await options.saveState(refState, page.id, inspectionOnly);
            }
            const inspectionCount = Math.min(
              childrenOf(node).length,
              3,
              Math.max(0, sliceNodeBudget - workUnitsThisSlice),
            );
            const preview = inspectionOnly ? nativePreview(node, inspectionCount) : undefined;
            if (preview) {
              cursor.currentStats!.framesInspected++;
              cursor.currentStats!.inspectionNodesVisited += 1 + inspectionCount;
              workUnitsThisSlice += inspectionCount;
            }
            const frameSample = {
                pageId: page.id, pageName: page.name.slice(0, 100), nodeId: node.id,
                ...(node.parent?.type !== "PAGE" && node.parent ? { parentNodeId: node.parent.id, parentName: node.parent.name.slice(0, 100) } : {}),
                ...(ref ? { ref } : {}), depth: cursor.stack.length, type: node.type,
                name: node.name.slice(0, 100), x: node.x, y: node.y, width: node.width,
                height: node.height, visible: node.visible, locked: node.locked,
                editable: Boolean(ref), ...(preview ? { nativeInspected: true, nativeInspection: preview } : {}),
                ...(node.getPluginData("fad.tool.operation-id.v1") ? { creationOperationId: node.getPluginData("fad.tool.operation-id.v1") } : {}),
                ...(node.getPluginData("fad.generation.commit") ? { generationStatus: node.getPluginData("fad.generation.commit") } : {}),
                ...(node.getPluginData("fad.design.name.v1") ? { projectName: node.getPluginData("fad.design.name.v1") } : {}),
                ...(node.getPluginData("fad.task-id.v1") || node.getPluginData(TOOL_TASK_PLUGIN_KEY)
                  ? { taskId: node.getPluginData("fad.task-id.v1") || node.getPluginData(TOOL_TASK_PLUGIN_KEY) }
                  : {}),
                ...(node.getPluginData("fad.design.task-id.v1") ? { ownerTaskId: node.getPluginData("fad.design.task-id.v1") } : {}),
                ...(node.getPluginData("fad.design.chat-id.v1") ? { chatId: node.getPluginData("fad.design.chat-id.v1") } : {}),
                ...(node.getPluginData("fad.multi-screen.batch-id") ? { generationId: node.getPluginData("fad.multi-screen.batch-id") } : {}),
                ...(node.getPluginData("fad.multi-screen.screen-id") ? { screenId: node.getPluginData("fad.multi-screen.screen-id") } : {}),
              };
            if (cursor.samples.length < DOCUMENT_DISCOVERY_LIMITS.resultFrames) cursor.samples.push(frameSample);
            else if (exactNameMatch && !cursor.samples.some((sample) =>
              typeof sample.name === "string" && sample.name.normalize("NFKC").toLocaleLowerCase().replace(/\s+/gu, " ").trim() === normalizedQuery,
            )) {
              const replaceIndex = cursor.samples.findIndex((sample) =>
                typeof sample.name !== "string" || sample.name.normalize("NFKC").toLocaleLowerCase().replace(/\s+/gu, " ").trim() !== normalizedQuery,
              );
              if (replaceIndex >= 0) cursor.samples[replaceIndex] = frameSample;
            }
          }
        }
        if ("children" in node && childrenOf(node).length) {
          cursor.stack.push({ nodeId: node.id, nextChildIndex: 0 });
          stackNodes.set(node.id, node);
        }
      }
      if (cursor.stack.length === 1 && cursor.stack[0]!.nextChildIndex >= childrenOf(page).length) {
        cursor.stack = [];
        pageCompleted = true;
      }
      const elapsed = Math.max(0, Date.now() - sliceStartedAt);
      if (elapsed > DOCUMENT_DISCOVERY_LIMITS.targetSliceMs) {
        cursor.adaptiveNodesPerSlice = Math.max(16, Math.floor(sliceNodeBudget * 0.75));
      } else if (elapsed < DOCUMENT_DISCOVERY_LIMITS.targetSliceMs / 2) {
        cursor.adaptiveNodesPerSlice = Math.min(DOCUMENT_DISCOVERY_LIMITS.nodesPerSlice, sliceNodeBudget + 16);
      }
      cursor.slices++;
      cursor.maxNodesPerSliceObserved = Math.max(cursor.maxNodesPerSliceObserved, workUnitsThisSlice);
      cursor.sliceElapsedMsTotal += elapsed;
      cursor.sliceElapsedMsMax = Math.max(cursor.sliceElapsedMsMax, elapsed);
      if (before === JSON.stringify([cursor.pageIndex, cursor.stack]) && nodesThisSlice === 0 && !pageCompleted) stalled++;
      else stalled = 0;
      if (stalled >= 2) {
        cursor.truncationReason = "discovery_cursor_stalled";
        cursor.complete = true;
      }
      if (pageCompleted) {
        const current = cursor.currentStats!;
        cursor.pageResults[page.id] = {
          status: "complete", nodesVisited: current.nodesVisited,
          framesDiscovered: current.framesDiscovered, matchingFrames: current.matchingFrames,
          exactNameMatches: current.exactNameMatches,
          framesInspected: current.framesInspected, inspectionNodesVisited: current.inspectionNodesVisited,
          pageLoadMs: current.pageLoadMs, revision: revisions.get(page.id) ?? 0,
        };
        cursor.currentStats = undefined;
        cursor.stack = [];
        completedPagesSinceCheckpoint++;
        pagesSinceEventLoopYield++;
      }
      const progressDue = Date.now() - lastProgressAt >= 750 ||
        (pageCompleted && (cursor.pageIndex + 1) % 10 === 0);
      const shouldCheckpoint = !pageCompleted ||
        completedPagesSinceCheckpoint >= DOCUMENT_DISCOVERY_LIMITS.pagesPerCheckpoint ||
        cursor.pageIndex === pages.length - 1 || isCancelled() || isPauseRequested();
      const completed = shouldCheckpoint ? await persist() : true;
      if (shouldCheckpoint) completedPagesSinceCheckpoint = 0;
      if (!completed && !cursor.complete) cursor.complete = true;
      if (progressDue) {
        const currentTotals = pageTotals();
        progress("Progressive discovery: " + currentTotals.pagesScanned + "/" + cursor.pages.length +
          " pages · " + currentTotals.nodesVisited + " nodes · " + currentTotals.matchingFrames + " matches.");
        lastProgressAt = Date.now();
      }
      if (isCancelled()) {
        await persist();
        throw new Error("Read-only discovery was cancelled.");
      }
      if (isPauseRequested()) {
        cursor.paused = true;
        await persist();
        break;
      }
      if (
        !pageCompleted ||
        pagesSinceEventLoopYield >= DOCUMENT_DISCOVERY_LIMITS.pagesPerYield ||
        Date.now() - lastEventLoopYieldAt >= DOCUMENT_DISCOVERY_LIMITS.hardSliceMs ||
        isCancelled() ||
        isPauseRequested()
      ) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        lastEventLoopYieldAt = Date.now();
        pagesSinceEventLoopYield = 0;
      }
    }
    return snapshot(false, cursor.paused);
  };
}
