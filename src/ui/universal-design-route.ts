import { isClearCreateRequest } from "../shared/chat-generation";

export const UNIVERSAL_DESIGN_ROUTE_FLAG_KEY = "fad.universal-design-chat.v1";
export const UNIVERSAL_DESIGN_ROUTE_FLAG_VALUE = "enabled";
export type ChatExecutionRoute = "legacy" | "universal-design-v1";

export function universalDesignRouteEnabled(storage?: Pick<Storage, "getItem">): boolean {
  try {
    const source = storage ?? (typeof localStorage === "undefined" ? undefined : localStorage);
    return source?.getItem(UNIVERSAL_DESIGN_ROUTE_FLAG_KEY) === UNIVERSAL_DESIGN_ROUTE_FLAG_VALUE;
  } catch {
    return false;
  }
}

export function selectChatExecutionRoute(
  prompt: string,
  enabled: boolean,
): ChatExecutionRoute {
  return enabled && isClearCreateRequest(prompt) ? "universal-design-v1" : "legacy";
}
