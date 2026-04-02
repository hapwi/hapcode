import { Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";
import { PlusIcon } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { DEFAULT_RUNTIME_MODE, ThreadId } from "@t3tools/contracts";
import { inferProviderForModel } from "@t3tools/shared/model";
import type { CanvasWindowState } from "./canvasStore";
import { useCanvasStore } from "./canvasStore";
import { CanvasTerminal } from "./CanvasTerminal";

import { useStore } from "~/store";
import { useComposerDraftStore } from "~/composerDraftStore";
import { newThreadId } from "~/lib/utils";

const BrowserPanel = lazy(() =>
  import("./BrowserPanel").then((m) => ({ default: m.BrowserPanel })),
);

// Lazy import for DiffPanel
const DiffPanel = lazy(() => import("../DiffPanel"));

// Lazy import for DiffWorkerPoolProvider
const DiffWorkerPoolProvider = lazy(() =>
  import("../DiffWorkerPoolProvider").then((m) => ({ default: m.DiffWorkerPoolProvider })),
);

// Lazy import for ChatView
const ChatView = lazy(() => import("../ChatView"));

// Lazy import for CanvasGitHub
const CanvasGitHub = lazy(() =>
  import("./CanvasGitHub").then((m) => ({ default: m.CanvasGitHub })),
);

// Lazy import for AppEmbedContent (VS Code)
const AppEmbedContent = lazy(() =>
  import("./AppEmbedContent").then((m) => ({ default: m.AppEmbedContent })),
);

// ---------------------------------------------------------------------------
// Loading states
// ---------------------------------------------------------------------------

function LoadingPlaceholder({ label }: { label: string }) {
  return (
    <div className="flex h-full w-full items-center justify-center text-xs text-muted-foreground/60">
      {label}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Browser content
// ---------------------------------------------------------------------------

function BrowserContent(props: { window: CanvasWindowState }) {
  const updateWindow = useCanvasStore((s) => s.updateWindow);
  const setActiveWindow = useCanvasStore((s) => s.setActiveWindow);
  const isDragging = useCanvasStore((s) => s.isDragging);
  const isActiveWindow = useCanvasStore((s) => {
    const scope = s.scopes[s.currentScopeKey];
    return scope?.activeWindowId === props.window.id;
  });
  const containerRef = useRef<HTMLDivElement>(null);
  const webviewListenerAttached = useRef(false);

  // Stable callback so BrowserPanel doesn't re-render on every parent render
  const windowIdRef = useRef(props.window.id);
  windowIdRef.current = props.window.id;
  const handleUrlChange = useCallback(
    (url: string) => updateWindow(windowIdRef.current, { browserUrl: url }),
    [updateWindow],
  );

  // Interaction mode: once the window is activated by a click, the overlay
  // stays hidden so the browser chrome (tab strip, toolbar, URL bar) remains
  // fully interactive.  The overlay only returns when:
  //   • A canvas drag starts (blocks accidental webview interaction)
  //   • The window becomes inactive (another window is selected)
  const [interacting, setInteracting] = useState(false);

  const handleActivate = useCallback(() => {
    setActiveWindow(props.window.id);
  }, [props.window.id, setActiveWindow]);

  const enterInteraction = useCallback(() => {
    handleActivate();
    setInteracting(true);
  }, [handleActivate]);

  // Reset interaction when a drag starts or the window becomes inactive
  useEffect(() => {
    if (isDragging || !isActiveWindow) {
      setInteracting(false);
    }
  }, [isDragging, isActiveWindow]);

  const handleOverlayWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const isHorizontal = Math.abs(e.deltaX) > Math.abs(e.deltaY);
    if (isHorizontal) {
      const scrollContainer = containerRef.current?.closest(
        "[data-canvas-scroll-container]",
      ) as HTMLElement | null;
      if (scrollContainer) {
        scrollContainer.scrollLeft += e.deltaX;
      }
    } else {
      const webview = containerRef.current?.querySelector("webview") as
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

  // Attach focus listener to the webview (lazily loaded via Suspense).
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let attachedWebview: Element | null = null;

    const attachWebviewListener = () => {
      const webview = container.querySelector("webview");
      if (!webview) return;
      if (webviewListenerAttached.current && attachedWebview === webview) return;
      if (attachedWebview && attachedWebview !== webview) {
        attachedWebview.removeEventListener("focus", handleActivate);
        attachedWebview.removeEventListener("dom-ready", handleActivate);
      }
      attachedWebview = webview;
      webviewListenerAttached.current = true;
      webview.addEventListener("focus", handleActivate);
      webview.addEventListener("dom-ready", handleActivate);
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
      }
      container.removeEventListener("pointerdown", handleActivate);
      window.removeEventListener("blur", handleWindowBlur);
      webviewListenerAttached.current = false;
    };
  }, [handleActivate]);

  return (
    <div ref={containerRef} className="relative flex h-full w-full flex-col">
      <Suspense fallback={<LoadingPlaceholder label="Loading browser..." />}>
        <BrowserPanel
          {...(props.window.browserUrl ? { initialUrl: props.window.browserUrl } : {})}
          onUrlChange={handleUrlChange}
        />
      </Suspense>
      {/* Overlay: only shown during drag OR when the window isn't active yet.
          Once the user clicks to activate, it stays hidden so all browser
          chrome (tabs, toolbar, URL bar) remains interactive. */}
      {(isDragging || !interacting) && (
        <div
          className="absolute inset-0 z-50"
          onWheel={handleOverlayWheel}
          onPointerDown={enterInteraction}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Terminal content
// ---------------------------------------------------------------------------

function TerminalContent(props: { cwd: string | null; windowId: string }) {
  const setActiveWindow = useCanvasStore((s) => s.setActiveWindow);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleFocus = () => {
      setActiveWindow(props.windowId);
    };

    // xterm.js uses focusin — catch it at the container level
    container.addEventListener("focusin", handleFocus);
    container.addEventListener("pointerdown", handleFocus);

    return () => {
      container.removeEventListener("focusin", handleFocus);
      container.removeEventListener("pointerdown", handleFocus);
    };
  }, [props.windowId, setActiveWindow]);

  return (
    <div ref={containerRef} className="h-full w-full">
      <CanvasTerminal cwd={props.cwd} windowId={props.windowId} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Diff content
// ---------------------------------------------------------------------------

function DiffContent(_props: { windowId: string }) {
  return (
    <div className="flex h-full w-full flex-col overflow-auto">
      <Suspense fallback={<LoadingPlaceholder label="Loading diff viewer..." />}>
        <DiffWorkerPoolProvider>
          <DiffPanel mode="sheet" />
        </DiffWorkerPoolProvider>
      </Suspense>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chat content
// ---------------------------------------------------------------------------

function ChatContent(props: { window: CanvasWindowState }) {
  const { window: win } = props;
  const threadId = win.threadId;
  const threadIdRef = useRef(threadId);
  threadIdRef.current = threadId;
  const updateWindow = useCanvasStore((s) => s.updateWindow);
  const removeWindow = useCanvasStore((s) => s.removeWindow);

  // Check if the thread actually exists (either as a real thread or a draft)
  const threadExists = useStore((store) => {
    if (!threadId) return false;
    return store.threads.some((t) => t.id === threadId);
  });
  const draftThreadExists = useComposerDraftStore((store) => {
    if (!threadId) return false;
    return Object.hasOwn(store.draftThreadsByThreadId, threadId);
  });

  // Remove orphaned chat windows whose thread no longer exists (e.g. an empty
  // draft that was cleaned up while this window was in an inactive canvas scope).
  const threadsHydrated = useStore((store) => store.threadsHydrated);
  useEffect(() => {
    if (!threadsHydrated) return;
    if (threadId && !threadExists && !draftThreadExists) {
      removeWindow(win.id);
    }
  }, [threadId, threadExists, draftThreadExists, threadsHydrated, removeWindow, win.id]);

  // Sync window title with thread title
  const threadTitle = useStore((store) => {
    if (!threadId) return null;
    const thread = store.threads.find((t) => t.id === threadId);
    return thread?.title ?? null;
  });

  useEffect(() => {
    if (threadTitle && threadTitle !== win.title) {
      updateWindow(win.id, { title: threadTitle });
    }
  }, [threadTitle, win.id, win.title, updateWindow]);

  // Clean up empty draft threads when the chat window is closed (unmount).
  // If the user never typed anything, there's no reason to keep the draft around.
  // Skip the cleanup if another canvas window is still showing the same thread,
  // otherwise that window's orphan-detection would fire and close it too.
  useEffect(() => {
    return () => {
      const tid = threadIdRef.current;
      if (!tid) return;
      const typedThreadId = ThreadId.makeUnsafe(tid);
      const draftStore = useComposerDraftStore.getState();
      const draftThread = draftStore.draftThreadsByThreadId[typedThreadId];
      if (!draftThread) return; // not a draft (already a server thread)
      const draft = draftStore.draftsByThreadId[typedThreadId];
      const hasContent =
        (draft?.prompt ?? "").trim().length > 0 ||
        (draft?.images ?? []).length > 0 ||
        (draft?.terminalContexts ?? []).length > 0;
      if (!hasContent) {
        // Only clear the draft if no other canvas window is still showing this thread.
        const canvasState = useCanvasStore.getState();
        const allWindows = Object.values(canvasState.scopes).flatMap((scope) =>
          scope.workspaces.flatMap((ws) => ws.windows),
        );
        const otherWindowWithSameThread = allWindows.some(
          (w) => w.threadId === tid && w.id !== win.id,
        );
        if (!otherWindowWithSameThread) {
          draftStore.clearDraftThread(typedThreadId);
        }
      }
    };
  }, [win.id]);

  if (!threadId) {
    return (
      <div className="flex h-full w-full items-center justify-center text-xs text-muted-foreground/60">
        No thread selected
      </div>
    );
  }

  return (
    <div className="absolute inset-0 flex flex-col overflow-hidden">
      <Suspense fallback={<LoadingPlaceholder label="Loading chat..." />}>
        <ChatView key={threadId} threadId={ThreadId.makeUnsafe(threadId)} />
      </Suspense>
    </div>
  );
}

// ---------------------------------------------------------------------------
// NewThreadButton — shown in chat window title bars
// ---------------------------------------------------------------------------

export function NewThreadButton(props: { window: CanvasWindowState }) {
  const { window: win } = props;
  const navigate = useNavigate();
  const updateWindow = useCanvasStore((s) => s.updateWindow);
  const stickyModel = useComposerDraftStore((s) => s.stickyModel);
  const stickyModelOptions = useComposerDraftStore((s) => s.stickyModelOptions);

  // Resolve projectId from this window's thread (not the route's thread)
  const windowThreadId = win.threadId;
  const projectId = useStore((store) => {
    if (!windowThreadId) return null;
    const thread = store.threads.find((t) => t.id === windowThreadId);
    return thread?.projectId ?? null;
  });
  const draftProjectId = useComposerDraftStore((store) => {
    if (!windowThreadId) return null;
    const draft = store.draftThreadsByThreadId[ThreadId.makeUnsafe(windowThreadId)];
    return draft?.projectId ?? null;
  });
  const resolvedProjectId = projectId ?? draftProjectId;

  // Get the current thread's model so the new thread inherits it
  const currentModel = useStore((store) => {
    if (!windowThreadId) return null;
    const thread = store.threads.find((t) => t.id === windowThreadId);
    return thread?.model ?? null;
  });
  const currentDraftModel = useComposerDraftStore((store) => {
    if (!windowThreadId) return null;
    return store.draftsByThreadId[ThreadId.makeUnsafe(windowThreadId)]?.model ?? null;
  });
  const activeProjectModel = useStore((store) => {
    if (!resolvedProjectId) return null;
    const project = store.projects.find((p) => p.id === resolvedProjectId);
    return project?.model ?? null;
  });

  const onNewThread = useCallback(() => {
    if (!resolvedProjectId) return;

    const { setModel, setModelOptions, setProvider, setProjectDraftThreadId } =
      useComposerDraftStore.getState();

    const threadId = newThreadId();
    const createdAt = new Date().toISOString();
    const initialModel = stickyModel ?? currentDraftModel ?? currentModel ?? activeProjectModel;

    // 1. Create the draft thread
    setProjectDraftThreadId(resolvedProjectId, threadId, {
      createdAt,
      branch: null,
      worktreePath: null,
      envMode: "local",
      runtimeMode: DEFAULT_RUNTIME_MODE,
    });

    // 2. Carry over model settings
    if (initialModel) {
      setProvider(threadId, inferProviderForModel(initialModel));
      setModel(threadId, initialModel);
    }
    if (Object.keys(stickyModelOptions).length > 0) {
      setModelOptions(threadId, stickyModelOptions);
    }

    // 3. Update THIS window to point to the new thread BEFORE navigating.
    //    This way ensureChatWindow (triggered by EditorPanel on route change)
    //    finds this window already owns the new threadId and won't create another.
    updateWindow(win.id, { threadId, title: "New Thread" });

    // 4. Navigate to the new thread
    navigate({ to: "/$threadId", params: { threadId } });
  }, [
    resolvedProjectId,
    stickyModel,
    stickyModelOptions,
    currentDraftModel,
    currentModel,
    activeProjectModel,
    updateWindow,
    win.id,
    navigate,
  ]);

  if (!resolvedProjectId) return null;

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onNewThread();
      }}
      className="flex size-4 items-center justify-center rounded text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
      aria-label="New Thread"
      title="New Thread"
    >
      <PlusIcon className="size-2.5" />
    </button>
  );
}

// ---------------------------------------------------------------------------
// CanvasWindowContent — routes to the right content by type
// ---------------------------------------------------------------------------

export function CanvasWindowContent(props: { window: CanvasWindowState; cwd: string | null }) {
  const { window: win, cwd } = props;

  switch (win.type) {
    case "chat":
      return <ChatContent window={win} />;
    case "browser":
      return <BrowserContent window={win} />;
    case "terminal":
      return <TerminalContent cwd={cwd} windowId={win.id} />;

    case "diff":
      return <DiffContent windowId={win.id} />;
    case "github":
      return (
        <Suspense fallback={<LoadingPlaceholder label="Loading GitHub..." />}>
          <CanvasGitHub window={win} cwd={cwd} />
        </Suspense>
      );
    case "vscode":
      return (
        <Suspense fallback={<LoadingPlaceholder label="Loading VS Code..." />}>
          <AppEmbedContent window={win} cwd={cwd} />
        </Suspense>
      );
    default:
      return (
        <div className="flex h-full w-full items-center justify-center text-xs text-muted-foreground/60">
          Unknown window type
        </div>
      );
  }
}
