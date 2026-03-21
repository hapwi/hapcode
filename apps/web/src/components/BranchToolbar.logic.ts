import type { GitBranch, OrchestrationThreadActivity, ProviderKind } from "@t3tools/contracts";
import { Schema } from "effect";

export const EnvMode = Schema.Literals(["local", "worktree"]);
export type EnvMode = typeof EnvMode.Type;

export interface ClaudeStatusSummary {
  contextLabel: string | null;
  timerLabel: string | null;
  title: string | null;
}

export function resolveEffectiveEnvMode(input: {
  activeWorktreePath: string | null;
  hasServerThread: boolean;
  draftThreadEnvMode: EnvMode | undefined;
}): EnvMode {
  const { activeWorktreePath, hasServerThread, draftThreadEnvMode } = input;
  return activeWorktreePath || (!hasServerThread && draftThreadEnvMode === "worktree")
    ? "worktree"
    : "local";
}

export function resolveDraftEnvModeAfterBranchChange(input: {
  nextWorktreePath: string | null;
  currentWorktreePath: string | null;
  effectiveEnvMode: EnvMode;
}): EnvMode {
  const { nextWorktreePath, currentWorktreePath, effectiveEnvMode } = input;
  if (nextWorktreePath) {
    return "worktree";
  }
  if (effectiveEnvMode === "worktree" && !currentWorktreePath) {
    return "worktree";
  }
  return "local";
}

export function resolveBranchToolbarValue(input: {
  envMode: EnvMode;
  activeWorktreePath: string | null;
  activeThreadBranch: string | null;
  currentGitBranch: string | null;
}): string | null {
  const { envMode, activeWorktreePath, activeThreadBranch, currentGitBranch } = input;
  if (envMode === "worktree" && !activeWorktreePath) {
    return activeThreadBranch ?? currentGitBranch;
  }
  return currentGitBranch ?? activeThreadBranch;
}

export function deriveLocalBranchNameFromRemoteRef(branchName: string): string {
  const firstSeparatorIndex = branchName.indexOf("/");
  if (firstSeparatorIndex <= 0 || firstSeparatorIndex === branchName.length - 1) {
    return branchName;
  }
  return branchName.slice(firstSeparatorIndex + 1);
}

function deriveLocalBranchNameCandidatesFromRemoteRef(
  branchName: string,
  remoteName?: string,
): ReadonlyArray<string> {
  const candidates = new Set<string>();
  const firstSlashCandidate = deriveLocalBranchNameFromRemoteRef(branchName);
  if (firstSlashCandidate.length > 0) {
    candidates.add(firstSlashCandidate);
  }

  if (remoteName) {
    const remotePrefix = `${remoteName}/`;
    if (branchName.startsWith(remotePrefix) && branchName.length > remotePrefix.length) {
      candidates.add(branchName.slice(remotePrefix.length));
    }
  }

  return [...candidates];
}

export function dedupeRemoteBranchesWithLocalMatches(
  branches: ReadonlyArray<GitBranch>,
): ReadonlyArray<GitBranch> {
  const localBranchNames = new Set(
    branches.filter((branch) => !branch.isRemote).map((branch) => branch.name),
  );

  return branches.filter((branch) => {
    if (!branch.isRemote) {
      return true;
    }

    if (branch.remoteName !== "origin") {
      return true;
    }

    const localBranchCandidates = deriveLocalBranchNameCandidatesFromRemoteRef(
      branch.name,
      branch.remoteName,
    );
    return !localBranchCandidates.some((candidate) => localBranchNames.has(candidate));
  });
}

export function resolveBranchSelectionTarget(input: {
  activeProjectCwd: string;
  activeWorktreePath: string | null;
  branch: Pick<GitBranch, "isDefault" | "worktreePath">;
}): {
  checkoutCwd: string;
  nextWorktreePath: string | null;
  reuseExistingWorktree: boolean;
} {
  const { activeProjectCwd, activeWorktreePath, branch } = input;

  if (branch.worktreePath) {
    return {
      checkoutCwd: branch.worktreePath,
      nextWorktreePath: branch.worktreePath === activeProjectCwd ? null : branch.worktreePath,
      reuseExistingWorktree: true,
    };
  }

  const nextWorktreePath =
    activeWorktreePath !== null && branch.isDefault ? null : activeWorktreePath;

  return {
    checkoutCwd: nextWorktreePath ?? activeProjectCwd,
    nextWorktreePath,
    reuseExistingWorktree: false,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatCompactCount(value: number): string {
  if (value >= 1_000_000) {
    return `${Math.round(value / 100_000) / 10}m`;
  }
  if (value >= 1_000) {
    return `${Math.round(value / 100) / 10}k`;
  }
  return `${Math.round(value)}`;
}

const FIVE_HOUR_WINDOW_MS = 5 * 60 * 60 * 1000;

function formatMinutesRemaining(targetEpochMs: number, nowMs: number): string | null {
  const diffMs = targetEpochMs - nowMs;
  if (!Number.isFinite(diffMs) || diffMs <= 0) {
    return null;
  }
  const totalMinutes = Math.ceil(diffMs / 60_000);
  const elapsedMs = FIVE_HOUR_WINDOW_MS - diffMs;
  const usedPct = Math.round(Math.max(0, Math.min(100, (elapsedMs / FIVE_HOUR_WINDOW_MS) * 100)));
  const timeLabel =
    totalMinutes >= 60
      ? totalMinutes % 60 === 0
        ? `${Math.floor(totalMinutes / 60)}h left`
        : `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m left`
      : `${totalMinutes}m left`;
  return `5h: ${usedPct}% · ${timeLabel}`;
}

function normalizeEpochMs(value: unknown): number | null {
  const raw = asFiniteNumber(value);
  if (raw === null) {
    return null;
  }
  return raw < 1_000_000_000_000 ? raw * 1000 : raw;
}

function deriveClaudeContextLabel(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): string | null {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (activity?.kind !== "turn.completed") {
      continue;
    }
    const payload = asRecord(activity.payload);
    const modelUsage = asRecord(payload?.modelUsage);
    if (!modelUsage) {
      continue;
    }

    let totalTokens = 0;
    let contextWindow: number | null = null;
    for (const entry of Object.values(modelUsage)) {
      const modelStats = asRecord(entry);
      if (!modelStats) {
        continue;
      }
      totalTokens +=
        (asFiniteNumber(modelStats.inputTokens) ?? 0) +
        (asFiniteNumber(modelStats.cacheReadInputTokens) ?? 0) +
        (asFiniteNumber(modelStats.cacheCreationInputTokens) ?? 0);
      const modelContextWindow = asFiniteNumber(modelStats.contextWindow);
      if (modelContextWindow !== null) {
        contextWindow = Math.max(contextWindow ?? 0, modelContextWindow);
      }
    }

    if (!contextWindow || totalTokens <= 0) {
      continue;
    }

    const pct = Math.round((totalTokens / contextWindow) * 100);
    return `ctx: ${pct}%`;
  }
  // No turn.completed activities yet — context is fully available
  return "ctx: 100%";
}

function deriveClaudeTimerLabel(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  now: Date,
): string | null {
  const nowMs = now.getTime();
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (activity?.kind !== "account.rate-limits.updated") {
      continue;
    }
    const payload = asRecord(activity.payload);
    const rateLimitEvent = asRecord(payload?.rateLimits);
    const rateLimitInfo = asRecord(rateLimitEvent?.rate_limit_info);
    if (!rateLimitInfo || rateLimitInfo.rateLimitType !== "five_hour") {
      continue;
    }

    const resetAtMs = normalizeEpochMs(rateLimitInfo.resetsAt);
    if (resetAtMs === null) {
      continue;
    }

    return formatMinutesRemaining(resetAtMs, nowMs);
  }
  return null;
}

export function deriveClaudeStatusSummary(input: {
  provider: ProviderKind | null;
  activities: ReadonlyArray<OrchestrationThreadActivity>;
  now?: Date;
}): ClaudeStatusSummary | null {
  if (input.provider !== "claudeAgent") {
    return null;
  }

  const now = input.now ?? new Date();
  const contextLabel = deriveClaudeContextLabel(input.activities);
  const timerLabel = deriveClaudeTimerLabel(input.activities, now);
  if (!contextLabel && !timerLabel) {
    return null;
  }

  const titleParts = [contextLabel, timerLabel].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );

  return {
    contextLabel,
    timerLabel,
    title: titleParts.length > 0 ? `Claude status: ${titleParts.join(" · ")}` : null,
  };
}
