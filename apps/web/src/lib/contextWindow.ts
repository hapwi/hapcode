import type { OrchestrationThreadActivity, ThreadTokenUsageSnapshot } from "@t3tools/contracts";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

type NullableContextWindowUsage = {
  readonly [Key in keyof ThreadTokenUsageSnapshot]: undefined extends ThreadTokenUsageSnapshot[Key]
    ? Exclude<ThreadTokenUsageSnapshot[Key], undefined> | null
    : ThreadTokenUsageSnapshot[Key];
};

export type ContextWindowSnapshot = NullableContextWindowUsage & {
  readonly remainingTokens: number | null;
  readonly usedPercentage: number | null;
  readonly remainingPercentage: number | null;
  readonly updatedAt: string;
};

export function deriveLatestContextWindowSnapshot(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ContextWindowSnapshot | null {
  // Find the latest context-window.updated event with valid usedTokens.
  let latestActivity: OrchestrationThreadActivity | null = null;
  let latestPayload: Record<string, unknown> | null = null;
  let latestUsedTokens: number | null = null;
  let latestIndex = -1;

  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (!activity || activity.kind !== "context-window.updated") {
      continue;
    }

    const payload = asRecord(activity.payload);
    const usedTokens = asFiniteNumber(payload?.usedTokens);
    if (usedTokens === null || usedTokens <= 0) {
      continue;
    }

    latestActivity = activity;
    latestPayload = payload;
    latestUsedTokens = usedTokens;
    latestIndex = index;
    break;
  }

  if (latestActivity === null || latestPayload === null || latestUsedTokens === null) {
    return null;
  }

  // Try to get maxTokens from the latest event first.  When the latest event
  // lacks it (e.g. Claude task_progress events before the first turn completes),
  // carry forward maxTokens from a previous event so the badge can show a
  // percentage instead of a raw token count.
  let maxTokens = asFiniteNumber(latestPayload?.maxTokens);
  if (maxTokens === null) {
    for (let index = latestIndex - 1; index >= 0; index -= 1) {
      const activity = activities[index];
      if (!activity || activity.kind !== "context-window.updated") {
        continue;
      }
      const payload = asRecord(activity.payload);
      const prevMaxTokens = asFiniteNumber(payload?.maxTokens);
      if (prevMaxTokens !== null && prevMaxTokens > 0) {
        maxTokens = prevMaxTokens;
        break;
      }
    }
  }

  const usedPercentage =
    maxTokens !== null && maxTokens > 0
      ? Math.min(100, (latestUsedTokens / maxTokens) * 100)
      : null;
  const remainingTokens =
    maxTokens !== null ? Math.max(0, Math.round(maxTokens - latestUsedTokens)) : null;
  const remainingPercentage = usedPercentage !== null ? Math.max(0, 100 - usedPercentage) : null;

  return {
    usedTokens: latestUsedTokens,
    totalProcessedTokens: asFiniteNumber(latestPayload?.totalProcessedTokens),
    maxTokens,
    remainingTokens,
    usedPercentage,
    remainingPercentage,
    inputTokens: asFiniteNumber(latestPayload?.inputTokens),
    cachedInputTokens: asFiniteNumber(latestPayload?.cachedInputTokens),
    outputTokens: asFiniteNumber(latestPayload?.outputTokens),
    reasoningOutputTokens: asFiniteNumber(latestPayload?.reasoningOutputTokens),
    lastUsedTokens: asFiniteNumber(latestPayload?.lastUsedTokens),
    lastInputTokens: asFiniteNumber(latestPayload?.lastInputTokens),
    lastCachedInputTokens: asFiniteNumber(latestPayload?.lastCachedInputTokens),
    lastOutputTokens: asFiniteNumber(latestPayload?.lastOutputTokens),
    lastReasoningOutputTokens: asFiniteNumber(latestPayload?.lastReasoningOutputTokens),
    toolUses: asFiniteNumber(latestPayload?.toolUses),
    durationMs: asFiniteNumber(latestPayload?.durationMs),
    compactsAutomatically: asBoolean(latestPayload?.compactsAutomatically) ?? false,
    updatedAt: latestActivity.createdAt,
  };
}

export function formatContextWindowTokens(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return "0";
  }
  if (value < 1_000) {
    return `${Math.round(value)}`;
  }
  if (value < 10_000) {
    return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  }
  if (value < 1_000_000) {
    return `${Math.round(value / 1_000)}k`;
  }
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}
