import { type PointerEvent as ReactPointerEvent, type ReactNode, useCallback, useRef } from "react";
import {
  GlobeIcon,
  GitBranchIcon,
  GripVerticalIcon,
  MinusIcon,
  MaximizeIcon,
  MessageSquareIcon,
  Minimize2Icon,
  TerminalSquareIcon,
  CodeIcon,
  DiffIcon,
  XIcon,
} from "lucide-react";
import { cn } from "~/lib/utils";
import type { CanvasWindowState, CanvasWindowType } from "./canvasStore";
import { selectCurrentCanvasScope, useCanvasStore } from "./canvasStore";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIN_WIDTH = 280;
const MIN_HEIGHT = 200;

const TYPE_ICONS: Record<CanvasWindowType, typeof GlobeIcon> = {
  browser: GlobeIcon,
  terminal: TerminalSquareIcon,
  "code-editor": CodeIcon,
  diff: DiffIcon,
  chat: MessageSquareIcon,
  github: GitBranchIcon,
};

// ---------------------------------------------------------------------------
// CanvasWindow (niri-style — horizontal tiling, no overlap)
// ---------------------------------------------------------------------------

export function CanvasWindow(props: {
  window: CanvasWindowState;
  children: ReactNode;
  forceStretch?: boolean;
  headerActions?: ReactNode;
}) {
  const { window: win, children, forceStretch: _forceStretch, headerActions } = props;
  const updateWindow = useCanvasStore((s) => s.updateWindow);
  const removeWindow = useCanvasStore((s) => s.removeWindow);
  const minimizeWindow = useCanvasStore((s) => s.minimizeWindow);
  const toggleMaximizeWindow = useCanvasStore((s) => s.toggleMaximizeWindow);
  const setIsDragging = useCanvasStore((s) => s.setIsDragging);
  const setActiveWindow = useCanvasStore((s) => s.setActiveWindow);
  const isActive = useCanvasStore((s) => selectCurrentCanvasScope(s).activeWindowId === win.id);
  const isDragging = useCanvasStore((s) => s.isDragging);
  const defaultW = useCanvasStore((s) => s.defaultWindowWidth);
  const defaultH = useCanvasStore((s) => s.defaultWindowHeight);

  const isMaximized = win.maximized ?? false;
  const width = win.width ?? defaultW;
  // Height fills the row — only use explicit height if user has resized
  const hasCustomHeight = win.height !== null;
  const windowRef = useRef<HTMLDivElement>(null);

  // -- Right edge resize -----------------------------------------------------

  const rightResizeRef = useRef<{
    startX: number;
    origW: number;
  } | null>(null);

  const onRightResizeDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      // Use actual rendered width (may differ from store if width is null/dynamic)
      const actualWidth = windowRef.current?.clientWidth ?? width;
      rightResizeRef.current = { startX: e.clientX, origW: actualWidth };
      setIsDragging(true);
    },
    [width, setIsDragging],
  );

  const onRightResizeMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!rightResizeRef.current) return;
      const dx = e.clientX - rightResizeRef.current.startX;
      updateWindow(win.id, {
        width: Math.max(MIN_WIDTH, rightResizeRef.current.origW + dx),
      });
    },
    [win.id, updateWindow],
  );

  const onRightResizeUp = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!rightResizeRef.current) return;
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
      rightResizeRef.current = null;
      setIsDragging(false);
    },
    [setIsDragging],
  );

  // -- Bottom edge resize ----------------------------------------------------

  const bottomResizeRef = useRef<{
    startY: number;
    origH: number;
  } | null>(null);

  const onBottomResizeDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      bottomResizeRef.current = {
        startY: e.clientY,
        origH: win.height ?? defaultH,
      };
      setIsDragging(true);
    },
    [win.height, defaultH, setIsDragging],
  );

  const onBottomResizeMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!bottomResizeRef.current) return;
      const dy = e.clientY - bottomResizeRef.current.startY;
      updateWindow(win.id, {
        height: Math.max(MIN_HEIGHT, bottomResizeRef.current.origH + dy),
      });
    },
    [win.id, updateWindow],
  );

  const onBottomResizeUp = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!bottomResizeRef.current) return;
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
      bottomResizeRef.current = null;
      setIsDragging(false);
    },
    [setIsDragging],
  );

  // -- Corner resize (both width + height) ------------------------------------

  const cornerResizeRef = useRef<{
    startX: number;
    startY: number;
    origW: number;
    origH: number;
  } | null>(null);

  const onCornerResizeDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      const actualWidth = windowRef.current?.clientWidth ?? width;
      cornerResizeRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        origW: actualWidth,
        origH: win.height ?? defaultH,
      };
      setIsDragging(true);
    },
    [width, win.height, defaultH, setIsDragging],
  );

  const onCornerResizeMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!cornerResizeRef.current) return;
      const dx = e.clientX - cornerResizeRef.current.startX;
      const dy = e.clientY - cornerResizeRef.current.startY;
      updateWindow(win.id, {
        width: Math.max(MIN_WIDTH, cornerResizeRef.current.origW + dx),
        height: Math.max(MIN_HEIGHT, cornerResizeRef.current.origH + dy),
      });
    },
    [win.id, updateWindow],
  );

  const onCornerResizeUp = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!cornerResizeRef.current) return;
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
      cornerResizeRef.current = null;
      setIsDragging(false);
    },
    [setIsDragging],
  );

  // -- Title bar drag (for stacking) ------------------------------------------

  const titleDragRef = useRef<{
    startX: number;
    startY: number;
    dragging: boolean;
  } | null>(null);

  const onTitlePointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    // Only left button, and not on child buttons
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button")) return;
    titleDragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      dragging: false,
    };
  }, []);

  const onTitlePointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const ref = titleDragRef.current;
      if (!ref) return;
      const dx = e.clientX - ref.startX;
      const dy = e.clientY - ref.startY;
      // Start drag after 5px movement
      if (!ref.dragging && Math.abs(dx) + Math.abs(dy) > 5) {
        ref.dragging = true;
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        setIsDragging(true);
      }
      if (ref.dragging) {
        // Dispatch custom event so workspace can show drop indicators
        window.dispatchEvent(
          new CustomEvent("canvas-window-drag", {
            detail: { windowId: win.id, clientX: e.clientX, clientY: e.clientY },
          }),
        );
      }
    },
    [win.id, setIsDragging],
  );

  const onTitlePointerUp = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const ref = titleDragRef.current;
      if (!ref) return;
      if (ref.dragging) {
        (e.target as HTMLElement).releasePointerCapture(e.pointerId);
        // Dispatch drop event
        window.dispatchEvent(
          new CustomEvent("canvas-window-drop", {
            detail: { windowId: win.id, clientX: e.clientX, clientY: e.clientY },
          }),
        );
        setIsDragging(false);
      }
      titleDragRef.current = null;
    },
    [win.id, setIsDragging],
  );

  if (win.minimized) return null;

  const Icon = TYPE_ICONS[win.type];

  return (
    <div
      ref={windowRef}
      data-canvas-window-id={win.id}
      className={cn(
        "relative flex flex-col overflow-hidden rounded-lg border bg-card shadow-lg",
        // Only animate border/ring changes — disable ALL transitions during drag/resize
        // to prevent sluggish feel when resizing
        isDragging ? "transition-none" : "transition-[border-color,box-shadow] duration-150",
        isActive ? "border-blue-500/60 ring-1 ring-blue-500/30" : "border-border/60",
        "w-full",
        isMaximized ? "h-full" : !hasCustomHeight ? "flex-1 min-h-0" : "",
      )}
      style={
        isMaximized
          ? {}
          : {
              ...(hasCustomHeight ? { height: win.height!, maxHeight: "100%" } : {}),
              minHeight: MIN_HEIGHT,
            }
      }
      onPointerDown={() => setActiveWindow(win.id)}
    >
      {/* Title bar — drag handle for stacking/reorder */}
      <div
        className="flex h-8 shrink-0 items-center gap-1.5 border-b border-border/40 bg-muted/50 px-2 select-none cursor-grab active:cursor-grabbing"
        onPointerDown={onTitlePointerDown}
        onPointerMove={onTitlePointerMove}
        onPointerUp={onTitlePointerUp}
      >
        <Icon className="size-3 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-muted-foreground">
          {win.title}
        </span>
        {headerActions}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            minimizeWindow(win.id);
          }}
          className="flex size-4 items-center justify-center rounded text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
          aria-label="Minimize"
        >
          <MinusIcon className="size-2.5" />
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            toggleMaximizeWindow(win.id);
          }}
          className={cn(
            "flex size-4 items-center justify-center rounded transition-colors hover:bg-accent hover:text-foreground",
            isMaximized ? "text-blue-400" : "text-muted-foreground/60",
          )}
          aria-label={isMaximized ? "Restore size" : "Maximize"}
          title={isMaximized ? "Restore size" : "Maximize"}
        >
          {isMaximized ? (
            <Minimize2Icon className="size-2.5" />
          ) : (
            <MaximizeIcon className="size-2.5" />
          )}
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            removeWindow(win.id);
          }}
          className="flex size-4 items-center justify-center rounded text-muted-foreground/60 transition-colors hover:bg-destructive/20 hover:text-destructive"
          aria-label="Close"
        >
          <XIcon className="size-2.5" />
        </button>
      </div>

      {/* Content */}
      <div className="relative min-h-0 flex-1 overflow-hidden">{children}</div>

      {/* Resize handles — hidden when maximized */}
      {!isMaximized && (
        <>
          {/* Right edge resize handle */}
          <div
            className="absolute right-0 top-0 h-full w-1.5 cursor-e-resize"
            onPointerDown={onRightResizeDown}
            onPointerMove={onRightResizeMove}
            onPointerUp={onRightResizeUp}
          />
          {/* Bottom edge resize handle */}
          <div
            className="absolute bottom-0 left-0 h-1.5 w-full cursor-s-resize"
            onPointerDown={onBottomResizeDown}
            onPointerMove={onBottomResizeMove}
            onPointerUp={onBottomResizeUp}
          />
          {/* Bottom-right corner resize handle */}
          <div
            className="absolute bottom-0 right-0 size-4 cursor-se-resize"
            onPointerDown={onCornerResizeDown}
            onPointerMove={onCornerResizeMove}
            onPointerUp={onCornerResizeUp}
          >
            <GripVerticalIcon className="absolute bottom-0.5 right-0.5 size-2.5 rotate-[-45deg] text-muted-foreground/30" />
          </div>
        </>
      )}
    </div>
  );
}
