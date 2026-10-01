import { configureStore } from "@reduxjs/toolkit";
import rundownReducer from "./rundownSlice";
import { clearDraft, saveDraft } from "../sync/draft";

export const store = configureStore({
  reducer: { rundown: rundownReducer }
});

/**
 * 本地草稿持久化（非整单覆盖）：
 * - 离线/错误/待确认/合并中的每次变化都落盘，刷新或关机后仍可继续编排；
 * - 在线空闲不落盘；同步成功后草稿清除。
 */
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function persist() {
  const state = store.getState().rundown;
  if (!state.bootstrapped) return;
  if (state.sync === "online") return;
  saveDraft({
    items: state.items,
    base: state.base,
    baseRevision: state.baseRevision,
    offlineOps: state.offlineOps,
    changes: state.changes,
    history: state.history,
    pendingMerge: state.sync === "conflict"
      ? { provisional: state.items, conflicts: state.conflicts, remoteRevision: state.pendingRemoteRevision ?? 0 }
      : undefined,
    lastError: state.lastError ?? undefined,
    savedAt: new Date().toISOString()
  });
}

store.subscribe(() => {
  const state = store.getState().rundown;
  // 同步成功（或首次以服务端数据引导）：本机无需保留草稿
  if (state.sync === "online" && state.bootstrapped && state.lastSyncedAt) {
    clearDraft();
    return;
  }
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(persist, 200);
});

// 页面隐藏/关闭前尽量把草稿刷盘
window.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") persist();
});
window.addEventListener("pagehide", persist);
