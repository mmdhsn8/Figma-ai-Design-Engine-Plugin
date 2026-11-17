/** Preserve Persian joiners, numerals, punctuation and mixed-script order for native shaping. */
export function hasArabicScript(text: string): boolean {
  return /\p{Script=Arabic}/u.test(text);
}

export function hasUnrenderableProgramText(text: string): boolean {
  return /[\p{Cc}\p{Surrogate}\u202a-\u202e\ufffd]/u.test(text.replaceAll(/[\t\n\r]/gu, ""));
}

/** Candidate families with Arabic coverage. Actual availability is resolved by Figma. */
export const PERSIAN_FONT_FAMILIES = ["Vazirmatn", "Noto Sans Arabic", "Noto Naskh Arabic", "Tahoma", "Arial"] as const;
