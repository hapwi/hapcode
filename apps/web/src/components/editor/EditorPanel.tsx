import { Suspense, lazy, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { type ProjectId, ThreadId } from "@t3tools/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";

import { useEditorStore } from "./editorStore";
import { useAllScopeKeys, useCanvasStore } from "./canvasStore";
import { EditorPanelShell, type EditorPanelMode } from "./EditorPanelShell";
import { ScopeVisibilityProvider } from "./ScopeVisibilityContext";
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

  // Safety: if the persisted currentScopeKey doesn't match any entry in
  // allScopeKeys, every scope div would get `display: none` → blank screen.
  // Reset to the first available scope before the browser paints.
  useLayoutEffect(() => {
    if (allScopeKeys.length > 0 && !allScopeKeys.includes(currentScopeKey)) {
      setCanvasScope(allScopeKeys[0]!);
    }
  }, [allScopeKeys, currentScopeKey, setCanvasScope]);

  const projects = useStore((s) => s.projects);

  // Build a cwd map for each scope.  We persist each scope's last-known cwd
  // in a ref so that switching away from a scope does NOT recompute its cwd
  // (which would lose worktree paths and cause terminal sessions to be torn
  // down and recreated).  Only the *active* scope's cwd is updated; inactive
  // scopes keep whatever cwd they had when they were last active.
  const scopeCwdMapRef = useRef<Record<string, string | null>>({});

  // Update only the active scope's cwd entry when it changes.
  // Guard: only write when `canvasScopeKey` matches `currentScopeKey`.
  // During scope transitions, `cwd` is derived from the *incoming* thread/project
  // and updates immediately, while `currentScopeKey` still points at the
  // *outgoing* scope (the zustand update happens in a separate effect).
  // Without this guard, the outgoing scope's cwd gets overwritten with the
  // incoming scope's value, which causes the old scope's terminal to tear down
  // and attempt to reopen with the wrong cwd — resulting in timeout errors.
  useEffect(() => {
    if (currentScopeKey && cwd != null && currentScopeKey === canvasScopeKey) {
      scopeCwdMapRef.current = {
        ...scopeCwdMapRef.current,
        [currentScopeKey]: cwd,
      };
    }
  }, [currentScopeKey, cwd, canvasScopeKey]);

  const scopeCwdMap = useMemo(() => {
    const map: Record<string, string | null> = {};
    for (const key of allScopeKeys) {
      // Use the persisted cwd if we have one (preserves worktree paths for
      // inactive scopes), otherwise fall back to resolving from the project.
      map[key] = scopeCwdMapRef.current[key] ?? resolveCwdForScopeKey(key, projects);
    }
    return map;
    // currentScopeKey, cwd, and canvasScopeKey are included so the memo
    // recomputes after the ref is updated by the effect above.  The ref is
    // only written when canvasScopeKey === currentScopeKey, so we need both
    // in the dep array to catch the moment they converge.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allScopeKeys, currentScopeKey, cwd, canvasScopeKey, projects]);

  return (
    <EditorPanelShell mode={mode}>
      {allScopeKeys.map((key) => {
        const isActive = key === currentScopeKey;
        return (
          <ScopeVisibilityProvider key={key} value={isActive}>
            <div
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
          </ScopeVisibilityProvider>
        );
      })}
    </EditorPanelShell>
  );
}
