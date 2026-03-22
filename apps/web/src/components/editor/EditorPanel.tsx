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

// Re-export ensureChatWindow logic so the route doesn't duplicate it.
// The route previously called ensureChatWindow in its own effect, but that
// caused race conditions with the scope change. Now it's handled here.

const CanvasWorkspace = lazy(() =>
  import("./CanvasWorkspace").then((m) => ({ default: m.CanvasWorkspace })),
);

export default function EditorPanel(props: { mode?: EditorPanelMode }) {
  const mode = props.mode ?? "sidebar";
  const queryClient = useQueryClient();
  const openTabs = useEditorStore((s) => s.openTabs);
  const closeAllTabs = useEditorStore((s) => s.closeAllTabs);
  const setCanvasScope = useCanvasStore((s) => s.setCanvasScope);
  const ensureChatWindow = useCanvasStore((s) => s.ensureChatWindow);
  const previousCwdRef = useRef<string | null>(null);
  const routeThreadId = useParams({
    strict: false,
    select: (params) => (params.threadId ? ThreadId.makeUnsafe(params.threadId) : null),
  });

  const threadsHydrated = useStore((store) => store.threadsHydrated);
  const activeThread = useStore((store) =>
    routeThreadId ? store.threads.find((thread) => thread.id === routeThreadId) : undefined,
  );
  const draftThread = useComposerDraftStore((store) =>
    routeThreadId ? store.draftThreadsByThreadId[routeThreadId] : undefined,
  );
  const routeThreadExists = activeThread !== undefined || draftThread !== undefined;
  const activeProjectId = activeThread?.projectId ?? draftThread?.projectId ?? null;
  const activeProject = useStore((store) =>
    activeProjectId ? store.projects.find((project) => project.id === activeProjectId) : undefined,
  );
  const cwd = activeThread?.worktreePath ?? activeProject?.cwd ?? null;
  const canvasScopeKey =
    activeProjectId !== null ? `project:${activeProjectId}` : cwd ? `cwd:${cwd}` : null;

  // Set the canvas scope AND ensure the chat window exists in a single effect
  // so there's no race condition between scope changes and window creation.
  useEffect(() => {
    if (canvasScopeKey !== null) {
      setCanvasScope(canvasScopeKey);
    }

    // Only ensure a chat window after threads have hydrated and the thread exists
    if (routeThreadId && threadsHydrated && routeThreadExists && canvasScopeKey !== null) {
      ensureChatWindow(routeThreadId);
    }
  }, [
    canvasScopeKey,
    setCanvasScope,
    routeThreadId,
    threadsHydrated,
    routeThreadExists,
    ensureChatWindow,
  ]);

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
