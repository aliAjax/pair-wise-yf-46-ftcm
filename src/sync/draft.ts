import type { BreakingChange, HistoryEntry, MergeConflict, OfflineOp, RundownItem } from "../types";
import { DRAFT_KEY } from "./server";

/**
 * 本地草稿：断网期间编排结果独立保存在本机，不和“服务端”文档互相覆盖。
 * base 是最后一次成功同步时的服务端快照，回网后作为三路合并的共同基线。
 * 合并失败（网络错误等）时草稿原样保留，允许稍后重试。
 */
export interface LocalDraft {
  items: RundownItem[];
  base: RundownItem[];
  baseRevision: number;
  offlineOps: OfflineOp[];
  changes: BreakingChange[];
  history: HistoryEntry[];
  /** 已完成三路合并、但还有字段双版本待人工确认的中间结果 */
  pendingMerge?: {
    provisional: RundownItem[];
    conflicts: MergeConflict[];
    remoteRevision: number;
  };
  lastError?: string;
  savedAt: string;
}

export function saveDraft(draft: LocalDraft): void {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ ...draft, savedAt: new Date().toISOString() }));
  } catch {
    // 存储空间异常时也不能丢内存中的草稿，等待下次写入
  }
}

export function loadDraft(): LocalDraft | null {
  const raw = localStorage.getItem(DRAFT_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as LocalDraft;
  } catch {
    return null;
  }
}

export function clearDraft(): void {
  localStorage.removeItem(DRAFT_KEY);
}
