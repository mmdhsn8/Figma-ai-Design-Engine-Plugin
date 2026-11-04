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
