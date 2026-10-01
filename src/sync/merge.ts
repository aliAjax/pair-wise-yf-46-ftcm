import { migrateAnchors } from "../logic/timeline";
import type {
  DeleteConflict,
  FieldConflict,
  MergeConflict,
  MergeResult,
  MergeableField,
  RundownItem
} from "../types";

/** 参与逐字段三路合并的条目字段（顺序不在此列，走专门的顺序冲突） */
export const MERGE_FIELDS: MergeableField[] = ["title", "type", "duration", "hardStart", "status", "presenter", "source"];

export const FIELD_LABELS: Record<MergeableField, string> = {
  title: "标题",
  type: "类型",
  duration: "时长",
  hardStart: "硬时间",
  status: "播出状态",
  presenter: "主播",
  source: "来源"
};

type Value = string | number | undefined;

function getField(item: RundownItem, field: MergeableField): Value {
  return item[field] as Value;
}

function sameValue(a: Value, b: Value): boolean {
  // undefined 与空串都视为“未设置”，避免假冲突
  if ((a === undefined || a === "") && (b === undefined || b === "")) return true;
  return a === b;
}

interface MergeContext {
  base: RundownItem[];
  local: RundownItem[];
  remote: RundownItem[];
  conflicts: MergeConflict[];
}

function byId(items: RundownItem[]): Map<string, RundownItem> {
  return new Map(items.map((item) => [item.id, item]));
}

function mergeFields(ctx: MergeContext, id: string, base: RundownItem, local: RundownItem, remote: RundownItem): RundownItem {
  const merged: RundownItem = { ...local };
  for (const field of MERGE_FIELDS) {
    const b = getField(base, field);
    const l = getField(local, field);
    const r = getField(remote, field);
    if (sameValue(l, r)) {
      (merged[field] as Value) = l;
    } else if (sameValue(b, l)) {
      // 只对端改了
      (merged[field] as Value) = r;
    } else if (sameValue(b, r)) {
      // 只本机改了
      (merged[field] as Value) = l;
    } else {
      // 同一字段两边都改且不同 → 保留两版待确认，先临时取本机值
      const conflict: FieldConflict = {
        kind: "field",
        id: crypto.randomUUID(),
        itemId: id,
        itemTitle: local.title || remote.title || id,
        field,
        fieldLabel: FIELD_LABELS[field],
        local: l,
        remote: r,
        choice: "local"
      };
      ctx.conflicts.push(conflict);
      (merged[field] as Value) = l;
    }
  }
  return merged;
}

/**
 * 三路（base 共同基线 / local 现场草稿 / remote 主控最新）按条目字段合并：
 * - 单边新增、单边删除、单边改字段：直接合入；
 * - 同一字段两边都改且不同：挂字段冲突，留两版由人确认；
 * - 一边删条目、另一边改该条目字段：挂删除冲突；
 * - 两边都对共同顺序做了重排且结果不同：挂顺序冲突；
 * - 突发插播（anchorId）在顺序定版后整体迁移，跟随锚点。
 */
export function threeWayMerge(
  baseItems: RundownItem[],
  localItems: RundownItem[],
  remoteItems: RundownItem[],
  baseRevision: number
): MergeResult {
  const ctx: MergeContext = {
    base: baseItems,
    local: localItems,
    remote: remoteItems,
    conflicts: []
  };
  const baseMap = byId(baseItems);
  const localMap = byId(localItems);
  const remoteMap = byId(remoteItems);

  const removedIds: string[] = [];
  const provisional = new Map<string, RundownItem>();

  for (const [id, base] of baseMap) {
    const l = localMap.get(id);
    const r = remoteMap.get(id);
    if (l && r) {
      provisional.set(id, mergeFields(ctx, id, base, l, r));
    } else if (l && !r) {
      // 对端删除：本机也删则照删；本机改过字段则留删除冲突，先把条目恢复回来
      const changedFields = MERGE_FIELDS.filter((field) => !sameValue(getField(base, field), getField(l, field)));
      if (changedFields.length === 0) {
        removedIds.push(id);
      } else {
        provisional.set(id, { ...l });
        for (const field of changedFields) {
          const conflict: DeleteConflict = {
            kind: "delete",
            id: crypto.randomUUID(),
            itemId: id,
            itemTitle: l.title || id,
            deletedBy: "remote",
            local: getField(l, field),
            remote: undefined,
            choice: "local"
          };
          ctx.conflicts.push(conflict);
        }
      }
    } else if (!l && r) {
      // 本机删除：对端也删照删；对端改过字段则留删除冲突
      const changedFields = MERGE_FIELDS.filter((field) => !sameValue(getField(base, field), getField(r, field)));
      if (changedFields.length === 0) {
        removedIds.push(id);
      } else {
        provisional.set(id, { ...r });
        for (const field of changedFields) {
          const conflict: DeleteConflict = {
            kind: "delete",
            id: crypto.randomUUID(),
            itemId: id,
            itemTitle: r.title || id,
            deletedBy: "local",
            local: undefined,
            remote: getField(r, field),
            choice: "remote"
          };
          ctx.conflicts.push(conflict);
        }
      }
    }
    // 两边都删：天然一致，什么都不做
  }

  // 单边新增的条目（基线里没有 id）
  for (const [id, l] of localMap) {
    if (!baseMap.has(id) && !remoteMap.has(id)) provisional.set(id, { ...l });
  }
  for (const [id, r] of remoteMap) {
    if (!baseMap.has(id) && !localMap.has(id)) provisional.set(id, { ...r });
  }
  // 两边碰巧同 id 新增（UUID 下基本不会发生），仍走字段合并
  for (const [id, l] of localMap) {
    if (!baseMap.has(id)) {
      const r = remoteMap.get(id);
      if (r) provisional.set(id, mergeFields(ctx, id, { ...l, ...r }, l, r));
    }
  }

  const order = resolveOrder(baseItems, localItems, remoteItems, provisional, ctx);

  // 非锚点新增条目：按各自所在一边的相对位置，就近插回主干
  const placed = new Set(order);
  const insertNearby = (source: RundownItem[]) => {
    for (const item of source) {
      if (placed.has(item.id) || !provisional.has(item.id) || item.anchorId) continue;
      let index = order.length;
      for (let i = source.indexOf(item) - 1; i >= 0; i--) {
        const at = order.indexOf(source[i].id);
        if (at >= 0) { index = at + 1; break; }
      }
      order.splice(index, 0, item.id);
      placed.add(item.id);
    }
  };
  insertNearby(remoteItems);
  insertNearby(localItems);

  // 突发插播先按现场（本机）原顺序追加，再统一锚点迁移
  for (const item of localItems) {
    if (item.anchorId && provisional.has(item.id) && !placed.has(item.id)) {
      order.push(item.id);
      placed.add(item.id);
    }
  }
  for (const item of remoteItems) {
    if (item.anchorId && provisional.has(item.id) && !placed.has(item.id)) {
      order.push(item.id);
      placed.add(item.id);
    }
  }

  let items = order.map((id) => provisional.get(id)!).filter(Boolean);
  // 以本机顺序为锚点缺失时的回溯参考
  items = migrateAnchors(items, localItems);

  return { items, conflicts: ctx.conflicts, baseRevision, removedIds };
}

/**
 * 顺序归并：以“共同存活条目”为主干比较两边的相对顺序。
 * 任一边没动顺序就采纳另一边；两边都重排且结果不一致则整单挂顺序冲突，先取现场顺序。
 */
function resolveOrder(
  base: RundownItem[],
  local: RundownItem[],
  remote: RundownItem[],
  provisional: Map<string, RundownItem>,
  ctx: MergeContext
): string[] {
  const backbone = base
    .map((item) => item.id)
    .filter((id) => local.some((item) => item.id === id) && remote.some((item) => item.id === id));

  const localBackbone = local.map((item) => item.id).filter((id) => backbone.includes(id));
  const remoteBackbone = remote.map((item) => item.id).filter((id) => backbone.includes(id));
  const baseBackbone = base.map((item) => item.id).filter((id) => backbone.includes(id));

  const localReordered = !sameOrder(localBackbone, baseBackbone);
  const remoteReordered = !sameOrder(remoteBackbone, baseBackbone);

  let chosenOrder: string[];
  if (localReordered && remoteReordered && !sameOrder(localBackbone, remoteBackbone)) {
    chosenOrder = localBackbone;
    ctx.conflicts.push({
      kind: "order",
      id: crypto.randomUUID(),
      detail: "现场与主控都调整了条目顺序，且结果不一致",
      localOrder: local,
      remoteOrder: remote,
      choice: "local"
    });
  } else if (localReordered) {
    chosenOrder = localBackbone;
  } else {
    chosenOrder = remoteBackbone;
  }

  // 主干之外（删除冲突恢复的、新增的）条目的就近归位由调用方统一处理
  return chosenOrder;
}

function sameOrder(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/** 应用人工确认结果：字段/删除冲突按选择改写临时条目；顺序冲突按选择换序后重跑锚点迁移 */
export function applyResolutions(items: RundownItem[], conflicts: MergeConflict[]): RundownItem[] {
  let next = structuredClone(items);
  const map = new Map(next.map((item) => [item.id, item]));

  for (const conflict of conflicts) {
    if (conflict.kind === "field") {
      const item = map.get(conflict.itemId);
      if (item) {
        const value = conflict.choice === "local" ? conflict.local : conflict.remote;
        (item[conflict.field] as Value) = value;
        if (conflict.field === "hardStart" && (value === undefined || value === "")) delete item.hardStart;
      }
    } else if (conflict.kind === "delete") {
      if (conflict.choice === "local" && conflict.deletedBy === "remote") {
        // 保留本机修改版：字段值已是本机值，无需处理
        continue;
      }
      if (conflict.choice === "remote" && conflict.deletedBy === "local") continue;
      // 选择“删除”一方：移除条目
      next = next.filter((item) => item.id !== conflict.itemId);
      map.delete(conflict.itemId);
    }
  }

  const orderConflict = conflicts.find((c): c is Extract<MergeConflict, { kind: "order" }> => c.kind === "order");
  if (orderConflict) {
    const wanted = orderConflict.choice === "local" ? orderConflict.localOrder : orderConflict.remoteOrder;
    const wantedIds = wanted.map((item) => item.id);
    next.sort((a, b) => {
      const ia = wantedIds.indexOf(a.id);
      const ib = wantedIds.indexOf(b.id);
      if (ia === -1 && ib === -1) return 0;
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    });
    next = migrateAnchors(next);
  }
  return next;
}
