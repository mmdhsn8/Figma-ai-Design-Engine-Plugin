import { z } from "zod";
import { TokenColorValueSchema, type TokenColorValue } from "./design-system-schema";
import {
  ComponentDefinitionSchema,
  DESIGN_SCHEMA_VERSION,
  DesignNodeSchema,
  DesignSystemSchema,
  LayoutSchema,
  findDuplicateJsonKeys,
  parseDesignValue,
  type ComponentDefinitionSpec,
  type DesignCounts,
  type DesignNode,
  type DesignSpec,
  countDesignNodes,
} from "./schema";
import { VisualAssetSchema, type VisualAsset } from "./visual-schema";

const nameSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine(
    (value) =>
      !/[\\/]/.test(value) &&
      !Array.from(value).some((character) => {
        const code = character.charCodeAt(0);
        return code <= 0x1f || code === 0x7f;
      }),
    {
      message: "Use a name without slashes or control characters.",
    },
  );

const idSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,79}$/);
const dimensionSchema = z.number().finite().min(1).max(10_000);
const metadataSchema = z
  .record(
    z.string().trim().min(1).max(40),
    z.union([z.string().max(500), z.number().finite(), z.boolean()]),
  )
  .optional()
  .superRefine((value, context) => {
    if (value && Object.keys(value).length > 20) {
      context.addIssue({ code: "custom", message: "Metadata supports at most 20 entries." });
    }
  });

export const MultiScreenItemSchema = z
  .object({
    id: idSchema,
    name: nameSchema,
    group: nameSchema.optional(),
    order: z.number().int().min(0).max(1_000_000).optional(),
    devicePreset: z.enum(["mobile", "tablet", "desktop", "custom"]).optional(),
    width: dimensionSchema,
    height: dimensionSchema,
    background: TokenColorValueSchema.optional(),
    layout: LayoutSchema.optional(),
    children: z.array(DesignNodeSchema),
    metadata: metadataSchema,
  })
  .strict();

export const MultiScreenSpecSchema = z
  .object({
    schemaVersion: z.literal(DESIGN_SCHEMA_VERSION),
    id: idSchema,
    name: nameSchema,
    designSystem: DesignSystemSchema.optional(),
    components: z.array(ComponentDefinitionSchema).optional(),
    assets: z.array(VisualAssetSchema).max(20).optional(),
    screens: z.array(MultiScreenItemSchema).min(1),
  })
  .strict();

export type MultiScreenItem = z.infer<typeof MultiScreenItemSchema>;
export interface MultiScreenSpec {
  schemaVersion: typeof DESIGN_SCHEMA_VERSION;
  id: string;
  name: string;
  designSystem?: DesignSpec["designSystem"];
  components?: ComponentDefinitionSpec[];
  assets?: VisualAsset[];
  screens: MultiScreenItem[];
}

export type MultiScreenParseResult =
  | { success: true; data: MultiScreenSpec; nodeCount: number }
  | { success: false; errors: string[] };

function issuePath(path: PropertyKey[]): string {
  return path.map(String).join(".") || "Input";
}

function issueMessages(issues: z.ZodIssue[]): string[] {
  return issues.map((issue) => `${issuePath(issue.path)}: ${issue.message}`);
}

function screenAsDesignSpec(batch: MultiScreenSpec, screen: MultiScreenItem): DesignSpec {
  const pageBackground: TokenColorValue = batch.designSystem?.colors["color.page.background"]
    ? { token: "color.page.background" }
    : "#FFFFFF";
  return {
    schemaVersion: DESIGN_SCHEMA_VERSION,
    designSystem: batch.designSystem,
    assets: batch.assets,
    document: {
      name: `${screen.name} — ${screen.id}`,
      width: screen.width,
      height: screen.height,
      background: screen.background ?? pageBackground,
      children: screen.children,
      layout: screen.layout,
      components: batch.components,
    },
  };
}

function totalNodes(counts: DesignCounts): number {
  return (
    counts.frames +
    counts.texts +
    counts.rectangles +
    counts.components +
    counts.instances +
    (counts.ellipses ?? 0) +
    (counts.vectors ?? 0) +
    (counts.images ?? 0)
  );
}

function componentTreeNodeCount(
  components: ComponentDefinitionSpec[],
  assets: VisualAsset[] = [],
): number {
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  let count = components.length;
  const visit = (nodes: DesignNode[]) => {
    for (const node of nodes) {
      count++;
      if (node.type === "frame") visit(node.children);
      else if (node.type === "image" && assetById.get(node.assetId)?.kind === "svg-paths") {
        count += (assetById.get(node.assetId) as Extract<VisualAsset, { kind: "svg-paths" }>).paths
          .length;
      }
    }
  };
  for (const component of components) visit(component.children);
  return count;
}

function referencePrefix(screenId: string, errors: string[]): string[] {
  return errors.map((error) => `screens["${screenId}"]: ${error}`);
}

export function orderMultiScreenItems(screens: readonly MultiScreenItem[]): MultiScreenItem[] {
  return [...screens].sort((first, second) => {
    const firstGroup = (first.group ?? "").toLocaleLowerCase("en-US");
    const secondGroup = (second.group ?? "").toLocaleLowerCase("en-US");
    if (firstGroup !== secondGroup) return firstGroup < secondGroup ? -1 : 1;
    const orderDifference = (first.order ?? 0) - (second.order ?? 0);
    if (orderDifference !== 0) return orderDifference;
    return first.id < second.id ? -1 : first.id > second.id ? 1 : 0;
  });
}

export function designSpecForScreen(batch: MultiScreenSpec, screen: MultiScreenItem): DesignSpec {
  return screenAsDesignSpec(batch, screen);
}

export function parseMultiScreenValue(value: unknown): MultiScreenParseResult {
  const parsed = MultiScreenSpecSchema.safeParse(value);
  if (!parsed.success)
    return { success: false, errors: issueMessages(parsed.error.issues).slice(0, 100) };

  const batch = parsed.data as MultiScreenSpec;
  const errors: string[] = [];
  const ids = new Set<string>();
  const names = new Map<string, string>();
  for (const screen of batch.screens) {
    if (ids.has(screen.id)) errors.push(`Screen id “${screen.id}” is duplicated.`);
    ids.add(screen.id);
    const normalizedName = screen.name.trim().toLocaleLowerCase("en-US");
    const previousId = names.get(normalizedName);
    if (previousId) {
      errors.push(
        `Screens “${previousId}” and “${screen.id}” use colliding display names “${screen.name}”.`,
      );
    } else {
      names.set(normalizedName, screen.id);
    }
  }

  const sharedComponents = [...(batch.components ?? []), ...(batch.designSystem?.components ?? [])];
  // One generated component-area frame contains the shared masters when any are new.
  const sharedNodes =
    componentTreeNodeCount(sharedComponents, batch.assets) + (sharedComponents.length ? 1 : 0);
  let nodeCount = 0;
  for (const screen of batch.screens) {
    const checked = parseDesignValue(screenAsDesignSpec(batch, screen));
    if (!checked.success) {
      errors.push(...referencePrefix(screen.id, checked.errors));
    } else {
      const screenSpec = designSpecForScreen(batch, screen);
      const screenOnlySpec: DesignSpec = {
        ...screenSpec,
        designSystem: screenSpec.designSystem
          ? { ...screenSpec.designSystem, components: undefined }
          : undefined,
        document: { ...screenSpec.document, components: undefined },
      };
      nodeCount += totalNodes(countDesignNodes(screenOnlySpec));
    }
  }

  // Shared component masters are counted once for the batch instead of once per screen.
  nodeCount += sharedNodes;
  const uniqueErrors = [...new Set(errors)].slice(0, 100);
  if (uniqueErrors.length) return { success: false, errors: uniqueErrors };
  return {
    success: true,
    data: { ...batch, screens: orderMultiScreenItems(batch.screens) },
    nodeCount,
  };
}

export function parseMultiScreenText(source: string): MultiScreenParseResult {
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch (error) {
    return {
      success: false,
      errors: [
        `Invalid JSON syntax: ${error instanceof Error ? error.message : "Could not parse JSON."}`,
      ],
    };
  }
  const duplicates = findDuplicateJsonKeys(source);
  if (duplicates.length) return { success: false, errors: duplicates };
  return parseMultiScreenValue(value);
}

export function isMultiScreenInput(source: string): boolean {
  try {
    const value = JSON.parse(source) as Record<string, unknown>;
    return typeof value === "object" && value !== null && "screens" in value;
  } catch {
    return false;
  }
}

export function multiScreenDesignSystem(batch: MultiScreenSpec): DesignSpec["designSystem"] {
  return batch.designSystem;
}

export function multiScreenComponents(batch: MultiScreenSpec): ComponentDefinitionSpec[] {
  return [...(batch.components ?? []), ...(batch.designSystem?.components ?? [])];
}
