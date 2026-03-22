import { XIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useEditorStore } from "./editorStore";
import { VscodeEntryIcon } from "../chat/VscodeEntryIcon";
import { useTheme } from "~/hooks/useTheme";
import { cn } from "~/lib/utils";

function fileBasename(relativePath: string): string {
  const idx = relativePath.lastIndexOf("/");
  return idx === -1 ? relativePath : relativePath.slice(idx + 1);
}

export function EditorTabStrip() {
  const openTabs = useEditorStore((s) => s.openTabs);
  const activeTabPath = useEditorStore((s) => s.activeTabPath);
  const setActiveTab = useEditorStore((s) => s.setActiveTab);
  const closeTab = useEditorStore((s) => s.closeTab);
  const { resolvedTheme } = useTheme();
  const scrollRef = useRef<HTMLDivElement>(null);
  const dragStateRef = useRef<{
    startX: number;
    startScrollLeft: number;
  } | null>(null);
  const suppressClickRef = useRef(false);
  const [dragging, setDragging] = useState(false);

  const handleClose = useCallback(
    (e: React.MouseEvent, path: string) => {
      e.stopPropagation();
      closeTab(path);
    },
    [closeTab],
  );

  const handleAuxClick = useCallback(
    (e: React.MouseEvent, path: string) => {
      // Middle-click to close
      if (e.button === 1) {
        e.preventDefault();
        closeTab(path);
      }
    },
    [closeTab],
  );

  const handleMouseDown = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest("[data-tab-close='true']")) return;
    dragStateRef.current = {
      startScrollLeft: event.currentTarget.scrollLeft,
      startX: event.clientX,
    };
    suppressClickRef.current = false;
  }, []);

  useEffect(() => {
    const handleMouseMove = (event: MouseEvent) => {
      const dragState = dragStateRef.current;
      const container = scrollRef.current;
      if (!dragState || !container) return;

      const deltaX = event.clientX - dragState.startX;
      if (!dragging && Math.abs(deltaX) > 3) {
        suppressClickRef.current = true;
        setDragging(true);
      }

      if (Math.abs(deltaX) <= 3) return;
      container.scrollLeft = dragState.startScrollLeft - deltaX;
    };

    const handleMouseUp = () => {
      if (!dragStateRef.current) return;
      dragStateRef.current = null;
      window.requestAnimationFrame(() => {
        setDragging(false);
      });
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [dragging]);

  const handleClickCapture = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (!suppressClickRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    suppressClickRef.current = false;
  }, []);

  useEffect(() => {
    const container = scrollRef.current;
    if (!container || !activeTabPath) return;
    const activeTab = container.querySelector<HTMLElement>(
      `[data-tab-path="${CSS.escape(activeTabPath)}"]`,
    );
    activeTab?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeTabPath]);

  if (openTabs.length === 0) {
    return null;
  }

  return (
    <div
      ref={scrollRef}
      className={cn(
        "flex min-w-0 flex-1 select-none items-center gap-0 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        dragging ? "cursor-grabbing" : "cursor-grab",
      )}
      onClickCapture={handleClickCapture}
      onMouseDown={handleMouseDown}
    >
      {openTabs.map((tab) => {
        const isActive = tab.relativePath === activeTabPath;
        const name = fileBasename(tab.relativePath);
        return (
          <div
            key={tab.relativePath}
            data-tab-path={tab.relativePath}
            className={cn(
              "group flex shrink-0 items-center border-b-2 pr-1 text-[11px] transition-colors",
              isActive
                ? "border-primary bg-accent/40 text-foreground"
                : "border-transparent text-muted-foreground hover:bg-accent/20 hover:text-foreground",
            )}
            onAuxClick={(e) => handleAuxClick(e, tab.relativePath)}
            title={tab.relativePath}
          >
            <button
              type="button"
              data-tab-button="true"
              className="flex min-w-0 items-center gap-1.5 px-2.5 py-1.5 text-left"
              onClick={() => setActiveTab(tab.relativePath)}
            >
              <VscodeEntryIcon
                pathValue={tab.relativePath}
                kind="file"
                theme={resolvedTheme === "dark" ? "dark" : "light"}
                className="size-3.5"
              />
              <span className="max-w-[120px] truncate">{name}</span>
            </button>
            <button
              type="button"
              data-tab-close="true"
              aria-label={`Close ${name}`}
              className={cn(
                "ml-0.5 shrink-0 rounded-sm p-0.5 opacity-60 hover:bg-muted hover:opacity-100",
                isActive && "opacity-100",
              )}
              onClick={(e) => handleClose(e, tab.relativePath)}
            >
              <XIcon className="size-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
