import { mergeRundown, applyConflictResolutions, computeRisks } from "./merge";
import type { RundownItem } from "../types";

function item(id: string, title: string, duration: number, extra: Partial<RundownItem> = {}): RundownItem {
  return { id, title, type: "新闻片", duration, status: "待播", presenter: "主播", source: "来源", ...extra };
}

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}`); }
}

// 场景1：现场改时长、主控改硬时间 → 自动按字段合并，无冲突
{
  console.log("场景1：非重叠字段自动合并（时长归现场，硬时间归主控）");
  const base = [item("a", "A", 5), item("b", "B", 5)];
  const local = [item("a", "A", 8), item("b", "B", 5)]; // 现场改了 a 的时长
  const remote = [item("a", "A", 5, { hardStart: "09:00" }), item("b", "B", 5)]; // 主控安排硬时间
  const result = mergeRundown(base, local, remote);
  check("无冲突", result.conflicts.length === 0);
  check("时长取现场(8)", result.items[0].duration === 8);
  check("硬时间取主控(09:00)", result.items[0].hardStart === "09:00");
}

// 场景2：同一字段两边不同 → 留下两版待确认
{
  console.log("场景2：同字段冲突，两版待确认");
  const base = [item("a", "A", 5)];
  const local = [item("a", "A", 8)];
  const remote = [item("a", "A", 3)];
  const result = mergeRundown(base, local, remote);
  check("有1个冲突", result.conflicts.length === 1);
  check("冲突字段是 duration", result.conflicts[0].field === "duration");
  check("本地版=8", result.conflicts[0].localValue === 8);
  check("主控版=3", result.conflicts[0].remoteValue === 3);
  // 默认留本地版
  check("默认留本地版(8)", result.items[0].duration === 8);
  // 应用选择主控版
  const resolved = applyConflictResolutions(result.items, result.conflicts, { [result.conflicts[0].id]: "remote" });
  check("应用后取主控版(3)", resolved[0].duration === 3);
}

// 场景3：现场新增条目 + 主控移动广告位（顺序变化）→ 新增条目按锚点插入
{
  console.log("场景3：现场新增条目，主控移动广告位，顺序归并");
  const base = [item("a", "A", 5), item("ad", "广告", 3, { type: "广告" }), item("c", "C", 5)];
  const local = [item("a", "A", 5), item("new", "现场新增", 4), item("ad", "广告", 3, { type: "广告" }), item("c", "C", 5)];
  // 主控把广告移到最前
  const remote = [item("ad", "广告", 3, { type: "广告" }), item("a", "A", 5), item("c", "C", 5)];
  const result = mergeRundown(base, local, remote);
  check("无冲突", result.conflicts.length === 0);
  check("广告在最前", result.items[0].id === "ad");
  check("新增条目仍在 a 之后", result.items[1].id === "a" && result.items[2].id === "new");
}

// 场景4：突发插播锚点被删 → 插播位置向前迁移到最近存活锚点
{
  console.log("场景4：突发插播锚点被删，位置向前迁移");
  const base = [item("a", "A", 5), item("b", "B", 5), item("c", "C", 5)];
  // 现场在 b 后插播 breaking
  const local = [item("a", "A", 5), item("b", "B", 5), item("breaking", "突发", 2), item("c", "C", 5)];
  // 主控删掉了 b
  const remote = [item("a", "A", 5), item("c", "C", 5)];
  const result = mergeRundown(base, local, remote);
  check("无存废冲突", result.conflicts.length === 0);
  check("b 已删除", !result.items.find((i) => i.id === "b"));
  check("breaking 迁移到 a 之后", result.items[1].id === "breaking");
}

// 场景5：删改冲突（本地删，远端改）→ 存废冲突待确认
{
  console.log("场景5：本地删除 + 远端修改 → 存废冲突");
  const base = [item("a", "A", 5)];
  const local: RundownItem[] = []; // 本地删了
  const remote = [item("a", "A", 9)]; // 远端改了时长
  const result = mergeRundown(base, local, remote);
  check("有1个冲突", result.conflicts.length === 1);
  check("是存废冲突", result.conflicts[0].field === "__delete__");
  check("默认保留远端版", result.items.length === 1 && result.items[0].duration === 9);
  // 选择删除
  const resolved = applyConflictResolutions(result.items, result.conflicts, { [result.conflicts[0].id]: "local" });
  check("选择删除后条目移除", resolved.length === 0);
}

// 场景6：顺序改动后硬时间风险立即重算
{
  console.log("场景6：顺序改动后硬时间风险重算");
  const items = [
    item("a", "A", 5, { hardStart: "08:00" }),
    item("b", "B", 10, { hardStart: "08:10" }),
    item("c", "C", 10)
  ];
  const risks = computeRisks(items);
  // a: 08:00 开播，hardStart 08:00 → 不晚于 → 无风险
  // b: 08:05 开播，hardStart 08:10 → 不晚于 → 无风险
  check("初始无风险", risks.length === 0);
  // 把顺序改成 [c, a, b]：c 占 5 分钟，a 变成 08:10 开播（晚于 08:00），b 变成 08:15 开播（晚于 08:10）
  const reordered = [items[2], items[0], items[1]];
  const risks2 = computeRisks(reordered);
  check("重算后有2个风险", risks2.length === 2);
  const riskB = risks2.find((r) => r.itemId === "b");
  check("b 有风险", !!riskB);
  check("b 预计 08:15 开播", riskB?.scheduled === "08:15");
}

// 场景7：现场拖动调整顺序（远端未动）→ 本地顺序生效
{
  console.log("场景7：现场拖动顺序，远端未动 → 本地顺序生效");
  const base = [item("a", "A", 5), item("b", "B", 5), item("c", "C", 5)];
  const local = [item("b", "B", 5), item("a", "A", 5), item("c", "C", 5)]; // 现场把 b 拖到 a 前
  const remote = [item("a", "A", 5), item("b", "B", 5), item("c", "C", 5)]; // 远端没动
  const result = mergeRundown(base, local, remote);
  check("无冲突", result.conflicts.length === 0);
  check("顺序为 b,a,c", result.items.map((i) => i.id).join(",") === "b,a,c");
}

console.log(`\n${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
