import { PluginToUISchema, type UIToPluginMessage } from "../shared/messages";
import type { BrandKitStorageCommand, BrandKitStorageResultSchema } from "../shared/brand-kit";
import type { z } from "zod";
import { createBrandVisualAsset, type PinnedBrandKit } from "../shared/brand-kit";
import type { VisualAsset } from "../shared/visual-schema";

type BrandKitResult = z.infer<typeof BrandKitStorageResultSchema>;

export function brandKitRequest(command: BrandKitStorageCommand): Promise<BrandKitResult> {
  const message: Extract<UIToPluginMessage, { type: "brand-kit-storage" }> = {
    type: "brand-kit-storage",
    requestId: `brand-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    command,
  };
  return new Promise((resolve, reject) => {
    const finish = () => {
      clearTimeout(timer);
      window.removeEventListener("message", receive);
    };
    const receive = (event: MessageEvent) => {
      const parsed = PluginToUISchema.safeParse(event.data?.pluginMessage);
      if (
        !parsed.success ||
        parsed.data.type !== "brand-kit-result" ||
        parsed.data.requestId !== message.requestId
      )
        return;
      finish();
      resolve(parsed.data);
    };
    const timer = window.setTimeout(() => {
      finish();
      reject(new Error("Brand Kit storage timed out. Saved revisions were not replaced."));
    }, 10_000);
    window.addEventListener("message", receive);
    parent.postMessage({ pluginMessage: message }, "*");
  });
}

export async function resolvePinnedBrandAssets(
  pinned: PinnedBrandKit | undefined,
): Promise<VisualAsset[]> {
  if (!pinned) return [];
  const assets: VisualAsset[] = [];
  for (const asset of pinned.assets) {
    const result = await brandKitRequest({ action: "load-asset", assetId: asset.assetId });
    if (!result.success || !result.assetBase64)
      throw new Error(
        `Pinned Brand Kit asset “${asset.name}” is unavailable; resume is blocked without mutation.`,
      );
    assets.push(createBrandVisualAsset(asset, result.assetBase64));
  }
  return assets;
}
