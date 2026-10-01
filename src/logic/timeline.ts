import { addMinutes, format, parse } from "date-fns";
import type { RundownItem } from "../types";

const SHOW_START = new Date("2026-10-08T08:00:00");

export interface TimelineSlot {
  item: RundownItem;
  /** 该条目的预计开播时间（由前面条目时长累加得到） */
  at: Date;
  atLabel: string;
  /** 硬时间约束是否被破坏：预计开播晚于硬时间 */
  hardRisk: boolean;
  /** 与硬时间的偏差分钟数，正数为迟到 */
  driftMinutes: number;
}

/**
 * 顺序或时长一变就立即重算：逐条累加时长，和硬时间（如广告位 08:30）比对。
 * 突发插播条目的时长同样参与累加，因此插播会把后续硬时间整体推后并立刻暴露风险。
 */
export function computeTimeline(items: RundownItem[]): TimelineSlot[] {
  let cursor = SHOW_START;
  return items.map((item) => {
    const at = cursor;
    let hardRisk = false;
    let driftMinutes = 0;
    if (item.hardStart) {
      const hard = parse(item.hardStart, "HH:mm", SHOW_START);
      driftMinutes = Math.round((at.getTime() - hard.getTime()) / 60000);
      hardRisk = driftMinutes > 0;
    }
    cursor = addMinutes(cursor, item.duration);
    return { item, at, atLabel: format(at, "HH:mm"), hardRisk, driftMinutes };
  });
}

export function totalDuration(items: RundownItem[]): number {
  return items.reduce((sum, item) => sum + item.duration, 0);
}

/**
 * 顺序重算/合并定版后，把突发插播条目重新摆回其锚点之后：
 * - 锚点还在 → 仍插在它后面（主控移动广告位、重排条目时插播跟着迁移）；
 * - 锚点已被删除 → 按参考顺序找锚点前面最近的存活条目，顺延其后；
 * - 头部全部消失 → 落到列表开头。
 * 多个插播挂同一锚点时保持它们在参考顺序中的相对先后。
 */
export function migrateAnchors(items: RundownItem[], reference: RundownItem[] = items): RundownItem[] {
  const anchored = items.filter((item) => item.anchorId);
  if (!anchored.length) return items;

  const result = items.filter((item) => !item.anchorId);
  const ordered = [...anchored].sort(
    (a, b) => reference.findIndex((item) => item.id === a.id) - reference.findIndex((item) => item.id === b.id)
  );

  // 同锚点的多条插播按原顺序依次排在锚点之后
  const placedAfter = new Map<string, number>();
  for (const insert of ordered) {
    const anchorId = insert.anchorId;
    const base = resolveAnchorPosition(result, reference, anchorId);
    const offset = anchorId ? placedAfter.get(anchorId) ?? 0 : 0;
    result.splice(base + offset, 0, insert);
    if (anchorId) placedAfter.set(anchorId, offset + 1);
  }
  return result;
}

function resolveAnchorPosition(alive: RundownItem[], reference: RundownItem[], anchorId: string | undefined): number {
  if (!anchorId) return 0;
  const direct = alive.findIndex((item) => item.id === anchorId);
  if (direct >= 0) return direct + 1;

  // 锚点已删除：顺着参考顺序找它前面最近的存活条目
  const anchorIndex = reference.findIndex((item) => item.id === anchorId);
  if (anchorIndex >= 0) {
    for (let i = anchorIndex - 1; i >= 0; i--) {
      const at = alive.findIndex((item) => item.id === reference[i].id);
      if (at >= 0) return at + 1;
    }
  }
  return 0;
}
