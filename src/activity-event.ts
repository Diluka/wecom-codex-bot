import type { OutputTag } from "./output-settings.ts";

export type ActivityDelivery = "direct" | "progress";
export type ActivityToolState = "started" | "completed";

export interface ActivityEvent {
  tag: OutputTag;
  summary?: string;
  body?: string;
  threadId?: string;
  turnId?: string;
  itemId?: string;
  toolState?: ActivityToolState;
  delivery: ActivityDelivery;
}
