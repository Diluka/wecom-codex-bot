import type { OutputTag } from "./output-settings.ts";

export type ActivityDelivery = "direct" | "progress";

export interface ActivityEvent {
  tag: OutputTag;
  summary?: string;
  body?: string;
  turnId?: string;
  itemId?: string;
  toolId?: string;
  delivery: ActivityDelivery;
}
