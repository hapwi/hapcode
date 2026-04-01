import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import { useEffect, useMemo, useState } from "react";
import { refreshClaudeUsage, useClaudeUsage } from "~/claudeUsageStore";
import type { RateLimitInfo } from "~/session-logic";
import { cn } from "~/lib/utils";

interface ChatStatusBarProps {
  activities: ReadonlyArray<OrchestrationThreadActivity>;
  rateLimitInfo: RateLimitInfo | null;
}

// ── Hooks ─────────────────────────────────────────────────────────────

function useCountdown(resetsAt: string | null): string | null {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    if (resetsAt === null) return;
    const interval = setInterval(() => {
      setNow(Math.floor(Date.now() / 1000));
    }, 30_000);
    return () => clearInterval(interval);
  }, [resetsAt]);

  if (resetsAt === null) return null;

  const resetEpoch = Math.floor(new Date(resetsAt).getTime() / 1000);
  const diff = resetEpoch - now;
  if (diff <= 0 || Number.isNaN(diff)) return "now";

  const hours = Math.floor(diff / 3600);
  const mins = Math.floor((diff % 3600) / 60);
  if (hours > 0) return `${hours}h ${mins}m`;
  if (mins > 0) return `${mins}m`;
  return "<1m";
}

function useClaudeOAuthUsage(activities: ReadonlyArray<OrchestrationThreadActivity>) {
  const usage = useClaudeUsage();

  const latestTurnCompleted = useMemo(() => {
    for (let i = activities.length - 1; i >= 0; i--) {
      if (activities[i]?.kind === "turn.completed") return activities[i]?.id;
    }
    return null;
  }, [activities]);

  useEffect(() => {
    void refreshClaudeUsage();
  }, []);

  useEffect(() => {
    if (latestTurnCompleted === null) return;
    void refreshClaudeUsage({ force: true });
  }, [latestTurnCompleted]);

  return usage;
}

// ── Color helpers ─────────────────────────────────────────────────────

function usageColor(usedPercent: number): string {
  if (usedPercent >= 90) return "text-red-400/70";
  if (usedPercent >= 75) return "text-amber-400/70";
  return "text-emerald-400/70";
}

// ── Component ─────────────────────────────────────────────────────────

/**
 * Renders inline status items (context %, 5h usage %, reset countdown)
 * meant to sit inside the BranchToolbar row.
 */
export function ChatStatusBar({
  activities,
  rateLimitInfo,
}: ChatStatusBarProps) {
  const oauthUsage = useClaudeOAuthUsage(activities);

  // Fall back to SDK rate_limit_event for reset time if OAuth didn't provide one
  const resetsAt =
    oauthUsage.resetsAt ??
    (rateLimitInfo?.resetsAt ? new Date(rateLimitInfo.resetsAt * 1000).toISOString() : null);
  const countdown = useCountdown(resetsAt);

  const fiveHourItem =
    oauthUsage.fiveHourPercent !== null ? (
      <span className="whitespace-nowrap">
        5h:{" "}
        <span className={cn("tabular-nums font-medium", usageColor(oauthUsage.fiveHourPercent))}>
          {oauthUsage.fiveHourPercent}%
        </span>
      </span>
    ) : null;

  if (!fiveHourItem && !countdown) return null;

  return (
    <div className="flex items-center gap-0 text-xs text-muted-foreground/70 sm:text-xs">
      {fiveHourItem}
      {countdown && (
        <span className="hidden items-center @sm/toolbar:flex">
          {fiveHourItem ? <span className="mx-2 opacity-40">·</span> : null}
          <span className="whitespace-nowrap">
            resets: <span className="tabular-nums">{countdown}</span>
          </span>
        </span>
      )}
    </div>
  );
}
