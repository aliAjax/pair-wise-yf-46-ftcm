import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import type { AppDispatch, RootState } from "./types";
import { can, type Capability } from "../logic/permissions";
import { migrateAnchors } from "../logic/timeline";
import { applyResolutions, threeWayMerge } from "../sync/merge";
import { RevisionMismatchError, serverGet, serverPush, serverSimulateRemoteEdit, setLinkOnline } from "../sync/server";
import { loadDraft, type LocalDraft } from "../sync/draft";
import type {
  BreakingChange,
  HistoryEntry,
  MergeConflict,
  MergeableField,
  OfflineOp,
  Role,
  RundownItem,
  SyncStatus
} from "../types";
import { seedItems } from "../sync/seed";

interface RundownState {
  bootstrapped: boolean;
  items: RundownItem[];
  /** 最后一次成功同步的服务端快照与版本号（三路合并的共同基线） */
  base: RundownItem[];
  baseRevision: number;
  history: HistoryEntry[];
  offlineOps: OfflineOp[];
  changes: BreakingChange[];
  role: Role;
  sync: SyncStatus;
  /** 合并后待人工确认的双版本冲突 */
  conflicts: MergeConflict[];
  /** 待确认合并所基于的远端版本与快照（确认期间远端再变时继续作为三路合并基线） */
  pendingRemoteRevision: number | null;
  pendingRemoteItems: RundownItem[];
  lastError: string | null;
  lastSyncedAt: string | null;
  /** 本机是否存在尚未推送的改动 */
  dirty: boolean;
}

const initialState: RundownState = {
  bootstrapped: false,
  items: seedItems,
  base: structuredClone(seedItems),
  baseRevision: 0,
  history: [],
  offlineOps: [],
  changes: [],
  role: "导播",
  sync: "online",
  conflicts: [],
  pendingRemoteRevision: null,
  pendingRemoteItems: [],
  lastError: null,
  lastSyncedAt: null,
  dirty: false
};

function snapshot(items: RundownItem[], label: string, detail: string): HistoryEntry {
  return { id: crypto.randomUUID(), label, detail, time: new Date().toISOString(), snapshot: structuredClone(items) };
}

/** 无权限时 reducer 直接拒绝（UI 同时禁用入口，双重保障） */
function denied(state: RundownState, capability: Capability): boolean {
  return !can(state.role, capability);
}

/** 提交/合并进行中不接受编辑，避免飞行中的推送把期间新改动覆盖掉 */
function busy(state: RundownState): boolean {
  return state.sync === "pushing" || state.sync === "merging";
}

function record(state: RundownState, action: string, detail: string) {
  if (state.sync === "offline" || state.sync === "error") {
    state.offlineOps.unshift({ id: crypto.randomUUID(), action, detail, queuedAt: new Date().toISOString() });
  }
}

const slice = createSlice({
  name: "rundown",
  initialState,
  reducers: {
    bootstrapFromServer(state, action: PayloadAction<{ items: RundownItem[]; revision: number; history: HistoryEntry[]; changes: BreakingChange[] }>) {
      state.items = action.payload.items;
      state.base = structuredClone(action.payload.items);
      state.baseRevision = action.payload.revision;
      state.history = action.payload.history;
      state.changes = action.payload.changes;
      state.sync = "online";
      state.offlineOps = [];
      state.conflicts = [];
      state.dirty = false;
      state.lastError = null;
      state.lastSyncedAt = new Date().toISOString();
      state.bootstrapped = true;
    },
    bootstrapOffline(state, action: PayloadAction<{ draft: LocalDraft }>) {
      const draft = action.payload.draft;
      return {
        ...state,
        bootstrapped: true,
        items: draft.items,
        base: draft.base,
        baseRevision: draft.baseRevision,
        offlineOps: draft.offlineOps,
        changes: draft.changes,
        history: draft.history,
        sync: "offline",
        conflicts: [],
        pendingRemoteRevision: null,
        pendingRemoteItems: [],
        lastError: "链路中断：正在使用本机草稿继续编排",
        dirty: true
      };
    },
    restorePendingMerge(state, action: PayloadAction<{ draft: LocalDraft }>) {
      const draft = action.payload.draft;
      const pending = draft.pendingMerge!;
      return {
        ...state,
        bootstrapped: true,
        items: pending.provisional,
        base: draft.base,
        baseRevision: draft.baseRevision,
        offlineOps: draft.offlineOps,
        changes: draft.changes,
        history: draft.history,
        sync: "conflict",
        conflicts: pending.conflicts,
        pendingRemoteRevision: pending.remoteRevision,
        pendingRemoteItems: pending.provisional,
        lastError: null,
        dirty: true
      };
    },
    restoreUnfinishedSync(state, action: PayloadAction<{ draft: LocalDraft }>) {
      const draft = action.payload.draft;
      return {
        ...state,
        bootstrapped: true,
        items: draft.items,
        base: draft.base,
        baseRevision: draft.baseRevision,
        offlineOps: draft.offlineOps,
        changes: draft.changes,
        history: draft.history,
        sync: "error",
        conflicts: [],
        pendingRemoteRevision: null,
        pendingRemoteItems: [],
        lastError: draft.lastError ?? "上次同步未完成，本地草稿已保留",
        lastSyncedAt: draft.savedAt,
        dirty: true
      };
    },
    setRole(state, action: PayloadAction<Role>) { state.role = action.payload; },
    /** 进入本机应急模式（链路标志由调用方统一维护） */
    goOffline(state) {
      state.sync = "offline";
      state.lastError = null;
    },
    syncPushStart(state) { state.sync = "pushing"; state.lastError = null; },
    syncMergeStart(state) { state.sync = "merging"; },
    syncConflict(state, action: PayloadAction<{ provisional: RundownItem[]; conflicts: MergeConflict[]; remoteRevision: number; remoteItems: RundownItem[] }>) {
      state.sync = "conflict";
      state.items = action.payload.provisional;
      state.conflicts = action.payload.conflicts;
      state.pendingRemoteRevision = action.payload.remoteRevision;
      state.pendingRemoteItems = structuredClone(action.payload.remoteItems);
    },
    syncFailed(state, action: PayloadAction<string>) {
      // 合并/推送失败：不覆盖任何本机内容，items 仍是本地草稿，允许重试
      state.sync = state.offlineOps.length || state.dirty ? "error" : "offline";
      state.lastError = action.payload;
    },
    syncSucceeded(state, action: PayloadAction<{ items: RundownItem[]; revision: number }>) {
      state.items = action.payload.items;
      state.base = structuredClone(action.payload.items);
      state.baseRevision = action.payload.revision;
      state.sync = "online";
      state.offlineOps = [];
      state.conflicts = [];
      state.pendingRemoteRevision = null;
      state.pendingRemoteItems = [];
      state.lastError = null;
      state.dirty = false;
      state.lastSyncedAt = new Date().toISOString();
    },
    setConflictChoice(state, action: PayloadAction<{ id: string; choice: "local" | "remote" }>) {
      const conflict = state.conflicts.find((entry) => entry.id === action.payload.id);
      if (conflict) conflict.choice = action.payload.choice;
    },
    addItem(state, action: PayloadAction<Omit<RundownItem, "id" | "status">>) {
      if (denied(state, "addItem") || busy(state)) return;
      state.history.unshift(snapshot(state.items, "新增条目", action.payload.title));
      state.items.push({ ...action.payload, id: crypto.randomUUID(), status: "草稿" });
      state.dirty = true;
      record(state, "新增条目", action.payload.title);
    },
    updateStatus(state, action: PayloadAction<{ id: string; status: RundownItem["status"] }>) {
      if (denied(state, "changeStatus") || busy(state)) return;
      const item = state.items.find((entry) => entry.id === action.payload.id);
      if (!item) return;
      state.history.unshift(snapshot(state.items, "播出状态", `${item.title} → ${action.payload.status}`));
      item.status = action.payload.status;
      state.dirty = true;
      record(state, "播出状态", `${item.title} → ${action.payload.status}`);
    },
    reorder(state, action: PayloadAction<RundownItem[]>) {
      if (denied(state, "reorder") || busy(state)) return;
      state.history.unshift(snapshot(state.items, "调整顺序", "直播串联单顺序变化"));
      // 突发插播跟随锚点迁移，不允许游离
      state.items = migrateAnchors(action.payload, state.items);
      state.dirty = true;
      record(state, "调整顺序", "直播串联单顺序变化");
    },
    adjustDuration(state, action: PayloadAction<{ id: string; delta: number }>) {
      // 字幕岗无权改时长
      if (denied(state, "adjustDuration") || busy(state)) return;
      const item = state.items.find((entry) => entry.id === action.payload.id);
      if (!item) return;
      state.history.unshift(snapshot(state.items, "调整时长", `${item.title} ${action.payload.delta > 0 ? "增加" : "减少"} ${Math.abs(action.payload.delta)} 分钟`));
      item.duration = Math.max(1, item.duration + action.payload.delta);
      state.dirty = true;
      record(state, "调整时长", `${item.title} ${item.duration} 分钟`);
    },
    editField(state, action: PayloadAction<{ id: string; field: MergeableField; value: string | number | undefined }>) {
      // 字幕岗只持有 editFields：时长与硬时间由各自的专项权限先拦掉
      if (action.payload.field === "duration" && denied(state, "adjustDuration")) return;
      if (action.payload.field === "hardStart" && denied(state, "setHardStart")) return;
      if (denied(state, "editFields") || busy(state)) return;
      const item = state.items.find((entry) => entry.id === action.payload.id);
      if (!item) return;
      const { field, value } = action.payload;
      state.history.unshift(snapshot(state.items, "修改条目", `${item.title} · ${field}`));
      if (field === "duration") item.duration = Math.max(1, Number(value) || 1);
      else if (field === "hardStart") {
        if (value === undefined || value === "") delete item.hardStart;
        else item.hardStart = String(value);
      } else {
        (item as Record<string, string | number>)[field] = value as string | number;
      }
      state.dirty = true;
      record(state, "修改条目", `${item.title} · ${field}`);
    },
    removeItem(state, action: PayloadAction<string>) {
      if (denied(state, "deleteItem") || busy(state)) return;
      const item = state.items.find((entry) => entry.id === action.payload);
      if (!item) return;
      state.history.unshift(snapshot(state.items, "删除条目", item.title));
      state.items = migrateAnchors(state.items.filter((entry) => entry.id !== action.payload), state.items);
      state.dirty = true;
      record(state, "删除条目", item.title);
    },
    insertBreaking(state, action: PayloadAction<Omit<BreakingChange, "id" | "createdAt">>) {
      if (denied(state, "insertBreaking") || busy(state)) return;
      const change: BreakingChange = { ...action.payload, id: crypto.randomUUID(), createdAt: new Date().toISOString() };
      state.history.unshift(snapshot(state.items, "突发插播", change.headline));
      const insert: RundownItem = {
        id: crypto.randomUUID(),
        title: change.headline,
        type: "新闻片",
        duration: change.duration,
        status: "待播",
        presenter: "值班主播",
        source: `插播：${change.reason}`,
        anchorId: change.insertAfter
      };
      state.items = migrateAnchors([...state.items, insert], state.items);
      state.changes.unshift(change);
      state.dirty = true;
      record(state, "突发插播", change.headline);
    },
    skipItem(state, action: PayloadAction<string>) {
      if (denied(state, "changeStatus") || busy(state)) return;
      const item = state.items.find((entry) => entry.id === action.payload);
      if (!item) return;
      state.history.unshift(snapshot(state.items, "取消条目", item.title));
      item.status = "已跳过";
      state.dirty = true;
      record(state, "取消条目", item.title);
    },
    undo(state) {
      if (denied(state, "undo") || busy(state)) return;
      const last = state.history.shift();
      if (!last) return;
      // 撤回后插播锚点同样重新归位
      state.items = migrateAnchors(structuredClone(last.snapshot), state.items);
      state.dirty = true;
      record(state, "撤回", last.label);
    }
  }
});

export const {
  bootstrapFromServer,
  bootstrapOffline,
  restorePendingMerge,
  restoreUnfinishedSync,
  setRole,
  goOffline,
  syncPushStart,
  syncMergeStart,
  syncConflict,
  syncFailed,
  syncSucceeded,
  setConflictChoice,
  addItem,
  updateStatus,
  reorder,
  adjustDuration,
  editField,
  removeItem,
  insertBreaking,
  skipItem,
  undo
} = slice.actions;

/** 启动：优先拉服务端；断网则恢复本机草稿继续编排 */
export function bootstrap() {
  return async (dispatch: AppDispatch, getState: () => RootState) => {
    if (getState().rundown.bootstrapped) return;
    const draft = readDraftSilently();
    let server: { items: RundownItem[]; revision: number } | null = null;
    try {
      server = await serverGet();
    } catch {
      server = null;
    }

    if (!server) {
      dispatch(bootstrapOffline({ draft: draft ?? emptyDraft() }));
      return;
    }
    if (draft?.pendingMerge) {
      // 上次会话停在双版本待确认
      dispatch(restorePendingMerge({ draft }));
      return;
    }
    if (draft) {
      // 草稿里确有未推送的本机改动时才留住；纯历史/变更记录不算
      const hasLocalEdits = draft.offlineOps.length > 0 || staleItems(draft.items, draft.base);
      if ((hasLocalEdits || draft.lastError) && (draft.baseRevision !== server.revision || hasLocalEdits)) {
        dispatch(restoreUnfinishedSync({ draft }));
        return;
      }
    }
    dispatch(bootstrapFromServer({ items: server.items, revision: server.revision, history: draft?.history ?? [], changes: draft?.changes ?? [] }));
  };
}

function staleItems(items: RundownItem[], base: RundownItem[]): boolean {
  return JSON.stringify(items) !== JSON.stringify(base);
}

/** 顶部链路开关：断网立即切本机草稿；回网触发合并推送 */
export function toggleOnline(online: boolean) {
  return async (dispatch: AppDispatch, getState: () => RootState) => {
    const current = getState().rundown.sync;
    if (!online) {
      if (current === "offline") return;
      setLinkOnline(false);
      dispatch(goOffline());
      return;
    }
    if (current === "online" || current === "pushing" || current === "merging") return;
    setLinkOnline(true);
    await dispatch(pushLocal());
  };
}

/** 浏览器原生 online/offline 事件 */
export function networkStateChanged(online: boolean) {
  return async (dispatch: AppDispatch, getState: () => RootState) => {
    const state = getState().rundown;
    if (online && (state.sync === "offline" || state.sync === "error")) {
      await dispatch(pushLocal());
    } else if (!online && state.sync === "online") {
      setLinkOnline(false);
      dispatch(goOffline());
    }
  };
}

/**
 * 推送本机草稿，遇到版本过期做三路字段合并：
 * 无冲突自动合入并重推；有双版本差异进入 conflict；网络/合并失败保留草稿可重试。
 */
export function pushLocal() {
  return async (dispatch: AppDispatch, getState: () => RootState) => {
    const state = getState().rundown;
    if (!state.bootstrapped || state.sync === "pushing" || state.sync === "merging" || state.sync === "conflict") return;
    if (!state.dirty && state.sync === "online") return;
    dispatch(syncPushStart());
    await pushWithMerge(dispatch, state.items, state.baseRevision, state.base);
  };
}

/** 合并冲突全部人工确认后，按确认结果推送（远端再变则继续合并一轮） */
export function resolveConflicts() {
  return async (dispatch: AppDispatch, getState: () => RootState) => {
    const state = getState().rundown;
    if (state.sync !== "conflict" || state.pendingRemoteRevision === null) return;
    const merged = applyResolutions(state.items, state.conflicts);
    dispatch(syncPushStart());
    await pushWithMerge(dispatch, merged, state.pendingRemoteRevision, state.pendingRemoteItems);
  };
}

async function pushWithMerge(
  dispatch: AppDispatch,
  localItems: RundownItem[],
  baseRevision: number,
  ancestorItems: RundownItem[]
): Promise<void> {
  let local = localItems;
  let revision = baseRevision;
  let ancestor = ancestorItems;
  // 远端在合并期间又改单才会进入下一轮；正常一到两轮就结束
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const doc = await serverPush(revision, local);
      dispatch(syncSucceeded({ items: doc.items, revision: doc.revision }));
      return;
    } catch (error) {
      if (error instanceof RevisionMismatchError) {
        dispatch(syncMergeStart());
        let merged;
        try {
          merged = threeWayMerge(ancestor, local, error.latest.items, error.latest.revision);
        } catch {
          dispatch(syncFailed("合并失败：本地草稿已保留，可修改后重试"));
          return;
        }
        if (merged.conflicts.length === 0) {
          // 无字段冲突：以合并结果继续推送，基线推进到最新远端版本
          local = merged.items;
          revision = error.latest.revision;
          ancestor = error.latest.items;
          continue;
        }
        dispatch(syncConflict({ provisional: merged.items, conflicts: merged.conflicts, remoteRevision: error.latest.revision, remoteItems: error.latest.items }));
        return;
      }
      dispatch(syncFailed(error instanceof Error ? error.message : "同步失败：本地草稿已保留"));
      return;
    }
  }
  dispatch(syncFailed("多次合并后仍未达成一致，本地草稿已保留，请稍后重试"));
}

/** 演示：模拟主控在现场断网期间移动广告位/安排硬时间（对端始终在线，不受本机链路开关影响） */
export function simulateRemoteEdit() {
  return async (dispatch: AppDispatch) => {
    try {
      await serverSimulateRemoteEdit();
    } catch (error) {
      dispatch(syncFailed(error instanceof Error ? error.message : "模拟对端操作失败"));
    }
  };
}

function readDraftSilently(): LocalDraft | null {
  return loadDraft();
}

function emptyDraft(): LocalDraft {
  return {
    items: seedItems,
    base: structuredClone(seedItems),
    baseRevision: 0,
    offlineOps: [],
    changes: [],
    history: [],
    savedAt: new Date().toISOString()
  };
}

export default slice.reducer;
