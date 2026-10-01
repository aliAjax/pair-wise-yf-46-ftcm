import type { RundownItem } from "../types";
import { seedItems } from "./seed";

/**
 * 用 localStorage 模拟“服务端”：主控/现场两个浏览器标签页共享同一份带版本号的数据。
 * KEY.online 是链路开关；offline 时 get/push 一律 reject，模拟断网。
 */
const DATA_KEY = "pair-wise-yf-46/server";
const LINK_KEY = "pair-wise-yf-46/link-online";
export const DRAFT_KEY = "pair-wise-yf-46/local-draft";

export interface ServerDoc {
  revision: number;
  items: RundownItem[];
}

export class RevisionMismatchError extends Error {
  latest: ServerDoc;
  constructor(latest: ServerDoc) {
    super("revision mismatch");
    this.name = "RevisionMismatchError";
    this.latest = latest;
  }
}

function read(): ServerDoc {
  const raw = localStorage.getItem(DATA_KEY);
  if (!raw) {
    const doc: ServerDoc = { revision: 1, items: seedItems };
    localStorage.setItem(DATA_KEY, JSON.stringify(doc));
    return doc;
  }
  return JSON.parse(raw) as ServerDoc;
}

function write(doc: ServerDoc) {
  localStorage.setItem(DATA_KEY, JSON.stringify(doc));
}

export function isLinkOnline(): boolean {
  return localStorage.getItem(LINK_KEY) !== "off";
}

export function setLinkOnline(online: boolean) {
  if (online) localStorage.removeItem(LINK_KEY);
  else localStorage.setItem(LINK_KEY, "off");
  // 跨标签页（主控/现场）同步链路状态
  window.dispatchEvent(new Event("link-state-changed"));
}

/** 拉取服务端最新版本；断网时 reject */
export async function serverGet(): Promise<ServerDoc> {
  await networkDelay();
  if (!isLinkOnline()) throw new Error("链路中断：无法访问编排服务器");
  return read();
}

/**
 * 乐观锁推送：baseRevision 过期说明主控期间也改过，返回 409 并带回最新文档供三路合并。
 * 同一版本的重复推送是幂等的。
 */
export async function serverPush(baseRevision: number, items: RundownItem[]): Promise<ServerDoc> {
  await networkDelay();
  if (!isLinkOnline()) throw new Error("链路中断：推送失败");
  const current = read();
  if (current.revision !== baseRevision) throw new RevisionMismatchError(current);
  const next: ServerDoc = { revision: current.revision + 1, items };
  write(next);
  return next;
}

/**
 * 演示用：模拟“对端（主控）在现场断网期间”的编辑——动广告位、安排硬时间。
 * 只在服务端写入新版本，不碰本地草稿；对端始终在线，不受本机链路开关影响。
 */
export async function serverSimulateRemoteEdit(): Promise<ServerDoc> {
  await networkDelay();
  const current = read();
  const items = structuredClone(current.items);
  const ad = items.find((item) => item.id === "r4");
  const talk = items.find((item) => item.id === "r3");
  if (ad) {
    // 主控把整点广告挪到连线之后并锁 08:18
    const adIndex = items.indexOf(ad);
    items.splice(adIndex, 1);
    const r2Index = items.findIndex((item) => item.id === "r2");
    ad.hardStart = "08:18";
    ad.source = "广告串（主控调整）";
    items.splice(r2Index + 1, 0, ad);
  }
  if (talk) talk.hardStart = "08:22";
  const next: ServerDoc = { revision: current.revision + 1, items };
  write(next);
  return next;
}

function networkDelay() {
  return new Promise((resolve) => setTimeout(resolve, 250));
}
