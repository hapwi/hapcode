import { Suspense, lazy, useCallback, useEffect, useRef } from "react";
import { CodeIcon, DiffIcon, PanelLeftCloseIcon, PanelLeftOpenIcon } from "lucide-react";
import { ThreadId } from "@t3tools/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";

import { useEditorStore } from "./editorStore";
import { EditorPanelShell, type EditorPanelMode } from "./EditorPanelShell";
import { EditorTabStrip } from "./EditorTabStrip";
import { EditorFileTree } from "./EditorFileTree";
import { EditorCodeArea } from "./EditorCodeArea";
import { DiffPanelLoadingState } from "../DiffPanelShell";
import { DiffWorkerPoolProvider } from "../DiffWorkerPoolProvider";
import { Button } from "../ui/button";
import { useStore } from "~/store";
import { useComposerDraftStore } from "~/composerDraftStore";
import { useTheme } from "~/hooks/useTheme";
import { projectReadFileQueryOptions } from "~/lib/projectReactQuery";

const DiffPanel = lazy(() => import("../DiffPanel"));

export default function EditorPanel(props: { mode?: EditorPanelMode }) {
  const mode = props.mode ?? "sidebar";
  const queryClient = useQueryClient();
  const viewMode = useEditorStore((s) => s.viewMode);
  const setViewMode = useEditorStore((s) => s.setViewMode);
  const activeTabPath = useEditorStore((s) => s.activeTabPath);
  const openTabs = useEditorStore((s) => s.openTabs);
  const closeAllTabs = useEditorStore((s) => s.closeAllTabs);
  const fileTreeVisible = useEditorStore((s) => s.fileTreeVisible);
  const setFileTreeVisible = useEditorStore((s) => s.setFileTreeVisible);
  const { resolvedTheme } = useTheme();
  const previousCwdRef = useRef<string | null>(null);
  const routeThreadId = useParams({
    strict: false,
    select: (params) => (params.threadId ? ThreadId.makeUnsafe(params.threadId) : null),
  });

  const activeThread = useStore((store) =>
    routeThreadId ? store.threads.find((thread) => thread.id === routeThreadId) : undefined,
  );
  const draftThread = useComposerDraftStore((store) =>
    routeThreadId ? store.draftThreadsByThreadId[routeThreadId] : undefined,
  );
  const activeProjectId = activeThread?.projectId ?? draftThread?.projectId ?? null;
  const activeProject = useStore((store) =>
    activeProjectId ? store.projects.find((project) => project.id === activeProjectId) : undefined,
  );
  const cwd = activeThread?.worktreePath ?? activeProject?.cwd ?? null;

  const toggleFileTree = useCallback(() => {
    setFileTreeVisible(!fileTreeVisible);
  }, [fileTreeVisible, setFileTreeVisible]);

  useEffect(() => {
    if (previousCwdRef.current === null) {
      previousCwdRef.current = cwd;
      return;
    }
    if (previousCwdRef.current !== cwd) {
      closeAllTabs();
      previousCwdRef.current = cwd;
    }
  }, [closeAllTabs, cwd]);

  useEffect(() => {
    if (!cwd || openTabs.length === 0) return;

    openTabs.forEach((tab) => {
      void queryClient.prefetchQuery(
        projectReadFileQueryOptions({ cwd, relativePath: tab.relativePath }),
      );
    });
  }, [cwd, openTabs, queryClient]);

  const header = (
    <>
      <div className="flex min-w-0 flex-1 items-center gap-1">
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={toggleFileTree}
          aria-label={fileTreeVisible ? "Hide file tree" : "Show file tree"}
          className="shrink-0"
        >
          {fileTreeVisible ? (
            <PanelLeftCloseIcon className="size-3.5" />
          ) : (
            <PanelLeftOpenIcon className="size-3.5" />
          )}
        </Button>
        {viewMode === "editor" && <EditorTabStrip />}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          type="button"
          variant={viewMode === "editor" ? "default" : "ghost"}
          size="icon-xs"
          onClick={() => setViewMode("editor")}
          aria-label="Editor view"
        >
          <CodeIcon className="size-3.5" />
        </Button>
        <Button
          type="button"
          variant={viewMode === "diff" ? "default" : "ghost"}
          size="icon-xs"
          onClick={() => setViewMode("diff")}
          aria-label="Diff view"
        >
          <DiffIcon className="size-3.5" />
        </Button>
      </div>
    </>
  );

  if (viewMode === "diff") {
    return (
      <EditorPanelShell mode={mode} header={header}>
        <div className="flex min-h-0 flex-1 flex-col">
          <DiffWorkerPoolProvider>
            <Suspense fallback={<DiffPanelLoadingState label="Loading diff viewer..." />}>
              <DiffPanel mode={mode} />
            </Suspense>
          </DiffWorkerPoolProvider>
        </div>
      </EditorPanelShell>
    );
  }

  // Always show file tree when no tabs are open so the user can navigate
  const showFileTree = cwd && (fileTreeVisible || !activeTabPath);

  if (!cwd) {
    return (
      <EditorPanelShell mode={mode} header={header}>
        <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground/60">
          No project selected
        </div>
      </EditorPanelShell>
    );
  }

  return (
    <EditorPanelShell mode={mode} header={header}>
      <div className="flex min-h-0 flex-1">
        {showFileTree && (
          <EditorFileTree cwd={cwd} resolvedTheme={resolvedTheme === "dark" ? "dark" : "light"} />
        )}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {activeTabPath ? (
            <EditorCodeArea cwd={cwd} relativePath={activeTabPath} />
          ) : (
            !showFileTree && (
              <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground/60">
                Open a file from the tree or chat
              </div>
            )
          )}
        </div>
      </div>
    </EditorPanelShell>
  );
}
