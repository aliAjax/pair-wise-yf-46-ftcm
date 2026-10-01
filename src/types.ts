export type Role = "导播" | "主编" | "字幕" | "演播室";
export type ItemType = "新闻片" | "连线" | "嘉宾" | "口播" | "广告";
export type ItemStatus = "待播" | "已播出" | "已跳过" | "草稿";

export interface RundownItem {
  id: string;
  title: string;
  type: ItemType;
  duration: number;
  hardStart?: string;
  status: ItemStatus;
  presenter: string;
  source: string;
}

export interface BreakingChange {
  id: string;
  headline: string;
  duration: number;
  insertAfter: string;
  reason: string;
  createdAt: string;
}

export interface PendingChange {
  id: string;
  action: string;
  detail: string;
  queuedAt: string;
}

export interface HistoryEntry {
  id: string;
  label: string;
  detail: string;
  time: string;
  snapshot: RundownItem[];
}

export type SyncStatus = "idle" | "syncing" | "conflict" | "failed" | "synced";

/** 字段级冲突：同一字段两边改成不同值，留下两版待确认 */
export interface FieldConflict {
  id: string;
  itemId: string;
  itemTitle: string;
  /** RundownItem 字段名；"__delete__" 表示条目存废冲突 */
  field: string;
  fieldLabel: string;
  baseValue: unknown;
  localValue: unknown;
  remoteValue: unknown;
}

/** 顺序改动后立即重算的硬时间风险 */
export interface HardTimeRisk {
  itemId: string;
  title: string;
  /** 按当前顺序推算的实际开播时间 HH:mm */
  scheduled: string;
  /** 条目要求的硬时间 HH:mm */
  hardStart: string;
}
