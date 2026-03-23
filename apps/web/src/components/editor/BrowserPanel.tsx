import {
  ArrowLeftIcon,
  ArrowRightIcon,
  BlocksIcon,
  HomeIcon,
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

/**
 * Electron <webview> element type helpers.
 *
 * The webview tag is an Electron-specific element that hosts an isolated
 * guest page.  React doesn't ship built-in types for it, so we declare a
 * minimal interface covering the APIs we use and augment JSX so TSX accepts
 * the element.
 */
interface WebviewElement extends HTMLElement {
  src: string;
  getURL(): string;
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
          /** Comma-separated list of permissions to allow in the guest page */
          webpreferences?: string;
        },
        HTMLElement
      >;
    }
  }
}

const DEFAULT_URL = "about:blank";

// Keyboard shortcuts that should bubble up to the host app instead of being
// consumed by the webview guest.  We intercept these via `before-input-event`.
const HOST_SHORTCUTS: Array<{
  key: string;
  meta?: boolean;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
}> = [
  { key: "d", meta: true }, // Cmd+D  — toggle panel (macOS)
  { key: "d", ctrl: true }, // Ctrl+D — toggle panel (Windows/Linux)
  { key: "l", meta: true }, // Cmd+L  — focus URL bar
  { key: "l", ctrl: true }, // Ctrl+L — focus URL bar
  { key: "Enter", alt: true }, // Alt+Enter — fullscreen toggle
  { key: "Enter", meta: true, shift: true }, // Cmd+Shift+Enter — fullscreen toggle (macOS)
  { key: "]", alt: true }, // Alt+] — next window
  { key: "[", alt: true }, // Alt+[ — prev window
  { key: "]", meta: true }, // Cmd+] — next window (macOS)
  { key: "[", meta: true }, // Cmd+[ — prev window (macOS)
];

function normalizeUrlInput(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return DEFAULT_URL;

  // Already has a protocol
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;

  // Looks like a domain or localhost with optional port
  if (/^(localhost|[\w-]+\.[\w-]+)(:\d+)?(\/|$)/i.test(trimmed)) {
    return `http://${trimmed}`;
  }

  // Treat as search query - use Google
  return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
}

/** Fetch loaded extensions from the main process via IPC. */
function getDesktopBridge() {
  return (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).desktopBridge as
      | { getBrowserExtensions?: () => Promise<BrowserExtensionInfo[]> }
      | undefined
  );
}

// ---------------------------------------------------------------------------
// Extension toolbar
// ---------------------------------------------------------------------------

function ExtensionBar() {
  const [extensions, setExtensions] = useState<BrowserExtensionInfo[]>([]);
  const [showDropdown, setShowDropdown] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Load extensions on mount
  useEffect(() => {
    const bridge = getDesktopBridge();
    if (bridge?.getBrowserExtensions) {
      void bridge.getBrowserExtensions().then(setExtensions);
    }
  }, []);

  // Close dropdown when clicking outside or when the webview takes focus
  useEffect(() => {
    if (!showDropdown) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
      }
    };
    // The webview swallows mouse events so clicks inside it won't fire on
    // `document`.  Closing on blur/focusout catches the case where the user
    // clicks back into the webview (which steals focus from our window).
    const handleBlur = () => {
      // Small delay so that clicking the extension button itself can toggle
      // before the blur fires.
      setTimeout(() => setShowDropdown(false), 150);
    };
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
        <div className="absolute right-0 top-full z-50 mt-1 w-64 rounded-lg border border-border bg-popover shadow-lg">
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
              functionality (popups, service workers, etc. are not fully supported).
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// BrowserPanel
// ---------------------------------------------------------------------------

export function BrowserPanel(props?: { initialUrl?: string; onUrlChange?: (url: string) => void }) {
  const storeBrowserUrl = useEditorStore((s) => s.browserUrl);
  const storeSetBrowserUrl = useEditorStore((s) => s.setBrowserUrl);

  // When scoped props are provided (canvas mode), use them instead of global store
  const browserUrl = props?.initialUrl ?? storeBrowserUrl;
  const setBrowserUrl = props?.onUrlChange ?? storeSetBrowserUrl;
  const webviewRef = useRef<WebviewElement | null>(null);
  const urlInputRef = useRef<HTMLInputElement | null>(null);
  const [displayUrl, setDisplayUrl] = useState(browserUrl || DEFAULT_URL);
  const [urlInputValue, setUrlInputValue] = useState(browserUrl || DEFAULT_URL);
  const [urlInputFocused, setUrlInputFocused] = useState(false);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  const updateNavState = useCallback(() => {
    const wv = webviewRef.current;
    if (!wv) return;
    try {
      setCanGoBack(wv.canGoBack());
      setCanGoForward(wv.canGoForward());
      setIsLoading(wv.isLoading());
    } catch {
      // webview may not be ready yet
    }
  }, []);

  useEffect(() => {
    const wv = webviewRef.current;
    if (!wv) return;

    const onNavigate = () => {
      try {
        const currentUrl = wv.getURL();
        setDisplayUrl(currentUrl);
        setBrowserUrl(currentUrl);
        if (!urlInputFocused) {
          setUrlInputValue(currentUrl);
        }
        updateNavState();
      } catch {
        // webview may not be ready
      }
    };

    const onStartLoading = () => {
      setIsLoading(true);
    };

    const onStopLoading = () => {
      setIsLoading(false);
      onNavigate();
    };

    // Intercept keyboard shortcuts that should go to the host app.
    // The webview's guest page normally swallows all key events — this lets
    // shortcuts like Cmd+D still work to toggle the panel.
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
      if (!input) return;
      if (input.type !== "keyDown") return;
      const k = input.key.toLowerCase();

      // Cmd/Ctrl+L → focus the URL bar (handled internally)
      if (
        (k === "l" && input.meta && process.platform === "darwin") ||
        (k === "l" && input.control && process.platform !== "darwin")
      ) {
        event?.preventDefault();
        urlInputRef.current?.focus();
        urlInputRef.current?.select();
        return;
      }

      // For other host shortcuts, prevent the webview from consuming the
      // keystroke and re-dispatch it so the host app's keydown listener
      // (CanvasWorkspace, ChatView, etc.) can pick it up.
      for (const s of HOST_SHORTCUTS) {
        if (k !== s.key.toLowerCase()) continue;
        if (s.meta && !input.meta) continue;
        if (s.ctrl && !input.control) continue;
        if (s.alt && !input.alt) continue;
        if (s.shift && !input.shift) continue;
        // Stop the webview guest page from handling this key
        event?.preventDefault();
        // Re-dispatch to host window so CanvasWorkspace's handler sees it
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

    wv.addEventListener("did-navigate", onNavigate);
    wv.addEventListener("did-navigate-in-page", onNavigate);
    wv.addEventListener("did-start-loading", onStartLoading);
    wv.addEventListener("did-stop-loading", onStopLoading);
    wv.addEventListener("dom-ready", updateNavState);
    wv.addEventListener("before-input-event", onBeforeInput);

    return () => {
      wv.removeEventListener("did-navigate", onNavigate);
      wv.removeEventListener("did-navigate-in-page", onNavigate);
      wv.removeEventListener("did-start-loading", onStartLoading);
      wv.removeEventListener("did-stop-loading", onStopLoading);
      wv.removeEventListener("dom-ready", updateNavState);
      wv.removeEventListener("before-input-event", onBeforeInput);
    };
  }, [setBrowserUrl, updateNavState, urlInputFocused]);

  const navigateTo = useCallback(
    (raw: string) => {
      const url = normalizeUrlInput(raw);
      const wv = webviewRef.current;
      if (wv) {
        void wv.loadURL(url);
      }
      setDisplayUrl(url);
      setBrowserUrl(url);
      setUrlInputValue(url);
    },
    [setBrowserUrl],
  );

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
  const goHome = useCallback(() => navigateTo(DEFAULT_URL), [navigateTo]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Browser toolbar */}
      <div className="flex items-center gap-1 border-b border-border/50 px-1.5 py-1">
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
          aria-label={isLoading ? "Stop loading" : "Refresh"}
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

        {/* URL bar */}
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

        {/* Extension manager button */}
        <ExtensionBar />
      </div>

      {/* Webview container */}
      <div className="min-h-0 flex-1">
        <webview
          ref={webviewRef as React.Ref<HTMLElement>}
          src={browserUrl || DEFAULT_URL}
          partition="persist:browser"
          allowpopups
          style={{ width: "100%", height: "100%" }}
        />
      </div>
    </div>
  );
}
