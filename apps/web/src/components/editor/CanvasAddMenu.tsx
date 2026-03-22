import { useState } from "react";
import { CodeIcon, DiffIcon, GlobeIcon, PlusIcon, TerminalSquareIcon } from "lucide-react";
import { Button } from "../ui/button";
import { useCanvasStore, type CanvasWindowType } from "./canvasStore";

const WINDOW_TYPES: Array<{
  type: CanvasWindowType;
  label: string;
  icon: typeof GlobeIcon;
}> = [
  { type: "browser", label: "Browser", icon: GlobeIcon },
  { type: "terminal", label: "Terminal", icon: TerminalSquareIcon },
  { type: "code-editor", label: "Code Editor", icon: CodeIcon },
  { type: "diff", label: "Diff Viewer", icon: DiffIcon },
];

export function CanvasAddMenu() {
  const [open, setOpen] = useState(false);
  const addWindow = useCanvasStore((s) => s.addWindow);

  return (
    <div className="relative">
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        onClick={() => setOpen(!open)}
        className="size-5 text-muted-foreground/60 hover:text-foreground"
        title="Add window"
      >
        <PlusIcon className="size-3.5" />
      </Button>

      {open && (
        <>
          {/* Backdrop to close menu */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-50 mt-1 w-44 overflow-hidden rounded-lg border border-border bg-popover shadow-lg">
            <div className="py-1">
              {WINDOW_TYPES.map((item) => {
                const Icon = item.icon;
                return (
                  <button
                    key={item.type}
                    type="button"
                    onClick={() => {
                      addWindow(item.type);
                      setOpen(false);
                    }}
                    className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-foreground transition-colors hover:bg-accent"
                  >
                    <Icon className="size-4 text-muted-foreground" />
                    {item.label}
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
