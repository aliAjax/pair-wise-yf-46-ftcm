import { addMinutes, format } from "date-fns";
import type { FieldConflict, HardTimeRisk, RundownItem } from "../types";

/** 参与字段级合并的条目字段 */
export const MERGE_FIELDS = ["title", "type", "duration", "hardStart", "status", "presenter", "source"] as const;
export type MergeField = (typeof MERGE_FIELDS)[number];

export const FIELD_LABELS: Record<string, string> = {
  title: "标题",
  type: "类型",
  duration: "时长",
  hardStart: "硬时间",
  status: "播出状态",
  presenter: "主播",
  source: "来源"
};

export interface MergeStats {
  added: number;
  deleted: number;
  modified: number;
  conflicted: number;
}

export interface MergeResult {
  items: RundownItem[];
  conflicts: FieldConflict[];
  stats: MergeStats;
}

function eq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}

function mkConflict(itemId: string, itemTitle: string, field: string, baseValue: unknown, localValue: unknown, remoteValue: unknown): FieldConflict {
  return {
    id: `cf-${itemId}-${field}-${Math.random().toString(36).slice(2, 8)}`,
    itemId,
    itemTitle,
    field,
    fieldLabel: field === "__delete__" ? "条目存废" : (FIELD_LABELS[field] ?? field),
    baseValue,
    localValue,
    remoteValue
  };
}

/**
 * 三段式字段级合并：base（上次同步的服务端快照）/ local（现场草稿）/ remote（回网拉到的服务端）。
 * 同一字段两边都改且不一致 → 留下两版待确认；只改一边 → 自动采用那一边。
 */
export function mergeRundown(base: RundownItem[], local: RundownItem[], remote: RundownItem[]): MergeResult {
  const baseMap = new Map(base.map((i) => [i.id, i]));
  const localMap = new Map(local.map((i) => [i.id, i]));
  const remoteMap = new Map(remote.map((i) => [i.id, i]));
  const ids = new Set<string>([...baseMap.keys(), ...localMap.keys(), ...remoteMap.keys()]);

  const mergedMap = new Map<string, RundownItem>();
  const conflicts: FieldConflict[] = [];
  const stats: MergeStats = { added: 0, deleted: 0, modified: 0, conflicted: 0 };

  for (const id of ids) {
    const b = baseMap.get(id);
    const l = localMap.get(id);
    const r = remoteMap.get(id);

    if (!b) {
      // 新增条目
      if (l && r) {
        mergedMap.set(id, { ...l });
        conflicts.push(mkConflict(id, l.title, "title", undefined, l.title, r.title));
        stats.conflicted += 1;
      } else if (l) {
        mergedMap.set(id, { ...l });
        stats.added += 1;
      } else if (r) {
        mergedMap.set(id, { ...r });
        stats.added += 1;
      }
      continue;
    }

    if (!l && !r) {
      stats.deleted += 1; // 两边都删
      continue;
    }

    if (!l) {
      // 本地删除，远端保留
      if (eq(r, b)) {
        stats.deleted += 1; // 远端没动 → 跟随删除
      } else {
        // 远端改了 + 本地删了 → 存废冲突，先留远端版待确认
        mergedMap.set(id, { ...r! });
        conflicts.push(mkConflict(id, r!.title, "__delete__", "exists", "delete", "keep"));
        stats.conflicted += 1;
        stats.modified += 1;
      }
      continue;
    }

    if (!r) {
      // 远端删除，本地保留
      if (eq(l, b)) {
        stats.deleted += 1; // 本地没动 → 跟随删除
      } else {
        mergedMap.set(id, { ...l });
        conflicts.push(mkConflict(id, l.title, "__delete__", "exists", "keep", "delete"));
        stats.conflicted += 1;
        stats.modified += 1;
      }
      continue;
    }

    // 两边都有：逐字段合并
    const merged: RundownItem = { ...b };
    const mergedRecord = merged as unknown as Record<string, unknown>;
    let changed = false;
    for (const field of MERGE_FIELDS) {
      const bv = b[field];
      const lv = l[field];
      const rv = r[field];
      if (eq(lv, bv) && eq(rv, bv)) {
        mergedRecord[field] = bv;
      } else if (eq(lv, bv)) {
        mergedRecord[field] = rv; // 本地没改 → 采用远端
      } else if (eq(rv, bv)) {
        mergedRecord[field] = lv; // 远端没改 → 采用本地
      } else if (eq(lv, rv)) {
        mergedRecord[field] = lv; // 两边改成一样
      } else {
        mergedRecord[field] = lv; // 先留本地版，冲突待确认
        conflicts.push(mkConflict(id, l.title, field, bv, lv, rv));
        stats.conflicted += 1;
      }
      if (!eq(mergedRecord[field], bv)) changed = true;
    }
    mergedMap.set(id, merged);
    if (changed) stats.modified += 1;
  }

  const order = reconcileOrder(base, local, remote, mergedMap);
  const items = order.map((id) => mergedMap.get(id)!).filter(Boolean);
  return { items, conflicts, stats };
}

/**
 * 顺序归并：以远端顺序为主干，把本地新增条目按锚点插入（锚点被删则向前迁移到最近存活锚点），
 * 本地对既有条目的拖动仅在远端未拖动该条目时生效。
 * 判断“是否被拖动”只看共同条目之间的相对顺序，避免新增/删除条目导致的绝对位次偏移误判。
 */
function reconcileOrder(base: RundownItem[], local: RundownItem[], remote: RundownItem[], mergedMap: Map<string, RundownItem>): string[] {
  const surviving = new Set(mergedMap.keys());
  const posIn = (list: RundownItem[]) => new Map(list.map((i, idx) => [i.id, idx]));
  const basePos = posIn(base);
  const localPos = posIn(local);
  const remotePos = posIn(remote);

  // 主干：远端顺序，过滤掉已不存在的条目
  let order = remote.map((i) => i.id).filter((id) => surviving.has(id));

  // 本地新增条目：沿锚点插入，锚点没了就向前迁到最近存活锚点（突发插播位置跟着迁移）
  const localAdds = local.filter((i) => !basePos.has(i.id));
  for (const added of localAdds) {
    if (!surviving.has(added.id) || order.includes(added.id)) continue;
    const idx = localPos.get(added.id)!;
    let anchor: string | null = null;
    for (let k = idx - 1; k >= 0; k--) {
      const cand = local[k].id;
      if (surviving.has(cand)) {
        anchor = cand;
        break;
      }
    }
    if (anchor) {
      order.splice(order.indexOf(anchor) + 1, 0, added.id);
    } else {
      order.unshift(added.id);
    }
  }

  // 共同条目（两边都没删）的相对顺序，用于判断本地是否真的拖动了既有条目
  const commonBaseOrder = base.filter((i) => localPos.has(i.id)).map((i) => i.id);
  const commonLocalOrder = local.filter((i) => basePos.has(i.id)).map((i) => i.id);

  // 本地对既有条目的拖动：远端没拖过同一条目时才生效
  for (const item of local) {
    if (!surviving.has(item.id) || !basePos.has(item.id)) continue;
    const baseRank = commonBaseOrder.indexOf(item.id);
    const localRank = commonLocalOrder.indexOf(item.id);
    const rp = remotePos.get(item.id);
    const remoteMoved = rp !== undefined && rp !== basePos.get(item.id);
    if (localRank !== baseRank && !remoteMoved) {
      const idx = commonLocalOrder.indexOf(item.id);
      let pred: string | null = null;
      for (let k = idx - 1; k >= 0; k--) {
        const cand = commonLocalOrder[k];
        if (surviving.has(cand)) {
          pred = cand;
          break;
        }
      }
      order = order.filter((id) => id !== item.id);
      if (pred) {
        order.splice(order.indexOf(pred) + 1, 0, item.id);
      } else {
        order.unshift(item.id);
      }
    }
  }

  for (const id of surviving) {
    if (!order.includes(id)) order.push(id);
  }
  return order;
}

/** 应用字段冲突的选择，生成最终条目顺序 */
export function applyConflictResolutions(items: RundownItem[], conflicts: FieldConflict[], resolutions: Record<string, "local" | "remote">): RundownItem[] {
  const map = new Map(items.map((i) => [i.id, { ...i }]));
  for (const c of conflicts) {
    const side = resolutions[c.id] ?? "local";
    if (c.field === "__delete__") {
      const deleteSide = c.localValue === "delete" ? "local" : "remote";
      if (side === deleteSide) map.delete(c.itemId);
      continue;
    }
    if (side === "remote") {
      const item = map.get(c.itemId);
      if (item) (item as Record<string, unknown>)[c.field] = c.remoteValue;
    }
  }
  return [...map.values()];
}

/** 按当前顺序重算硬时间风险：顺序或时长一变就立即重算 */
export function computeRisks(items: RundownItem[]): HardTimeRisk[] {
  const start = new Date("2026-10-08T08:00:00");
  const risks: HardTimeRisk[] = [];
  let cursor = start;
  for (const item of items) {
    const at = format(cursor, "HH:mm");
    if (item.hardStart && at > item.hardStart) {
      risks.push({ itemId: item.id, title: item.title, scheduled: at, hardStart: item.hardStart });
    }
    cursor = addMinutes(cursor, item.duration);
  }
  return risks;
}
