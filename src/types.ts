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
  /** 突发插播条目的锚点：条目迁移时始终跟随该条目 */
  anchorId?: string;
}

export interface BreakingChange {
  id: string;
  headline: string;
  duration: number;
  insertAfter: string;
  reason: string;
  createdAt: string;
}

/** 离线期间在本机发生、回网后需要提交的操作 */
export interface OfflineOp {
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

/** 同步状态机：offline 可继续编排；pushing/merging 进行中；conflict 有待确认双版本；error 合并失败、本地草稿保留 */
export type SyncStatus = "online" | "offline" | "pushing" | "merging" | "conflict" | "error";

export type MergeableField = "title" | "type" | "duration" | "hardStart" | "status" | "presenter" | "source";

export type ConflictChoice = "local" | "remote";

export interface FieldConflict {
  kind: "field";
  id: string;
  itemId: string;
  itemTitle: string;
  field: MergeableField;
  fieldLabel: string;
  local: string | number | undefined;
  remote: string | number | undefined;
  choice: ConflictChoice;
}

export interface DeleteConflict {
  kind: "delete";
  id: string;
  itemId: string;
  itemTitle: string;
  /** deleted 方删除、另一方修改了字段 */
  deletedBy: "local" | "remote";
  remote: string | number | undefined;
  local: string | number | undefined;
  choice: ConflictChoice;
}

export interface OrderConflict {
  kind: "order";
  id: string;
  detail: string;
  localOrder: RundownItem[];
  remoteOrder: RundownItem[];
  /** local = 保留现场顺序；remote = 采用主控顺序 */
  choice: ConflictChoice;
}

export type MergeConflict = FieldConflict | DeleteConflict | OrderConflict;

export interface MergeResult {
  items: RundownItem[];
  conflicts: MergeConflict[];
  baseRevision: number;
  /** 本地删除、远端未动的条目（合入后随推送真正消失） */
  removedIds: string[];
}
