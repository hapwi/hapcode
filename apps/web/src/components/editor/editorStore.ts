import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { createDebouncedStorage, createMemoryStorage } from "~/lib/storage";

const EDITOR_STORAGE_KEY = "t3code:editor-state:v2";
const EDITOR_PERSIST_DEBOUNCE_MS = 500;

const editorDebouncedStorage = createDebouncedStorage(
  typeof localStorage !== "undefined" ? localStorage : createMemoryStorage(),
  EDITOR_PERSIST_DEBOUNCE_MS,
);

if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => {
    editorDebouncedStorage.flush();
  });
}

export type EditorViewMode = "editor" | "diff";

export interface EditorTab {
  relativePath: string;
}

interface EditorState {
  openTabs: EditorTab[];
  activeTabPath: string | null;
  expandedDirs: Record<string, boolean>;
  fileTreeWidth: number;
  viewMode: EditorViewMode;
  fileTreeVisible: boolean;
}

interface EditorActions {
  openFile: (relativePath: string) => void;
  closeTab: (relativePath: string) => void;
  setActiveTab: (relativePath: string) => void;
  toggleDir: (dirPath: string) => void;
  setFileTreeWidth: (width: number) => void;
  setViewMode: (mode: EditorViewMode) => void;
  setFileTreeVisible: (visible: boolean) => void;
  closeAllTabs: () => void;
  closeOtherTabs: (relativePath: string) => void;
}

type EditorStore = EditorState & EditorActions;

const DEFAULT_FILE_TREE_WIDTH = 220;

export const useEditorStore = create<EditorStore>()(
  persist(
    (set, get) => ({
      // State
      openTabs: [],
      activeTabPath: null,
      expandedDirs: {},
      fileTreeWidth: DEFAULT_FILE_TREE_WIDTH,
      viewMode: "editor",
      fileTreeVisible: true,

      // Actions
      openFile: (relativePath) => {
        const { openTabs } = get();
        const existing = openTabs.find((t) => t.relativePath === relativePath);
        if (existing) {
          set({ activeTabPath: relativePath, viewMode: "editor" });
          return;
        }
        set({
          openTabs: [...openTabs, { relativePath }],
          activeTabPath: relativePath,
          viewMode: "editor",
        });
      },

      closeTab: (relativePath) => {
        const { openTabs, activeTabPath } = get();
        const idx = openTabs.findIndex((t) => t.relativePath === relativePath);
        if (idx === -1) return;
        const nextTabs = openTabs.filter((t) => t.relativePath !== relativePath);
        let nextActive = activeTabPath;
        if (activeTabPath === relativePath) {
          // Activate the adjacent tab
          if (nextTabs.length === 0) {
            nextActive = null;
          } else if (idx >= nextTabs.length) {
            nextActive = nextTabs[nextTabs.length - 1]!.relativePath;
          } else {
            nextActive = nextTabs[idx]!.relativePath;
          }
        }
        set({ openTabs: nextTabs, activeTabPath: nextActive });
      },

      setActiveTab: (relativePath) => {
        set({ activeTabPath: relativePath });
      },

      toggleDir: (dirPath) => {
        set((state) => ({
          expandedDirs: {
            ...state.expandedDirs,
            [dirPath]: !state.expandedDirs[dirPath],
          },
        }));
      },

      setFileTreeWidth: (width) => {
        set({ fileTreeWidth: width });
      },

      setViewMode: (mode) => {
        set({ viewMode: mode });
      },

      setFileTreeVisible: (visible) => {
        set({ fileTreeVisible: visible });
      },

      closeAllTabs: () => {
        set({ openTabs: [], activeTabPath: null });
      },

      closeOtherTabs: (relativePath) => {
        const { openTabs } = get();
        const kept = openTabs.filter((t) => t.relativePath === relativePath);
        set({ openTabs: kept, activeTabPath: relativePath });
      },
    }),
    {
      name: EDITOR_STORAGE_KEY,
      storage: createJSONStorage(() => editorDebouncedStorage),
      partialize: (state) => ({
        expandedDirs: state.expandedDirs,
        fileTreeWidth: state.fileTreeWidth,
        fileTreeVisible: state.fileTreeVisible,
        viewMode: state.viewMode,
      }),
    },
  ),
);
