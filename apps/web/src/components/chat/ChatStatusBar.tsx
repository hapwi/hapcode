import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  deriveContextWindowUsage,
  deriveRateLimitInfo,
} from "~/session-logic";
import { cn } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";

interface ChatStatusBarProps {
  activities: ReadonlyArray<OrchestrationThreadActivity>;
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

interface OAuthUsage {
  fiveHourPercent: number | null;
  resetsAt: string | null;
}

function useClaudeOAuthUsage(activities: ReadonlyArray<OrchestrationThreadActivity>): OAuthUsage {
  const [usage, setUsage] = useState<OAuthUsage>({ fiveHourPercent: null, resetsAt: null });

  // Re-fetch whenever a new turn completes (activity list changes with turn.completed)
  const latestTurnCompleted = useMemo(() => {
    for (let i = activities.length - 1; i >= 0; i--) {
      if (activities[i]?.kind === "turn.completed") return activities[i]?.id;
    }
    return null;
  }, [activities]);

  const fetchUsage = useCallback(async () => {
    try {
      const api = readNativeApi();
      if (!api) return;
      const result = await api.claude.getUsage();
      if (result.fiveHour) {
        setUsage({
          fiveHourPercent: Math.round(result.fiveHour.utilization),
          resetsAt: result.fiveHour.resetsAt || null,
        });
      }
    } catch (err) {
      console.debug("[ChatStatusBar] OAuth usage fetch failed:", err);
    }
  }, []);

  useEffect(() => {
    // Fetch on mount and whenever a turn completes
    void fetchUsage();

    // Also refresh every 2 minutes to keep the data fresh
    const interval = setInterval(() => void fetchUsage(), 120_000);
    return () => clearInterval(interval);
  }, [fetchUsage, latestTurnCompleted]);

  return usage;
}

// ── Color helpers ─────────────────────────────────────────────────────

function usageColor(usedPercent: number): string {
  if (usedPercent >= 80) return "text-red-500";
  if (usedPercent >= 50) return "text-amber-500";
  return "text-emerald-500";
}

// ── Component ─────────────────────────────────────────────────────────

/**
 * Renders inline status items (context %, 5h usage %, reset countdown)
 * meant to sit inside the BranchToolbar row.
 */
export function ChatStatusBar({ activities }: ChatStatusBarProps) {
  const ctxUsage = useMemo(() => deriveContextWindowUsage(activities), [activities]);
  const oauthUsage = useClaudeOAuthUsage(activities);

  // Fall back to SDK rate_limit_event for reset time if OAuth didn't provide one
  const sdkRateLimit = useMemo(() => deriveRateLimitInfo(activities), [activities]);
  const resetsAt = oauthUsage.resetsAt ?? (sdkRateLimit?.resetsAt ? new Date(sdkRateLimit.resetsAt * 1000).toISOString() : null);
  const countdown = useCountdown(resetsAt);

  // Default to 100% remaining when no turn has completed yet
  const ctx = ctxUsage ?? { usedPercent: 0, remainingPercent: 100, usedTokens: 0, contextWindow: 200_000 };

  const items: React.ReactNode[] = [];

  items.push(
    <span key="ctx" className="whitespace-nowrap">
      ctx: <span className={cn("tabular-nums font-medium", usageColor(ctx.usedPercent))}>{ctx.remainingPercent}%</span>
    </span>,
  );

  if (oauthUsage.fiveHourPercent !== null) {
    items.push(
      <span key="5h" className="whitespace-nowrap">
        5h: <span className={cn("tabular-nums font-medium", usageColor(oauthUsage.fiveHourPercent))}>{oauthUsage.fiveHourPercent}%</span>
      </span>,
    );
  }

  if (countdown) {
    items.push(
      <span key="resets" className="whitespace-nowrap">
        resets: <span className="tabular-nums">{countdown}</span>
      </span>,
    );
  }

  if (items.length === 0) return null;

  return (
    <div className="flex items-center gap-0 text-xs text-muted-foreground/70 sm:text-xs">
      {items.map((item, i) => (
        <span key={i} className="flex items-center">
          {i > 0 && <span className="mx-2 opacity-40">·</span>}
          {item}
        </span>
      ))}
    </div>
  );
}
