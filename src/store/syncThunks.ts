import { createAsyncThunk } from "@reduxjs/toolkit";
import { rundownApi } from "./api";
import { applyConflictResolutions, mergeRundown } from "../lib/merge";
import { conflictsResolved, syncConflicts, syncFailed, syncStarted, syncSucceeded } from "./rundownSlice";
import type { RootState } from "./index";

/** 回网同步：拉取服务端 → 三段式字段合并 → 无冲突则推送，有冲突则留待确认 */
export const syncRundown = createAsyncThunk("rundown/sync", async (_: void, { getState, dispatch }) => {
  const state = getState() as RootState;
  const { items, base, simulateFailure } = state.rundown;
  dispatch(syncStarted());
  try {
    const server = await dispatch(rundownApi.endpoints.getServer.initiate(undefined, { subscribe: false, forceRefetch: true })).unwrap();
    const result = mergeRundown(base, items, server);
    if (result.conflicts.length) {
      dispatch(syncConflicts(result.conflicts));
      return { conflicts: result.conflicts.length, stats: result.stats };
    }
    if (simulateFailure) {
      dispatch(syncFailed("模拟网络故障：合并结果写入服务端失败，本地草稿已保留，可重试。"));
      return { failed: true as const };
    }
    await dispatch(rundownApi.endpoints.saveServer.initiate({ items: result.items })).unwrap();
    dispatch(syncSucceeded({ items: result.items, base: result.items }));
    return { merged: true as const, stats: result.stats };
  } catch (error) {
    dispatch(syncFailed(error instanceof Error ? error.message : String(error)));
    return { failed: true as const };
  }
});

/** 应用字段冲突选择后推送；失败则留住已合并草稿，允许重试 */
export const pushResolved = createAsyncThunk("rundown/pushResolved", async (_: void, { getState, dispatch }) => {
  const state = getState() as RootState;
  const { items, conflicts, resolutions, simulateFailure } = state.rundown;
  dispatch(syncStarted());
  try {
    const resolved = applyConflictResolutions(items, conflicts, resolutions);
    dispatch(conflictsResolved({ items: resolved }));
    if (simulateFailure) {
      dispatch(syncFailed("模拟网络故障：合并结果写入服务端失败，本地草稿已保留，可重试。"));
      return { failed: true as const };
    }
    await dispatch(rundownApi.endpoints.saveServer.initiate({ items: resolved })).unwrap();
    dispatch(syncSucceeded({ items: resolved, base: resolved }));
    return { merged: true as const };
  } catch (error) {
    dispatch(syncFailed(error instanceof Error ? error.message : String(error)));
    return { failed: true as const };
  }
});
