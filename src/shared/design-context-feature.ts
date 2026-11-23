import { FW2_FEATURE } from "./design-context";

// Internal build-time opt-in. No persisted preference or user-facing toggle.
export const FW2_ENABLED = import.meta.env.VITE_FW2_CONTEXT === FW2_FEATURE;
