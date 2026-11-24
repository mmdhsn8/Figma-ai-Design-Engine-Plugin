import type { DesignProgramFinding, DesignProgramNode, DesignProgramV1 } from "./design-program";
import { contrastRatio } from "./visual-quality";

type ProgramText = Extract<DesignProgramNode, { type: "text" }>;

// Keep Universal's existing 4.5:1 preflight floor, including for headings.
const MIN_TEXT_CONTRAST = 4.5;

export function programColor(program: DesignProgramV1, color: string): string {
  if (!color.startsWith("token:")) return color;
  const key = color.slice(6);
  return Object.prototype.hasOwnProperty.call(program.tokens.colors, key)
    ? program.tokens.colors[key]!
    : color;
}

export function programPageColor(program: DesignProgramV1): string {
  return program.visualLanguageV1?.colorRoles.page ?? program.tokens.colors.page ?? "#FFFFFF";
}

function textContrast(program: DesignProgramV1, node: ProgramText, surface: string) {
  const foreground = programColor(program, node.color);
  const background = programColor(program, surface);
  // V1 allows only opaque hex fills. A container without a fill inherits its surface.
  return { foreground, background, ratio: contrastRatio(foreground, background, 1) };
}

export function auditDesignProgramComposition(program: DesignProgramV1): DesignProgramFinding[] {
  const findings: DesignProgramFinding[] = [];
  const masters = new Map(program.componentsV1?.map(({ id, root }) => [id, root]));
  for (const screen of program.screens) {
    if (!screen.compositionV1) continue;
    const contentByNode = new Map<string, { text: boolean; control: boolean }>();
    const visit = (node: DesignProgramNode, index: boolean): { text: boolean; control: boolean } => {
      const content = {
        text: node.type === "text" && /[\p{L}\p{N}]/u.test(node.text) && !/^(?:placeholder|lorem ipsum|sample text)$/iu.test(node.text.trim()),
        control: ["button", "input", "navigation"].includes(node.interaction ?? "none"),
      };
      if (node.type === "container") {
        for (const child of node.children) {
          const nested = visit(child, index);
          content.text ||= nested.text;
          content.control ||= nested.control;
        }
      } else if (node.type === "instance") {
        const master = masters.get(node.componentId);
        if (master) {
          const nested = visit(master, false);
          content.text ||= nested.text;
          content.control ||= nested.control;
        }
      } else if (index && node.type === "image" && node.asset.source === "placeholder" &&
        node.width.value * node.height.value >= screen.viewport.width * screen.viewport.height / 4) {
        findings.push({ code: "quality_large_placeholder", path: `screens.${screen.id}.${node.id}`, severity: "warning",
          message: "This placeholder reserves at least a quarter of the nominal viewport area. Check whether it displaces the main content or action." });
      }
      if (index) contentByNode.set(node.id, content);
      return content;
    };
    visit(screen.root, true);
    for (const region of screen.compositionV1.regions) {
      if (!["text", "data", "action"].includes(region.contentKind)) continue;
      const content = contentByNode.get(region.nodeId);
      const path = `screens.${screen.id}.${region.nodeId}`;
      if (!content?.text) findings.push({ code: "quality_region_content_missing", path, severity: "warning",
        message: "This mapped region has no meaningful editable text. Add content specific to its purpose when the screen state calls for it." });
      if (region.contentKind === "action" && !content?.control)
        findings.push({ code: "quality_action_control_missing", path, severity: "warning",
          message: "This mapped action region has no native button, input or navigation role. Make the next action identifiable." });
    }
  }
  return findings;
}

export function auditDesignProgramContrast(program: DesignProgramV1): DesignProgramFinding[] {
  const findings: DesignProgramFinding[] = [];
  const components = new Map(program.componentsV1?.map(({ id, root }) => [id, root]));
  const visit = (node: DesignProgramNode, surface: string, path: string) => {
    if (node.type === "container") {
      node.children.forEach((child) => visit(child, node.background ?? surface, path));
    } else if (node.type === "instance") {
      const master = components.get(node.componentId);
      if (master) visit(master, surface, `${path}.${node.id}`);
    } else if (node.type === "text") {
      const { foreground, background, ratio } = textContrast(program, node, surface);
      if (ratio !== undefined && ratio >= MIN_TEXT_CONTRAST) return;
      findings.push({
        code: ratio === undefined ? "quality_contrast-unmeasurable" : "quality_low-contrast",
        path: `${path}.${node.id}.color`,
        message: ratio === undefined
          ? `Cannot resolve a solid foreground (${foreground}) and background (${background}).`
          : `${foreground} over ${background} at alpha 1 measures ${ratio.toFixed(4)}:1. Required at least 4.5:1.`,
        severity: "warning",
      });
    }
  };
  for (const screen of program.screens) visit(screen.root, programPageColor(program), `screens.${screen.id}.root`);
  return findings;
}

export function normalizeDesignProgramContrast(program: DesignProgramV1) {
  const repairs: Array<{ path: string; foreground: string; background: string; alpha: number; before: number; replacement: string; after: number }> = [];
  const rewrite = (node: DesignProgramNode, surface: string | undefined, path: string, insideButton = false): DesignProgramNode => {
    if (node.type === "container") {
      const children = node.children.map((child) => rewrite(child, node.background ?? surface, path, insideButton || node.interaction === "button"));
      return children.some((child, index) => child !== node.children[index]) ? { ...node, children } : node;
    }
    if (node.type !== "text" || surface === undefined) return node;
    const { foreground, background, ratio } = textContrast(program, node, surface);
    if (ratio === undefined || ratio >= MIN_TEXT_CONTRAST) return node;

    const supportingText = node.color === "token:muted" || node.textRole === "caption" || /(?:muted|caption|secondary|supporting)/iu.test(node.semanticRole);
    const textColors = supportingText ? ["muted", "text"] : ["text", "muted"];
    const candidates = [...textColors, "primary", "accent", "surface", "raised-surface", "page", "background"].map((role) => `token:${role}`);
    // A local neutral label keeps the action's surface and the shared palette intact.
    if (insideButton || node.textRole === "action") candidates.push("#000000", "#FFFFFF");
    for (const color of candidates) {
      const replacement = programColor(program, color);
      const after = contrastRatio(replacement, background);
      if (after === undefined || after < MIN_TEXT_CONTRAST) continue;
      repairs.push({ path: `${path}.${node.id}.color`, foreground, background, alpha: 1, before: ratio, replacement, after });
      return { ...node, color };
    }
    return node;
  };

  const screens = program.screens.map((screen) => ({
    ...screen, root: rewrite(screen.root, programPageColor(program), `screens.${screen.id}.root`),
  }));
  // A shared master can be used on other screens. Only repair against fills inside the master.
  const componentsV1 = program.componentsV1?.map((component) => ({
    ...component, root: rewrite(component.root, undefined, `componentsV1.${component.id}`),
  }));
  return {
    program: repairs.length ? { ...program, screens, ...(componentsV1 ? { componentsV1 } : {}) } : program,
    repairs,
  };
}
