import { VisualReviewModeSchema, type VisualReviewMode } from "./fw5-visual-qa";

export const FW5_VISUAL_QA_FEATURE = "fw5-visual-qa-v1" as const;
export const FW5_VISUAL_QA_ENABLED = import.meta.env.VITE_FW5_VISUAL_QA === FW5_VISUAL_QA_FEATURE;

const configuredReviewMode = VisualReviewModeSchema.safeParse(import.meta.env.VITE_FW5_VISUAL_QA_MODE);
/** Capture-only is the default; review and bounded repair require an injected, explicitly authorized reviewer. */
export const FW5_VISUAL_REVIEW_MODE: VisualReviewMode = configuredReviewMode.success
  ? configuredReviewMode.data
  : "capture-only";
