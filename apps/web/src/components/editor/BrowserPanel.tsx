import {
  ArrowLeftIcon,
  ArrowRightIcon,
  BlocksIcon,
  GlobeIcon,
  HomeIcon,
  PlusIcon,
  PuzzleIcon,
  RefreshCwIcon,
  XIcon,
} from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { BrowserExtensionInfo } from "@t3tools/contracts";
import { Button } from "../ui/button";
import { useEditorStore } from "./editorStore";
import {
  useBrowserStore,
  type BrowserTab,
  generateTabId,
  NEW_TAB_URL,
  MAX_BROWSER_TABS,
} from "./browserStore";
import { cn } from "~/lib/utils";

// ---------------------------------------------------------------------------
// Electron <webview> type helpers
// ---------------------------------------------------------------------------

interface WebviewElement extends HTMLElement {
  src: string;
  getURL(): string;
  getTitle(): string;
  loadURL(url: string): Promise<void>;
  goBack(): void;
  goForward(): void;
  reload(): void;
  stop(): void;
  canGoBack(): boolean;
  canGoForward(): boolean;
  isLoading(): boolean;
  addEventListener(type: string, listener: (...args: unknown[]) => void): void;
  removeEventListener(type: string, listener: (...args: unknown[]) => void): void;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      webview: React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & {
          src?: string;
          partition?: string;
          allowpopups?: boolean | string;
          webpreferences?: string;
        },
        HTMLElement
      >;
    }
  }
}

// ---------------------------------------------------------------------------
// Constants & helpers
// ---------------------------------------------------------------------------

/** Shortcuts forwarded from the webview guest to the host app. */
const HOST_SHORTCUTS: Array<{
  key: string;
  meta?: boolean;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
}> = [
  { key: "d", meta: true },
  { key: "d", ctrl: true },
  { key: "l", meta: true },
  { key: "l", ctrl: true },
  { key: "Enter", alt: true },
  { key: "Enter", meta: true, shift: true },
  { key: "]", alt: true },
  { key: "[", alt: true },
  { key: "]", meta: true },
  { key: "[", meta: true },
];

function normalizeUrlInput(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return NEW_TAB_URL;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
  if (/^(localhost|[\w-]+\.[\w-]+)(:\d+)?(\/|$)/i.test(trimmed)) {
    return `http://${trimmed}`;
  }
  return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
}

function getDesktopBridge() {
  return (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).desktopBridge as
      | { getBrowserExtensions?: () => Promise<BrowserExtensionInfo[]> }
      | undefined
  );
}

function titleFromUrl(url: string): string {
  if (!url || url === "about:blank") return "New Tab";
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------
// ExtensionBar
// ---------------------------------------------------------------------------

function ExtensionBar() {
  const [extensions, setExtensions] = useState<BrowserExtensionInfo[]>([]);
  const [showDropdown, setShowDropdown] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const bridge = getDesktopBridge();
    if (bridge?.getBrowserExtensions) {
      void bridge.getBrowserExtensions().then(setExtensions);
    }
  }, []);

  useEffect(() => {
    if (!showDropdown) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
      }
    };
    const handleBlur = () => setTimeout(() => setShowDropdown(false), 150);
    document.addEventListener("mousedown", handleClickOutside);
    window.addEventListener("blur", handleBlur);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      window.removeEventListener("blur", handleBlur);
    };
  }, [showDropdown]);

  if (extensions.length === 0) return null;

  return (
    <div className="relative flex items-center" ref={dropdownRef}>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        onClick={() => setShowDropdown((v) => !v)}
        aria-label="Extensions"
        title={`Extensions (${extensions.length})`}
      >
        <PuzzleIcon className="size-3.5" />
      </Button>
      {showDropdown && (
        <div className="absolute right-0 top-full z-[70] mt-1 w-64 rounded-lg border border-border bg-popover shadow-lg">
          <div className="flex items-center gap-1.5 border-b border-border/50 px-3 py-2">
            <BlocksIcon className="size-3.5 text-muted-foreground" />
            <span className="text-xs font-medium">Extensions ({extensions.length})</span>
          </div>
          <div className="max-h-60 overflow-y-auto py-1">
            {extensions.map((ext) => (
              <div
                key={ext.id}
                className="flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-accent/50"
              >
                <PuzzleIcon className="size-3 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{ext.name}</div>
                  <div className="truncate text-[10px] text-muted-foreground">v{ext.version}</div>
                </div>
              </div>
            ))}
          </div>
          <div className="border-t border-border/50 px-3 py-2">
            <p className="text-[10px] leading-tight text-muted-foreground/70">
              Content scripts are injected automatically. Some extensions may have limited
              functionality.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// BrowserTabStrip
// ---------------------------------------------------------------------------

function BrowserTabStrip({
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onNewTab,
}: {
  tabs: BrowserTab[];
  activeTabId: string | null;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onNewTab: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = scrollRef.current;
    if (!container || !activeTabId) return;
    const el = container.querySelector<HTMLElement>(
      `[data-browser-tab="${CSS.escape(activeTabId)}"]`,
    );
    el?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeTabId]);

  return (
    <div className="relative z-[60] flex items-center border-b border-border/50 bg-background/50">
      <div
        ref={scrollRef}
        className="flex min-w-0 flex-1 select-none items-center overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId;
          return (
            <div
              key={tab.id}
              data-browser-tab={tab.id}
              className={cn(
                "group flex max-w-[200px] min-w-[100px] shrink-0 items-center border-b-2 text-[11px] transition-colors",
                isActive
                  ? "border-primary bg-accent/40 text-foreground"
                  : "border-transparent text-muted-foreground hover:bg-accent/20 hover:text-foreground",
              )}
              onAuxClick={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  onCloseTab(tab.id);
                }
              }}
              title={tab.url}
            >
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-1.5 px-2.5 py-1.5 text-left"
                onClick={() => onSelectTab(tab.id)}
              >
                <GlobeIcon className="size-3 shrink-0 opacity-60" />
                <span className="truncate">{tab.title || titleFromUrl(tab.url)}</span>
              </button>
              <button
                type="button"
                aria-label="Close tab"
                className={cn(
                  "mr-1 shrink-0 rounded-sm p-0.5 opacity-0 transition-opacity hover:bg-muted group-hover:opacity-60 hover:!opacity-100",
                  isActive && "opacity-60",
                )}
                onClick={(e) => {
                  e.stopPropagation();
                  onCloseTab(tab.id);
                }}
              >
                <XIcon className="size-3" />
              </button>
            </div>
          );
        })}
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        onClick={onNewTab}
        aria-label="New tab"
        title="New tab (Cmd+T)"
        className="mx-1 shrink-0"
      >
        <PlusIcon className="size-3.5" />
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// BrowserWebview — one per tab, stays mounted for instant switching
// ---------------------------------------------------------------------------

/**
 * Each tab gets its own BrowserWebview that stays mounted for the tab's
 * lifetime.  Inactive tabs are hidden with `display:none` (Chromium
 * throttles hidden webviews automatically).  The `src` attribute is set
 * ONCE at mount via a ref — all subsequent navigation happens through
 * the webview itself or our `loadURL()` calls, preventing re-render loops.
 */
function BrowserWebview({
  tabId,
  initialUrl,
  isActive,
  onNavigate,
}: {
  tabId: string;
  initialUrl: string;
  isActive: boolean;
  onNavigate: (tabId: string, url: string, title: string) => void;
}) {
  const webviewRef = useRef<WebviewElement | null>(null);
  // Freeze initial src so React never re-sets it
  const initialSrcRef = useRef(initialUrl || NEW_TAB_URL);
  const tabIdRef = useRef(tabId);
  tabIdRef.current = tabId;

  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [urlInputValue, setUrlInputValue] = useState(initialUrl || NEW_TAB_URL);
  const [urlInputFocused, setUrlInputFocused] = useState(false);
  const [displayUrl, setDisplayUrl] = useState(initialUrl || NEW_TAB_URL);

  const urlInputRef = useRef<HTMLInputElement | null>(null);
  const onNavigateRef = useRef(onNavigate);
  onNavigateRef.current = onNavigate;
  const urlInputFocusedRef = useRef(urlInputFocused);
  urlInputFocusedRef.current = urlInputFocused;

  const updateNavState = useCallback(() => {
    const wv = webviewRef.current;
    if (!wv) return;
    try {
      setCanGoBack(wv.canGoBack());
      setCanGoForward(wv.canGoForward());
      setIsLoading(wv.isLoading());
    } catch {
      /* not ready */
    }
  }, []);

  // Attach webview event listeners once — clean up on unmount
  useEffect(() => {
    const wv = webviewRef.current;
    if (!wv) return;

    const onNav = () => {
      try {
        const url = wv.getURL();
        let title: string;
        try {
          title = wv.getTitle();
        } catch {
          title = titleFromUrl(url);
        }
        setDisplayUrl(url);
        if (!urlInputFocusedRef.current) setUrlInputValue(url);
        onNavigateRef.current(tabIdRef.current, url, title);
        updateNavState();
      } catch {
        /* not ready */
      }
    };

    const onStartLoading = () => setIsLoading(true);
    const onStopLoading = () => {
      setIsLoading(false);
      onNav();
    };

    const onPageTitle = (...args: unknown[]) => {
      const evt = args[0] as { title?: string } | undefined;
      if (evt?.title) {
        try {
          onNavigateRef.current(tabIdRef.current, wv.getURL(), evt.title);
        } catch {
          /* */
        }
      }
    };

    const onBeforeInput = (...args: unknown[]) => {
      const event = args[0] as Event | undefined;
      const input = args[1] as
        | {
            type: string;
            key: string;
            meta: boolean;
            control: boolean;
            alt: boolean;
            shift: boolean;
          }
        | undefined;
      if (!input || input.type !== "keyDown") return;
      const k = input.key.toLowerCase();

      if ((k === "l" && input.meta) || (k === "l" && input.control)) {
        event?.preventDefault();
        urlInputRef.current?.focus();
        urlInputRef.current?.select();
        return;
      }
      if (
        (k === "t" && (input.meta || input.control)) ||
        (k === "w" && (input.meta || input.control))
      ) {
        event?.preventDefault();
        window.dispatchEvent(
          new globalThis.KeyboardEvent("keydown", {
            key: input.key,
            code: `Key${input.key.toUpperCase()}`,
            metaKey: input.meta,
            ctrlKey: input.control,
            bubbles: true,
            cancelable: true,
          }),
        );
        return;
      }
      for (const s of HOST_SHORTCUTS) {
        if (k !== s.key.toLowerCase()) continue;
        if (s.meta && !input.meta) continue;
        if (s.ctrl && !input.control) continue;
        if (s.alt && !input.alt) continue;
        if (s.shift && !input.shift) continue;
        event?.preventDefault();
        window.dispatchEvent(
          new globalThis.KeyboardEvent("keydown", {
            key: input.key,
            code: input.key === "Enter" ? "Enter" : `Key${input.key.toUpperCase()}`,
            metaKey: input.meta,
            ctrlKey: input.control,
            altKey: input.alt,
            shiftKey: input.shift,
            bubbles: true,
            cancelable: true,
          }),
        );
        return;
      }
    };

    wv.addEventListener("did-navigate", onNav);
    wv.addEventListener("did-navigate-in-page", onNav);
    wv.addEventListener("did-start-loading", onStartLoading);
    wv.addEventListener("did-stop-loading", onStopLoading);
    wv.addEventListener("dom-ready", updateNavState);
    wv.addEventListener("before-input-event", onBeforeInput);
    wv.addEventListener("page-title-updated", onPageTitle);

    return () => {
      wv.removeEventListener("did-navigate", onNav);
      wv.removeEventListener("did-navigate-in-page", onNav);
      wv.removeEventListener("did-start-loading", onStartLoading);
      wv.removeEventListener("did-stop-loading", onStopLoading);
      wv.removeEventListener("dom-ready", updateNavState);
      wv.removeEventListener("before-input-event", onBeforeInput);
      wv.removeEventListener("page-title-updated", onPageTitle);
      webviewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only; refs keep callbacks fresh
  }, [updateNavState]);

  // Focus URL bar when this tab becomes active
  useEffect(() => {
    if (isActive && urlInputRef.current) {
      // Don't auto-focus — just make sure the input is reachable
    }
  }, [isActive]);

  const navigateTo = useCallback((raw: string) => {
    const url = normalizeUrlInput(raw);
    const wv = webviewRef.current;
    if (wv) void wv.loadURL(url);
    setDisplayUrl(url);
    setUrlInputValue(url);
    onNavigateRef.current(tabIdRef.current, url, titleFromUrl(url));
  }, []);

  const handleSubmit = useCallback(
    (e: FormEvent) => {
      e.preventDefault();
      navigateTo(urlInputValue);
      urlInputRef.current?.blur();
    },
    [navigateTo, urlInputValue],
  );

  const handleUrlKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Escape") {
        setUrlInputValue(displayUrl);
        urlInputRef.current?.blur();
      }
    },
    [displayUrl],
  );

  const goBack = useCallback(() => webviewRef.current?.goBack(), []);
  const goForward = useCallback(() => webviewRef.current?.goForward(), []);
  const refresh = useCallback(() => webviewRef.current?.reload(), []);
  const stopLoading = useCallback(() => webviewRef.current?.stop(), []);
  const goHome = useCallback(() => navigateTo(NEW_TAB_URL), [navigateTo]);

  return (
    <div className="absolute inset-0 flex flex-col" style={{ display: isActive ? "flex" : "none" }}>
      {/* Toolbar — z-[60] above canvas overlay (z-50) */}
      <div className="relative z-[60] flex items-center gap-1 border-b border-border/50 px-1.5 py-1">
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={goBack}
          disabled={!canGoBack}
          aria-label="Go back"
          title="Go back"
        >
          <ArrowLeftIcon className="size-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={goForward}
          disabled={!canGoForward}
          aria-label="Go forward"
          title="Go forward"
        >
          <ArrowRightIcon className="size-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={isLoading ? stopLoading : refresh}
          aria-label={isLoading ? "Stop" : "Refresh"}
          title={isLoading ? "Stop" : "Refresh"}
        >
          {isLoading ? <XIcon className="size-3.5" /> : <RefreshCwIcon className="size-3.5" />}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={goHome}
          aria-label="Home"
          title="Home"
        >
          <HomeIcon className="size-3.5" />
        </Button>

        <form onSubmit={handleSubmit} className="min-w-0 flex-1">
          <input
            ref={urlInputRef}
            type="text"
            value={urlInputValue}
            onChange={(e) => setUrlInputValue(e.target.value)}
            onFocus={(e) => {
              setUrlInputFocused(true);
              e.target.select();
            }}
            onBlur={() => setUrlInputFocused(false)}
            onKeyDown={handleUrlKeyDown}
            className="w-full rounded-md border border-border/70 bg-background/80 px-2.5 py-1 text-xs text-foreground outline-none transition-colors placeholder:text-muted-foreground/50 focus:border-border focus:bg-background"
            placeholder="Search or enter URL"
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
          />
        </form>
        <ExtensionBar />
      </div>

      {/* Webview — src frozen at mount time, never re-rendered */}
      <div className="min-h-0 flex-1">
        <webview
          ref={webviewRef as React.Ref<HTMLElement>}
          src={initialSrcRef.current}
          partition="persist:browser"
          allowpopups
          style={{ width: "100%", height: "100%" }}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Local tab state hook (canvas mode — per-window, not persisted)
// ---------------------------------------------------------------------------

interface LocalTabState {
  tabs: BrowserTab[];
  activeTabId: string | null;
}

function useLocalBrowserTabs(initialUrl?: string) {
  const [state, setState] = useState<LocalTabState>(() => {
    const first: BrowserTab = {
      id: generateTabId(),
      url: initialUrl || NEW_TAB_URL,
      title: titleFromUrl(initialUrl || NEW_TAB_URL),
    };
    return { tabs: [first], activeTabId: first.id };
  });

  const addTab = useCallback((url?: string) => {
    const id = generateTabId();
    const tab: BrowserTab = { id, url: url ?? NEW_TAB_URL, title: "New Tab" };
    setState((s) => {
      if (s.tabs.length >= MAX_BROWSER_TABS) return s;
      return { tabs: [...s.tabs, tab], activeTabId: id };
    });
    return id;
  }, []);

  const closeTab = useCallback((tabId: string) => {
    setState((s) => {
      if (s.tabs.length <= 1) {
        const reset: BrowserTab = { id: generateTabId(), url: NEW_TAB_URL, title: "New Tab" };
        return { tabs: [reset], activeTabId: reset.id };
      }
      const idx = s.tabs.findIndex((t) => t.id === tabId);
      if (idx === -1) return s;
      const next = s.tabs.filter((t) => t.id !== tabId);
      let active = s.activeTabId;
      if (s.activeTabId === tabId) {
        active = idx >= next.length ? next[next.length - 1]!.id : next[idx]!.id;
      }
      return { tabs: next, activeTabId: active };
    });
  }, []);

  const setActiveTab = useCallback((tabId: string) => {
    setState((s) => ({ ...s, activeTabId: tabId }));
  }, []);

  const updateTab = useCallback((tabId: string, patch: { url?: string; title?: string }) => {
    setState((s) => ({
      ...s,
      tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, ...patch } : t)),
    }));
  }, []);

  return { ...state, addTab, closeTab, setActiveTab, updateTab };
}

// ---------------------------------------------------------------------------
// Shared keyboard shortcuts
// ---------------------------------------------------------------------------

function useBrowserKeyboardShortcuts(
  handleNewTab: () => void,
  closeTab: (id: string) => void,
  activeTabId: string | null,
  tabs: BrowserTab[],
  setActiveTab: (id: string) => void,
) {
  useEffect(() => {
    const handler = (e: globalThis.KeyboardEvent) => {
      const isMac = navigator.platform.toUpperCase().includes("MAC");
      const mod = isMac ? e.metaKey : e.ctrlKey;

      if (mod && e.key.toLowerCase() === "t" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        handleNewTab();
        return;
      }
      if (mod && e.key.toLowerCase() === "w" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        if (activeTabId) closeTab(activeTabId);
        return;
      }
      if (e.ctrlKey && e.key === "Tab") {
        e.preventDefault();
        const idx = tabs.findIndex((t) => t.id === activeTabId);
        if (idx === -1) return;
        const next = e.shiftKey ? (idx - 1 + tabs.length) % tabs.length : (idx + 1) % tabs.length;
        setActiveTab(tabs[next]!.id);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleNewTab, closeTab, activeTabId, tabs, setActiveTab]);
}

// ---------------------------------------------------------------------------
// BrowserPanel — public API
// ---------------------------------------------------------------------------

export function BrowserPanel(props?: { initialUrl?: string; onUrlChange?: (url: string) => void }) {
  if (props?.onUrlChange) {
    return (
      <LocalTabbedBrowserPanel
        {...(props.initialUrl != null ? { initialUrl: props.initialUrl } : {})}
        onUrlChange={props.onUrlChange}
      />
    );
  }
  return <GlobalTabbedBrowserPanel />;
}

// ---------------------------------------------------------------------------
// Canvas-mode (local state, per window instance)
// ---------------------------------------------------------------------------

function LocalTabbedBrowserPanel({
  initialUrl,
  onUrlChange,
}: {
  initialUrl?: string;
  onUrlChange?: (url: string) => void;
}) {
  const { tabs, activeTabId, addTab, closeTab, setActiveTab, updateTab } =
    useLocalBrowserTabs(initialUrl);

  const activeTab = tabs.find((t) => t.id === activeTabId);

  // Sync active URL to canvas store
  const onUrlChangeRef = useRef(onUrlChange);
  onUrlChangeRef.current = onUrlChange;
  useEffect(() => {
    if (activeTab) onUrlChangeRef.current?.(activeTab.url);
  }, [activeTab?.url]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleNewTab = useCallback(() => {
    addTab();
  }, [addTab]);

  useBrowserKeyboardShortcuts(handleNewTab, closeTab, activeTabId, tabs, setActiveTab);

  // Single stable callback — BrowserWebview passes tabId back
  const handleNavigate = useCallback(
    (tabId: string, url: string, title: string) => {
      updateTab(tabId, { url, title });
    },
    [updateTab],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <BrowserTabStrip
        tabs={tabs}
        activeTabId={activeTabId}
        onSelectTab={setActiveTab}
        onCloseTab={closeTab}
        onNewTab={handleNewTab}
      />
      {/* All tabs mounted — only active is visible (display:none for others).
          This gives instant tab switching. Chromium throttles hidden webviews. */}
      <div className="relative min-h-0 flex-1">
        {tabs.map((tab) => (
          <BrowserWebview
            key={tab.id}
            tabId={tab.id}
            initialUrl={tab.url}
            isActive={tab.id === activeTabId}
            onNavigate={handleNavigate}
          />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Global tabbed panel (persisted store)
// ---------------------------------------------------------------------------

function GlobalTabbedBrowserPanel() {
  const tabs = useBrowserStore((s) => s.tabs);
  const activeTabId = useBrowserStore((s) => s.activeTabId);
  const addTab = useBrowserStore((s) => s.addTab);
  const closeTab = useBrowserStore((s) => s.closeTab);
  const setActiveTab = useBrowserStore((s) => s.setActiveTab);
  const updateTab = useBrowserStore((s) => s.updateTab);

  // Legacy sync
  const storeSetBrowserUrl = useEditorStore((s) => s.setBrowserUrl);
  const activeTab = tabs.find((t) => t.id === activeTabId);
  useEffect(() => {
    if (activeTab) storeSetBrowserUrl(activeTab.url);
  }, [activeTab?.url, storeSetBrowserUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleNewTab = useCallback(() => {
    addTab();
  }, [addTab]);

  useBrowserKeyboardShortcuts(handleNewTab, closeTab, activeTabId, tabs, setActiveTab);

  // Single stable callback — BrowserWebview passes tabId back
  const handleNavigate = useCallback(
    (tabId: string, url: string, title: string) => {
      updateTab(tabId, { url, title });
    },
    [updateTab],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <BrowserTabStrip
        tabs={tabs}
        activeTabId={activeTabId}
        onSelectTab={setActiveTab}
        onCloseTab={closeTab}
        onNewTab={handleNewTab}
      />
      <div className="relative min-h-0 flex-1">
        {tabs.map((tab) => (
          <BrowserWebview
            key={tab.id}
            tabId={tab.id}
            initialUrl={tab.url}
            isActive={tab.id === activeTabId}
            onNavigate={handleNavigate}
          />
        ))}
      </div>
    </div>
  );
}
