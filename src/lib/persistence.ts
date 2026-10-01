import type { BreakingChange, HistoryEntry, PendingChange, RundownItem } from "../types";

const DRAFT_KEY = "pair-wise-yf-46/rundown/draft";
const SERVER_KEY = "pair-wise-yf-46/rundown/server";
const LEGACY_KEY = "pair-wise-yf-46/rundown";

export interface DraftShape {
  items: RundownItem[];
  base: RundownItem[];
  queue: PendingChange[];
  changes: BreakingChange[];
  history: HistoryEntry[];
}

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function loadDraft(): DraftShape | null {
  return read<DraftShape>(DRAFT_KEY);
}

export function saveDraft(draft: DraftShape): void {
  localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
}

export function clearDraft(): void {
  localStorage.removeItem(DRAFT_KEY);
}

export function loadServer(): RundownItem[] {
  const server = read<RundownItem[]>(SERVER_KEY);
  if (Array.isArray(server)) return server;
  const legacy = read<RundownItem[]>(LEGACY_KEY);
  if (Array.isArray(legacy) && legacy.length) {
    localStorage.setItem(SERVER_KEY, JSON.stringify(legacy));
    return legacy;
  }
  return [];
}

export function saveServerItems(items: RundownItem[]): void {
  localStorage.setItem(SERVER_KEY, JSON.stringify(items));
}

export const STORAGE_KEYS = { DRAFT: DRAFT_KEY, SERVER: SERVER_KEY };
