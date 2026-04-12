import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { createDebouncedStorage, createMemoryStorage } from "~/lib/storage";

const BROWSER_STORAGE_KEY = "t3code:browser-tabs:v1";
const BROWSER_PERSIST_DEBOUNCE_MS = 500;

/** Maximum number of open tabs to prevent runaway memory usage. */
export const MAX_BROWSER_TABS = 20;

/** URL opened for every new tab. */
export const NEW_TAB_URL = "https://www.google.com";

const browserDebouncedStorage = createDebouncedStorage(
  typeof localStorage !== "undefined" ? localStorage : createMemoryStorage(),
  BROWSER_PERSIST_DEBOUNCE_MS,
);

declare global {
  interface Window {
    __t3codeBrowserBeforeUnloadRegistered__?: boolean;
  }
}

if (typeof window !== "undefined" && !window.__t3codeBrowserBeforeUnloadRegistered__) {
  window.__t3codeBrowserBeforeUnloadRegistered__ = true;
  window.addEventListener("beforeunload", () => {
    browserDebouncedStorage.flush();
  });
}

let nextTabId = 1;

export function generateTabId(): string {
  return `tab-${Date.now()}-${nextTabId++}`;
}

export interface BrowserTab {
  id: string;
  url: string;
  title: string;
}

interface BrowserTabState {
  tabs: BrowserTab[];
  activeTabId: string | null;
}

interface BrowserTabActions {
  addTab: (url?: string) => string;
  closeTab: (tabId: string) => void;
  setActiveTab: (tabId: string) => void;
  /** Update both url and title in a single store write to avoid double-renders. */
  updateTab: (tabId: string, patch: { url?: string; title?: string }) => void;
  reorderTabs: (fromIndex: number, toIndex: number) => void;
  closeOtherTabs: (tabId: string) => void;
  closeTabsToRight: (tabId: string) => void;
  duplicateTab: (tabId: string) => string;
}

type BrowserTabStore = BrowserTabState & BrowserTabActions;

function createDefaultTab(): BrowserTab {
  return {
    id: generateTabId(),
    url: NEW_TAB_URL,
    title: "New Tab",
  };
}

export const useBrowserStore = create<BrowserTabStore>()(
  persist(
    (set, get) => ({
      tabs: [],
      activeTabId: null,

      addTab: (url?: string) => {
        const { tabs } = get();
        // Enforce tab limit
        if (tabs.length >= MAX_BROWSER_TABS) return tabs[tabs.length - 1]!.id;
        const newTab: BrowserTab = {
          id: generateTabId(),
          url: url ?? NEW_TAB_URL,
          title: "New Tab",
        };
        set((state) => ({
          tabs: [...state.tabs, newTab],
          activeTabId: newTab.id,
        }));
        return newTab.id;
      },

      closeTab: (tabId: string) => {
        const { tabs, activeTabId } = get();
        if (tabs.length <= 1) {
          const resetTab = createDefaultTab();
          set({ tabs: [resetTab], activeTabId: resetTab.id });
          return;
        }
        const idx = tabs.findIndex((t) => t.id === tabId);
        if (idx === -1) return;
        const nextTabs = tabs.filter((t) => t.id !== tabId);
        let nextActive = activeTabId;
        if (activeTabId === tabId) {
          nextActive =
            idx >= nextTabs.length ? nextTabs[nextTabs.length - 1]!.id : nextTabs[idx]!.id;
        }
        set({ tabs: nextTabs, activeTabId: nextActive });
      },

      setActiveTab: (tabId: string) => {
        set({ activeTabId: tabId });
      },

      updateTab: (tabId: string, patch: { url?: string; title?: string }) => {
        set((state) => ({
          tabs: state.tabs.map((t) => (t.id === tabId ? { ...t, ...patch } : t)),
        }));
      },

      reorderTabs: (fromIndex: number, toIndex: number) => {
        set((state) => {
          const newTabs = [...state.tabs];
          const [moved] = newTabs.splice(fromIndex, 1);
          if (!moved) return state;
          newTabs.splice(toIndex, 0, moved);
          return { tabs: newTabs };
        });
      },

      closeOtherTabs: (tabId: string) => {
        const { tabs } = get();
        const kept = tabs.filter((t) => t.id === tabId);
        set({ tabs: kept, activeTabId: tabId });
      },

      closeTabsToRight: (tabId: string) => {
        const { tabs, activeTabId } = get();
        const idx = tabs.findIndex((t) => t.id === tabId);
        if (idx === -1) return;
        const kept = tabs.slice(0, idx + 1);
        const activeStillExists = kept.some((t) => t.id === activeTabId);
        set({
          tabs: kept,
          activeTabId: activeStillExists ? activeTabId : tabId,
        });
      },

      duplicateTab: (tabId: string) => {
        const { tabs } = get();
        if (tabs.length >= MAX_BROWSER_TABS) return "";
        const tab = tabs.find((t) => t.id === tabId);
        if (!tab) return "";
        const newTab: BrowserTab = {
          id: generateTabId(),
          url: tab.url,
          title: tab.title,
        };
        const idx = tabs.findIndex((t) => t.id === tabId);
        const newTabs = [...tabs];
        newTabs.splice(idx + 1, 0, newTab);
        set({ tabs: newTabs, activeTabId: newTab.id });
        return newTab.id;
      },
    }),
    {
      name: BROWSER_STORAGE_KEY,
      storage: createJSONStorage(() => browserDebouncedStorage),
      partialize: (state) => ({
        tabs: state.tabs,
        activeTabId: state.activeTabId,
      }),
    },
  ),
);

// Ensure at least one tab exists (handles first-run and rehydration)
function ensureDefaultTab() {
  const state = useBrowserStore.getState();
  if (!state.tabs || state.tabs.length === 0) {
    const defaultTab = createDefaultTab();
    useBrowserStore.setState({ tabs: [defaultTab], activeTabId: defaultTab.id });
  } else if (!state.tabs.some((t) => t.id === state.activeTabId)) {
    useBrowserStore.setState({ activeTabId: state.tabs[0]!.id });
  }
}

ensureDefaultTab();
useBrowserStore.persist.onFinishHydration(ensureDefaultTab);
