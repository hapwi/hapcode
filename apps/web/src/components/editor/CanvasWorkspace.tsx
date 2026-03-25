import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { LayoutDashboardIcon } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { cn } from "~/lib/utils";
import { isElectron } from "~/env";
import { resolveShortcutCommand } from "~/keybindings";
import { isTerminalFocused } from "~/lib/terminalFocus";
import { serverConfigQueryOptions } from "~/lib/serverReactQuery";
import { SidebarTrigger, useSidebar } from "~/components/ui/sidebar";
import { useStore } from "~/store";
import type { ResolvedKeybindingsConfig } from "@t3tools/contracts";
import {
  type CanvasWorkspace as CanvasWorkspaceType,
  groupWindowsIntoColumns,
  selectCanvasScopeByKey,
  selectCurrentCanvasScope,
  useActiveWorkspace,
  useAllWorkspacesForScope,
  useCanvasStore,
  useWorkspaceForScope,
} from "./canvasStore";
import { CanvasWindow } from "./CanvasWindow";
import { CanvasWindowContent, NewThreadButton } from "./CanvasWindowContent";
import { CanvasAddMenu } from "./CanvasAddMenu";
import { WorkspaceActions } from "./WorkspaceActions";
import { ResizeHUD } from "./ResizeHUD";

// ---------------------------------------------------------------------------
// Minimized windows dock
// ---------------------------------------------------------------------------

function MinimizedDock(props: { scopeKey?: string }) {
  const currentWorkspace = useActiveWorkspace();
  const scopedWorkspace = useWorkspaceForScope(props.scopeKey ?? "");
  const workspace = props.scopeKey ? scopedWorkspace : currentWorkspace;
  const restoreWindow = useCanvasStore((s) => s.restoreWindow);

  if (!workspace) return null;
  const minimized = workspace.windows.filter((w) => w.minimized);
  if (minimized.length === 0) return null;

  return (
    <div className="absolute bottom-10 left-1/2 z-50 flex -translate-x-1/2 gap-1.5 rounded-xl border border-border/40 bg-popover px-2 py-1.5 shadow-lg">
      {minimized.map((win) => (
        <button
          key={win.id}
          type="button"
          onClick={() => restoreWindow(win.id)}
          className="rounded-md bg-muted/60 px-2.5 py-1 text-[10px] font-medium text-muted-foreground shadow-sm transition-colors hover:bg-accent hover:text-foreground"
        >
          {win.title}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// WorkspaceScrollArea — scrollable canvas content for a single workspace.
// Extracted so that each workspace within a scope can stay mounted
// (hidden with display:none) and preserve terminal/browser state.
// ---------------------------------------------------------------------------

function WorkspaceScrollArea(props: {
  workspace: CanvasWorkspaceType;
  cwd: string | null;
  scopeKey?: string;
  /** True only when both the scope AND this workspace are active. */
  isActive: boolean;
  activeWindowId: string | null;
  scrollTrigger: number;
  isDragging: boolean;
  stackWindow: (windowId: string, targetId: string) => void;
}) {
  const {
    workspace,
    cwd,
    scopeKey: scopeKeyProp,
    isActive,
    activeWindowId,
    scrollTrigger,
    isDragging,
    stackWindow,
  } = props;

  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Track scroll container viewport width for fullscreen windows
  const [viewportWidth, setViewportWidth] = useState(0);
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const updateWidth = () => setViewportWidth(container.clientWidth);
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // Compute columns — memoize so the reference is stable across re-renders
  // when the underlying windows haven't changed.
  const columns = useMemo(
    () => groupWindowsIntoColumns(workspace.windows),
    [workspace.windows],
  );

  // -- Scroll wheel → horizontal scroll (vertical stays within windows) ------
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const onWheel = (e: WheelEvent) => {
      // If the user is scrolling horizontally (trackpad), let it happen naturally
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;

      // Check if the event target is inside a canvas window — if so, let the
      // window's own content (browser, file tree, terminal) handle vertical scroll
      const target = e.target as HTMLElement;
      if (target.closest("[data-canvas-window-id]")) return;

      // On the canvas background itself, translate vertical scroll → horizontal
      const hasHorizontalOverflow = container.scrollWidth > container.clientWidth;
      if (hasHorizontalOverflow) {
        e.preventDefault();
        container.scrollLeft += e.deltaY;
      }
    };

    container.addEventListener("wheel", onWheel, { passive: false });
    return () => container.removeEventListener("wheel", onWheel);
  }, []);

  // -- Middle-click pan with momentum ----------------------------------------
  const [isPanning, setIsPanning] = useState(false);
  const panRef = useRef<{
    startX: number;
    startY: number;
    scrollLeft: number;
    scrollTop: number;
  } | null>(null);
  const velocityRef = useRef({ vx: 0, vy: 0 });
  const lastPanPos = useRef({ x: 0, y: 0, time: 0 });
  const momentumRaf = useRef<number | null>(null);

  const stopMomentum = useCallback(() => {
    if (momentumRaf.current) {
      cancelAnimationFrame(momentumRaf.current);
      momentumRaf.current = null;
    }
  }, []);

  // Momentum scroll after pan release
  const startMomentum = useCallback(() => {
    stopMomentum();
    const container = scrollContainerRef.current;
    if (!container) return;

    const FRICTION = 0.92;
    const MIN_VELOCITY = 0.5;

    const tick = () => {
      const v = velocityRef.current;
      v.vx *= FRICTION;
      v.vy *= FRICTION;

      if (Math.abs(v.vx) < MIN_VELOCITY && Math.abs(v.vy) < MIN_VELOCITY) {
        momentumRaf.current = null;
        return;
      }

      container.scrollLeft -= v.vx;
      container.scrollTop -= v.vy;
      momentumRaf.current = requestAnimationFrame(tick);
    };

    momentumRaf.current = requestAnimationFrame(tick);
  }, [stopMomentum]);

  useEffect(() => {
    if (!isActive) return;
    const container = scrollContainerRef.current;
    if (!container) return;

    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 1) return;
      const rect = container.getBoundingClientRect();
      if (
        e.clientX < rect.left ||
        e.clientX > rect.right ||
        e.clientY < rect.top ||
        e.clientY > rect.bottom
      )
        return;
      e.preventDefault();
      stopMomentum();
      panRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        scrollLeft: container.scrollLeft,
        scrollTop: container.scrollTop,
      };
      lastPanPos.current = { x: e.clientX, y: e.clientY, time: performance.now() };
      velocityRef.current = { vx: 0, vy: 0 };
      setIsPanning(true);
    };

    document.addEventListener("mousedown", onMouseDown, { capture: true });
    return () => {
      document.removeEventListener("mousedown", onMouseDown, {
        capture: true,
      });
    };
  }, [isActive, stopMomentum]);

  // -- Title-bar drag-to-stack detection --------------------------------------
  const [dropTarget, setDropTarget] = useState<{ columnId: string; position: "below" } | null>(
    null,
  );

  // Use refs for values accessed inside event handlers so the effect doesn't
  // need to re-subscribe listeners every time columns/dropTarget change.
  const columnsRef = useRef(columns);
  columnsRef.current = columns;
  const dropTargetRef = useRef(dropTarget);
  dropTargetRef.current = dropTarget;
  const stackWindowRef = useRef(stackWindow);
  stackWindowRef.current = stackWindow;

  useEffect(() => {
    if (!isActive) return;
    const handleDrag = (e: Event) => {
      const { windowId, clientX, clientY } = (e as CustomEvent).detail;
      const container = scrollContainerRef.current;
      if (!container) return;

      // Find column elements and check if cursor is below a window in a column
      const columnEls = container.querySelectorAll("[data-canvas-column-id]");
      let found = false;

      for (const colEl of columnEls) {
        const colRect = colEl.getBoundingClientRect();
        // Check if cursor is horizontally within this column
        if (clientX >= colRect.left && clientX <= colRect.right) {
          // Check if cursor is below the column's windows (in empty space)
          const windowEls = colEl.querySelectorAll("[data-canvas-window-id]");
          let lowestBottom = colRect.top;
          let hasShortWindow = false;

          for (const winEl of windowEls) {
            const winRect = winEl.getBoundingClientRect();
            if (winRect.bottom > lowestBottom) lowestBottom = winRect.bottom;
            // A window is "short" if it doesn't fill the column height
            if (winRect.height < colRect.height - 20) hasShortWindow = true;
          }

          // Also consider: cursor below last window in the column, OR column has short window and cursor is in lower portion
          if (
            clientY > lowestBottom - 10 ||
            (hasShortWindow && clientY > colRect.top + colRect.height * 0.5)
          ) {
            const columnId = colEl.getAttribute("data-canvas-column-id");
            if (columnId) {
              // Don't show drop target on the dragged window's own solo column
              const col = columnsRef.current.find((c) => c.groupId === columnId);
              if (col && !(col.windows.length === 1 && col.windows[0]!.id === windowId)) {
                setDropTarget({ columnId, position: "below" });
                found = true;
              }
            }
          }
          break;
        }
      }

      if (!found) setDropTarget(null);
    };

    const handleDrop = (e: Event) => {
      const { windowId } = (e as CustomEvent).detail;
      const currentDropTarget = dropTargetRef.current;
      if (currentDropTarget) {
        // Find the first window in the target column to stack with
        const col = columnsRef.current.find((c) => c.groupId === currentDropTarget.columnId);
        if (col && col.windows.length > 0) {
          stackWindowRef.current(windowId, col.windows[0]!.id);
        }
        setDropTarget(null);
      }
    };

    window.addEventListener("canvas-window-drag", handleDrag);
    window.addEventListener("canvas-window-drop", handleDrop);
    return () => {
      window.removeEventListener("canvas-window-drag", handleDrag);
      window.removeEventListener("canvas-window-drop", handleDrop);
    };
  }, [isActive]);

  // -- Scroll active window into view with padding ---------------------------
  const SCROLL_PADDING = 16;
  // Track maximized state so we re-scroll when a window is fullscreened
  const maximizedKey =
    workspace.windows
      .filter((w) => w.maximized)
      .map((w) => w.id)
      .join(",") ?? "";
  useEffect(() => {
    if (!activeWindowId) return;
    const container = scrollContainerRef.current;
    if (!container) return;

    const isMaximized = maximizedKey.includes(activeWindowId);

    const doScroll = () => {
      const el = container.querySelector(
        `[data-canvas-window-id="${activeWindowId}"]`,
      ) as HTMLElement | null;
      if (!el) return;

      const containerRect = container.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();

      let scrollLeftTarget = container.scrollLeft;

      const elLeftInContainer = elRect.left - containerRect.left + container.scrollLeft;
      const elRightInContainer = elLeftInContainer + elRect.width;

      if (isMaximized) {
        // Center the maximized window in the viewport so padding is even
        scrollLeftTarget = elLeftInContainer - (container.clientWidth - elRect.width) / 2;
      } else if (elLeftInContainer < container.scrollLeft) {
        // Window is clipped on the left — scroll to reveal it with padding
        scrollLeftTarget = elLeftInContainer - SCROLL_PADDING;
      } else if (elRightInContainer > container.scrollLeft + container.clientWidth) {
        // Window is clipped on the right — scroll to reveal it with padding
        scrollLeftTarget = elRightInContainer + SCROLL_PADDING - container.clientWidth;
      }

      scrollLeftTarget = Math.max(0, scrollLeftTarget);

      if (scrollLeftTarget !== container.scrollLeft) {
        container.scrollTo({
          left: scrollLeftTarget,
          behavior: "smooth",
        });
      }
    };

    // When maximizing, the column width changes dramatically and the browser
    // needs time to reflow.  Use multiple deferred attempts so the scroll
    // calculation uses the final layout dimensions.
    if (maximizedKey) {
      requestAnimationFrame(doScroll);
      const t1 = setTimeout(doScroll, 100);
      const t2 = setTimeout(doScroll, 300);
      return () => {
        clearTimeout(t1);
        clearTimeout(t2);
      };
    } else {
      doScroll();
    }
  }, [activeWindowId, maximizedKey, scrollTrigger]);

  // -- Scroll newly added windows into view ----------------------------------
  const prevWindowCount = useRef(0);
  useEffect(() => {
    const visibleCount = workspace.windows.filter((w) => !w.minimized).length;
    const shouldScroll = visibleCount > prevWindowCount.current && scrollContainerRef.current;
    // Always update the ref so we don't re-trigger scroll-to-end on
    // unrelated workspace changes (e.g. maximizing a window).
    prevWindowCount.current = visibleCount;

    if (shouldScroll) {
      const container = scrollContainerRef.current!;
      const scrollToEnd = () => {
        container.scrollTo({
          left: container.scrollWidth,
          behavior: "smooth",
        });
      };
      // Scroll immediately after layout, then again after lazy content may have loaded
      // to handle cases where Suspense fallbacks resolve and change scrollWidth.
      requestAnimationFrame(scrollToEnd);
      const t1 = setTimeout(scrollToEnd, 100);
      const t2 = setTimeout(scrollToEnd, 300);
      return () => {
        clearTimeout(t1);
        clearTimeout(t2);
      };
    }
  }, [workspace.windows]);

  return (
    <>
      {/* Scrollable canvas — horizontal only, no scrollbar visible */}
      <div
        ref={scrollContainerRef}
        data-canvas-scroll-container
        className={cn(
          "relative min-h-0 flex-1 overflow-x-auto overflow-y-hidden",
          // Hide scrollbar across browsers
          "scrollbar-none [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none]",
          // Dot grid background — applied directly so it tiles with scroll
          "[background-size:24px_24px]",
          "[background-image:radial-gradient(color-mix(in_srgb,var(--muted-foreground)_15%,transparent)_1px,transparent_1px)]",
          "dark:[background-image:radial-gradient(color-mix(in_srgb,var(--muted-foreground)_12%,transparent)_1px,transparent_1px)]",
        )}
      >
        {columns.length === 0 ? (
          <div className="relative flex h-full flex-col items-center justify-center gap-3 text-muted-foreground/40">
            <LayoutDashboardIcon className="size-10" />
            <p className="text-sm">
              Click <span className="font-medium text-muted-foreground/60">+</span> to open a
              browser, terminal, or editor
            </p>
          </div>
        ) : (
          <div className="relative flex h-full min-w-fit min-h-0 items-stretch gap-2 px-2 pt-1 pb-3">
            {columns.map((col) => {
              // Single window column — render directly (no extra wrapper needed for simple case)
              const anyMaximized = col.windows.some((w) => w.maximized);
              // Default width = half viewport minus padding/gaps so 2 windows fit side by side
              // p-2 = 8px each side = 16px, gap-2 × 1 gap between columns = 8px → 24px overhead
              const halfViewport = viewportWidth > 0 ? Math.floor((viewportWidth - 24) / 2) : 550;
              const colWidth = Math.max(...col.windows.map((w) => w.width ?? halfViewport));

              const isDropTarget = dropTarget?.columnId === col.groupId;

              if (col.windows.length === 1) {
                const win = col.windows[0]!;
                // Fullscreen: use viewport width minus padding (p-2 = 8px each side)
                const fullscreenWidth = viewportWidth > 0 ? viewportWidth - 16 : undefined;
                return (
                  <div
                    key={col.groupId}
                    data-canvas-column-id={col.groupId}
                    className="flex h-full shrink-0 flex-col px-1"
                    style={
                      anyMaximized && fullscreenWidth
                        ? { width: fullscreenWidth }
                        : { width: colWidth }
                    }
                  >
                    <div className="flex min-h-0 flex-1">
                      <CanvasWindow
                        window={win}
                        {...(scopeKeyProp ? { scopeKey: scopeKeyProp } : {})}
                        headerActions={
                          win.type === "chat" ? <NewThreadButton window={win} /> : undefined
                        }
                      >
                        <CanvasWindowContent window={win} cwd={cwd} />
                      </CanvasWindow>
                    </div>
                    {/* Drop indicator */}
                    {isDropTarget && (
                      <div className="mt-1 flex h-16 items-center justify-center rounded-lg border-2 border-dashed border-blue-500/40 bg-blue-500/5">
                        <span className="text-[10px] font-medium text-blue-400/60">
                          Drop to stack here
                        </span>
                      </div>
                    )}
                  </div>
                );
              }

              // Multi-window column — stack vertically
              const fullscreenWidth = viewportWidth > 0 ? viewportWidth - 16 : undefined;
              return (
                <div
                  key={col.groupId}
                  data-canvas-column-id={col.groupId}
                  className="flex h-full shrink-0 flex-col gap-1 px-1"
                  style={
                    anyMaximized && fullscreenWidth
                      ? { width: fullscreenWidth }
                      : { width: colWidth }
                  }
                >
                  {col.windows.map((win) => (
                    <div key={win.id} className="flex min-h-0 flex-1">
                      <CanvasWindow
                        window={win}
                        forceStretch
                        {...(scopeKeyProp ? { scopeKey: scopeKeyProp } : {})}
                        headerActions={
                          win.type === "chat" ? <NewThreadButton window={win} /> : undefined
                        }
                      >
                        <CanvasWindowContent window={win} cwd={cwd} />
                      </CanvasWindow>
                    </div>
                  ))}
                  {/* Drop indicator */}
                  {isDropTarget && (
                    <div className="flex h-16 shrink-0 items-center justify-center rounded-lg border-2 border-dashed border-blue-500/40 bg-blue-500/5">
                      <span className="text-[10px] font-medium text-blue-400/60">
                        Drop to stack here
                      </span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Overlay during drag-to-reorder */}
        {isDragging && <div className="absolute inset-0 z-[9999]" />}

        {/* Pan overlay */}
        {isPanning && (
          <div
            className="absolute inset-0 z-[10000] cursor-grabbing"
            onPointerMove={(e) => {
              const p = panRef.current;
              const container = scrollContainerRef.current;
              if (!p || !container) return;
              container.scrollLeft = p.scrollLeft - (e.clientX - p.startX);
              container.scrollTop = p.scrollTop - (e.clientY - p.startY);

              // Track velocity for momentum
              const now = performance.now();
              const dt = now - lastPanPos.current.time;
              if (dt > 0) {
                velocityRef.current = {
                  vx: ((e.clientX - lastPanPos.current.x) / Math.max(dt, 1)) * 16,
                  vy: ((e.clientY - lastPanPos.current.y) / Math.max(dt, 1)) * 16,
                };
              }
              lastPanPos.current = { x: e.clientX, y: e.clientY, time: now };
            }}
            onPointerUp={() => {
              panRef.current = null;
              setIsPanning(false);
              startMomentum();
            }}
            onPointerLeave={() => {
              panRef.current = null;
              setIsPanning(false);
              startMomentum();
            }}
          />
        )}
      </div>

      {/* Minimized dock — rendered per-workspace so it appears when the workspace is active */}
      {isActive && <MinimizedDock {...(scopeKeyProp ? { scopeKey: scopeKeyProp } : {})} />}
    </>
  );
}

// ---------------------------------------------------------------------------
// CanvasWorkspace — niri-style: single horizontal strip, full-height windows
// ---------------------------------------------------------------------------

export function CanvasWorkspace(props: {
  cwd: string | null;
  /** When provided, renders this scope's workspace instead of the current one. */
  scopeKey?: string;
  /** When false the workspace is hidden — global event listeners are disabled. */
  isActive?: boolean;
}) {
  const { cwd, scopeKey: scopeKeyProp, isActive: isActiveProp = true } = props;
  const currentWorkspace = useActiveWorkspace();
  const scopedWorkspace = useWorkspaceForScope(scopeKeyProp ?? "");
  const workspace = scopeKeyProp ? scopedWorkspace : currentWorkspace;
  const { open: sidebarOpen } = useSidebar();

  // Get all workspaces for the scope so we can render them all and keep
  // terminal/browser instances alive across workspace tab switches.
  const currentScopeKey = useCanvasStore((s) => s.currentScopeKey);
  const scopeKey = scopeKeyProp ?? currentScopeKey;
  const { workspaces: allWorkspaces, activeWorkspaceId } = useAllWorkspacesForScope(scopeKey);

  // Resolve project name from canvas scope key (persisted, always available)
  const scopeProjectId = scopeKey.startsWith("project:") ? scopeKey.slice("project:".length) : null;
  const projects = useStore((s) => s.projects);
  const activeProjectName = scopeProjectId
    ? projects.find((p) => p.id === scopeProjectId)?.name
    : undefined;

  const isDragging = useCanvasStore((s) => s.isDragging);
  const addWindow = useCanvasStore((s) => s.addWindow);
  const ensureTerminalWindow = useCanvasStore((s) => s.ensureTerminalWindow);
  const removeWindow = useCanvasStore((s) => s.removeWindow);
  const focusNextWindow = useCanvasStore((s) => s.focusNextWindow);
  const focusPrevWindow = useCanvasStore((s) => s.focusPrevWindow);
  const moveWindow = useCanvasStore((s) => s.moveWindow);
  const toggleMaximizeWindow = useCanvasStore((s) => s.toggleMaximizeWindow);
  const stackWindow = useCanvasStore((s) => s.stackWindow);
  const unstackWindow = useCanvasStore((s) => s.unstackWindow);
  const activeWindowId = useCanvasStore((s) => {
    const scope = scopeKeyProp
      ? selectCanvasScopeByKey(s, scopeKeyProp)
      : selectCurrentCanvasScope(s);
    return scope.activeWindowId;
  });
  const scrollTrigger = useCanvasStore((s) => {
    const scope = scopeKeyProp
      ? selectCanvasScopeByKey(s, scopeKeyProp)
      : selectCurrentCanvasScope(s);
    return scope.scrollTrigger;
  });

  // Keybindings for terminal.toggle (Cmd+J)
  const EMPTY_KEYBINDINGS: ResolvedKeybindingsConfig = useMemo(() => [], []);
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const keybindings = serverConfigQuery.data?.keybindings ?? EMPTY_KEYBINDINGS;

  // Visible windows for the active workspace (used for top bar display)
  const visibleWindows = workspace?.windows.filter((w) => !w.minimized) ?? [];

  // -- Keyboard navigation ---------------------------------------------------
  useEffect(() => {
    // Only register keyboard handlers for the active scope to prevent
    // duplicate handling when multiple scopes are rendered simultaneously.
    if (!isActiveProp) return;

    const isEditableTarget = (target: EventTarget | null): boolean => {
      if (!(target instanceof HTMLElement)) {
        return false;
      }
      return (
        target.isContentEditable ||
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.tagName === "SELECT"
      );
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;

      // terminal.toggle (Cmd+J) — always open a new terminal window.
      // Must fire from anywhere (including chat textarea / terminal focus).
      const toggleCommand = resolveShortcutCommand(e, keybindings, {
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen: false,
        },
      });
      if (toggleCommand === "terminal.toggle") {
        e.preventDefault();
        e.stopPropagation();
        addWindow("terminal");
        return;
      }

      // ⌘W — close the active canvas window before the OS/app gets a chance to
      // close the entire window/tab.  Always prevent the default so the
      // browser never interprets Cmd+W as "close tab".
      if ((e.metaKey || e.ctrlKey) && e.key === "w") {
        e.preventDefault();
        e.stopPropagation();
        if (activeWindowId) {
          removeWindow(activeWindowId);
        }
        return;
      }

      // Fullscreen toggle — must fire even when focused inside an input/textarea.
      // Use Cmd+Shift+Enter (or Alt+Enter) to avoid conflicting with browser Cmd+F.
      if (
        ((e.altKey && e.key === "Enter" && !e.metaKey && !e.ctrlKey && !e.shiftKey) ||
          (e.metaKey && e.shiftKey && e.key === "Enter" && !e.altKey && !e.ctrlKey)) &&
        activeWindowId
      ) {
        e.preventDefault();
        toggleMaximizeWindow(activeWindowId);
        return;
      }

      // ⌘[ / ⌘] or Alt+[ / Alt+] or Ctrl+Tab — switch active window
      // Must fire even when focused inside an input/textarea (like fullscreen).
      if (
        (e.altKey && e.key === "]") ||
        (e.metaKey && e.key === "]") ||
        (e.altKey && e.key === "ArrowRight") ||
        (e.ctrlKey && e.key === "Tab" && !e.shiftKey)
      ) {
        e.preventDefault();
        focusNextWindow();
        return;
      }
      if (
        (e.altKey && e.key === "[") ||
        (e.metaKey && e.key === "[") ||
        (e.altKey && e.key === "ArrowLeft") ||
        (e.ctrlKey && e.key === "Tab" && e.shiftKey)
      ) {
        e.preventDefault();
        focusPrevWindow();
        return;
      }

      // Prefer Alt+Shift+Arrow for browser-safe reordering, but keep the old
      // Cmd+Ctrl+Arrow chord as an extra path in desktop environments.
      // Must fire even when focused inside an input/textarea (like fullscreen).
      if (
        ((e.altKey && e.shiftKey && !e.metaKey && !e.ctrlKey) ||
          (e.ctrlKey && e.metaKey && !e.altKey)) &&
        activeWindowId
      ) {
        if (e.key === "ArrowRight") {
          e.preventDefault();
          moveWindow(activeWindowId, "right");
          return;
        }
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          moveWindow(activeWindowId, "left");
          return;
        }
      }

      // Alt+Shift+↑ or Cmd+Ctrl+↑ — stack active window with its left neighbor.
      // Must fire even when focused inside an input/textarea.
      if (
        ((e.altKey && e.shiftKey && !e.metaKey && !e.ctrlKey) ||
          (e.ctrlKey && e.metaKey && !e.altKey)) &&
        e.key === "ArrowUp" &&
        activeWindowId
      ) {
        e.preventDefault();
        // Find the window to the left and stack with it
        const ws = workspace;
        if (ws) {
          const visible = ws.windows.filter((w) => !w.minimized);
          const idx = visible.findIndex((w) => w.id === activeWindowId);
          if (idx > 0) {
            stackWindow(activeWindowId, visible[idx - 1]!.id);
          }
        }
        return;
      }

      // Alt+Shift+↓ or Cmd+Ctrl+↓ — unstack active window.
      // Must fire even when focused inside an input/textarea.
      if (
        ((e.altKey && e.shiftKey && !e.metaKey && !e.ctrlKey) ||
          (e.ctrlKey && e.metaKey && !e.altKey)) &&
        e.key === "ArrowDown" &&
        activeWindowId
      ) {
        e.preventDefault();
        unstackWindow(activeWindowId);
        return;
      }

      if (isEditableTarget(e.target)) {
        return;
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    isActiveProp,
    addWindow,
    ensureTerminalWindow,
    removeWindow,
    focusNextWindow,
    focusPrevWindow,
    moveWindow,
    toggleMaximizeWindow,
    stackWindow,
    unstackWindow,
    activeWindowId,
    workspace,
    keybindings,
  ]);

  // -- Desktop menu action: canvas.toggleMaximize (Alt+Enter / Cmd+Shift+Enter)
  // Electron menu accelerators fire even when a <webview> has focus, so this
  // is the reliable path for the browser panel fullscreen toggle.
  useEffect(() => {
    if (!isActiveProp) return;
    const onMenuAction = window.desktopBridge?.onMenuAction;
    if (typeof onMenuAction !== "function") return;
    const unsubscribe = onMenuAction((action: string) => {
      if (action === "canvas.toggleMaximize" && activeWindowId) {
        toggleMaximizeWindow(activeWindowId);
      }
    });
    return unsubscribe;
  }, [isActiveProp, activeWindowId, toggleMaximizeWindow]);

  if (!workspace) {
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground/60">
        No workspace found
      </div>
    );
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      {/* Top bar */}
      <div
        className={cn(
          "flex shrink-0 items-center justify-between border-b border-border/30 px-3",
          isElectron ? "drag-region h-[52px]" : "h-[44px]",
          // When the sidebar is closed in Electron, add left padding so the
          // workspace header doesn't overlap the macOS traffic light buttons.
          isElectron && !sidebarOpen && "pl-[88px]",
        )}
      >
        <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground/50 select-none">
          <SidebarTrigger className="shrink-0" size="icon-xs" variant="outline" />
          <LayoutDashboardIcon className="size-3" />
          <span className="truncate">{activeProjectName ?? workspace.name}</span>
          <span className="ml-0.5 text-[10px] text-muted-foreground/30">
            {visibleWindows.length} window
            {visibleWindows.length !== 1 ? "s" : ""}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="hidden text-[10px] text-muted-foreground/30 select-none xl:inline">
            ⌘[ ] navigate · ⌃⌘ arrows reorder · ⇧⌘↵ fullscreen
          </span>
          <WorkspaceActions />
          <CanvasAddMenu />
        </div>
      </div>

      {/* Render ALL workspaces for this scope, hiding inactive ones with
          display:none so that terminal/browser instances stay mounted and
          preserve their state across workspace tab switches. */}
      {allWorkspaces.map((ws) => {
        const isActiveWs = ws.id === activeWorkspaceId;
        return (
          <div
            key={ws.id}
            className={isActiveWs ? "relative flex min-h-0 flex-1 flex-col" : undefined}
            style={isActiveWs ? undefined : { display: "none" }}
          >
            <WorkspaceScrollArea
              workspace={ws}
              cwd={cwd}
              {...(scopeKeyProp ? { scopeKey: scopeKeyProp } : {})}
              isActive={isActiveProp && isActiveWs}
              activeWindowId={activeWindowId}
              scrollTrigger={scrollTrigger}
              isDragging={isDragging}
              stackWindow={stackWindow}
            />
          </div>
        );
      })}

      {/* Resize visualizer HUD — shows dimensions during window resize */}
      {isActiveProp && (
        <ResizeHUD {...(scopeKeyProp ? { scopeKey: scopeKeyProp } : {})} />
      )}
    </div>
  );
}
