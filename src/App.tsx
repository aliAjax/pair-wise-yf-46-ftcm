import { useEffect, useRef, useState } from "react";
import { closestCenter, DndContext, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { arrayMove, SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { Alert, Button, Card, Divider, Form, Input, InputNumber, Select, Switch, Tag, Timeline, message } from "antd";
import { addMinutes, format } from "date-fns";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useTranslation } from "react-i18next";
import { NavLink, Route, Routes } from "react-router-dom";
import { SortableItem } from "./components/SortableItem";
import { useGetServerQuery, useSaveServerMutation } from "./store/api";
import { useAppDispatch, useAppSelector } from "./store/hooks";
import { addItem, adjustDuration, initialize, insertBreaking, queueChange, reorder, resolveConflict, serverSaved, setOnline, setRole, setSimulateFailure, skipItem, undo, updateStatus } from "./store/rundownSlice";
import { pushResolved, syncRundown } from "./store/syncThunks";
import { STORAGE_KEYS, saveDraft } from "./lib/persistence";
import type { Role, RundownItem, SyncStatus } from "./types";

const schema = z.object({ title: z.string().min(2), type: z.enum(["新闻片", "连线", "嘉宾", "口播", "广告"]), duration: z.number().min(1).max(120), presenter: z.string().min(1), source: z.string().min(1) });
type FormValues = z.infer<typeof schema>;

const seed: RundownItem[] = [
  { id: "r1", title: "早间新闻提要", type: "新闻片", duration: 4, hardStart: "08:00", status: "已播出", presenter: "陈默", source: "主控" },
  { id: "r2", title: "城市更新现场连线", type: "连线", duration: 8, hardStart: "08:06", status: "待播", presenter: "陈默", source: "记者周岚" },
  { id: "r3", title: "政策发布会解读", type: "嘉宾", duration: 12, status: "待播", presenter: "陈默", source: "演播室A" },
  { id: "r4", title: "整点广告", type: "广告", duration: 3, hardStart: "08:30", status: "待播", presenter: "系统", source: "广告串" }
];

function useTimeline(items: RundownItem[]) {
  const start = new Date("2026-10-08T08:00:00");
  let cursor = start;
  return items.map((item) => {
    const current = cursor;
    cursor = addMinutes(cursor, item.duration);
    return { item, at: format(current, "HH:mm"), duration: item.duration };
  });
}

const SYNC_META: Record<SyncStatus, { label: string; color: string }> = {
  idle: { label: "待同步", color: "default" },
  syncing: { label: "同步中…", color: "blue" },
  conflict: { label: "有冲突待确认", color: "orange" },
  failed: { label: "同步失败-草稿已保留", color: "red" },
  synced: { label: "已同步", color: "green" }
};

function displayValue(field: string, value: unknown): string {
  if (value === undefined || value === null) return "—";
  if (field === "__delete__") return value === "delete" ? "删除条目" : "保留条目";
  if (field === "duration") return `${value} 分钟`;
  if (field === "hardStart") return `硬时间 ${value}`;
  if (field === "status") return `状态：${value}`;
  return String(value);
}

function RundownPage() {
  const dispatch = useAppDispatch();
  const { items, role, online, hardTimeRisks } = useAppSelector((state) => state.rundown);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const timeline = useTimeline(items);
  const total = items.reduce((sum, item) => sum + item.duration, 0);
  const { control, handleSubmit, reset } = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: { title: "", type: "新闻片", duration: 5, presenter: "陈默", source: "主控" } });

  const canEditOrder = role === "导播";
  const canEditDuration = role !== "字幕";

  const onDragEnd = (event: DragEndEvent) => {
    if (!event.over || event.active.id === event.over.id) return;
    if (!canEditOrder) {
      message.error("仅导播可调整串联单顺序");
      return;
    }
    const oldIndex = items.findIndex((item) => item.id === event.active.id);
    const newIndex = items.findIndex((item) => item.id === event.over!.id);
    dispatch(reorder(arrayMove(items, oldIndex, newIndex)));
  };

  const submit = (values: FormValues) => {
    dispatch(addItem(values));
    if (!online) dispatch(queueChange({ action: "新增条目", detail: values.title }));
    reset();
  };

  return <div className="page-grid">
    <Card className="main-card">
      <div className="card-heading"><div><small>2026-10-08 - 08:00 开播</small><h2>直播串联单</h2></div><div className="head-actions"><Tag color={online ? "green" : "red"}>{online ? "主备链路正常" : "本地应急模式"}</Tag><Button onClick={() => dispatch(undo())} disabled={!role || role === "字幕"}>撤回上一步</Button></div></div>
      {role === "字幕" && <Alert className="perm-alert" type="warning" showIcon message="字幕岗按岗位权限拒绝改顺序与时长：拖动排序、时长 ±1 已禁用，相关操作不会生效。" />}
      <div className="summary"><span><b>{items.length}</b> 条内容</span><span><b>{total}</b> 分钟总时长</span><span className={hardTimeRisks.length ? "danger-text" : ""}><b>{hardTimeRisks.length}</b> 个硬时间风险</span><span><b>{timeline.at(-1)?.at ?? "--:--"}</b> 预计收播</span></div>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={items.map((item) => item.id)} strategy={verticalListSortingStrategy}>
          <div className="rundown-list">{timeline.map(({ item, at }) => <SortableItem key={item.id} item={item} cumulative={at} dragDisabled={!canEditOrder} durationDisabled={!canEditDuration} onDuration={(delta) => { if (!canEditDuration) { message.error("字幕岗无权调整时长"); return; } dispatch(adjustDuration({ id: item.id, delta })); }} onStatus={() => dispatch(updateStatus({ id: item.id, status: "已播出" }))} onSkip={() => dispatch(skipItem(item.id))} />)}</div>
        </SortableContext>
      </DndContext>
    </Card>
    <aside className="side-stack">
      <Card title="新增播出条目">
        <Form layout="vertical" onFinish={handleSubmit(submit)}>
          <Form.Item label="标题"><Controller name="title" control={control} render={({ field, fieldState }) => <><Input {...field} status={fieldState.error ? "error" : ""} /><small className="error">{fieldState.error?.message}</small></>} /></Form.Item>
          <div className="two-cols"><Form.Item label="类型"><Controller name="type" control={control} render={({ field }) => <Select {...field} options={["新闻片","连线","嘉宾","口播","广告"].map((v) => ({ value: v, label: v }))} />} /></Form.Item><Form.Item label="时长"><Controller name="duration" control={control} render={({ field }) => <InputNumber {...field} min={1} max={120} addonAfter="分钟" />} /></Form.Item></div>
          <Form.Item label="主播"><Controller name="presenter" control={control} render={({ field }) => <Input {...field} />} /></Form.Item>
          <Form.Item label="来源"><Controller name="source" control={control} render={({ field }) => <Input {...field} />} /></Form.Item>
          <Button htmlType="submit" type="primary" block disabled={role === "字幕"}>加入串联单</Button>
        </Form>
      </Card>
      <BreakingForm />
      <HardTimePanel />
      <SyncPanel />
    </aside>
  </div>;
}

function BreakingForm() {
  const dispatch = useAppDispatch();
  const { items, online } = useAppSelector((state) => state.rundown);
  const [values, setValues] = useState({ headline: "", duration: 5, insertAfter: items[0]?.id ?? "", reason: "突发新闻" });
  return <Card title="突发插播" className="breaking-card">
    <Input value={values.headline} onChange={(event) => setValues({ ...values, headline: event.target.value })} placeholder="插播标题" />
    <div className="two-cols"><InputNumber value={values.duration} onChange={(value) => setValues({ ...values, duration: Number(value ?? 5) })} addonAfter="分钟" /><Select value={values.insertAfter} onChange={(value) => setValues({ ...values, insertAfter: value })} options={items.map((item) => ({ value: item.id, label: `插在「${item.title}」后` }))} /></div>
    <Input value={values.reason} onChange={(event) => setValues({ ...values, reason: event.target.value })} placeholder="插播原因" />
    <Button type="primary" danger block disabled={values.headline.length < 2} onClick={() => { dispatch(insertBreaking(values)); if (!online) message.warning("已进入本地应急队列，回网后按锚点迁移合并"); setValues({ ...values, headline: "" }); }}>立即插入并重算时长</Button>
    {!online && <small>离线操作将在主链路恢复后统一提交，当前顺序仍可用于本地播出；插播位置会随锚点迁移。</small>}
  </Card>;
}

function HardTimePanel() {
  const risks = useAppSelector((state) => state.rundown.hardTimeRisks);
  return <Card title="硬时间风险（顺序重算）" className="risk-card">
    {risks.length
      ? <div className="risk-list">{risks.map((risk) => <div key={risk.itemId} className="risk-row"><Tag color="red">风险</Tag><div><b>{risk.title}</b><small>按当前顺序 {risk.scheduled} 开播，晚于硬时间 {risk.hardStart}</small></div></div>)}</div>
      : <p className="muted">顺序调整后暂无硬时间冲突。</p>}
  </Card>;
}

function SyncPanel() {
  const dispatch = useAppDispatch();
  const { online, syncStatus, queue, simulateFailure } = useAppSelector((state) => state.rundown);
  const { data: server = [] } = useGetServerQuery();
  const [saveServer] = useSaveServerMutation();
  const meta = SYNC_META[syncStatus];

  const moveAd = async () => {
    const adIdx = server.findIndex((item) => item.type === "广告");
    if (adIdx < 0) { message.info("服务端没有广告条目可移动"); return; }
    const next = [...server];
    const [ad] = next.splice(adIdx, 1);
    const target = adIdx === 0 ? Math.min(2, next.length) : 0;
    next.splice(target, 0, ad);
    await saveServer({ items: next }).unwrap();
    message.success("主控已移动广告位（服务端），回网后合并顺序并重算风险");
  };

  const scheduleHard = async () => {
    const target = server.find((item) => item.status === "待播" && !item.hardStart);
    if (!target) { message.info("服务端没有可安排硬时间的待播条目"); return; }
    const next = server.map((item) => (item.id === target.id ? { ...item, hardStart: "09:00" } : item));
    await saveServer({ items: next }).unwrap();
    message.success(`主控已为「${target.title}」安排硬时间 09:00`);
  };

  return <Card title="同步与草稿">
    <div className="sync-row"><Tag color={meta.color}>{meta.label}</Tag><span className="muted">{queue.length} 项待同步</span></div>
    <Button block type="primary" disabled={!online || syncStatus === "syncing"} onClick={() => dispatch(syncRundown())}>{syncStatus === "syncing" ? "同步中…" : "立即同步（回网合并）"}</Button>
    <Divider style={{ margin: "12px 0" }} />
    <div className="demo-block">
      <small className="muted">演示：离线时模拟主控（服务端）改动，回网后与本地草稿按字段合并</small>
      <Button block disabled={online} onClick={moveAd}>移动广告位（主控）</Button>
      <Button block disabled={online} onClick={scheduleHard}>安排硬时间（主控）</Button>
    </div>
    <Divider style={{ margin: "12px 0" }} />
    <label className="fail-toggle"><Switch checked={simulateFailure} onChange={(value) => dispatch(setSimulateFailure(value))} /> 模拟同步失败（验证草稿保留与重试）</label>
  </Card>;
}

function ConflictPanel() {
  const dispatch = useAppDispatch();
  const { conflicts, resolutions, syncStatus } = useAppSelector((state) => state.rundown);
  if (syncStatus !== "conflict" || !conflicts.length) return null;
  const allResolved = conflicts.every((conflict) => resolutions[conflict.id]);
  return <Card className="conflict-card" title="字段冲突 - 两版待确认">
    <Alert type="warning" showIcon message="本地（现场）与主控在同一字段改成了不同值，请逐字段选择保留版本；选择后将合并并同步，未选字段默认留本地版。" />
    <div className="conflict-list">
      {conflicts.map((conflict) => {
        const choice = resolutions[conflict.id];
        return <div key={conflict.id} className="conflict-row">
          <div className="conflict-meta"><b>{conflict.itemTitle}</b><Tag>{conflict.fieldLabel}</Tag></div>
          <div className="conflict-options">
            <button type="button" className={choice === "local" ? "opt selected" : "opt"} onClick={() => dispatch(resolveConflict({ id: conflict.id, side: "local" }))}>
              <span className="opt-tag">本地（现场）版本</span>
              <b>{displayValue(conflict.field, conflict.localValue)}</b>
            </button>
            <button type="button" className={choice === "remote" ? "opt selected" : "opt"} onClick={() => dispatch(resolveConflict({ id: conflict.id, side: "remote" }))}>
              <span className="opt-tag">主控版本</span>
              <b>{displayValue(conflict.field, conflict.remoteValue)}</b>
            </button>
          </div>
        </div>;
      })}
    </div>
    <Button type="primary" disabled={!allResolved} onClick={() => dispatch(pushResolved())}>应用所选并同步</Button>
  </Card>;
}

function FailedBanner() {
  const dispatch = useAppDispatch();
  const { syncStatus, mergeError } = useAppSelector((state) => state.rundown);
  if (syncStatus !== "failed") return null;
  return <Alert className="failed-banner" type="error" showIcon message="合并失败，本地草稿已保留" description={<span>{mergeError} 草稿未清空、冲突未丢失，可重试同步。</span>} action={<Button type="primary" onClick={() => dispatch(syncRundown())}>重试同步</Button>} />;
}

function ChainPage({ mode }: { mode: "changes" | "queue" | "history" }) {
  const state = useAppSelector((root) => root.rundown);
  const dispatch = useAppDispatch();
  if (mode === "queue") return <Card title="本地应急队列"><div className="queue-list">{state.queue.length ? state.queue.map((item) => <article key={item.id}><Tag color="red">{item.action}</Tag><b>{item.detail}</b><small>{format(new Date(item.queuedAt), "HH:mm:ss")}</small></article>) : <p>当前没有待同步操作。</p>}</div><Button type="primary" disabled={state.online} onClick={() => dispatch(syncRundown())}>主链路恢复后提交</Button></Card>;
  if (mode === "changes") return <Card title="突发变更记录"><Timeline items={state.changes.map((item) => ({ children: <div><b>{item.headline}</b><p>{item.reason} - 插播 {item.duration} 分钟</p><small>{format(new Date(item.createdAt), "HH:mm:ss")}</small></div> }))} /></Card>;
  return <Card title="操作历史"><Timeline items={state.history.map((entry) => ({ color: "blue", children: <div><b>{entry.label}</b><p>{entry.detail}</p><small>{format(new Date(entry.time), "HH:mm:ss")}</small></div> }))} /></Card>;
}

export default function App() {
  const dispatch = useAppDispatch();
  const state = useAppSelector((root) => root.rundown);
  const { data: server = [], isLoading } = useGetServerQuery();
  const [saveServer] = useSaveServerMutation();
  const { t, i18n } = useTranslation();
  const didBootstrap = useRef(false);

  // 首次加载：无本地草稿则以服务端为准，服务端也空则落 seed
  useEffect(() => {
    if (isLoading || didBootstrap.current) return;
    didBootstrap.current = true;
    if (!state.initialized) {
      if (server.length) {
        dispatch(initialize({ items: server, base: server }));
      } else {
        dispatch(initialize({ items: seed, base: seed }));
        void saveServer({ items: seed });
      }
    }
    if (state.online) void dispatch(syncRundown());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading, server]);

  // 回网（离线→在线）立即按字段合并
  const wasOnline = useRef(state.online);
  useEffect(() => {
    if (state.online && !wasOnline.current && state.initialized) {
      void dispatch(syncRundown());
    }
    wasOnline.current = state.online;
  }, [state.online, state.initialized, dispatch]);

  // 草稿持久化：离线刷新也不丢
  useEffect(() => {
    const timer = setTimeout(() => saveDraft({ items: state.items, base: state.base, queue: state.queue, changes: state.changes, history: state.history }), 300);
    return () => clearTimeout(timer);
  }, [state.items, state.base, state.queue, state.changes, state.history]);

  // 在线写穿透：本地草稿与服务端基准不一致时才写，避免合并后重复写
  useEffect(() => {
    if (!state.online || !state.initialized) return;
    if (state.syncStatus === "syncing" || state.syncStatus === "conflict" || state.syncStatus === "failed") return;
    if (JSON.stringify(state.items) === JSON.stringify(state.base)) return;
    const timer = setTimeout(() => {
      saveServer({ items: state.items }).unwrap()
        .then((saved) => { if (saved) dispatch(serverSaved({ items: state.items })); })
        .catch(() => {});
    }, 700);
    return () => clearTimeout(timer);
  }, [state.items, state.base, state.online, state.initialized, state.syncStatus, saveServer, dispatch]);

  // 其他标签页（主控）写入服务端后，回网自动合并
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEYS.SERVER && state.online) void dispatch(syncRundown());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [state.online, dispatch]);

  const pendingCount = state.queue.length + state.conflicts.length;

  return <div className="app-shell">
    <aside className="sidebar"><div className="brand"><span>LIVE</span><div><b>{t("title")}</b><small>Control room</small></div></div><nav><NavLink to="/">{t("rundown")}</NavLink><NavLink to="/changes">{t("changes")}</NavLink><NavLink to="/queue">{t("queue")} {pendingCount ? <em>{pendingCount}</em> : null}</NavLink></nav><Button ghost onClick={() => void i18n.changeLanguage(i18n.language === "zh" ? "en" : "zh")}>{i18n.language === "zh" ? "EN" : "中文"}</Button></aside>
    <main><header className="topbar"><div><small>直播运行中 - 紧急操作均保留审计记录</small><h1>{t("title")}</h1></div><div className="top-actions"><label>在线模式 <Switch checked={state.online} onChange={(value) => dispatch(setOnline(value))} /></label><label>当前岗位 <Select<Role> value={state.role} onChange={(value) => dispatch(setRole(value))} options={[{value:"导播"},{value:"主编"},{value:"字幕"},{value:"演播室"}]} /></label><Tag color={SYNC_META[state.syncStatus].color}>{SYNC_META[state.syncStatus].label}</Tag><Button size="small" disabled={!state.online || state.syncStatus === "syncing"} onClick={() => dispatch(syncRundown())}>回网同步</Button></div></header>
      <FailedBanner />
      <ConflictPanel />
      <Routes><Route path="/" element={<RundownPage />} /><Route path="/changes" element={<ChainPage mode="changes" />} /><Route path="/queue" element={<ChainPage mode="queue" />} /><Route path="/history" element={<ChainPage mode="history" />} /></Routes></main>
  </div>;
}
