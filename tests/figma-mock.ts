export type MockNode = SceneNode & {
  children: MockNode[];
  pluginData: Map<string, string>;
  parent: MockNode | PageNode | null;
  resize(width: number, height: number): void;
  appendChild(node: MockNode): void;
  remove(): void;
  removed: boolean;
  [key: string]: unknown;
};

export function createMockApi() {
  const roots: MockNode[] = [];
  const nodes: MockNode[] = [];
  const storage = new Map<string, unknown>();
  const rootData = new Map<string, string>();
  const viewportFocusCalls: string[][] = [];
  const pageChangeListeners = new Map<string, Set<(event: NodeChangeEvent) => void>>();
  const documentChangeListeners = new Set<(event: DocumentChangeEvent) => void>();
  const emitDocumentChange = () => {
    const event = { documentChanges: [] } as unknown as DocumentChangeEvent;
    for (const listener of documentChangeListeners) listener(event);
  };
  const emitPageChange = (pageId: string) => {
    for (const listener of pageChangeListeners.get(pageId) ?? [])
      listener({ nodeChanges: [] } as unknown as NodeChangeEvent);
    emitDocumentChange();
  };
  const paintStyles = [
    { id: "paint-token-brand", name: "Color/Brand", paints: [] },
  ] as unknown as PaintStyle[];
  const textStyles = [
    { id: "text-token-heading", name: "Typography/Heading" },
  ] as unknown as TextStyle[];
  let nextId = 1;
  const detach = (node: MockNode) => {
    if (!node.parent) return;
    if (node.parent.type === "PAGE") {
      const page = node.parent as unknown as { children: MockNode[] };
      const index = page.children.indexOf(node);
      if (index >= 0) page.children.splice(index, 1);
    } else {
      const parent = node.parent as MockNode;
      const index = parent.children.indexOf(node);
      if (index >= 0) parent.children.splice(index, 1);
    }
    node.parent = null;
  };
  const page = {
    id: "page:current",
    name: "Current Page",
    type: "PAGE",
    children: roots,
    selection: [] as MockNode[],
    loaded: true,
    loadCalls: 0,
    async loadAsync() {
      page.loadCalls++;
      page.loaded = true;
    },
    on(_type: "nodechange", listener: (event: NodeChangeEvent) => void) {
      const listeners = pageChangeListeners.get(page.id) ?? new Set();
      listeners.add(listener);
      pageChangeListeners.set(page.id, listeners);
    },
    off(_type: "nodechange", listener: (event: NodeChangeEvent) => void) {
      pageChangeListeners.get(page.id)?.delete(listener);
    },
    findAll(predicate: (node: SceneNode) => boolean = () => true) {
      const result: MockNode[] = [];
      const visit = (node: MockNode) => {
        if (predicate(node)) result.push(node);
        node.children.forEach(visit);
      };
      roots.forEach(visit);
      return result;
    },
    appendChild(node: MockNode) {
      detach(node);
      roots.push(node);
      node.parent = page as unknown as PageNode;
    },
  };
  const makeNode = (type: string): MockNode => {
    let layoutSizingHorizontal: "FIXED" | "HUG" | "FILL" = "FIXED";
    let layoutSizingVertical: "FIXED" | "HUG" | "FILL" = "FIXED";
    const node = {
      id: `mock:${nextId++}`,
      type,
      name: "",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      visible: true,
      opacity: 1,
      fills: [] as readonly Paint[],
      strokes: [] as readonly Paint[],
      strokeWeight: 1,
      cornerRadius: 0,
      effects: [] as readonly Effect[],
      clipsContent: false,
      layoutMode: "NONE",
      primaryAxisSizingMode: "FIXED",
      counterAxisSizingMode: "FIXED",
      primaryAxisAlignItems: "MIN",
      counterAxisAlignItems: "MIN",
      itemSpacing: 0,
      paddingTop: 0,
      paddingRight: 0,
      paddingBottom: 0,
      paddingLeft: 0,
      layoutAlign: "INHERIT",
      layoutGrow: 0,
      layoutSizingHorizontal: "FIXED",
      layoutSizingVertical: "FIXED",
      fontName: { family: "Inter", style: "Regular" },
      fontSize: 16,
      lineHeight: { unit: "AUTO" },
      letterSpacing: { unit: "PIXELS", value: 0 },
      characters: "",
      textAutoResize: "HEIGHT",
      textAlignHorizontal: "LEFT",
      children: [] as MockNode[],
      parent: null as MockNode | PageNode | null,
      removed: false,
      pluginData: new Map<string, string>(),
      get absoluteTransform() {
        if (node.parent && node.parent.type !== "PAGE") {
          const [[a, c, e], [b, d, f]] = node.parent.absoluteTransform;
          return [
            [a, c, a * node.x + c * node.y + e],
            [b, d, b * node.x + d * node.y + f],
          ] as Transform;
        }
        return [
          [1, 0, node.x],
          [0, 1, node.y],
        ] as Transform;
      },
      get absoluteBoundingBox() {
        const [[a, c, e], [b, d, f]] = node.absoluteTransform;
        const corners = [
          [0, 0],
          [node.width, 0],
          [0, node.height],
          [node.width, node.height],
        ].map(([x, y]) => ({ x: a * x + c * y + e, y: b * x + d * y + f }));
        const left = Math.min(...corners.map(({ x }) => x));
        const top = Math.min(...corners.map(({ y }) => y));
        const right = Math.max(...corners.map(({ x }) => x));
        const bottom = Math.max(...corners.map(({ y }) => y));
        return { x: left, y: top, width: right - left, height: bottom - top };
      },
      get absoluteRenderBounds() {
        return node.absoluteBoundingBox;
      },
      resize(width: number, height: number) {
        const mutable = node as unknown as { width: number; height: number };
        mutable.width = width;
        mutable.height = height;
      },
      appendChild(child: MockNode) {
        detach(child);
        if (node.layoutMode === "VERTICAL") {
          const paddingLeft = Number(node.paddingLeft) || 0;
          const paddingTop = Number(node.paddingTop) || 0;
          const itemSpacing = Number(node.itemSpacing) || 0;
          child.x = paddingLeft;
          child.y =
            paddingTop +
            node.children.reduce((height, sibling) => height + sibling.height, 0) +
            itemSpacing * node.children.length;
        } else if (node.layoutMode === "HORIZONTAL") {
          const paddingLeft = Number(node.paddingLeft) || 0;
          const paddingTop = Number(node.paddingTop) || 0;
          const itemSpacing = Number(node.itemSpacing) || 0;
          child.x =
            paddingLeft +
            node.children.reduce((width, sibling) => width + sibling.width, 0) +
            itemSpacing * node.children.length;
          child.y = paddingTop;
        }
        node.children.push(child);
        (child as unknown as { parent: MockNode | PageNode | null }).parent =
          node as unknown as MockNode;
      },
      remove() {
        [...node.children].forEach((child) => child.remove());
        detach(node);
        node.removed = true;
      },
      getPluginData(key: string) {
        return node.pluginData.get(key) ?? "";
      },
      setPluginData(key: string, value: string) {
        node.pluginData.set(key, value);
      },
      async setFillStyleIdAsync(id: string) {
        (node as unknown as Record<string, unknown>).fillStyleId = id;
      },
      async setTextStyleIdAsync(id: string) {
        (node as unknown as Record<string, unknown>).textStyleId = id;
      },
    } as unknown as MockNode;
    for (const [property, read, write] of [
      [
        "layoutSizingHorizontal",
        () => layoutSizingHorizontal,
        (value: "FIXED" | "HUG" | "FILL") => (layoutSizingHorizontal = value),
      ],
      [
        "layoutSizingVertical",
        () => layoutSizingVertical,
        (value: "FIXED" | "HUG" | "FILL") => (layoutSizingVertical = value),
      ],
    ] as const) {
      Object.defineProperty(node, property, {
        configurable: true,
        get: read,
        set(value: "FIXED" | "HUG" | "FILL") {
          if (
            value === "FILL" &&
            (!node.parent ||
              (node.parent.type !== "FRAME" && node.parent.type !== "COMPONENT") ||
              (node.parent as MockNode).layoutMode === "NONE")
          )
            throw new Error("Figma requires a text FILL size to have an Auto Layout parent.");
          write(value);
        },
      });
    }
    if (type === "TEXT") delete (node as unknown as Record<string, unknown>).cornerRadius;
    nodes.push(node);
    const activePage = api.currentPage as unknown as PageNode & { children: MockNode[] };
    activePage.children.push(node);
    node.parent = activePage;
    return node;
  };
  const otherRoots: MockNode[] = [];
  const otherPage = {
    id: "page:other",
    name: "Other Page",
    type: "PAGE",
    children: otherRoots,
    selection: [] as MockNode[],
    loaded: false,
    loadCalls: 0,
    async loadAsync() {
      otherPage.loadCalls++;
      otherPage.loaded = true;
    },
    on(_type: "nodechange", listener: (event: NodeChangeEvent) => void) {
      const listeners = pageChangeListeners.get(otherPage.id) ?? new Set();
      listeners.add(listener);
      pageChangeListeners.set(otherPage.id, listeners);
    },
    off(_type: "nodechange", listener: (event: NodeChangeEvent) => void) {
      pageChangeListeners.get(otherPage.id)?.delete(listener);
    },
    findAll(predicate: (node: SceneNode) => boolean = () => true) {
      const result: MockNode[] = [];
      const visit = (node: MockNode) => {
        if (predicate(node)) result.push(node);
        node.children.forEach(visit);
      };
      otherRoots.forEach(visit);
      return result;
    },
    appendChild(node: MockNode) {
      detach(node);
      otherRoots.push(node);
      node.parent = otherPage as unknown as PageNode;
    },
  };
  const additionalPages: Array<ReturnType<typeof makeAdditionalPage>> = [];
  function makeAdditionalPage(id: string, name: string) {
    const pageRoots: MockNode[] = [];
    const mockPage = {
      id,
      name,
      type: "PAGE",
      children: pageRoots,
      selection: [] as MockNode[],
      loaded: false,
      loadCalls: 0,
      async loadAsync() {
        mockPage.loadCalls++;
        mockPage.loaded = true;
      },
      on(_type: "nodechange", listener: (event: NodeChangeEvent) => void) {
        const listeners = pageChangeListeners.get(mockPage.id) ?? new Set();
        listeners.add(listener);
        pageChangeListeners.set(mockPage.id, listeners);
      },
      off(_type: "nodechange", listener: (event: NodeChangeEvent) => void) {
        pageChangeListeners.get(mockPage.id)?.delete(listener);
      },
      findAll(predicate: (node: SceneNode) => boolean = () => true) {
        const result: MockNode[] = [];
        const visit = (node: MockNode) => {
          if (predicate(node)) result.push(node);
          node.children.forEach(visit);
        };
        pageRoots.forEach(visit);
        return result;
      },
      appendChild(node: MockNode) {
        detach(node);
        pageRoots.push(node);
        node.parent = mockPage as unknown as PageNode;
      },
    };
    return mockPage;
  }
  const root = {
    get children() {
      return [page, otherPage, ...additionalPages] as unknown as PageNode[];
    },
    getPluginData: (key: string) => rootData.get(key) ?? "",
    setPluginData: (key: string, value: string) => rootData.set(key, value),
  };
  let setCurrentPageCalls = 0;
  const api = {
    fileKey: "file-test-56",
    mixed: Symbol("mixed"),
    root,
    currentPage: page,
    setCurrentPageAsync: async (target: PageNode) => {
      setCurrentPageCalls++;
      (api as unknown as { currentPage: PageNode }).currentPage = target;
    },
    on: (event: "documentchange", listener: (event: DocumentChangeEvent) => void) => {
      if (event === "documentchange") documentChangeListeners.add(listener);
    },
    off: (event: "documentchange", listener: (event: DocumentChangeEvent) => void) => {
      if (event === "documentchange") documentChangeListeners.delete(listener);
    },
    viewport: {
      center: { x: 500, y: 400 },
      scrollAndZoomIntoView(focused: SceneNode[]) {
        viewportFocusCalls.push(focused.map(({ id }) => id));
      },
    },
    clientStorage: {
      getAsync: async (key: string) => storage.get(key),
      setAsync: async (key: string, value: unknown) => void storage.set(key, value),
      deleteAsync: async (key: string) => void storage.delete(key),
      keysAsync: async () => [...storage.keys()],
    },
    getNodeByIdAsync: async (id: string) =>
      nodes.find((node) => node.id === id && !node.removed) ?? null,
    createFrame: () => makeNode("FRAME") as unknown as FrameNode,
    createComponent: () => makeNode("COMPONENT") as unknown as ComponentNode,
    createRectangle: () => makeNode("RECTANGLE") as unknown as RectangleNode,
    createText: () => makeNode("TEXT") as unknown as TextNode,
    listAvailableFontsAsync: async () => [
      { fontName: { family: "Inter", style: "Regular" } },
      { fontName: { family: "Arial", style: "Regular" } },
    ],
    loadFontAsync: async () => undefined,
    getLocalPaintStylesAsync: async () => paintStyles,
    getLocalTextStylesAsync: async () => textStyles,
    variables: {
      getLocalVariablesAsync: async () => [],
      getLocalVariableCollectionsAsync: async () => [],
    },
    commitUndo: () => undefined,
  } as unknown as PluginAPI;
  return {
    api,
    page,
    nodes,
    roots,
    storage,
    viewportFocusCalls,
    emitPageChange,
    emitDocumentChange,
    addPage: (name: string, id = `page:${additionalPages.length + 2}`) => {
      const added = makeAdditionalPage(id, name);
      additionalPages.push(added);
      return added;
    },
    getSetCurrentPageCalls: () => setCurrentPageCalls,
    switchCurrentPage: () => {
      (api as unknown as { currentPage: PageNode }).currentPage = otherPage as unknown as PageNode;
    },
    find: (name: string) => page.findAll((node) => node.name === name)[0] as MockNode | undefined,
    otherPage,
  };
}
