import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { createDebouncedStorage, createMemoryStorage } from "~/lib/storage";

export const CANVAS_STORAGE_KEY = "t3code:canvas-state:v1";
const CANVAS_PERSIST_DEBOUNCE_MS = 500;

const canvasDebouncedStorage = createDebouncedStorage(
  typeof localStorage !== "undefined" ? localStorage : createMemoryStorage(),
  CANVAS_PERSIST_DEBOUNCE_MS,
);

declare global {
  interface Window {
    __t3codeCanvasBeforeUnloadRegistered__?: boolean;
  }
}

if (typeof window !== "undefined" && !window.__t3codeCanvasBeforeUnloadRegistered__) {
  window.__t3codeCanvasBeforeUnloadRegistered__ = true;
  window.addEventListener("beforeunload", () => {
    canvasDebouncedStorage.flush();
  });
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CanvasWindowType = "browser" | "terminal" | "code-editor" | "diff" | "chat" | "github";

export interface CanvasWindowState {
  id: string;
  type: CanvasWindowType;
  title: string;
  /** User-overridden width (null = use default) */
  width: number | null;
  /** User-overridden height (null = use default) */
  height: number | null;
  minimized: boolean;
  maximized: boolean;
  /** Column grouping — windows with the same columnGroup are stacked vertically.
   *  When undefined, the window is in its own column. */
  columnGroup?: string;
  // Type-specific payload
  browserUrl?: string;
  filePath?: string;
  terminalSessionId?: string;
  threadId?: string;
}

export interface CanvasWorkspace {
  id: string;
  name: string;
  windows: CanvasWindowState[];
}

interface CanvasScopeState {
  workspaces: CanvasWorkspace[];
  activeWorkspaceId: string;
  activeWindowId: string | null;
  /** Monotonic counter bumped to force a scroll-into-view of the active window. */
  scrollTrigger: number;
}

interface CanvasState {
  scopes: Record<string, CanvasScopeState>;
  currentScopeKey: string;
  isDragging: boolean;
  /** Default window size (shared across all types) */
  defaultWindowWidth: number;
  defaultWindowHeight: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_WINDOW_WIDTH = 700;
const DEFAULT_WINDOW_HEIGHT = 500;

/** Per-type default widths. Empty = use null (dynamic sizing at render time). */
const DEFAULT_TYPE_WIDTHS: Partial<Record<CanvasWindowType, number>> = {};

const DEFAULT_TITLES: Record<CanvasWindowType, string> = {
  browser: "Browser",
  terminal: "Terminal",
  "code-editor": "Code Editor",
  diff: "Diff",
  chat: "Chat",
  github: "GitHub",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let idCounter = 0;
function generateId(): string {
  return `cw-${Date.now()}-${++idCounter}`;
}

function generateWorkspaceId(): string {
  return `ws-${Date.now()}-${++idCounter}`;
}

const DEFAULT_SCOPE_KEY = "__default__";

function createInitialCanvasScopeState(): CanvasScopeState {
  return {
    workspaces: [
      {
        id: defaultWorkspaceId,
        name: "Workspace 1",
        windows: [],
      },
    ],
    activeWorkspaceId: defaultWorkspaceId,
    activeWindowId: null,
    scrollTrigger: 0,
  };
}

function getScopeState(state: Pick<CanvasState, "scopes" | "currentScopeKey">): CanvasScopeState {
  return state.scopes[state.currentScopeKey] ?? createInitialCanvasScopeState();
}

export function selectCurrentCanvasScope(
  state: Pick<CanvasState, "scopes" | "currentScopeKey">,
): CanvasScopeState {
  return getScopeState(state);
}

function updateCurrentScope(
  state: CanvasState,
  updater: (scope: CanvasScopeState) => CanvasScopeState,
): Pick<CanvasState, "scopes"> {
  const currentScope = getScopeState(state);
  return {
    scopes: {
      ...state.scopes,
      [state.currentScopeKey]: updater(currentScope),
    },
  };
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

interface CanvasActions {
  setCanvasScope: (scopeKey: string | null | undefined) => void;

  // Workspace actions
  addWorkspace: () => string;
  removeWorkspace: (id: string) => void;
  setActiveWorkspace: (id: string) => void;
  renameWorkspace: (id: string, name: string) => void;

  // Window actions
  addWindow: (type: CanvasWindowType, initialProps?: Partial<CanvasWindowState>) => string;
  removeWindow: (windowId: string) => void;
  updateWindow: (windowId: string, patch: Partial<CanvasWindowState>) => void;
  minimizeWindow: (windowId: string) => void;
  restoreWindow: (windowId: string) => void;
  toggleMaximizeWindow: (windowId: string) => void;
  moveWindow: (windowId: string, direction: "left" | "right") => void;
  reorderWindow: (windowId: string, toIndex: number) => void;
  setActiveWindow: (windowId: string | null) => void;
  focusNextWindow: () => void;
  focusPrevWindow: () => void;

  // Chat window management
  /** Finds an existing chat window for the given threadId or creates one.
   *  Returns the window id. Activates the window. */
  ensureChatWindow: (threadId: string) => string;

  // GitHub window management
  /** Finds an existing GitHub window or creates one.
   *  Returns the window id. Activates the window. */
  ensureGitHubWindow: () => string;

  // Column stacking
  stackWindow: (windowId: string, targetWindowId: string) => void;
  unstackWindow: (windowId: string) => void;

  // Drag state (for webview overlay protection)
  setIsDragging: (dragging: boolean) => void;
}

type CanvasStore = CanvasState & CanvasActions;

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

const defaultWorkspaceId = "ws-default";

const initialState: CanvasState = {
  scopes: {
    [DEFAULT_SCOPE_KEY]: createInitialCanvasScopeState(),
  },
  currentScopeKey: DEFAULT_SCOPE_KEY,
  isDragging: false,
  defaultWindowWidth: DEFAULT_WINDOW_WIDTH,
  defaultWindowHeight: DEFAULT_WINDOW_HEIGHT,
};

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useCanvasStore = create<CanvasStore>()(
  persist(
    (set, get) => ({
      ...initialState,

      setCanvasScope: (scopeKey) => {
        const normalizedScopeKey = scopeKey?.trim() || DEFAULT_SCOPE_KEY;
        const state = get();
        if (
          state.currentScopeKey === normalizedScopeKey &&
          state.scopes[normalizedScopeKey] !== undefined
        ) {
          return;
        }

        set({
          currentScopeKey: normalizedScopeKey,
          scopes: state.scopes[normalizedScopeKey]
            ? state.scopes
            : {
                ...state.scopes,
                [normalizedScopeKey]: createInitialCanvasScopeState(),
              },
        });
      },

      // -- Workspace actions --------------------------------------------------

      addWorkspace: () => {
        const id = generateWorkspaceId();
        const scope = getScopeState(get());
        const { workspaces } = scope;
        const name = `Workspace ${workspaces.length + 1}`;
        set((state) =>
          updateCurrentScope(state, (currentScope) => ({
            ...currentScope,
            workspaces: [...currentScope.workspaces, { id, name, windows: [] }],
            activeWorkspaceId: id,
          })),
        );
        return id;
      },

      removeWorkspace: (id) => {
        const { workspaces, activeWorkspaceId } = getScopeState(get());
        if (workspaces.length <= 1) return;
        const next = workspaces.filter((w) => w.id !== id);
        set((state) =>
          updateCurrentScope(state, (currentScope) => ({
            ...currentScope,
            workspaces: next,
            activeWorkspaceId: activeWorkspaceId === id ? next[0]!.id : activeWorkspaceId,
          })),
        );
      },

      setActiveWorkspace: (id) => {
        set((state) =>
          updateCurrentScope(state, (currentScope) => ({
            ...currentScope,
            activeWorkspaceId: id,
          })),
        );
      },

      renameWorkspace: (id, name) => {
        set((state) =>
          updateCurrentScope(state, (currentScope) => ({
            ...currentScope,
            workspaces: currentScope.workspaces.map((w) => (w.id === id ? { ...w, name } : w)),
          })),
        );
      },

      // -- Window actions -----------------------------------------------------

      addWindow: (type, initialProps) => {
        const { workspaces, activeWorkspaceId } = getScopeState(get());
        const ws = workspaces.find((w) => w.id === activeWorkspaceId);
        if (!ws) return "";

        const id = generateId();
        const typeWidth = DEFAULT_TYPE_WIDTHS[type];
        const newWindow: CanvasWindowState = {
          id,
          type,
          title: DEFAULT_TITLES[type],
          width: typeWidth ?? null, // type-specific or fallback to default
          height: null, // stretch to fill container height
          minimized: false,
          maximized: false,
          ...(type === "browser" ? { browserUrl: "https://www.google.com" } : {}),
          ...initialProps,
        };

        set((state) =>
          updateCurrentScope(state, (currentScope) => ({
            ...currentScope,
            workspaces: currentScope.workspaces.map((w) =>
              w.id === currentScope.activeWorkspaceId
                ? { ...w, windows: [...w.windows, newWindow] }
                : w,
            ),
            activeWindowId: id,
          })),
        );
        return id;
      },

      removeWindow: (windowId) => {
        set((state) =>
          updateCurrentScope(state, (currentScope) => {
            const activeWorkspace = currentScope.workspaces.find(
              (w) => w.id === currentScope.activeWorkspaceId,
            );
            const remaining = activeWorkspace
              ? activeWorkspace.windows.filter((win) => win.id !== windowId)
              : [];

            // Pick the next active window: prefer the one at the same index,
            // otherwise the last one, otherwise null.
            let nextActiveId: string | null = currentScope.activeWindowId;
            if (currentScope.activeWindowId === windowId) {
              const visibleRemaining = remaining.filter((w) => !w.minimized);
              if (visibleRemaining.length > 0) {
                const oldIndex = (activeWorkspace?.windows ?? [])
                  .filter((w) => !w.minimized)
                  .findIndex((w) => w.id === windowId);
                const clampedIndex = Math.min(oldIndex, visibleRemaining.length - 1);
                nextActiveId = visibleRemaining[Math.max(0, clampedIndex)]?.id ?? null;
              } else {
                nextActiveId = null;
              }
            }

            return {
              ...currentScope,
              activeWindowId: nextActiveId,
              workspaces: currentScope.workspaces.map((w) =>
                w.id === currentScope.activeWorkspaceId ? { ...w, windows: remaining } : w,
              ),
            };
          }),
        );
      },

      updateWindow: (windowId, patch) => {
        set((state) =>
          updateCurrentScope(state, (currentScope) => ({
            ...currentScope,
            workspaces: currentScope.workspaces.map((w) =>
              w.id === currentScope.activeWorkspaceId
                ? {
                    ...w,
                    windows: w.windows.map((win) =>
                      win.id === windowId ? { ...win, ...patch } : win,
                    ),
                  }
                : w,
            ),
          })),
        );
      },

      minimizeWindow: (windowId) => {
        set((state) =>
          updateCurrentScope(state, (currentScope) => ({
            ...currentScope,
            workspaces: currentScope.workspaces.map((w) =>
              w.id === currentScope.activeWorkspaceId
                ? {
                    ...w,
                    windows: w.windows.map((wn) =>
                      wn.id === windowId ? { ...wn, minimized: true } : wn,
                    ),
                  }
                : w,
            ),
          })),
        );
      },

      restoreWindow: (windowId) => {
        set((state) =>
          updateCurrentScope(state, (currentScope) => ({
            ...currentScope,
            workspaces: currentScope.workspaces.map((w) =>
              w.id === currentScope.activeWorkspaceId
                ? {
                    ...w,
                    windows: w.windows.map((wn) =>
                      wn.id === windowId ? { ...wn, minimized: false } : wn,
                    ),
                  }
                : w,
            ),
          })),
        );
      },

      toggleMaximizeWindow: (windowId) => {
        set((state) =>
          updateCurrentScope(state, (currentScope) => ({
            ...currentScope,
            workspaces: currentScope.workspaces.map((w) =>
              w.id === currentScope.activeWorkspaceId
                ? {
                    ...w,
                    windows: w.windows.map((wn) =>
                      wn.id === windowId ? { ...wn, maximized: !wn.maximized } : wn,
                    ),
                  }
                : w,
            ),
            activeWindowId: windowId,
          })),
        );
      },

      moveWindow: (windowId, direction) => {
        const { workspaces, activeWorkspaceId } = getScopeState(get());
        const ws = workspaces.find((w) => w.id === activeWorkspaceId);
        if (!ws) return;
        const idx = ws.windows.findIndex((w) => w.id === windowId);
        if (idx === -1) return;
        const targetIdx = direction === "left" ? idx - 1 : idx + 1;
        if (targetIdx < 0 || targetIdx >= ws.windows.length) return;
        const newWindows = [...ws.windows];
        [newWindows[idx], newWindows[targetIdx]] = [newWindows[targetIdx]!, newWindows[idx]!];
        set((state) =>
          updateCurrentScope(state, (currentScope) => ({
            ...currentScope,
            workspaces: currentScope.workspaces.map((w) =>
              w.id === currentScope.activeWorkspaceId ? { ...w, windows: newWindows } : w,
            ),
          })),
        );
      },

      reorderWindow: (windowId, toIndex) => {
        const { workspaces, activeWorkspaceId } = getScopeState(get());
        const ws = workspaces.find((w) => w.id === activeWorkspaceId);
        if (!ws) return;
        const fromIndex = ws.windows.findIndex((w) => w.id === windowId);
        if (fromIndex === -1 || fromIndex === toIndex) return;
        const clampedTo = Math.max(0, Math.min(toIndex, ws.windows.length - 1));
        const newWindows = [...ws.windows];
        const [moved] = newWindows.splice(fromIndex, 1);
        newWindows.splice(clampedTo, 0, moved!);
        set((state) =>
          updateCurrentScope(state, (currentScope) => ({
            ...currentScope,
            workspaces: currentScope.workspaces.map((w) =>
              w.id === currentScope.activeWorkspaceId ? { ...w, windows: newWindows } : w,
            ),
          })),
        );
      },

      // -- Active window --------------------------------------------------------

      setActiveWindow: (windowId) => {
        set((state) =>
          updateCurrentScope(state, (currentScope) => ({
            ...currentScope,
            activeWindowId: windowId,
          })),
        );
      },

      focusNextWindow: () => {
        const { workspaces, activeWorkspaceId, activeWindowId } = getScopeState(get());
        const ws = workspaces.find((w) => w.id === activeWorkspaceId);
        if (!ws) return;
        const visible = ws.windows.filter((w) => !w.minimized);
        if (visible.length === 0) return;
        const idx = visible.findIndex((w) => w.id === activeWindowId);
        const next = idx < 0 ? 0 : (idx + 1) % visible.length;
        set((state) =>
          updateCurrentScope(state, (currentScope) => ({
            ...currentScope,
            activeWindowId: visible[next]!.id,
          })),
        );
      },

      focusPrevWindow: () => {
        const { workspaces, activeWorkspaceId, activeWindowId } = getScopeState(get());
        const ws = workspaces.find((w) => w.id === activeWorkspaceId);
        if (!ws) return;
        const visible = ws.windows.filter((w) => !w.minimized);
        if (visible.length === 0) return;
        const idx = visible.findIndex((w) => w.id === activeWindowId);
        const prev = idx <= 0 ? visible.length - 1 : idx - 1;
        set((state) =>
          updateCurrentScope(state, (currentScope) => ({
            ...currentScope,
            activeWindowId: visible[prev]!.id,
          })),
        );
      },

      // -- Chat window management -----------------------------------------------

      ensureChatWindow: (threadId) => {
        const { workspaces, activeWorkspaceId, activeWindowId } = getScopeState(get());
        const ws = workspaces.find((w) => w.id === activeWorkspaceId);
        if (!ws) return "";

        // Check if a chat window for this threadId already exists
        const existing = ws.windows.find((w) => w.type === "chat" && w.threadId === threadId);
        if (existing) {
          if (activeWindowId === existing.id && !existing.minimized) {
            // Window is already active — bump scrollTrigger so the scroll-into-view
            // effect re-fires even though activeWindowId hasn't changed.
            set((state) =>
              updateCurrentScope(state, (scope) => ({
                ...scope,
                scrollTrigger: scope.scrollTrigger + 1,
              })),
            );
            return existing.id;
          }
          // Activate and restore if minimized
          set((state) =>
            updateCurrentScope(state, (currentScope) => ({
              ...currentScope,
              activeWindowId: existing.id,
              workspaces: currentScope.workspaces.map((w) =>
                w.id === currentScope.activeWorkspaceId
                  ? {
                      ...w,
                      windows: w.windows.map((wn) =>
                        wn.id === existing.id ? { ...wn, minimized: false } : wn,
                      ),
                    }
                  : w,
              ),
            })),
          );
          return existing.id;
        }

        // No window for this thread — create a new one on the right.
        const id = generateId();
        const typeWidth = DEFAULT_TYPE_WIDTHS["chat"];
        const newWindow: CanvasWindowState = {
          id,
          type: "chat",
          title: "Chat",
          width: typeWidth ?? null,
          height: null,
          minimized: false,
          maximized: false,
          threadId,
        };

        set((state) =>
          updateCurrentScope(state, (currentScope) => ({
            ...currentScope,
            workspaces: currentScope.workspaces.map((w) =>
              w.id === currentScope.activeWorkspaceId
                ? { ...w, windows: [...w.windows, newWindow] }
                : w,
            ),
            activeWindowId: id,
          })),
        );
        return id;
      },

      // -- GitHub window management -----------------------------------------------

      ensureGitHubWindow: () => {
        const { workspaces, activeWorkspaceId, activeWindowId } = getScopeState(get());
        const ws = workspaces.find((w) => w.id === activeWorkspaceId);
        if (!ws) return "";

        // Check if a GitHub window already exists
        const existing = ws.windows.find((w) => w.type === "github");
        if (existing) {
          if (activeWindowId === existing.id && !existing.minimized) {
            // Window is already active — bump scrollTrigger so the scroll-into-view
            // effect re-fires even though activeWindowId hasn't changed.
            set((state) =>
              updateCurrentScope(state, (scope) => ({
                ...scope,
                scrollTrigger: scope.scrollTrigger + 1,
              })),
            );
            return existing.id;
          }
          // Activate and restore if minimized
          set((state) =>
            updateCurrentScope(state, (currentScope) => ({
              ...currentScope,
              activeWindowId: existing.id,
              workspaces: currentScope.workspaces.map((w) =>
                w.id === currentScope.activeWorkspaceId
                  ? {
                      ...w,
                      windows: w.windows.map((wn) =>
                        wn.id === existing.id ? { ...wn, minimized: false } : wn,
                      ),
                    }
                  : w,
              ),
            })),
          );
          return existing.id;
        }

        // No GitHub window — create a new one.
        const id = generateId();
        const typeWidth = DEFAULT_TYPE_WIDTHS["github"];
        const newWindow: CanvasWindowState = {
          id,
          type: "github",
          title: "GitHub",
          width: typeWidth ?? null,
          height: null,
          minimized: false,
          maximized: false,
        };

        set((state) =>
          updateCurrentScope(state, (currentScope) => ({
            ...currentScope,
            workspaces: currentScope.workspaces.map((w) =>
              w.id === currentScope.activeWorkspaceId
                ? { ...w, windows: [...w.windows, newWindow] }
                : w,
            ),
            activeWindowId: id,
          })),
        );
        return id;
      },

      // -- Column stacking ----------------------------------------------------

      stackWindow: (windowId, targetWindowId) => {
        const { workspaces, activeWorkspaceId } = getScopeState(get());
        const ws = workspaces.find((w) => w.id === activeWorkspaceId);
        if (!ws) return;
        const targetWin = ws.windows.find((w) => w.id === targetWindowId);
        if (!targetWin) return;
        // The column group is the target's columnGroup, or the target's id if it has none
        const group = targetWin.columnGroup ?? targetWin.id;
        set((state) =>
          updateCurrentScope(state, (currentScope) => ({
            ...currentScope,
            workspaces: currentScope.workspaces.map((w) =>
              w.id === currentScope.activeWorkspaceId
                ? {
                    ...w,
                    windows: w.windows.map((wn) =>
                      wn.id === windowId ? { ...wn, columnGroup: group } : wn,
                    ),
                  }
                : w,
            ),
          })),
        );
      },

      unstackWindow: (windowId) => {
        set((state) =>
          updateCurrentScope(state, (currentScope) => ({
            ...currentScope,
            workspaces: currentScope.workspaces.map((w) =>
              w.id === currentScope.activeWorkspaceId
                ? {
                    ...w,
                    windows: w.windows.map((wn) =>
                      wn.id === windowId
                        ? (({ columnGroup: _columnGroup, ...rest }) => rest)(wn)
                        : wn,
                    ),
                  }
                : w,
            ),
          })),
        );
      },

      // -- Drag state ---------------------------------------------------------

      setIsDragging: (dragging) => {
        set({ isDragging: dragging });
      },
    }),
    {
      name: CANVAS_STORAGE_KEY,
      storage: createJSONStorage(() => canvasDebouncedStorage),
      partialize: (state) => ({
        scopes: state.scopes,
        currentScopeKey: state.currentScopeKey,
        defaultWindowWidth: state.defaultWindowWidth,
        defaultWindowHeight: state.defaultWindowHeight,
      }),
    },
  ),
);

// ---------------------------------------------------------------------------
// Selector hooks
// ---------------------------------------------------------------------------

export function useActiveWorkspace(): CanvasWorkspace | undefined {
  return useCanvasStore((s) => {
    const scope = selectCurrentCanvasScope(s);
    return scope.workspaces.find((w) => w.id === scope.activeWorkspaceId);
  });
}

/** Returns the threadId of the currently active canvas window (if it's a chat window). */
export function useActiveWindowThreadId(): string | null {
  return useCanvasStore((s) => {
    const scope = selectCurrentCanvasScope(s);
    if (!scope.activeWindowId) return null;
    const ws = scope.workspaces.find((w) => w.id === scope.activeWorkspaceId);
    const win = ws?.windows.find((w) => w.id === scope.activeWindowId);
    return win?.type === "chat" && win.threadId ? win.threadId : null;
  });
}

export function useCanvasWindows(): CanvasWindowState[] {
  return useCanvasStore((s) => {
    const scope = selectCurrentCanvasScope(s);
    const ws = scope.workspaces.find((w) => w.id === scope.activeWorkspaceId);
    return ws?.windows ?? [];
  });
}

/** Collects threadIds that have an open chat window in ANY canvas scope. */
function collectOpenChatThreadIds(scopes: Record<string, CanvasScopeState>): Set<string> {
  const ids = new Set<string>();
  for (const scope of Object.values(scopes)) {
    for (const ws of scope.workspaces) {
      for (const win of ws.windows) {
        if (win.type === "chat" && win.threadId) {
          ids.add(win.threadId);
        }
      }
    }
  }
  return ids;
}

let _cachedOpenChatThreadIds: Set<string> = new Set();

/** Returns the set of threadIds that have an open chat window in ANY canvas scope.
 *  Uses structural equality to avoid unnecessary re-renders. */
export function useThreadIdsWithOpenChatWindows(): Set<string> {
  return useCanvasStore((s) => {
    const next = collectOpenChatThreadIds(s.scopes);
    // Structural equality: only return a new Set reference if the contents changed
    if (
      next.size === _cachedOpenChatThreadIds.size &&
      [...next].every((id) => _cachedOpenChatThreadIds.has(id))
    ) {
      return _cachedOpenChatThreadIds;
    }
    _cachedOpenChatThreadIds = next;
    return next;
  });
}

// ---------------------------------------------------------------------------
// Column grouping helper
// ---------------------------------------------------------------------------

export interface CanvasColumn {
  groupId: string;
  windows: CanvasWindowState[];
}

/** Group visible (non-minimized) windows into columns based on columnGroup.
 *  Column order follows the first appearance of each group in the flat array.
 *  Within a column, window order follows the flat array order. */
export function groupWindowsIntoColumns(windows: CanvasWindowState[]): CanvasColumn[] {
  const columns: CanvasColumn[] = [];
  const columnMap = new Map<string, CanvasColumn>();

  for (const win of windows) {
    if (win.minimized) continue;
    const group = win.columnGroup ?? win.id;
    let col = columnMap.get(group);
    if (!col) {
      col = { groupId: group, windows: [] };
      columnMap.set(group, col);
      columns.push(col);
    }
    col.windows.push(win);
  }

  return columns;
}
