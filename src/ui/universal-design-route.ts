import { DEFAULT_DESIGN_ENGINE, type DesignEngine } from "../shared/design-engine-preference";

export type ChatExecutionRoute = "legacy" | "universal-design-v1";

export function selectChatExecutionRoute(engine: DesignEngine = DEFAULT_DESIGN_ENGINE): ChatExecutionRoute {
  return engine === "legacy" ? "legacy" : "universal-design-v1";
}
