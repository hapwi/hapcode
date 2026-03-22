import { Suspense, lazy, useEffect, useRef } from "react";
import { ThreadId } from "@t3tools/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";

import { useEditorStore } from "./editorStore";
import { useCanvasStore } from "./canvasStore";
import { EditorPanelShell, type EditorPanelMode } from "./EditorPanelShell";
import { useStore } from "~/store";
import { useComposerDraftStore } from "~/composerDraftStore";
import { projectReadFileQueryOptions } from "~/lib/projectReactQuery";

const CanvasWorkspace = lazy(() =>
  import("./CanvasWorkspace").then((m) => ({ default: m.CanvasWorkspace })),
);

export default function EditorPanel(props: { mode?: EditorPanelMode }) {
  const mode = props.mode ?? "sidebar";
  const queryClient = useQueryClient();
  const openTabs = useEditorStore((s) => s.openTabs);
  const closeAllTabs = useEditorStore((s) => s.closeAllTabs);
  const setCanvasScope = useCanvasStore((s) => s.setCanvasScope);
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
  const canvasScopeKey =
    activeProjectId !== null ? `project:${activeProjectId}` : cwd ? `cwd:${cwd}` : null;

  // Only update the canvas scope when we have a definitive scope key.
  // When canvasScopeKey is null (e.g. navigating to index route with no active
  // thread), keep the current scope so existing windows remain visible.
  useEffect(() => {
    if (canvasScopeKey !== null) {
      setCanvasScope(canvasScopeKey);
    }
  }, [canvasScopeKey, setCanvasScope]);

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

  return (
    <EditorPanelShell mode={mode}>
      <Suspense
        fallback={
          <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground/60">
            Loading workspace...
          </div>
        }
      >
        <CanvasWorkspace cwd={cwd} />
      </Suspense>
    </EditorPanelShell>
  );
}
