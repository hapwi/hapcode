import { Suspense, lazy, useEffect, useMemo, useRef } from "react";
import { type ProjectId, ThreadId } from "@t3tools/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";

import { useEditorStore } from "./editorStore";
import { useAllScopeKeys, useCanvasStore } from "./canvasStore";
import { EditorPanelShell, type EditorPanelMode } from "./EditorPanelShell";
import { useStore } from "~/store";
import { useComposerDraftStore } from "~/composerDraftStore";
import { projectReadFileQueryOptions } from "~/lib/projectReactQuery";

/**
 * Extract a ProjectId from the canvas scope key.
 * Scope keys have the format "project:<projectId>" or "cwd:<path>".
 */
function projectIdFromScopeKey(scopeKey: string): ProjectId | null {
  if (scopeKey.startsWith("project:")) {
    return scopeKey.slice("project:".length) as ProjectId;
  }
  return null;
}

/**
 * Extract a cwd path from the canvas scope key.
 */
function cwdFromScopeKey(scopeKey: string): string | null {
  if (scopeKey.startsWith("cwd:")) {
    return scopeKey.slice("cwd:".length);
  }
  return null;
}

/**
 * Resolve a cwd for any scope key by looking up the project or extracting
 * the path embedded in the key. Returns null for the default scope.
 */
function resolveCwdForScopeKey(
  scopeKey: string,
  projects: { id: string; cwd: string }[],
): string | null {
  const pid = projectIdFromScopeKey(scopeKey);
  if (pid) {
    return projects.find((p) => p.id === pid)?.cwd ?? null;
  }
  return cwdFromScopeKey(scopeKey);
}

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

  // Resolve cwd from thread/project first, then fall back to canvas scope key.
  // This ensures workspace windows (like terminals) get the project cwd even
  // when no thread is active (e.g. user navigated away from a chat).
  const currentScopeKey = useCanvasStore((s) => s.currentScopeKey);
  const scopeProjectId = projectIdFromScopeKey(currentScopeKey);
  const scopeProject = useStore((store) =>
    scopeProjectId ? store.projects.find((project) => project.id === scopeProjectId) : undefined,
  );
  const scopeCwd = scopeProject?.cwd ?? cwdFromScopeKey(currentScopeKey);

  const cwd = activeThread?.worktreePath ?? activeProject?.cwd ?? scopeCwd ?? null;
  // When there is an active thread, use its project scope.  When there is no
  // route thread (e.g. after closing a draft chat window which redirects to "/"),
  // preserve the existing project-based scope so that other open chat windows
  // in that scope remain visible instead of being hidden by a scope switch.
  const canvasScopeKey =
    activeProjectId !== null
      ? `project:${activeProjectId}`
      : scopeProjectId !== null
        ? `project:${scopeProjectId}`
        : cwd
          ? `cwd:${cwd}`
          : null;

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

  // ---------------------------------------------------------------------------
  // Render ALL scopes so that terminal/browser windows stay alive across
  // project navigation. Inactive scopes are hidden with `display: none` which
  // keeps the React tree (and xterm / webview instances) mounted.
  // ---------------------------------------------------------------------------

  const allScopeKeys = useAllScopeKeys();
  const projects = useStore((s) => s.projects);

  // Build a cwd map for each scope.  The active scope uses the full route-aware
  // cwd (which may include worktree paths), other scopes use project/path cwd.
  const scopeCwdMap = useMemo(() => {
    const map: Record<string, string | null> = {};
    for (const key of allScopeKeys) {
      if (key === currentScopeKey) {
        map[key] = cwd;
      } else {
        map[key] = resolveCwdForScopeKey(key, projects);
      }
    }
    return map;
  }, [allScopeKeys, currentScopeKey, cwd, projects]);

  return (
    <EditorPanelShell mode={mode}>
      {allScopeKeys.map((key) => {
        const isActive = key === currentScopeKey;
        return (
          <div
            key={key}
            className={isActive ? "flex min-h-0 flex-1 flex-col" : undefined}
            style={isActive ? undefined : { display: "none" }}
          >
            <Suspense
              fallback={
                <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground/60">
                  Loading workspace...
                </div>
              }
            >
              <CanvasWorkspace cwd={scopeCwdMap[key] ?? null} scopeKey={key} isActive={isActive} />
            </Suspense>
          </div>
        );
      })}
    </EditorPanelShell>
  );
}
