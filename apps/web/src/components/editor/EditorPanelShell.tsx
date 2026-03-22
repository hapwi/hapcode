import type { ReactNode } from "react";

import { isElectron } from "~/env";
import { cn } from "~/lib/utils";
import { Skeleton } from "../ui/skeleton";

export type EditorPanelMode = "inline" | "sheet" | "sidebar";

function getEditorPanelHeaderRowClassName(mode: EditorPanelMode) {
  const shouldUseDragRegion = isElectron && mode !== "sheet";
  return cn(
    "flex items-center justify-between gap-2 px-2",
    shouldUseDragRegion ? "drag-region h-[52px] border-b border-border" : "h-10",
  );
}

export function EditorPanelShell(props: {
  mode: EditorPanelMode;
  header: ReactNode;
  children: ReactNode;
}) {
  const shouldUseDragRegion = isElectron && props.mode !== "sheet";

  return (
    <div
      className={cn(
        "flex h-full min-w-0 flex-col bg-background",
        props.mode === "inline"
          ? "w-[42vw] min-w-[360px] max-w-[560px] shrink-0 border-l border-border"
          : "w-full",
      )}
    >
      {shouldUseDragRegion ? (
        <div className={getEditorPanelHeaderRowClassName(props.mode)}>{props.header}</div>
      ) : (
        <div className="border-b border-border">
          <div className={getEditorPanelHeaderRowClassName(props.mode)}>{props.header}</div>
        </div>
      )}
      {props.children}
    </div>
  );
}

export function EditorPanelHeaderSkeleton() {
  return (
    <>
      <div className="flex min-w-0 flex-1 gap-1">
        <Skeleton className="h-7 w-20 rounded-md" />
        <Skeleton className="h-7 w-20 rounded-md" />
      </div>
      <div className="flex shrink-0 gap-1">
        <Skeleton className="size-7 rounded-md" />
        <Skeleton className="size-7 rounded-md" />
      </div>
    </>
  );
}

export function EditorPanelLoadingState() {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 text-muted-foreground">
      <Skeleton className="h-4 w-32 rounded-full" />
      <span className="text-xs">Loading editor...</span>
    </div>
  );
}
