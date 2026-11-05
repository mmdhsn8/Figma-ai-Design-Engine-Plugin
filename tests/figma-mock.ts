export type MockNode = SceneNode & {
  children: MockNode[];
  pluginData: Map<string, string>;
  parent: MockNode | PageNode | null;
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
      get absoluteRenderBounds() {
        return { x: node.x, y: node.y, width: node.width, height: node.height };
      },
      get absoluteBoundingBox() {
        return { x: node.x, y: node.y, width: node.width, height: node.height };
      },
      get absoluteTransform() {
        return [
          [1, 0, node.x],
          [0, 1, node.y],
        ] as Transform;
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
          child.x = node.x + paddingLeft;
          child.y =
            node.y +
            paddingTop +
            node.children.reduce((height, sibling) => height + sibling.height, 0) +
            itemSpacing * node.children.length;
        } else if (node.layoutMode === "HORIZONTAL") {
          const paddingLeft = Number(node.paddingLeft) || 0;
          const paddingTop = Number(node.paddingTop) || 0;
          const itemSpacing = Number(node.itemSpacing) || 0;
          child.x =
            node.x +
            paddingLeft +
            node.children.reduce((width, sibling) => width + sibling.width, 0) +
            itemSpacing * node.children.length;
          child.y = node.y + paddingTop;
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
    if (type === "TEXT") delete (node as unknown as Record<string, unknown>).cornerRadius;
    nodes.push(node);
    roots.push(node);
    node.parent = page as unknown as PageNode;
    return node;
  };
  const root = {
    getPluginData: (key: string) => rootData.get(key) ?? "",
    setPluginData: (key: string, value: string) => rootData.set(key, value),
  };
  const api = {
    fileKey: "file-test-56",
    mixed: Symbol("mixed"),
    root,
    currentPage: page,
    viewport: { center: { x: 500, y: 400 }, scrollAndZoomIntoView() {} },
    clientStorage: {
      getAsync: async (key: string) => storage.get(key),
      setAsync: async (key: string, value: unknown) => void storage.set(key, value),
    },
    getNodeByIdAsync: async (id: string) =>
      nodes.find((node) => node.id === id && !node.removed) ?? null,
    createFrame: () => makeNode("FRAME") as unknown as FrameNode,
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
  const otherPage = {
    ...page,
    id: "page:other",
    name: "Other Page",
    children: [] as MockNode[],
    selection: [] as MockNode[],
  };
  return {
    api,
    page,
    nodes,
    roots,
    storage,
    switchCurrentPage: () => {
      (api as unknown as { currentPage: PageNode }).currentPage = otherPage as unknown as PageNode;
    },
    find: (name: string) => page.findAll((node) => node.name === name)[0] as MockNode | undefined,
  };
}
