import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import type { BreakingChange, FieldConflict, HardTimeRisk, HistoryEntry, PendingChange, Role, RundownItem, SyncStatus } from "../types";
import { computeRisks } from "../lib/merge";
import { loadDraft } from "../lib/persistence";

const seed: RundownItem[] = [
  { id: "r1", title: "早间新闻提要", type: "新闻片", duration: 4, hardStart: "08:00", status: "已播出", presenter: "陈默", source: "主控" },
  { id: "r2", title: "城市更新现场连线", type: "连线", duration: 8, hardStart: "08:06", status: "待播", presenter: "陈默", source: "记者周岚" },
  { id: "r3", title: "政策发布会解读", type: "嘉宾", duration: 12, status: "待播", presenter: "陈默", source: "演播室A" },
  { id: "r4", title: "整点广告", type: "广告", duration: 3, hardStart: "08:30", status: "待播", presenter: "系统", source: "广告串" }
];

interface State {
  initialized: boolean;
  /** 本地工作草稿 */
  items: RundownItem[];
  /** 上次同步的服务端快照（三段式合并的基准） */
  base: RundownItem[];
  history: HistoryEntry[];
  queue: PendingChange[];
  changes: BreakingChange[];
  role: Role;
  online: boolean;
  syncStatus: SyncStatus;
  conflicts: FieldConflict[];
  resolutions: Record<string, "local" | "remote">;
  mergeError: string | null;
  hardTimeRisks: HardTimeRisk[];
  /** 演示用：模拟同步写入失败 */
  simulateFailure: boolean;
}

const draft = loadDraft();
const initialState: State = draft
  ? {
      initialized: true,
      items: draft.items,
      base: draft.base,
      history: draft.history,
      queue: draft.queue,
      changes: draft.changes,
      role: "导播",
      online: true,
      syncStatus: "idle",
      conflicts: [],
      resolutions: {},
      mergeError: null,
      hardTimeRisks: computeRisks(draft.items),
      simulateFailure: false
    }
  : {
      initialized: false,
      items: seed,
      base: seed,
      history: [],
      queue: [],
      changes: [],
      role: "导播",
      online: true,
      syncStatus: "idle",
      conflicts: [],
      resolutions: {},
      mergeError: null,
      hardTimeRisks: computeRisks(seed),
      simulateFailure: false
    };

function snapshot(items: RundownItem[], label: string, detail: string): HistoryEntry {
  return { id: crypto.randomUUID(), label, detail, time: new Date().toISOString(), snapshot: structuredClone(items) };
}

/** 离线时把操作记入应急队列，回网合并后清除 */
function enqueue(state: State, action: string, detail: string) {
  if (!state.online) {
    state.queue.unshift({ id: crypto.randomUUID(), action, detail, queuedAt: new Date().toISOString() });
  }
}

const slice = createSlice({
  name: "rundown",
  initialState,
  reducers: {
    initialize(state, action: PayloadAction<{ items: RundownItem[]; base: RundownItem[] }>) {
      if (state.initialized) return;
      state.items = action.payload.items;
      state.base = action.payload.base;
      state.initialized = true;
      state.hardTimeRisks = computeRisks(state.items);
    },
    setRole(state, action: PayloadAction<Role>) {
      state.role = action.payload;
    },
    setOnline(state, action: PayloadAction<boolean>) {
      state.online = action.payload;
    },
    setSimulateFailure(state, action: PayloadAction<boolean>) {
      state.simulateFailure = action.payload;
    },
    addItem(state, action: PayloadAction<Omit<RundownItem, "id" | "status">>) {
      state.history.unshift(snapshot(state.items, "新增条目", action.payload.title));
      state.items.push({ ...action.payload, id: crypto.randomUUID(), status: "草稿" });
      state.hardTimeRisks = computeRisks(state.items);
      enqueue(state, "新增条目", action.payload.title);
    },
    updateStatus(state, action: PayloadAction<{ id: string; status: RundownItem["status"] }>) {
      const item = state.items.find((entry) => entry.id === action.payload.id);
      if (!item) return;
      state.history.unshift(snapshot(state.items, "播出状态", `${item.title} → ${action.payload.status}`));
      item.status = action.payload.status;
      state.hardTimeRisks = computeRisks(state.items);
    },
    reorder(state, action: PayloadAction<RundownItem[]>) {
      if (state.role !== "导播") return; // 按岗位权限拒绝改顺序
      state.history.unshift(snapshot(state.items, "调整顺序", "直播串联单顺序变化"));
      state.items = action.payload;
      state.hardTimeRisks = computeRisks(state.items); // 顺序改动后硬时间风险立即重算
      enqueue(state, "调整顺序", "直播串联单顺序变化");
    },
    adjustDuration(state, action: PayloadAction<{ id: string; delta: number }>) {
      if (state.role === "字幕") return; // 字幕岗拒绝改时长
      const item = state.items.find((entry) => entry.id === action.payload.id);
      if (!item) return;
      state.history.unshift(snapshot(state.items, "调整时长", `${item.title} ${action.payload.delta > 0 ? "增加" : "减少"} ${Math.abs(action.payload.delta)} 分钟`));
      item.duration = Math.max(1, item.duration + action.payload.delta);
      state.hardTimeRisks = computeRisks(state.items);
      enqueue(state, "调整时长", `${item.title} ${action.payload.delta > 0 ? "增加" : "减少"} ${Math.abs(action.payload.delta)} 分钟`);
    },
    insertBreaking(state, action: PayloadAction<Omit<BreakingChange, "id" | "createdAt">>) {
      const change: BreakingChange = { ...action.payload, id: crypto.randomUUID(), createdAt: new Date().toISOString() };
      const index = state.items.findIndex((item) => item.id === change.insertAfter);
      state.history.unshift(snapshot(state.items, "突发插播", change.headline));
      state.items.splice(index + 1, 0, { id: crypto.randomUUID(), title: change.headline, type: "新闻片", duration: change.duration, status: "待播", presenter: "值班主播", source: `插播：${change.reason}` });
      state.changes.unshift(change);
      state.hardTimeRisks = computeRisks(state.items);
      enqueue(state, "突发插播", change.headline);
    },
    skipItem(state, action: PayloadAction<string>) {
      const item = state.items.find((entry) => entry.id === action.payload);
      if (!item) return;
      state.history.unshift(snapshot(state.items, "取消条目", item.title));
      item.status = "已跳过";
      state.hardTimeRisks = computeRisks(state.items);
      enqueue(state, "取消条目", item.title);
    },
    undo(state) {
      const last = state.history.shift();
      if (!last) return;
      state.items = structuredClone(last.snapshot);
      state.hardTimeRisks = computeRisks(state.items);
    },
    queueChange(state, action: PayloadAction<{ action: string; detail: string }>) {
      state.queue.unshift({ ...action.payload, id: crypto.randomUUID(), queuedAt: new Date().toISOString() });
    },
    syncQueue(state) {
      state.queue = [];
    },
    // ---- 同步生命周期 ----
    syncStarted(state) {
      state.syncStatus = "syncing";
      state.mergeError = null;
    },
    syncSucceeded(state, action: PayloadAction<{ items: RundownItem[]; base: RundownItem[] }>) {
      state.items = action.payload.items;
      state.base = action.payload.base;
      state.conflicts = [];
      state.resolutions = {};
      state.queue = [];
      state.mergeError = null;
      state.syncStatus = "synced";
      state.hardTimeRisks = computeRisks(state.items);
    },
    syncConflicts(state, action: PayloadAction<FieldConflict[]>) {
      state.conflicts = action.payload;
      state.resolutions = {};
      state.syncStatus = "conflict";
    },
    syncFailed(state, action: PayloadAction<string>) {
      state.mergeError = action.payload;
      state.syncStatus = "failed";
      // 合并失败：留住本地草稿（items/base/queue/conflicts 均不清），允许重试
    },
    resolveConflict(state, action: PayloadAction<{ id: string; side: "local" | "remote" }>) {
      state.resolutions[action.payload.id] = action.payload.side;
    },
    conflictsResolved(state, action: PayloadAction<{ items: RundownItem[] }>) {
      state.items = action.payload.items;
      state.conflicts = [];
      state.resolutions = {};
      state.syncStatus = "idle";
      state.hardTimeRisks = computeRisks(state.items);
    },
    /** 在线写穿透成功后，让基准追上服务端 */
    serverSaved(state, action: PayloadAction<{ items: RundownItem[] }>) {
      state.base = action.payload.items;
      if (state.syncStatus === "idle" || state.syncStatus === "synced") state.syncStatus = "synced";
    }
  }
});

export const {
  initialize,
  setRole,
  setOnline,
  setSimulateFailure,
  addItem,
  updateStatus,
  reorder,
  adjustDuration,
  insertBreaking,
  skipItem,
  undo,
  queueChange,
  syncQueue,
  syncStarted,
  syncSucceeded,
  syncConflicts,
  syncFailed,
  resolveConflict,
  conflictsResolved,
  serverSaved
} = slice.actions;
export default slice.reducer;
