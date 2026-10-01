import { useEffect, useMemo, useState } from "react";
import { closestCenter, DndContext, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { arrayMove, SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { Alert, Button, Card, Form, Input, InputNumber, Radio, Select, Switch, Tag, Timeline, message } from "antd";
import { format } from "date-fns";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useTranslation } from "react-i18next";
import { NavLink, Route, Routes, useNavigate } from "react-router-dom";
import { SortableItem } from "./components/SortableItem";
import { store } from "./store";
import { useAppDispatch, useAppSelector } from "./store/hooks";
import {
  addItem,
  adjustDuration,
  bootstrap,
  bootstrapFromServer,
  editField,
  insertBreaking,
  networkStateChanged,
  pushLocal,
  removeItem,
  reorder,
  resolveConflicts,
  setConflictChoice,
  setRole,
  simulateRemoteEdit,
  skipItem,
  toggleOnline,
  undo,
  updateStatus
} from "./store/rundownSlice";
import { computeTimeline, totalDuration } from "./logic/timeline";
import { can } from "./logic/permissions";
import { isLinkOnline, serverGet } from "./sync/server";
import type { Role, SyncStatus } from "./types";

const schema = z.object({ title: z.string().min(2), type: z.enum(["新闻片", "连线", "嘉宾", "口播", "广告"]), duration: z.number().min(1).max(120), presenter: z.string().min(1), source: z.string().min(1) });
type FormValues = z.infer<typeof schema>;

function RundownPage() {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const { items, role, sync, conflicts } = useAppSelector((state) => state.rundown);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const slots = useMemo(() => computeTimeline(items), [items]);
  const total = totalDuration(items);
  const risks = slots.filter((slot) => slot.hardRisk);
  const { control, handleSubmit, reset } = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: { title: "", type: "新闻片", duration: 5, presenter: "陈默", source: "现场" } });

  const onDragEnd = (event: DragEndEvent) => {
    if (!can(role, "reorder")) {
      message.warning("当前岗位无权调整顺序");
      return;
    }
    if (!event.over || event.active.id === event.over.id) return;
    const oldIndex = items.findIndex((item) => item.id === event.active.id);
    const newIndex = items.findIndex((item) => item.id === event.over!.id);
    dispatch(reorder(arrayMove(items, oldIndex, newIndex)));
  };

  const submit = (values: FormValues) => { dispatch(addItem(values)); reset(); };

  return <div className="page-grid">
    <Card className="main-card">
      <div className="card-heading"><div><small>2026-10-08 · 08:00 开播</small><h2>直播串联单</h2></div><div className="head-actions"><Button onClick={() => dispatch(undo())} disabled={!can(role, "undo")}>撤回上一步</Button></div></div>
      <div className="summary"><span><b>{items.length}</b> 条内容</span><span><b>{total}</b> 分钟总时长</span><span className={risks.length ? "danger-text" : ""}><b>{risks.length}</b> 个硬时间风险</span><span><b>{slots.at(-1)?.atLabel ?? "--:--"}</b> 预计收播</span></div>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={items.map((item) => item.id)} strategy={verticalListSortingStrategy}>
          <div className="rundown-list">{slots.map((slot) => <SortableItem
            key={slot.item.id}
            item={slot.item}
            cumulative={slot.atLabel}
            hardRisk={slot.hardRisk}
            driftMinutes={slot.driftMinutes}
            role={role}
            conflicts={conflicts}
            onConflictChoice={(id, choice) => dispatch(setConflictChoice({ id, choice }))}
            onDuration={(delta) => { if (!can(role, "adjustDuration")) message.warning("当前岗位无权调整时长"); else dispatch(adjustDuration({ id: slot.item.id, delta })); }}
            onHardStart={(value) => dispatch(editField({ id: slot.item.id, field: "hardStart", value }))}
            onStatus={() => dispatch(updateStatus({ id: slot.item.id, status: "已播出" }))}
            onSkip={() => dispatch(skipItem(slot.item.id))}
            onDelete={() => dispatch(removeItem(slot.item.id))}
          />)}</div>
        </SortableContext>
      </DndContext>
      {sync === "offline" && <p className="offline-hint">本机应急模式：可继续增删条目、调时长与插播，所有改动存为本地草稿，回网后按字段合并。</p>}
      {sync === "conflict" && <p className="offline-hint conflict-hint">存在 {conflicts.length} 处双版本待确认，可先在条目上快速选择，或<Button size="small" type="link" onClick={() => navigate("/conflicts")}>前往合并确认页</Button>。</p>}
    </Card>
    <aside className="side-stack">
      <Card title="新增播出条目">
        <Form layout="vertical" onFinish={handleSubmit(submit)}>
          <Form.Item label="标题"><Controller name="title" control={control} render={({ field, fieldState }) => <><Input {...field} status={fieldState.error ? "error" : ""} /><small className="error">{fieldState.error?.message}</small></>} /></Form.Item>
          <div className="two-cols"><Form.Item label="类型"><Controller name="type" control={control} render={({ field }) => <Select {...field} options={["新闻片","连线","嘉宾","口播","广告"].map((v) => ({ value: v, label: v }))} />} /></Form.Item><Form.Item label="时长"><Controller name="duration" control={control} render={({ field }) => <InputNumber {...field} min={1} max={120} addonAfter="分钟" disabled={!can(role, "adjustDuration")} />} /></Form.Item></div>
          <Form.Item label="主播"><Controller name="presenter" control={control} render={({ field }) => <Input {...field} />} /></Form.Item>
          <Form.Item label="来源"><Controller name="source" control={control} render={({ field }) => <Input {...field} />} /></Form.Item>
          <Button htmlType="submit" type="primary" block disabled={!can(role, "addItem")}>{can(role, "addItem") ? "加入串联单" : "当前岗位无权新增"}</Button>
        </Form>
      </Card>
      <BreakingForm />
    </aside>
  </div>;
}

function BreakingForm() {
  const dispatch = useAppDispatch();
  const { items, role, sync } = useAppSelector((state) => state.rundown);
  const selectable = items.filter((item) => !item.anchorId && item.status !== "已跳过");
  const [values, setValues] = useState({ headline: "", duration: 5, insertAfter: selectable[0]?.id ?? "", reason: "突发新闻" });
  const anchorTitle = items.find((item) => item.id === values.insertAfter)?.title;
  const allowed = can(role, "insertBreaking");
  return <Card title="突发插播" className="breaking-card">
    <Input value={values.headline} onChange={(event) => setValues({ ...values, headline: event.target.value })} placeholder="插播标题" disabled={!allowed} />
    <div className="two-cols"><InputNumber value={values.duration} onChange={(value) => setValues({ ...values, duration: Number(value ?? 5) })} addonAfter="分钟" disabled={!allowed} /><Select value={values.insertAfter} onChange={(value) => setValues({ ...values, insertAfter: value })} options={selectable.map((item) => ({ value: item.id, label: `插在「${item.title}」后` }))} disabled={!allowed} /></div>
    <Input value={values.reason} onChange={(event) => setValues({ ...values, reason: event.target.value })} placeholder="插播原因" disabled={!allowed} />
    <Button type="primary" danger block disabled={!allowed || values.headline.length < 2} onClick={() => { dispatch(insertBreaking(values)); setValues({ ...values, headline: "" }); }}>立即插入并重算时长</Button>
    <small>{allowed
      ? `插播锚定在「${anchorTitle ?? "—"}」之后：条目被主控移动或重排时，插播位置自动跟随；${sync === "offline" ? "当前离线，记入本机草稿。" : ""}`
      : "当前岗位无权插播。"}
    </small>
  </Card>;
}

const SYNC_META: Record<SyncStatus, { color: string; tag: string }> = {
  online: { color: "green", tag: "主备链路正常" },
  offline: { color: "red", tag: "本地应急模式" },
  pushing: { color: "blue", tag: "正在提交本机草稿…" },
  merging: { color: "purple", tag: "回网合并中（按条目字段）…" },
  conflict: { color: "orange", tag: "存在双版本待确认" },
  error: { color: "red", tag: "同步失败，草稿已保留" }
};

function SyncBanner() {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const { sync, offlineOps, conflicts, lastError, lastSyncedAt, role } = useAppSelector((state) => state.rundown);
  const meta = SYNC_META[sync];
  return <div className="sync-banner">
    <Tag color={meta.color}>{meta.tag}</Tag>
    {sync === "offline" && <span>{offlineOps.length} 个本机改动待回网提交，断网期间编排不会被覆盖。</span>}
    {sync === "online" && lastSyncedAt && <span className="muted">最近同步 {format(new Date(lastSyncedAt), "HH:mm:ss")}</span>}
    {sync === "conflict" && <><span>字段合并后有 <b>{conflicts.length}</b> 处两边不一致，已各留一版。</span><Button size="small" type="primary" onClick={() => navigate("/conflicts")}>去确认</Button></>}
    {sync === "error" && <><span className="danger-text">{lastError}</span><Button size="small" danger type="primary" onClick={() => void dispatch(pushLocal())}>保留草稿并重试</Button></>}
    {(sync === "pushing" || sync === "merging") && <span className="muted">同步进行中，条目暂时锁定，瞬间完成。</span>}
    {(sync === "offline" || sync === "error") && <Button size="small" ghost onClick={() => void dispatch(simulateRemoteEdit())}>模拟主控此时调广告位/硬时间</Button>}
    {role === "字幕" && <span className="muted">字幕岗：顺序与时长已按权限锁定。</span>}
  </div>;
}

function ConflictsPage() {
  const dispatch = useAppDispatch();
  const { conflicts, items, sync } = useAppSelector((state) => state.rundown);
  const fieldConflicts = conflicts.filter((c): c is Extract<typeof conflicts[number], { kind: "field" }> => c.kind === "field");
  const deleteConflicts = conflicts.filter((c): c is Extract<typeof conflicts[number], { kind: "delete" }> => c.kind === "delete");
  const orderConflict = conflicts.find((c) => c.kind === "order") as Extract<typeof conflicts[number], { kind: "order" }> | undefined;

  if (sync !== "conflict") return <Card title="合并确认"><p>当前没有待确认的合并冲突。同一字段两边各改一版时，会在这里并列呈现两版供选择。</p></Card>;

  return <div className="conflict-stack">
    <Alert type="warning" showIcon message="回网合并发现同一条目的同一字段两边都改了" description="未确认前条目先保留现场值并高亮；逐处选择保留哪一版（顺序改动会立即重算硬时间风险与插播位置），确认后统一提交。" />
    {fieldConflicts.length > 0 && <Card title={`字段双版本（${fieldConflicts.length}）`}>
      <div className="conflict-table">
        {fieldConflicts.map((conflict) => <div key={conflict.id} className="conflict-row">
          <div><b>{conflict.itemTitle}</b><small>{conflict.fieldLabel}</small></div>
          <Radio.Group value={conflict.choice} onChange={(event) => dispatch(setConflictChoice({ id: conflict.id, choice: event.target.value }))}>
            <Radio value="local">现场版：{display(conflict.local)}</Radio>
            <Radio value="remote">主控版：{display(conflict.remote)}</Radio>
          </Radio.Group>
        </div>)}
      </div>
    </Card>}
    {deleteConflicts.length > 0 && <Card title={`删除 / 修改冲突（${deleteConflicts.length}）`}>
      <div className="conflict-table">
        {deleteConflicts.map((conflict) => <div key={conflict.id} className="conflict-row">
          <div><b>{conflict.itemTitle}</b><small>{conflict.deletedBy === "local" ? "现场删除了条目，主控修改了字段" : "主控删除了条目，现场修改了字段"}</small></div>
          <Radio.Group value={conflict.choice} onChange={(event) => dispatch(setConflictChoice({ id: conflict.id, choice: event.target.value }))}>
            <Radio value="local">{conflict.deletedBy === "local" ? "遵从现场：删除" : `保留现场修改：${display(conflict.local)}`}</Radio>
            <Radio value="remote">{conflict.deletedBy === "remote" ? "遵从主控：删除" : `保留主控修改：${display(conflict.remote)}`}</Radio>
          </Radio.Group>
        </div>)}
      </div>
    </Card>}
    {orderConflict && <Card title="顺序冲突">
      <p>{orderConflict.detail}</p>
      <Radio.Group className="order-choice" value={orderConflict.choice} onChange={(event) => dispatch(setConflictChoice({ id: orderConflict.id, choice: event.target.value }))}>
        <Radio value="local" className="order-option"><b>采用现场顺序</b><ol>{orderConflict.localOrder.map((item) => <li key={item.id}>{item.title}（{item.duration}′{item.hardStart ? ` · 硬 ${item.hardStart}` : ""}）</li>)}</ol></Radio>
        <Radio value="remote" className="order-option"><b>采用主控顺序</b><ol>{orderConflict.remoteOrder.map((item) => <li key={item.id}>{item.title}（{item.duration}′{item.hardStart ? ` · 硬 ${item.hardStart}` : ""}）</li>)}</ol></Radio>
      </Radio.Group>
    </Card>}
    <div className="conflict-actions">
      <span className="muted">合并后共 {items.length} 条；选择顺序后会按新顺序重算硬时间并迁移突发插播。</span>
      <Button type="primary" size="large" onClick={() => void dispatch(resolveConflicts())}>确认选择并提交合并</Button>
    </div>
  </div>;
}

function display(value: string | number | undefined): string {
  if (value === undefined || value === "") return "（空）";
  return String(value);
}

function QueuePage() {
  const dispatch = useAppDispatch();
  const state = useAppSelector((root) => root.rundown);
  return <Card title="本地应急队列">
    <div className="queue-list">{state.offlineOps.length ? state.offlineOps.map((item) => <article key={item.id}><Tag color="red">{item.action}</Tag><b>{item.detail}</b><small>{format(new Date(item.queuedAt), "HH:mm:ss")}</small></article>) : <p>当前没有待同步操作。</p>}</div>
    {state.lastError && state.sync === "error" && <Alert type="error" showIcon message={state.lastError} style={{ margin: "12px 0" }} />}
    <div className="queue-actions">
      <Button type="primary" disabled={state.sync === "online" || state.sync === "pushing" || state.sync === "merging"} loading={state.sync === "pushing"} onClick={() => void dispatch(pushLocal())}>主链路恢复后提交并重试合并</Button>
      <Button onClick={() => void dispatch(simulateRemoteEdit())}>模拟主控断网期间改单（广告位/硬时间）</Button>
    </div>
    <p className="muted small-hint">合并按条目字段进行：只现场改的时长、只主控改的硬时间都会自动保留；同一字段两边不同时进入“合并确认”。</p>
  </Card>;
}

function ChainPage({ mode }: { mode: "changes" | "history" }) {
  const state = useAppSelector((root) => root.rundown);
  if (mode === "changes") return <Card title="突发变更记录"><Timeline items={state.changes.map((item) => ({ children: <div><b>{item.headline}</b><p>{item.reason} · 插播 {item.duration} 分钟 · 锚点 {item.insertAfter}</p><small>{format(new Date(item.createdAt), "HH:mm:ss")}</small></div> }))} /></Card>;
  return <Card title="操作历史"><Timeline items={state.history.map((entry) => ({ color: "blue", children: <div><b>{entry.label}</b><p>{entry.detail}</p><small>{format(new Date(entry.time), "HH:mm:ss")}</small></div> }))} /></Card>;
}

export default function App() {
  const dispatch = useAppDispatch();
  const state = useAppSelector((root) => root.rundown);
  const { t, i18n } = useTranslation();

  useEffect(() => { void dispatch(bootstrap()); }, [dispatch]);

  // 在线编辑：防抖自动推送（服务端带 revision，版本过期自动走三路合并）
  const signature = JSON.stringify(state.items.map((item) => [
    item.id, item.title, item.type, item.duration, item.hardStart ?? "", item.status, item.presenter, item.source, item.anchorId ?? ""
  ]));
  useEffect(() => {
    if (state.sync !== "online" || !state.dirty) return;
    const timer = setTimeout(() => { void dispatch(pushLocal()); }, 600);
    return () => clearTimeout(timer);
  }, [signature, state.sync, state.dirty, dispatch]);

  // 浏览器原生断网/回网
  useEffect(() => {
    const onOffline = () => void dispatch(networkStateChanged(false));
    const onOnline = () => void dispatch(networkStateChanged(true));
    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);
    return () => { window.removeEventListener("offline", onOffline); window.removeEventListener("online", onOnline); };
  }, [dispatch]);

  // 跨标签页（主控/现场）链路开关与服务端更新
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === "pair-wise-yf-46/link-online") {
        void dispatch(networkStateChanged(isLinkOnline()));
      }
      if (event.key === "pair-wise-yf-46/server") {
        const current = store.getState().rundown;
        if (current.sync === "online" && !current.dirty) {
          serverGet().then((doc) => dispatch(bootstrapFromServer({ items: doc.items, revision: doc.revision, history: current.history, changes: current.changes }))).catch(() => undefined);
        }
      }
    };
    window.addEventListener("storage", onStorage);
    const onLinkState = () => void dispatch(networkStateChanged(isLinkOnline()));
    window.addEventListener("link-state-changed", onLinkState);
    return () => { window.removeEventListener("storage", onStorage); window.removeEventListener("link-state-changed", onLinkState); };
  }, [dispatch]);

  const onlineSwitch = state.sync !== "offline" && state.sync !== "error";

  return <div className="app-shell">
    <aside className="sidebar"><div className="brand"><span>LIVE</span><div><b>{t("title")}</b><small>Control room</small></div></div><nav><NavLink to="/">{t("rundown")}</NavLink><NavLink to="/changes">{t("changes")}</NavLink><NavLink to="/queue">{t("queue")} {state.offlineOps.length ? <em>{state.offlineOps.length}</em> : null}</NavLink>{state.sync === "conflict" && <NavLink to="/conflicts" className="conflict-nav">合并确认 <em>{state.conflicts.length}</em></NavLink>}<NavLink to="/history">操作历史</NavLink></nav><Button ghost onClick={() => void i18n.changeLanguage(i18n.language === "zh" ? "en" : "zh")}>{i18n.language === "zh" ? "EN" : "中文"}</Button></aside>
    <main><header className="topbar"><div><small>直播运行中 · 紧急操作均保留审计记录</small><h1>{t("title")}</h1></div><div className="top-actions"><label>链路在线 <Switch checked={onlineSwitch} loading={state.sync === "pushing" || state.sync === "merging"} disabled={state.sync === "conflict" || state.sync === "pushing" || state.sync === "merging"} onChange={(value) => void dispatch(toggleOnline(value))} /></label><label>当前岗位 <Select<Role> value={state.role} onChange={(value) => dispatch(setRole(value))} options={[{value:"导播"},{value:"主编"},{value:"字幕"},{value:"演播室"}]} /></label></div></header>
    <SyncBanner />
    <Routes><Route path="/" element={<RundownPage />} /><Route path="/changes" element={<ChainPage mode="changes" />} /><Route path="/queue" element={<QueuePage />} /><Route path="/history" element={<ChainPage mode="history" />} /><Route path="/conflicts" element={<ConflictsPage />} /></Routes></main>
  </div>;
}
