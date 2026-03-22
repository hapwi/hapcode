import { useEffect, useState } from "react";
import {
  CodeIcon,
  DiffIcon,
  GitBranchIcon,
  GlobeIcon,
  PlusIcon,
  TerminalSquareIcon,
} from "lucide-react";
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
  { type: "code-editor", label: "Code Editor", icon: CodeIcon, hotkey: "⌘E", key: "e" },
  { type: "diff", label: "Diff Viewer", icon: DiffIcon, hotkey: "⌘D", key: "d" },
  { type: "github", label: "GitHub", icon: GitBranchIcon, hotkey: "⌘H", key: "h" },
];

export function CanvasAddMenu() {
  const [open, setOpen] = useState(false);
  const addWindow = useCanvasStore((s) => s.addWindow);
  const ensureGitHubWindow = useCanvasStore((s) => s.ensureGitHubWindow);

  const openWindow = (type: CanvasWindowType) => {
    if (type === "github") {
      ensureGitHubWindow();
    } else {
      addWindow(type);
    }
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!e.metaKey && !e.ctrlKey) return;
      const match = WINDOW_TYPES.find((w) => w.key === e.key.toLowerCase());
      if (match) {
        e.preventDefault();
        openWindow(match.type);
        setOpen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [addWindow, ensureGitHubWindow]);

  return (
    <div className="relative">
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
              {WINDOW_TYPES.map((item) => {
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
