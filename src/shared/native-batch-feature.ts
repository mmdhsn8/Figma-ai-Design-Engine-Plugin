// Experimental FW-3 planning gate. It never enables native mutations by itself.
export const FW3_NATIVE_BATCH_FEATURE = "fw3-native-batch-v1" as const;
export const FW3_NATIVE_BATCH_ENABLED =
  import.meta.env.VITE_FW3_NATIVE_BATCH === FW3_NATIVE_BATCH_FEATURE;
