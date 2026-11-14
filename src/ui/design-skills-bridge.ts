import { PluginToUISchema, type UIToPluginMessage } from "../shared/messages";
import type { DesignSkillStorageCommand, DesignSkillStorageResult } from "../shared/design-skill";

export function designSkillsRequest(
  command: DesignSkillStorageCommand,
): Promise<DesignSkillStorageResult> {
  const message: Extract<UIToPluginMessage, { type: "design-skills-storage" }> = {
    type: "design-skills-storage",
    requestId: `skill-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
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
        parsed.data.type !== "design-skills-result" ||
        parsed.data.requestId !== message.requestId
      )
        return;
      finish();
      resolve(parsed.data);
    };
    const timer = window.setTimeout(() => {
      finish();
      reject(new Error("Skills storage timed out. Existing revisions were kept."));
    }, 10_000);
    window.addEventListener("message", receive);
    parent.postMessage({ pluginMessage: message }, "*");
  });
}
