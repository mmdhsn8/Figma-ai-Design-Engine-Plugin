import type { DraftManifest } from "../src/shared/generation-draft";
import type { GeneratedDesign } from "../src/shared/design-generation";

export function draftFixture(): { manifest: DraftManifest; design: GeneratedDesign } {
  return {
    manifest: {
      version: 1,
      documentId: "document-test-01",
      generationId: "generation-test-01",
      createdAt: 1,
      model: "account-model",
      request: {
        prompt: "یک فروشگاه فارسی با صفحه خانه و جزئیات محصول طراحی کن.",
        target: "mobile",
        screenCount: 2,
        screenNames: ["Home", "Detail"],
        language: "fa",
        style: "",
        projectType: "storefront",
        theme: "auto",
      },
    },
    design: {
      projectName: "فروشگاه",
      palette: {
        brand: "#223344",
        accent: "#CC7744",
        page: "#F7F5F0",
        surface: "#FFFFFF",
        text: "#17212B",
        muted: "#647080",
        border: "#D8DEE6",
      },
      screens: [{ id: "home", children: [] }],
    },
  };
}

export function sectionDesignFixture(
  screenId = "home",
  sectionName = "هویت و سربرگ",
): GeneratedDesign {
  const { design } = draftFixture();
  return {
    ...design,
    screens: [
      {
        id: screenId,
        children: [
          {
            type: "frame",
            name: sectionName,
            text: null,
            palette: "surface",
            width: 350,
            height: 100,
            fontSize: 16,
            fontStyle: "Regular",
            textAlign: "right",
            cornerRadius: 12,
            elevation: "none",
            layout: "vertical",
            gap: 8,
            padding: 8,
            qualityRole: "decorative",
            children: [
              {
                type: "text",
                name: "عنوان فارسی",
                text: "سلام، خوش آمدید",
                palette: "text",
                width: 334,
                height: 32,
                fontSize: 18,
                fontStyle: "Bold",
                textAlign: "right",
                cornerRadius: 0,
                elevation: "none",
                layout: "none",
                gap: 0,
                padding: 0,
                qualityRole: "heading",
                children: [],
              },
            ],
          },
        ],
      },
    ],
  };
}
