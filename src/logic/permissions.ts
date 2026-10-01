import type { Role } from "../types";

export type Capability =
  | "reorder"
  | "adjustDuration"
  | "addItem"
  | "deleteItem"
  | "editFields"
  | "editAdSlot"
  | "setHardStart"
  | "insertBreaking"
  | "changeStatus"
  | "undo";

/** 岗位权限矩阵：字幕岗只读条目顺序与时长，可改文案类字段（如字幕相关标题/来源） */
const matrix: Record<Role, Capability[]> = {
  导播: ["reorder", "adjustDuration", "addItem", "deleteItem", "editFields", "editAdSlot", "setHardStart", "insertBreaking", "changeStatus", "undo"],
  主编: ["reorder", "adjustDuration", "addItem", "deleteItem", "editFields", "editAdSlot", "setHardStart", "insertBreaking", "changeStatus", "undo"],
  字幕: ["editFields", "changeStatus"],
  演播室: ["addItem", "editFields", "insertBreaking", "changeStatus"]
};

export function can(role: Role | null, capability: Capability): boolean {
  if (!role) return false;
  return matrix[role].includes(capability);
}

/** 字幕岗无权触碰的条目字段 */
export function isOrderOrDurationField(field: string): boolean {
  return field === "duration" || field === "order";
}
