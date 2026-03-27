// ---------------------------------------------------------------------------
// ResizeHUD — floating heads-up display shown during window resize.
// Shows a miniature column map with the resizing column highlighted,
// plus the current width x height dimensions and viewport percentage.
// ---------------------------------------------------------------------------

import { useEffect, useMemo, useState } from "react";
import { cn } from "~/lib/utils";
import {
  useCanvasStore,
  selectCurrentCanvasScope,
  selectCanvasScopeByKey,
  groupWindowsIntoColumns,
} from "./canvasStore";

export function ResizeHUD(props: { scopeKey?: string }) {
  const { scopeKey } = props;

  const resizingWindowId = useCanvasStore((s) => s.resizingWindowId);
  const dimensions = useCanvasStore((s) => s.resizeDimensions);

  const workspace = useCanvasStore((s) => {
    const scope = scopeKey ? selectCanvasScopeByKey(s, scopeKey) : selectCurrentCanvasScope(s);
    const ws = scope.workspaces.find((w) => w.id === scope.activeWorkspaceId);
    return ws ?? null;
  });

  // -- Fade-out on resize end ------------------------------------------------

  const [visible, setVisible] = useState(false);
  const [fading, setFading] = useState(false);
  // Cache last-known dimensions so we can display them during fade-out
  const [lastDimensions, setLastDimensions] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const [lastResizingId, setLastResizingId] = useState<string | null>(null);

  useEffect(() => {
    if (resizingWindowId) {
      setVisible(true);
      setFading(false);
    } else if (visible) {
      // Start fade-out
      setFading(true);
      const t = setTimeout(() => {
        setVisible(false);
        setFading(false);
      }, 300);
      return () => clearTimeout(t);
    }
  }, [resizingWindowId, visible]);

  // Keep last-known values alive during fade
  useEffect(() => {
    if (dimensions) setLastDimensions(dimensions);
  }, [dimensions]);

  useEffect(() => {
    if (resizingWindowId) setLastResizingId(resizingWindowId);
  }, [resizingWindowId]);

  // -- Column layout ---------------------------------------------------------

  const columns = useMemo(
    () => (workspace ? groupWindowsIntoColumns(workspace.windows) : []),
    [workspace],
  );

  if (!visible) return null;

  const displayDimensions = dimensions ?? lastDimensions;
  const displayResizingId = resizingWindowId ?? lastResizingId;

  if (!displayDimensions || !displayResizingId) return null;

  const viewportWidth = typeof window !== "undefined" ? window.innerWidth : 1280;
  const pct = Math.round((displayDimensions.width / viewportWidth) * 100);

  return (
    <div
      className={cn(
        "pointer-events-none fixed top-4 left-1/2 z-[9999] -translate-x-1/2",
        "rounded-lg border border-white/10 dark:border-white/[0.06]",
        "bg-popover shadow-lg",
        "px-3 py-2",
        "transition-opacity duration-200",
        fading ? "opacity-0" : "opacity-100",
      )}
    >
      {/* Mini column map */}
      <div className="flex items-end gap-0.5 mb-1.5 justify-center">
        {columns.map((col) => {
          const isResizing = col.windows.some((w) => w.id === displayResizingId);
          // Scale column widths down to a minimap size
          const colWidth = col.windows[0]?.width ?? 700;
          const barWidth = Math.max(8, Math.round(colWidth / 20));
          return (
            <div
              key={col.groupId}
              className={cn(
                "rounded-sm transition-colors duration-100",
                isResizing
                  ? "bg-blue-500 shadow-[0_0_6px_rgba(59,130,246,0.4)]"
                  : "bg-muted-foreground/20",
              )}
              style={{
                width: barWidth,
                height: isResizing ? 18 : 14,
              }}
            />
          );
        })}
      </div>

      {/* Dimensions readout */}
      <div className="text-[10px] font-mono text-muted-foreground text-center select-none">
        <span className="text-foreground/80 font-semibold">{displayDimensions.width}</span>
        <span className="text-muted-foreground/50"> × </span>
        <span className="text-foreground/80 font-semibold">{displayDimensions.height}</span>
        <span className="text-muted-foreground/40">px</span>
        <span className="ml-1.5 text-muted-foreground/50">({pct}% viewport)</span>
        {pct > 90 && (
          <span className="ml-1 text-amber-400" title="Window exceeds 90% of viewport width">
            ⚠
          </span>
        )}
      </div>
    </div>
  );
}
