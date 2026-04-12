import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CodeIcon,
  DiffIcon,
  GitBranchIcon,
  GlobeIcon,
  PlusIcon,
  TerminalSquareIcon,
} from "lucide-react";
import { useAppSettings } from "../../appSettings";
import { Button } from "../ui/button";
import { useCanvasStore, type CanvasWindowType } from "./canvasStore";

const WINDOW_TYPES: Array<{
  type: CanvasWindowType;
  label: string;
  icon: typeof GlobeIcon;
  hotkey: string;
  key: string;
}> = [
  { type: "browser", label: "Browser", icon: GlobeIcon, hotkey: "⌘G", key: "g" },
  { type: "terminal", label: "Terminal", icon: TerminalSquareIcon, hotkey: "⌘J", key: "j" },
  { type: "vscode", label: "VS Code", icon: CodeIcon, hotkey: "⌘E", key: "e" },
  { type: "diff", label: "Diff Viewer", icon: DiffIcon, hotkey: "⌘D", key: "d" },
  { type: "github", label: "GitHub", icon: GitBranchIcon, hotkey: "⌘H", key: "h" },
];

export function CanvasAddMenu() {
  const [open, setOpen] = useState(false);
  const { settings } = useAppSettings();
  const addWindow = useCanvasStore((s) => s.addWindow);
  const ensureBrowserWindow = useCanvasStore((s) => s.ensureBrowserWindow);
  const ensureGitHubWindow = useCanvasStore((s) => s.ensureGitHubWindow);
  const ensureVsCodeWindow = useCanvasStore((s) => s.ensureVsCodeWindow);

  const visibleWindowTypes = useMemo(
    () =>
      settings.enableBrowser ? WINDOW_TYPES : WINDOW_TYPES.filter((w) => w.type !== "browser"),
    [settings.enableBrowser],
  );

  const openWindow = useCallback(
    (type: CanvasWindowType) => {
      if (type === "browser") {
        ensureBrowserWindow();
      } else if (type === "github") {
        ensureGitHubWindow();
      } else if (type === "vscode") {
        ensureVsCodeWindow();
      } else {
        addWindow(type);
      }
    },
    [addWindow, ensureBrowserWindow, ensureGitHubWindow, ensureVsCodeWindow],
  );

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (!e.metaKey && !e.ctrlKey) return;
      const key = e.key.toLowerCase();
      if (e.shiftKey) return;
      const match = visibleWindowTypes.find((w) => w.key === key);
      if (match) {
        e.preventDefault();
        openWindow(match.type);
        setOpen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [openWindow, visibleWindowTypes]);

  return (
    <div className="relative flex items-center">
      <Button
        type="button"
        variant="outline"
        size="icon-xs"
        onClick={() => setOpen(!open)}
        title="Add window"
      >
        <PlusIcon className="size-3.5" />
      </Button>

      {open && (
        <>
          {/* Backdrop to close menu */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-50 mt-1 w-52 overflow-hidden rounded-lg border border-border bg-popover shadow-lg">
            <div className="py-1">
              {visibleWindowTypes.map((item) => {
                const Icon = item.icon;
                return (
                  <button
                    key={item.type}
                    type="button"
                    onClick={() => {
                      openWindow(item.type);
                      setOpen(false);
                    }}
                    className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-foreground transition-colors hover:bg-accent"
                  >
                    <Icon className="size-4 shrink-0 text-muted-foreground" />
                    <span className="flex-1">{item.label}</span>
                    <span className="text-xs text-muted-foreground">{item.hotkey}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
