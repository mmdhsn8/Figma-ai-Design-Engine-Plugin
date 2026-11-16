import { z } from "zod";

export const DesignEngineSchema = z.enum(["universal", "legacy"]);
export type DesignEngine = z.infer<typeof DesignEngineSchema>;

export const DEFAULT_DESIGN_ENGINE: DesignEngine = "universal";
export const DESIGN_ENGINE_PREFERENCE_KEY = "fad.design-engine-preference.v1";
export const DESIGN_ENGINE_PREFERENCE_ARCHIVE_KEY = "fad.design-engine-preference-preserved.v1";
export const LEGACY_UNIVERSAL_ROUTE_FLAG_KEY = "fad.universal-design-chat.v1";

export const DesignEnginePreferenceSchema = z
  .object({ version: z.literal(1), selectedEngine: DesignEngineSchema })
  .strict();

export const DesignEnginePreferenceArchiveSchema = z
  .object({
    version: z.literal(1),
    entries: z.array(z.object({ archivedAt: z.number().int().nonnegative(), value: z.unknown() }).strict()).max(8),
  })
  .strict();

/** The experimental flag only enabled the new route; its off states never selected Legacy. */
export function migrateExperimentalEngineFlag(_value: string | null): DesignEngine {
  return _value === "enabled" ? "universal" : DEFAULT_DESIGN_ENGINE;
}

/** A saved engine choice always wins over the retired experimental flag. */
export function resolveDesignEnginePreference(
  storedValue: unknown,
  experimentalFlag: string | null,
): DesignEngine {
  const stored = DesignEnginePreferenceSchema.safeParse(storedValue);
  return stored.success
    ? stored.data.selectedEngine
    : migrateExperimentalEngineFlag(experimentalFlag);
}
