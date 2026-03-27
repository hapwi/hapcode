/**
 * AppEmbedContent — Generic webview-based embedded app component.
 *
 * Renders a status overlay while the server process is starting, a full
 * Electron webview when running, and an error state with retry when the
 * process fails. Used by the VS Code window type.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircleIcon, Loader2Icon, RefreshCwIcon, SquareIcon } from "lucide-react";
import type { CanvasWindowState } from "./canvasStore";
import { useCanvasStore } from "./canvasStore";
import { getAppDescriptor } from "./appRegistry";
import { Button } from "../ui/button";
import { readNativeApi } from "~/nativeApi";

// Keyboard shortcuts that should bubble up to the host app instead of being
// consumed by the webview guest.  We intercept these via `before-input-event`.
const HOST_SHORTCUTS: Array<{
  key: string;
  meta?: boolean;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
}> = [
  { key: "Enter", alt: true }, // Alt+Enter — fullscreen toggle
  { key: "Enter", meta: true, shift: true }, // Cmd+Shift+Enter — fullscreen (macOS)
  { key: "]", alt: true }, // Alt+] — next window
  { key: "[", alt: true }, // Alt+[ — prev window
  { key: "]", meta: true }, // Cmd+] — next window (macOS)
  { key: "[", meta: true }, // Cmd+[ — prev window (macOS)
  { key: "w", meta: true }, // Cmd+W — close window (macOS)
  { key: "w", ctrl: true }, // Ctrl+W — close window
  { key: "j", meta: true }, // Cmd+J — toggle terminal (macOS)
  { key: "j", ctrl: true }, // Ctrl+J — toggle terminal
];

// ---------------------------------------------------------------------------
// Status overlay — shown while starting or in error state
// ---------------------------------------------------------------------------

function StatusOverlay(props: {
  icon: React.ReactNode;
  label: string;
  sublabel?: string | undefined;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 text-muted-foreground">
      <div className="flex items-center gap-2">
        {props.icon}
        <span className="text-sm">{props.label}</span>
      </div>
      {props.sublabel && <span className="text-xs text-muted-foreground/60">{props.sublabel}</span>}
      {props.action}
    </div>
  );
}

// ---------------------------------------------------------------------------
// AppEmbedContent
// ---------------------------------------------------------------------------

export function AppEmbedContent(props: { window: CanvasWindowState; cwd: string | null }) {
  const { window: win, cwd } = props;
  const { appUrl, appStatus, appError, type } = win;
  const isDragging = useCanvasStore((s) => s.isDragging);
  const updateWindow = useCanvasStore((s) => s.updateWindow);
  const setActiveWindow = useCanvasStore((s) => s.setActiveWindow);
  const containerRef = useRef<HTMLDivElement>(null);
  const webviewListenerAttached = useRef(false);
  const descriptor = getAppDescriptor(type);
  const displayName = descriptor?.displayName ?? type;

  // Interaction mode: when the user clicks the webview area, we briefly
  // remove the overlay so the pointer event reaches the webview. The
  // overlay comes back after pointerup + short delay so that scroll
  // events are always captured for canvas panning.
  const [interacting, setInteracting] = useState(false);
  const interactTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const handleActivate = useCallback(() => {
    setActiveWindow(win.id);
  }, [win.id, setActiveWindow]);

  // Enter interaction mode: remove the overlay so clicks reach the webview.
  // The overlay is restored after pointerup + a short delay.
  const enterInteraction = useCallback(() => {
    handleActivate();
    setInteracting(true);
    clearTimeout(interactTimer.current);
  }, [handleActivate]);

  // Restore overlay after pointer interaction ends
  useEffect(() => {
    if (!interacting) return;
    const onPointerUp = () => {
      // Short delay to allow double-clicks and drag-start
      interactTimer.current = setTimeout(() => setInteracting(false), 200);
    };
    window.addEventListener("pointerup", onPointerUp);
    return () => {
      window.removeEventListener("pointerup", onPointerUp);
      clearTimeout(interactTimer.current);
    };
  }, [interacting]);

  // Wheel handler for the overlay: horizontal scroll → canvas panning,
  // vertical scroll → forwarded to the webview via Electron's sendInputEvent.
  const handleOverlayWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    e.stopPropagation();

    const isHorizontal = Math.abs(e.deltaX) > Math.abs(e.deltaY);

    if (isHorizontal) {
      // Horizontal trackpad scroll → scroll the parent canvas container
      const scrollContainer = containerRef.current?.closest(
        "[data-canvas-scroll-container]",
      ) as HTMLElement | null;
      if (scrollContainer) {
        scrollContainer.scrollLeft += e.deltaX;
      }
    } else {
      // Vertical scroll → forward to VS Code webview so code scrolling works
      const container = containerRef.current;
      const webview = container?.querySelector("webview") as
        | (HTMLElement & { sendInputEvent?: (event: unknown) => void })
        | null;
      if (webview?.sendInputEvent) {
        const rect = webview.getBoundingClientRect();
        webview.sendInputEvent({
          type: "mouseWheel",
          x: Math.round(rect.width / 2),
          y: Math.round(rect.height / 2),
          deltaX: 0,
          deltaY: -e.deltaY,
        });
      }
    }
  }, []);

  // Cleanup: notify the server to stop the app process when this window unmounts
  // (e.g. user closes the window). Uses a ref to capture the latest appStatus
  // so the cleanup effect doesn't re-subscribe on every status change.
  const appStatusRef = useRef(appStatus);
  appStatusRef.current = appStatus;
  const winIdRef = useRef(win.id);
  winIdRef.current = win.id;
  useEffect(() => {
    return () => {
      // Only attempt stop if the process was running or starting
      const status = appStatusRef.current;
      if (status === "running" || status === "starting") {
        const nativeApi = readNativeApi();
        if (nativeApi) {
          nativeApi.appEmbed.stop({ windowId: winIdRef.current }).catch(() => {}); // best-effort cleanup
        }
      }
    };
  }, []); // empty deps — runs on unmount only

  // Request the server to start the app process when the window mounts
  // with "starting" status and no URL yet.
  useEffect(() => {
    if (appStatus !== "starting" || appUrl || !cwd) return;

    const nativeApi = readNativeApi();
    if (!nativeApi) {
      updateWindow(win.id, {
        appStatus: "error",
        appError: "Native API not available",
      });
      return;
    }

    // Start the embedded app process via the server-side AppProcessManager.
    // The server spawns code-server, waits for it to become healthy, then
    // returns the URL for the webview to embed.
    nativeApi.appEmbed
      .start({ windowId: win.id, appType: type as "vscode" | "cursor", cwd })
      .then((result: { port: number; url: string }) => {
        updateWindow(win.id, {
          appStatus: "running",
          appUrl: result.url,
        });
      })
      .catch((err: unknown) => {
        updateWindow(win.id, {
          appStatus: "error",
          appError: err instanceof Error ? err.message : "Failed to start editor",
        });
      });
  }, [appStatus, appUrl, cwd, type, win.id, updateWindow]);

  // Webview focus detection and keyboard shortcut interception.
  // Same focus-tracking pattern as BrowserContent, plus a before-input-event
  // handler so host shortcuts (⌘[, ⌘], etc.) aren't consumed by the guest.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let attachedWebview: Element | null = null;

    // Intercept keyboard shortcuts that should go to the host app.
    // The webview's guest page normally swallows all key events — this lets
    // shortcuts like ⌘] still work to switch windows.
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
            code: input.key.length === 1 ? `Key${input.key.toUpperCase()}` : input.key,
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

    const attachWebviewListener = () => {
      const webview = container.querySelector("webview");
      if (!webview) return;
      if (webviewListenerAttached.current && attachedWebview === webview) return;
      if (attachedWebview && attachedWebview !== webview) {
        attachedWebview.removeEventListener("focus", handleActivate);
        attachedWebview.removeEventListener("dom-ready", handleActivate);
        attachedWebview.removeEventListener("before-input-event", onBeforeInput);
      }
      attachedWebview = webview;
      webviewListenerAttached.current = true;
      webview.addEventListener("focus", handleActivate);
      webview.addEventListener("dom-ready", handleActivate);
      webview.addEventListener("before-input-event", onBeforeInput);
    };

    attachWebviewListener();
    const observer = new MutationObserver(() => attachWebviewListener());
    observer.observe(container, { childList: true, subtree: true });

    const handleWindowBlur = () => {
      const webview = container.querySelector("webview");
      if (webview && document.activeElement !== webview) {
        requestAnimationFrame(() => handleActivate());
      }
    };

    container.addEventListener("pointerdown", handleActivate);
    window.addEventListener("blur", handleWindowBlur);

    return () => {
      observer.disconnect();
      if (attachedWebview) {
        attachedWebview.removeEventListener("focus", handleActivate);
        attachedWebview.removeEventListener("dom-ready", handleActivate);
        attachedWebview.removeEventListener("before-input-event", onBeforeInput);
      }
      container.removeEventListener("pointerdown", handleActivate);
      window.removeEventListener("blur", handleWindowBlur);
      webviewListenerAttached.current = false;
    };
  }, [handleActivate]);

  const handleRetry = useCallback(() => {
    updateWindow(win.id, {
      appStatus: "starting",
    });
  }, [win.id, updateWindow]);

  const handleStop = useCallback(() => {
    updateWindow(win.id, {
      appStatus: "stopped",
    });
  }, [win.id, updateWindow]);

  if (!cwd) {
    return (
      <StatusOverlay
        icon={<SquareIcon className="size-5 text-muted-foreground/40" />}
        label="No project selected"
        sublabel={`Select a project to open ${displayName}`}
      />
    );
  }

  if (appStatus === "starting") {
    return (
      <StatusOverlay
        icon={<Loader2Icon className="size-5 animate-spin" />}
        label={`Launching ${displayName}...`}
        sublabel={cwd}
      />
    );
  }

  if (appStatus === "error") {
    const errorMessage = appError ?? descriptor?.processConfig.installHint ?? "Unknown error";
    return (
      <StatusOverlay
        icon={<AlertCircleIcon className="size-5 text-destructive" />}
        label={`Failed to start ${displayName}`}
        sublabel={errorMessage}
        action={
          <Button variant="outline" size="sm" onClick={handleRetry}>
            <RefreshCwIcon className="mr-1.5 size-3" />
            Retry
          </Button>
        }
      />
    );
  }

  if (appStatus === "stopped") {
    return (
      <StatusOverlay
        icon={<SquareIcon className="size-5 text-muted-foreground/40" />}
        label={`${displayName} stopped`}
        action={
          <Button variant="outline" size="sm" onClick={handleRetry}>
            <RefreshCwIcon className="mr-1.5 size-3" />
            Restart
          </Button>
        }
      />
    );
  }

  // Running state — if we have an embed URL, show the webview
  if (appUrl) {
    // The overlay is always present EXCEPT during brief interaction mode
    // (after the user clicks, until pointerup + delay). This ensures:
    //  - Horizontal scroll always pans the canvas between window columns
    //  - Vertical scroll is forwarded to VS Code via sendInputEvent
    //  - Clicks temporarily remove the overlay so they reach the webview
    //  - Drag operations always show the overlay
    const showOverlay = isDragging || !interacting;
    return (
      <div ref={containerRef} className="relative h-full w-full">
        <webview src={appUrl} className="h-full w-full" />
        {showOverlay && (
          <div
            className="absolute inset-0 z-50"
            onWheel={handleOverlayWheel}
            onPointerDown={enterInteraction}
          />
        )}
      </div>
    );
  }

  // Running but no embed URL — editor was launched externally
  return (
    <div
      ref={containerRef}
      className="flex h-full w-full flex-col items-center justify-center gap-3"
    >
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <div className="size-2 rounded-full bg-green-500" />
        <span>{displayName} launched externally</span>
      </div>
      <p className="max-w-xs text-center text-xs text-muted-foreground/60">
        {displayName} is running as an external application. The editor window will open separately.
      </p>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={handleRetry}>
          <RefreshCwIcon className="mr-1.5 size-3" />
          Relaunch
        </Button>
        <Button variant="outline" size="sm" onClick={handleStop}>
          <SquareIcon className="mr-1.5 size-3" />
          Close
        </Button>
      </div>
    </div>
  );
}
