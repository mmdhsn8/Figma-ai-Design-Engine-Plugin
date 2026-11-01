import {
  type DesignSpec,
  type ComponentDefinitionSpec,
  type DesignNode,
  type FrameNodeSpec,
  type LayoutSpec,
  type RectangleNodeSpec,
  type TextNodeSpec,
} from "../../shared/schema";
import { isTokenReference, type TokenReference } from "../../shared/design-system-schema";

export type ResolvedLayoutSpec = Omit<LayoutSpec, "gap" | "padding"> & {
  gap?: number;
  padding?: { top?: number; right?: number; bottom?: number; left?: number };
};
export type ResolvedTextNodeSpec = Omit<
  TextNodeSpec,
  "fontSize" | "color" | "lineHeight" | "letterSpacing"
> & {
  fontSize: number;
  color: string;
  lineHeight?: number;
  letterSpacing?: number;
  styleOverrides?: {
    fontName?: { family: string; style: string };
    fontSize?: number;
    lineHeight?: number;
    letterSpacing?: number;
    textDecoration?: TextNodeSpec["textDecoration"];
  };
};
export type ResolvedRectangleNodeSpec = Omit<
  RectangleNodeSpec,
  "fill" | "stroke" | "cornerRadius"
> & {
  fill: string;
  stroke?: { color: string; width?: number };
  cornerRadius?: number;
};
export type ResolvedFrameNodeSpec = Omit<
  FrameNodeSpec,
  "background" | "stroke" | "cornerRadius" | "children" | "layout"
> & {
  background?: string;
  stroke?: { color: string; width?: number };
  cornerRadius?: number;
  children: ResolvedDesignNode[];
  layout?: ResolvedLayoutSpec;
};
export type ResolvedDesignNode =
  | ResolvedTextNodeSpec
  | ResolvedRectangleNodeSpec
  | ResolvedFrameNodeSpec
  | Extract<DesignNode, { type: "instance" }>;
export type ResolvedComponentDefinition = Omit<
  ComponentDefinitionSpec,
  "background" | "stroke" | "cornerRadius" | "children" | "layout"
> & {
  background?: string;
  stroke?: { color: string; width?: number };
  cornerRadius?: number;
  children: ResolvedDesignNode[];
  layout?: ResolvedLayoutSpec;
};
export type ResolvedDesignSpec = Omit<DesignSpec, "document" | "designSystem"> & {
  document: Omit<DesignSpec["document"], "background" | "children" | "layout" | "components"> & {
    background: string;
    children: ResolvedDesignNode[];
    layout?: ResolvedLayoutSpec;
    components?: ResolvedComponentDefinition[];
  };
  designSystem?: Omit<NonNullable<DesignSpec["designSystem"]>, "components"> & {
    components?: ResolvedComponentDefinition[];
  };
};

export interface ResolvedTokenTables {
  colors: Map<string, string>;
  spacing: Map<string, number>;
  radii: Map<string, number>;
  typography: Map<string, ResolvedTypographyToken>;
  borders: Map<string, { color: string; width: number }>;
}

export interface ResolvedTypographyToken {
  fontFamily: string;
  fontStyle: string;
  fontSize: number;
  lineHeight?: number;
  letterSpacing?: number;
  textAlign?: TextNodeSpec["textAlign"];
  textDecoration?: TextNodeSpec["textDecoration"];
}

export class TokenResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenResolutionError";
  }
}

function requireTableValue<T>(table: Map<string, T>, key: string, category: string): T {
  const value = table.get(key);
  if (value === undefined) throw new TokenResolutionError(`Missing ${category} token “${key}”.`);
  return value;
}

function resolveAlias<T>(
  key: string,
  values: Record<string, T | TokenReference>,
  category: string,
  resolveLiteral: (value: T) => T,
  trail: string[] = [],
): T {
  if (trail.includes(key)) {
    throw new TokenResolutionError(`Token alias cycle detected: ${[...trail, key].join(" → ")}.`);
  }
  const value = values[key];
  if (value === undefined) throw new TokenResolutionError(`Missing ${category} token “${key}”.`);
  if (!isTokenReference(value)) return resolveLiteral(value as T);
  const expectedPrefix = category === "radius" ? "radius." : `${category}.`;
  if (!value.token.startsWith(expectedPrefix)) {
    throw new TokenResolutionError(
      `Token “${key}” expects a ${category} reference; received “${value.token}”.`,
    );
  }
  return resolveAlias(value.token, values, category, resolveLiteral, [...trail, key]);
}

function createTokenTables(spec: DesignSpec): ResolvedTokenTables {
  const system = spec.designSystem;
  const colors = new Map<string, string>();
  const spacing = new Map<string, number>();
  const radii = new Map<string, number>();
  const typography = new Map<string, ResolvedTypographyToken>();
  const borders = new Map<string, { color: string; width: number }>();
  if (!system) return { colors, spacing, radii, typography, borders };

  const colorState = new Map<string, "visiting" | "visited">();
  const resolveColor = (key: string): string => {
    if (colorState.get(key) === "visiting") {
      throw new TokenResolutionError(`Color token alias cycle includes “${key}”.`);
    }
    const value = system.colors[key];
    if (value === undefined) throw new TokenResolutionError(`Missing color token “${key}”.`);
    if (!isTokenReference(value)) {
      colors.set(key, value);
      return value;
    }
    if (!value.token.startsWith("color.")) {
      throw new TokenResolutionError(`Color token “${key}” cannot reference “${value.token}”.`);
    }
    colorState.set(key, "visiting");
    const resolved = resolveColor(value.token);
    colorState.set(key, "visited");
    colors.set(key, resolved);
    return resolved;
  };
  for (const key of Object.keys(system.colors)) resolveColor(key);

  const resolveNumericCategory = (
    category: "spacing" | "radius",
    aliases: Record<string, number | TokenReference>,
    scale: number[],
  ) => {
    const table = category === "spacing" ? spacing : radii;
    const allValues: Record<string, number | TokenReference> = { ...aliases };
    scale.forEach((value, index) => {
      allValues[`${category}.scale.${index}`] = value;
    });
    for (const key of Object.keys(allValues)) {
      const resolved = resolveAlias<number>(key, allValues, category, (value) => value as number);
      table.set(key, resolved);
    }
  };
  resolveNumericCategory("spacing", system.spacing?.aliases ?? {}, system.spacing?.scale ?? []);
  resolveNumericCategory("radius", system.radii?.aliases ?? {}, system.radii?.scale ?? []);

  for (const [key, value] of Object.entries(system.typography)) {
    const fontSize = resolveNumber(value.fontSize, spacing, "spacing");
    if (fontSize === undefined) {
      throw new TokenResolutionError(`Typography token “${key}” has no resolved font size.`);
    }
    typography.set(key, {
      fontFamily: value.fontFamily,
      fontStyle: value.fontStyle ?? fontStyleFromWeight(value.fontWeight) ?? "Regular",
      fontSize,
      lineHeight: resolveNumber(value.lineHeight, spacing, "spacing"),
      letterSpacing: resolveNumber(value.letterSpacing, spacing, "spacing"),
      textAlign: value.textAlign,
      textDecoration: value.textDecoration,
    });
  }

  for (const [key, border] of Object.entries(system.borders)) {
    const color = isTokenReference(border.color)
      ? requireTableValue(colors, border.color.token, "color")
      : border.color;
    const width = isTokenReference(border.width)
      ? requireTableValue(spacing, border.width.token, "spacing")
      : border.width;
    borders.set(key, { color, width });
  }

  return { colors, spacing, radii, typography, borders };
}

function resolveColor(value: string | TokenReference, tables: ResolvedTokenTables): string {
  return isTokenReference(value) ? requireTableValue(tables.colors, value.token, "color") : value;
}

function resolveNumber(
  value: number | TokenReference | undefined,
  table: Map<string, number>,
  category: "spacing" | "radius",
): number | undefined {
  if (value === undefined || typeof value === "number") return value;
  return requireTableValue(table, value.token, category);
}

function resolveStroke(
  value:
    | { color: string | TokenReference; width?: number | TokenReference }
    | TokenReference
    | undefined,
  tables: ResolvedTokenTables,
): { color: string; width?: number } | undefined {
  if (!value) return undefined;
  if (isTokenReference(value)) return requireTableValue(tables.borders, value.token, "border");
  return {
    color: resolveColor(value.color, tables),
    width: resolveNumber(value.width, tables.spacing, "spacing"),
  };
}

function resolveLayout(
  layout: LayoutSpec | undefined,
  tables: ResolvedTokenTables,
): ResolvedLayoutSpec | undefined {
  if (!layout) return undefined;
  return {
    ...layout,
    gap: resolveNumber(layout.gap, tables.spacing, "spacing"),
    padding: layout.padding
      ? {
          top: resolveNumber(layout.padding.top, tables.spacing, "spacing"),
          right: resolveNumber(layout.padding.right, tables.spacing, "spacing"),
          bottom: resolveNumber(layout.padding.bottom, tables.spacing, "spacing"),
          left: resolveNumber(layout.padding.left, tables.spacing, "spacing"),
        }
      : undefined,
  };
}

function styleForText(
  node: TextNodeSpec,
  tables: ResolvedTokenTables,
): ResolvedTypographyToken | undefined {
  return node.textStyle
    ? requireTableValue(tables.typography, node.textStyle.token, "typography")
    : undefined;
}

function fontStyleFromWeight(weight: number | undefined): string | undefined {
  if (weight === undefined) return undefined;
  const map: Record<number, string> = {
    100: "Thin",
    200: "Extra Light",
    300: "Light",
    400: "Regular",
    500: "Medium",
    600: "Semi Bold",
    700: "Bold",
    800: "Extra Bold",
    900: "Black",
  };
  return map[weight];
}

function resolveText(node: TextNodeSpec, tables: ResolvedTokenTables): ResolvedTextNodeSpec {
  const typography = styleForText(node, tables);
  const fontSizeValue = node.fontSize ?? typography?.fontSize;
  const fontSize = resolveNumber(fontSizeValue, tables.spacing, "spacing");
  if (fontSize === undefined) {
    throw new TokenResolutionError(`Text node “${node.name}” has no resolved font size.`);
  }
  const fontFamily = node.fontFamily ?? typography?.fontFamily;
  const fontStyle = node.fontStyle ?? typography?.fontStyle;
  const lineHeight = resolveNumber(
    node.lineHeight ?? typography?.lineHeight,
    tables.spacing,
    "spacing",
  );
  const letterSpacing = resolveNumber(
    node.letterSpacing ?? typography?.letterSpacing,
    tables.spacing,
    "spacing",
  );
  const textDecoration = node.textDecoration ?? typography?.textDecoration;
  return {
    ...node,
    fontFamily,
    fontStyle,
    fontSize,
    color: resolveColor(node.color, tables),
    lineHeight,
    letterSpacing,
    textAlign: node.textAlign ?? typography?.textAlign,
    textDecoration,
    styleOverrides: node.textStyle
      ? {
          fontName:
            node.fontFamily !== undefined || node.fontStyle !== undefined
              ? { family: fontFamily ?? "Inter", style: fontStyle ?? "Regular" }
              : undefined,
          fontSize: node.fontSize !== undefined ? fontSize : undefined,
          lineHeight: node.lineHeight !== undefined ? lineHeight : undefined,
          letterSpacing: node.letterSpacing !== undefined ? letterSpacing : undefined,
          textDecoration: node.textDecoration,
        }
      : undefined,
  };
}

function resolveNode(node: DesignNode, tables: ResolvedTokenTables): ResolvedDesignNode {
  if (node.type === "text") return resolveText(node, tables);
  if (node.type === "rectangle") {
    return {
      ...node,
      fill: resolveColor(node.fill, tables),
      stroke: resolveStroke(node.stroke, tables),
      cornerRadius: resolveNumber(node.cornerRadius, tables.radii, "radius"),
    };
  }
  if (node.type === "frame") {
    return {
      ...node,
      background: node.background ? resolveColor(node.background, tables) : undefined,
      stroke: resolveStroke(node.stroke, tables),
      cornerRadius: resolveNumber(node.cornerRadius, tables.radii, "radius"),
      layout: resolveLayout(node.layout, tables),
      children: node.children.map((child) => resolveNode(child, tables)),
    };
  }
  return node;
}

function resolveComponent(
  component: ComponentDefinitionSpec,
  tables: ResolvedTokenTables,
): ResolvedComponentDefinition {
  return {
    ...component,
    background: component.background ? resolveColor(component.background, tables) : undefined,
    stroke: resolveStroke(component.stroke, tables),
    cornerRadius: resolveNumber(component.cornerRadius, tables.radii, "radius"),
    layout: resolveLayout(component.layout, tables),
    children: component.children.map((node) => resolveNode(node, tables)),
  };
}

export function resolveDesignSystemTokens(spec: DesignSpec): {
  spec: ResolvedDesignSpec;
  tables: ResolvedTokenTables;
} {
  const tables = createTokenTables(spec);
  const components = [
    ...(spec.document.components ?? []),
    ...(spec.designSystem?.components ?? []),
  ].map((component) => resolveComponent(component, tables));
  const documentComponentsCount = spec.document.components?.length ?? 0;
  const resolved: ResolvedDesignSpec = {
    ...spec,
    document: {
      ...spec.document,
      background: resolveColor(spec.document.background, tables),
      layout: resolveLayout(spec.document.layout, tables),
      children: spec.document.children.map((node) => resolveNode(node, tables)),
      components: components.slice(0, documentComponentsCount),
    },
    designSystem: spec.designSystem
      ? {
          ...spec.designSystem,
          components: components.slice(documentComponentsCount),
        }
      : undefined,
  };
  return { spec: resolved, tables };
}

export function tokenReference(token: string): TokenReference {
  return { token };
}
