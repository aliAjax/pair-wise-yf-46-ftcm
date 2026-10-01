import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Button, Input, Popconfirm, Tag, Tooltip } from "antd";
import { can } from "../logic/permissions";
import type { ConflictChoice, MergeConflict, Role, RundownItem } from "../types";

interface Props {
  item: RundownItem;
  cumulative: string;
  hardRisk: boolean;
  driftMinutes: number;
  role: Role | null;
  conflicts: MergeConflict[];
  onConflictChoice: (id: string, choice: ConflictChoice) => void;
  onDuration: (delta: number) => void;
  onHardStart: (value: string) => void;
  onStatus: () => void;
  onSkip: () => void;
  onDelete: () => void;
}

export function SortableItem({ item, cumulative, hardRisk, driftMinutes, role, conflicts, onConflictChoice, onDuration, onHardStart, onStatus, onSkip, onDelete }: Props) {
  // 已播出条目和突发插播（锚点条目，顺序由迁移决定）不可拖拽
  const disableDrag = item.status === "已播出" || Boolean(item.anchorId) || !can(role, "reorder");
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: item.id, disabled: disableDrag });
  const fieldConflicts = conflicts.filter((c): c is Extract<MergeConflict, { kind: "field" }> => c.kind === "field" && c.itemId === item.id);
  const deleteConflict = conflicts.find((c): c is Extract<MergeConflict, { kind: "delete" }> => c.kind === "delete" && c.itemId === item.id);
  const hasConflict = fieldConflicts.length > 0 || Boolean(deleteConflict);
  const canDuration = can(role, "adjustDuration");
  const canHardStart = can(role, "setHardStart");
  const canDelete = can(role, "deleteItem");
  const canStatus = can(role, "changeStatus");

  return (
    <article ref={setNodeRef} className={`rundown-row status-${item.status} ${hardRisk ? "hard-risk" : ""} ${hasConflict ? "has-conflict" : ""}`} style={{ transform: CSS.Transform.toString(transform), transition }}>
      <button className="drag-handle" {...attributes} {...listeners} disabled={disableDrag} title={item.anchorId ? "突发插播跟随锚点迁移" : ""}>⠿</button>
      <time>{cumulative}</time>
      <div className="row-main">
        <b>{item.title}{item.anchorId && <Tag color="volcano" className="anchor-tag">突发插播</Tag>}</b>
        <small>{item.source} · {item.presenter}</small>
        {hasConflict && <div className="conflict-fields">
          {fieldConflicts.map((conflict) => (
            <div key={conflict.id} className="conflict-chip">
              <span className="conflict-label">{conflict.fieldLabel}两版待确认：</span>
              <button type="button" className={conflict.choice === "local" ? "pick picked" : "pick"} onClick={() => onConflictChoice(conflict.id, "local")}>现场 {displayValue(conflict.local)}</button>
              <button type="button" className={conflict.choice === "remote" ? "pick picked remote" : "pick remote"} onClick={() => onConflictChoice(conflict.id, "remote")}>主控 {displayValue(conflict.remote)}</button>
            </div>
          ))}
          {deleteConflict && (
            <div className="conflict-chip">
              <span className="conflict-label">{deleteConflict.deletedBy === "local" ? "现场已删除，主控改了内容" : "主控已删除，现场改了内容"}：</span>
              <button type="button" className={deleteConflict.choice === "local" ? "pick picked" : "pick"} onClick={() => onConflictChoice(deleteConflict.id, "local")}>{deleteConflict.deletedBy === "local" ? "保留删除" : `保留修改 ${displayValue(deleteConflict.local)}`}</button>
              <button type="button" className={deleteConflict.choice === "remote" ? "pick picked remote" : "pick remote"} onClick={() => onConflictChoice(deleteConflict.id, "remote")}>{deleteConflict.deletedBy === "remote" ? "保留删除" : `保留修改 ${displayValue(deleteConflict.remote)}`}</button>
            </div>
          )}
        </div>}
      </div>
      <Tag color={item.type === "广告" ? "gold" : item.type === "连线" ? "blue" : "geekblue"}>{item.type}</Tag>
      <Tooltip title={canHardStart ? "硬时间（HH:mm），顺序/时长变化后立即重算风险" : "无权安排硬时间"}>
        <Input
          className={`hard-input ${hardRisk ? "hard-input-risk" : ""}`}
          size="small"
          value={item.hardStart ?? ""}
          placeholder="--:--"
          disabled={!canHardStart || item.status === "已播出"}
          onChange={(event) => onHardStart(event.target.value)}
        />
      </Tooltip>
      {hardRisk
        ? <Tooltip title={`比硬时间晚 ${driftMinutes} 分钟`}><Tag color="red" className="risk-tag">迟到{driftMinutes}′</Tag></Tooltip>
        : <Tag className="risk-tag">准时</Tag>}
      <span>{item.duration} 分钟</span>
      <Tag color={item.status === "已播出" ? "green" : item.status === "已跳过" ? "red" : "default"}>{item.status}</Tag>
      <div className="row-actions">
        <Button size="small" disabled={!canDuration || item.status === "已播出"} onClick={() => onDuration(-1)}>-1</Button>
        <Button size="small" disabled={!canDuration || item.status === "已播出"} onClick={() => onDuration(1)}>+1</Button>
        <Button size="small" type="primary" disabled={!canStatus || item.status === "已播出"} onClick={onStatus}>播出</Button>
        <Button size="small" danger disabled={!canStatus || item.status === "已播出"} onClick={onSkip}>取消</Button>
        <Popconfirm title="删除该条目？" description="突发插播会跟随锚点重新归位" onConfirm={onDelete} okText="删除" cancelText="再想想">
          <Button size="small" danger type="text" disabled={!canDelete || item.status === "已播出"}>删</Button>
        </Popconfirm>
      </div>
    </article>
  );
}

function displayValue(value: string | number | undefined): string {
  if (value === undefined || value === "") return "（空）";
  return String(value);
}
