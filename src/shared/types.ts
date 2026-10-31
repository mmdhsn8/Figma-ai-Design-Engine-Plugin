export type StatusKind = "ready" | "working" | "success" | "error";

export interface PluginStatus {
  kind: StatusKind;
  title: string;
  detail?: string;
}
