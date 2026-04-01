import type { ClaudeUsageResult } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";

import { readNativeApi } from "./nativeApi";

export interface ClaudeUsageSnapshot {
  fiveHourPercent: number | null;
  resetsAt: string | null;
}

const INITIAL_SNAPSHOT: ClaudeUsageSnapshot = {
  fiveHourPercent: null,
  resetsAt: null,
};

const REFRESH_INTERVAL_MS = 120_000;

let snapshot = INITIAL_SNAPSHOT;
let lastFetchedAt = 0;
let inFlight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function emitChange(): void {
  for (const listener of listeners) listener();
}

function normalizeUsage(result: ClaudeUsageResult): ClaudeUsageSnapshot | null {
  if (!result.fiveHour) return null;
  return {
    fiveHourPercent: Math.round(result.fiveHour.utilization),
    resetsAt: result.fiveHour.resetsAt || null,
  };
}

function setSnapshot(nextSnapshot: ClaudeUsageSnapshot): void {
  if (
    snapshot.fiveHourPercent === nextSnapshot.fiveHourPercent &&
    snapshot.resetsAt === nextSnapshot.resetsAt
  ) {
    return;
  }

  snapshot = nextSnapshot;
  emitChange();
}

export async function refreshClaudeUsage(options?: { force?: boolean }): Promise<void> {
  if (inFlight) {
    await inFlight;
    return;
  }

  if (!options?.force && Date.now() - lastFetchedAt < REFRESH_INTERVAL_MS) {
    return;
  }

  const api = readNativeApi();
  if (!api) return;

  inFlight = (async () => {
    try {
      const result = await api.claude.getUsage();
      const nextSnapshot = normalizeUsage(result);
      if (nextSnapshot) {
        setSnapshot(nextSnapshot);
      }
    } catch (error) {
      console.debug("[claudeUsageStore] OAuth usage fetch failed:", error);
    } finally {
      lastFetchedAt = Date.now();
      inFlight = null;
    }
  })();

  await inFlight;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): ClaudeUsageSnapshot {
  return snapshot;
}

export function useClaudeUsage(): ClaudeUsageSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function getClaudeUsageSnapshot(): ClaudeUsageSnapshot {
  return getSnapshot();
}

export function resetClaudeUsageStoreForTests(): void {
  snapshot = INITIAL_SNAPSHOT;
  lastFetchedAt = 0;
  inFlight = null;
  listeners.clear();
}
