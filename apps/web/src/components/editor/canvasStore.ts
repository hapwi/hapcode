import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { createDebouncedStorage, createMemoryStorage } from "~/lib/storage";
import {
  createInitialCanvasTerminalPaneState,
  type CanvasTerminalPaneState,
} from "./canvasTerminalState";

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
// Scope-switch suppression flag
// ---------------------------------------------------------------------------
// When the user switches scopes via the top-bar tabs, `switchToScope` navigates
// to the most recent thread to keep the URL in sync. That navigation triggers
// the EditorPanel effect which calls `ensureChatWindow` — recreating a chat
// window the user may have intentionally closed. This module-level flag lets
// `switchToScope` signal that the upcoming navigation is a scope restoration,
// NOT a user-initiated thread open, so `ensureChatWindow` should be skipped.

let _scopeSwitchInProgress = false;
export function markScopeSwitchInProgress(): void {
  _scopeSwitchInProgress = true;
}
export function isScopeSwitchInProgress(): boolean {
  return _scopeSwitchInProgress;
}
export function clearScopeSwitchInProgress(): void {
  _scopeSwitchInProgress = false;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CanvasWindowType = "browser" | "terminal" | "diff" | "chat" | "github" | "vscode";

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
  /** Pin order — pinned windows are sorted to the front of the window list.
   *  1 = first pin, 2 = second, etc.  undefined = not pinned. */
  pinOrder?: number;
  // Type-specific payload
  browserUrl?: string;

  terminalSessionId?: string;
  terminalPaneState?: CanvasTerminalPaneState;
  threadId?: string;
  /** URL for the embedded VS Code window. Set when the server process is ready. */
  appUrl?: string;
  /** Lifecycle status of the embedded VS Code process. */
  appStatus?: "starting" | "running" | "error" | "stopped";
  /** Port assigned to the embedded VS Code server process. */
  appPort?: number;
  /** Error message when appStatus is "error". */
  appError?: string;
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
  /** The window currently being resized (null when not resizing) */
  resizingWindowId: string | null;
  /** Live dimensions of the window being resized */
  resizeDimensions: { width: number; height: number } | null;
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

  diff: "Diff",
  chat: "Chat",
  github: "GitHub",
  vscode: "VS Code",
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
const defaultWorkspaceId = "ws-default";

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
  return state.scopes[state.currentScopeKey] ?? _fallbackScopeState;
}

export function selectCurrentCanvasScope(
  state: Pick<CanvasState, "scopes" | "currentScopeKey">,
): CanvasScopeState {
  return getScopeState(state);
}

/** Select a specific scope by key (does not depend on currentScopeKey). */
// Cache the fallback scope state so selectors return a stable reference
// when the requested scope key doesn't exist yet. Without this, every
// selector call creates a fresh object, causing Zustand's Object.is
// equality check to fail and triggering infinite re-renders.
const _fallbackScopeState = createInitialCanvasScopeState();

export function selectCanvasScopeByKey(
  state: Pick<CanvasState, "scopes">,
  scopeKey: string,
): CanvasScopeState {
  return state.scopes[scopeKey] ?? _fallbackScopeState;
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

  // Terminal window management
  /** Finds an existing terminal window or creates one.
   *  Returns the window id. Activates the window. */
  ensureTerminalWindow: () => string;

  // Chat window management
  /** Finds an existing chat window for the given threadId or creates one.
   *  Returns the window id. Activates the window. */
  ensureChatWindow: (threadId: string) => string;

  // Singleton window management
  /** Finds an existing browser window or creates one.
   *  Returns the window id. Activates the window.
   *  Only one browser window is allowed per workspace (tabs handle multiplexing). */
  ensureBrowserWindow: () => string;
  /** Finds an existing GitHub window or creates one.
   *  Returns the window id. Activates the window. */
  ensureGitHubWindow: () => string;
  /** Finds an existing VS Code window or creates one.
   *  Returns the window id. Activates the window. */
  ensureVsCodeWindow: () => string;

  // Pinning
  togglePinWindow: (windowId: string) => void;

  // Column stacking
  stackWindow: (windowId: string, targetWindowId: string) => void;
  unstackWindow: (windowId: string) => void;

  // Close all windows
  /** Close all windows in a specific scope (project). */
  closeAllWindowsInScope: (scopeKey: string) => void;
  /** Close all windows across all scopes (all projects). */
  closeAllWindows: () => void;

  // Drag state (for webview overlay protection)
  setIsDragging: (dragging: boolean) => void;

  // Resize tracking (for HUD visualizer)
  startResize: (windowId: string, dimensions: { width: number; height: number }) => void;
  updateResizeDimensions: (dimensions: { width: number; height: number }) => void;
  endResize: () => void;
}

type CanvasStore = CanvasState & CanvasActions;

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

const initialState: CanvasState = {
  scopes: {
    [DEFAULT_SCOPE_KEY]: createInitialCanvasScopeState(),
  },
  currentScopeKey: DEFAULT_SCOPE_KEY,
  isDragging: false,
  defaultWindowWidth: DEFAULT_WINDOW_WIDTH,
  defaultWindowHeight: DEFAULT_WINDOW_HEIGHT,
  resizingWindowId: null,
  resizeDimensions: null,
};

// ---------------------------------------------------------------------------
// Helpers for app embed windows
// ---------------------------------------------------------------------------

/** Singleton-per-type helper for ensureVsCodeWindow. */
function _ensureAppEmbedWindow(
  get: () => CanvasStore,
  set: (fn: (state: CanvasState) => Partial<CanvasState>) => void,
  appType: CanvasWindowType,
  displayName: string,
): string {
  const { workspaces, activeWorkspaceId, activeWindowId } = getScopeState(get());
  const ws = workspaces.find((w) => w.id === activeWorkspaceId);
  if (!ws) return "";

  // Check if a window of this type already exists
  const existing = ws.windows.find((w) => w.type === appType);
  if (existing) {
    if (activeWindowId === existing.id && !existing.minimized) {
      // Already active — bump scrollTrigger
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

  // No window of this type — create a new one
  const id = generateId();
  const typeWidth = DEFAULT_TYPE_WIDTHS[appType];
  const newWindow: CanvasWindowState = {
    id,
    type: appType,
    title: displayName,
    width: typeWidth ?? null,
    height: null,
    minimized: false,
    maximized: appType === "vscode",
    appStatus: "starting",
  };

  set((state) =>
    updateCurrentScope(state, (currentScope) => ({
      ...currentScope,
      workspaces: currentScope.workspaces.map((w) =>
        w.id === currentScope.activeWorkspaceId ? { ...w, windows: [...w.windows, newWindow] } : w,
      ),
      activeWindowId: id,
    })),
  );
  return id;
}

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
          ...(type === "terminal"
            ? { terminalPaneState: createInitialCanvasTerminalPaneState(id) }
            : {}),
          ...(type === "vscode" ? { appStatus: "starting" as const, maximized: true } : {}),
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
            // Search ALL workspaces in the scope, not just the active one.
            // Terminal pane state updates can occur for background workspaces
            // (e.g. when syncing pane state), and limiting to the active
            // workspace would silently drop those updates.
            workspaces: currentScope.workspaces.map((w) => ({
              ...w,
              windows: w.windows.map((win) => (win.id === windowId ? { ...win, ...patch } : win)),
            })),
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
            // Bump scrollTrigger so the viewport follows the moved window
            scrollTrigger: currentScope.scrollTrigger + 1,
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
            // Bump scrollTrigger so the viewport follows the moved window
            scrollTrigger: currentScope.scrollTrigger + 1,
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

      // -- Terminal window management ---------------------------------------------

      ensureTerminalWindow: () => {
        const { workspaces, activeWorkspaceId, activeWindowId } = getScopeState(get());
        const ws = workspaces.find((w) => w.id === activeWorkspaceId);
        if (!ws) return "";

        // Check if a terminal window already exists in this workspace
        const existing = ws.windows.find((w) => w.type === "terminal");
        if (existing) {
          if (activeWindowId === existing.id && !existing.minimized) {
            // Already active — toggle: minimize and focus the previous non-terminal window
            const visible = ws.windows.filter((w) => !w.minimized && w.id !== existing.id);
            const nextActive = visible.length > 0 ? visible[0]!.id : null;
            set((state) =>
              updateCurrentScope(state, (scope) => ({
                ...scope,
                activeWindowId: nextActive ?? scope.activeWindowId,
                workspaces: scope.workspaces.map((w) =>
                  w.id === scope.activeWorkspaceId
                    ? {
                        ...w,
                        windows: w.windows.map((wn) =>
                          wn.id === existing.id ? { ...wn, minimized: true } : wn,
                        ),
                      }
                    : w,
                ),
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

        // No terminal window — create a new one
        const id = generateId();
        const typeWidth = DEFAULT_TYPE_WIDTHS["terminal"];
        const newWindow: CanvasWindowState = {
          id,
          type: "terminal",
          title: "Terminal",
          width: typeWidth ?? null,
          height: null,
          minimized: false,
          maximized: false,
          terminalPaneState: createInitialCanvasTerminalPaneState(id),
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

      // -- Browser window management (singleton per workspace) --------------------

      ensureBrowserWindow: () => {
        const { workspaces, activeWorkspaceId, activeWindowId } = getScopeState(get());
        const ws = workspaces.find((w) => w.id === activeWorkspaceId);
        if (!ws) return "";

        const existing = ws.windows.find((w) => w.type === "browser");
        if (existing) {
          if (activeWindowId === existing.id && !existing.minimized) {
            set((state) =>
              updateCurrentScope(state, (scope) => ({
                ...scope,
                scrollTrigger: scope.scrollTrigger + 1,
              })),
            );
            return existing.id;
          }
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

        // No browser window — create one
        const id = generateId();
        const typeWidth = DEFAULT_TYPE_WIDTHS["browser"];
        const newWindow: CanvasWindowState = {
          id,
          type: "browser",
          title: "Browser",
          width: typeWidth ?? null,
          height: null,
          minimized: false,
          maximized: false,
          browserUrl: "https://www.google.com",
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

      ensureVsCodeWindow: () => {
        return _ensureAppEmbedWindow(get, set, "vscode", "VS Code");
      },

      // -- Pin management -------------------------------------------------------

      togglePinWindow: (windowId) => {
        set((state) =>
          updateCurrentScope(state, (currentScope) => {
            const ws = currentScope.workspaces.find((w) => w.id === currentScope.activeWorkspaceId);
            if (!ws) return currentScope;

            const win = ws.windows.find((w) => w.id === windowId);
            if (!win) return currentScope;

            let newWindows: CanvasWindowState[];

            if (win.pinOrder != null) {
              // Unpin: remove pinOrder and renumber remaining pins
              const removedOrder = win.pinOrder;
              newWindows = ws.windows.map((w) => {
                if (w.id === windowId) {
                  const { pinOrder: _, ...rest } = w;
                  return rest;
                }
                if (w.pinOrder != null && w.pinOrder > removedOrder) {
                  return { ...w, pinOrder: w.pinOrder - 1 };
                }
                return w;
              });
            } else {
              // Pin: assign the next pin number
              const maxPin = Math.max(0, ...ws.windows.map((w) => w.pinOrder ?? 0));
              newWindows = ws.windows.map((w) =>
                w.id === windowId ? { ...w, pinOrder: maxPin + 1 } : w,
              );
            }

            // Re-sort: pinned windows first (by pinOrder), then unpinned in original order
            const pinned = newWindows
              .filter((w) => w.pinOrder != null)
              .sort((a, b) => a.pinOrder! - b.pinOrder!);
            const unpinned = newWindows.filter((w) => w.pinOrder == null);
            const sorted = [...pinned, ...unpinned];

            return {
              ...currentScope,
              workspaces: currentScope.workspaces.map((w) =>
                w.id === currentScope.activeWorkspaceId ? { ...w, windows: sorted } : w,
              ),
            };
          }),
        );
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
            // Bump scrollTrigger so the viewport follows the moved window
            scrollTrigger: currentScope.scrollTrigger + 1,
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
            // Bump scrollTrigger so the viewport follows the moved window
            scrollTrigger: currentScope.scrollTrigger + 1,
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

      // -- Close all windows ---------------------------------------------------

      closeAllWindowsInScope: (scopeKey) => {
        set((state) => {
          const scope = state.scopes[scopeKey];
          if (!scope) return state;
          return {
            scopes: {
              ...state.scopes,
              [scopeKey]: {
                ...scope,
                workspaces: scope.workspaces.map((w) => ({
                  ...w,
                  windows: [],
                })),
                activeWindowId: null,
              },
            },
          };
        });
      },

      closeAllWindows: () => {
        set((state) => {
          const newScopes: Record<string, CanvasScopeState> = {};
          for (const [key, scope] of Object.entries(state.scopes)) {
            newScopes[key] = {
              ...scope,
              workspaces: scope.workspaces.map((w) => ({
                ...w,
                windows: [],
              })),
              activeWindowId: null,
            };
          }
          return { scopes: newScopes };
        });
      },

      // -- Drag state ---------------------------------------------------------

      setIsDragging: (dragging) => {
        set({ isDragging: dragging });
      },

      // -- Resize tracking (HUD) -----------------------------------------------

      startResize: (windowId, dimensions) => {
        set({ resizingWindowId: windowId, resizeDimensions: dimensions, isDragging: true });
      },

      updateResizeDimensions: (dimensions) => {
        set({ resizeDimensions: dimensions });
      },

      endResize: () => {
        set({ resizingWindowId: null, resizeDimensions: null, isDragging: false });
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
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        // Safety: ensure the default scope always exists after rehydration.
        // If localStorage contained an empty or corrupted scopes map, the app
        // would render nothing (all scope divs get display:none).
        if (!state.scopes[DEFAULT_SCOPE_KEY]) {
          state.scopes = {
            ...state.scopes,
            [DEFAULT_SCOPE_KEY]: createInitialCanvasScopeState(),
          };
        }
        // If the persisted currentScopeKey references a scope that no longer
        // exists (e.g. a deleted project), reset to the default scope so the
        // user doesn't see a blank screen.
        if (!state.scopes[state.currentScopeKey]) {
          state.currentScopeKey = DEFAULT_SCOPE_KEY;
        }
      },
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

/** Returns the active workspace for a specific scope key. */
export function useWorkspaceForScope(scopeKey: string): CanvasWorkspace | undefined {
  return useCanvasStore((s) => {
    const scope = selectCanvasScopeByKey(s, scopeKey);
    return scope.workspaces.find((w) => w.id === scope.activeWorkspaceId);
  });
}

/** Returns all workspaces and the active workspace ID for a specific scope key.
 *
 * Uses a module-level cache keyed by scopeKey so the selector always returns
 * the **same object reference** when the underlying values haven't changed.
 * This is required by React's `useSyncExternalStore` (used internally by
 * Zustand v5): if `getSnapshot()` returns a different reference on every call,
 * React will loop forever with re-renders (error #185).
 *
 * Zustand v5 dropped the `equalityFn` second argument from the bound-store
 * hook, so passing `shallow` no longer has any effect — every new object
 * returned by a selector is treated as "changed" by `Object.is`.
 */
type WorkspacesForScopeSnapshot = { workspaces: CanvasWorkspace[]; activeWorkspaceId: string };
const _cachedWorkspacesForScope = new Map<string, WorkspacesForScopeSnapshot>();

export function useAllWorkspacesForScope(scopeKey: string): WorkspacesForScopeSnapshot {
  return useCanvasStore((s) => {
    const scope = selectCanvasScopeByKey(s, scopeKey);
    const cached = _cachedWorkspacesForScope.get(scopeKey);
    if (
      cached &&
      cached.workspaces === scope.workspaces &&
      cached.activeWorkspaceId === scope.activeWorkspaceId
    ) {
      return cached;
    }
    const next: WorkspacesForScopeSnapshot = {
      workspaces: scope.workspaces,
      activeWorkspaceId: scope.activeWorkspaceId,
    };
    _cachedWorkspacesForScope.set(scopeKey, next);
    return next;
  });
}

/** Returns all scope keys that have been created. */
let _cachedScopeKeys: string[] = [];

export function useAllScopeKeys(): string[] {
  return useCanvasStore((s) => {
    const next = Object.keys(s.scopes);
    if (
      next.length === _cachedScopeKeys.length &&
      next.every((k, i) => k === _cachedScopeKeys[i])
    ) {
      return _cachedScopeKeys;
    }
    _cachedScopeKeys = next;
    return next;
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

/** Returns the total window count for a specific scope (across all workspaces). */
export function useWindowCountForScope(scopeKey: string): number {
  return useCanvasStore((s) => {
    const scope = selectCanvasScopeByKey(s, scopeKey);
    let count = 0;
    for (const ws of scope.workspaces) {
      count += ws.windows.length;
    }
    return count;
  });
}

/** Returns the total window count across all scopes. */
export function useTotalWindowCount(): number {
  return useCanvasStore((s) => {
    let count = 0;
    for (const scope of Object.values(s.scopes)) {
      for (const ws of scope.workspaces) {
        count += ws.windows.length;
      }
    }
    return count;
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

/** Returns info about all scopes that have at least one open window.
 *  Used to render workspace switcher buttons in the header. */
export interface ScopeWithWindows {
  scopeKey: string;
  windowCount: number;
}

let _cachedScopesWithWindows: ScopeWithWindows[] = [];

export function useScopesWithWindows(): ScopeWithWindows[] {
  return useCanvasStore((s) => {
    const next: ScopeWithWindows[] = [];
    for (const [key, scope] of Object.entries(s.scopes)) {
      let count = 0;
      for (const ws of scope.workspaces) {
        count += ws.windows.length;
      }
      if (count > 0) {
        next.push({ scopeKey: key, windowCount: count });
      }
    }
    // Structural equality check to avoid unnecessary re-renders
    if (
      next.length === _cachedScopesWithWindows.length &&
      next.every(
        (item, i) =>
          item.scopeKey === _cachedScopesWithWindows[i]?.scopeKey &&
          item.windowCount === _cachedScopesWithWindows[i]?.windowCount,
      )
    ) {
      return _cachedScopesWithWindows;
    }
    _cachedScopesWithWindows = next;
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
