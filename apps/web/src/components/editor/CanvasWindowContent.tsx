import { Suspense, lazy, useCallback, useEffect, useRef } from "react";
import type { CanvasWindowState } from "./canvasStore";
import { useCanvasStore } from "./canvasStore";
import { CanvasTerminal } from "./CanvasTerminal";
import { useTheme } from "~/hooks/useTheme";
import { ThreadId } from "@t3tools/contracts";
import { useStore } from "~/store";
import { useComposerDraftStore } from "~/composerDraftStore";

const BrowserPanel = lazy(() =>
  import("./BrowserPanel").then((m) => ({ default: m.BrowserPanel })),
);

// Lazy import for EditorCodeArea
const EditorCodeArea = lazy(() =>
  import("./EditorCodeArea").then((m) => ({ default: m.EditorCodeArea })),
);

// Lazy import for EditorFileTree
const EditorFileTree = lazy(() =>
  import("./EditorFileTree").then((m) => ({ default: m.EditorFileTree })),
);

// Lazy import for DiffPanel
const DiffPanel = lazy(() => import("../DiffPanel"));

// Lazy import for DiffWorkerPoolProvider
const DiffWorkerPoolProvider = lazy(() =>
  import("../DiffWorkerPoolProvider").then((m) => ({ default: m.DiffWorkerPoolProvider })),
);

// Lazy import for ChatView
const ChatView = lazy(() => import("../ChatView"));

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
  const containerRef = useRef<HTMLDivElement>(null);
  const webviewListenerAttached = useRef(false);

  const handleActivate = useCallback(() => {
    setActiveWindow(props.window.id);
  }, [props.window.id, setActiveWindow]);

  // Attach focus listener to the webview. Because the webview is lazily loaded
  // via Suspense, it may not exist in the DOM yet when this effect first runs.
  // We use a MutationObserver to detect when it appears.
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

    // Try immediately
    attachWebviewListener();

    // Watch for the webview to be added to the DOM
    const observer = new MutationObserver(() => {
      attachWebviewListener();
    });
    observer.observe(container, { childList: true, subtree: true });

    // Detect when our main window loses focus — this happens when the
    // webview gains focus (it's a separate guest process).
    const handleWindowBlur = () => {
      // Check if our container is the one that lost focus to the webview
      const webview = container.querySelector("webview");
      if (webview && document.activeElement !== webview) {
        // The webview is likely focused (Electron moves focus to guest)
        // Use a small delay to let the focus settle
        requestAnimationFrame(() => {
          handleActivate();
        });
      }
    };

    // Catch clicks on the toolbar (url bar, nav buttons) — normal DOM elements
    container.addEventListener("pointerdown", handleActivate);
    // Catch window blur which indicates webview took focus
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
          onUrlChange={(url) => updateWindow(props.window.id, { browserUrl: url })}
        />
      </Suspense>
      {/* Overlay to prevent webview from swallowing pointer events during drag */}
      {isDragging && <div className="absolute inset-0 z-50" />}
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
      <CanvasTerminal cwd={props.cwd} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Code editor content (file tree + read-only code viewer)
// ---------------------------------------------------------------------------

function CodeEditorContent(props: { window: CanvasWindowState; cwd: string | null }) {
  const { window: win, cwd } = props;
  const updateWindow = useCanvasStore((s) => s.updateWindow);
  const { resolvedTheme } = useTheme();

  const handleFileSelect = useCallback(
    (relativePath: string) => {
      updateWindow(win.id, {
        filePath: relativePath,
        title: relativePath.split("/").pop() ?? "Code Editor",
      });
    },
    [win.id, updateWindow],
  );

  if (!cwd) {
    return (
      <div className="flex h-full w-full items-center justify-center text-xs text-muted-foreground/60">
        No project selected
      </div>
    );
  }

  return (
    <div className="flex h-full w-full">
      {/* Embedded file tree */}
      <Suspense fallback={<LoadingPlaceholder label="Loading files..." />}>
        <EditorFileTree
          cwd={cwd}
          resolvedTheme={resolvedTheme === "dark" ? "dark" : "light"}
          onFileSelect={handleFileSelect}
          activeFilePath={win.filePath ?? null}
          width={200}
        />
      </Suspense>
      {/* Code viewer */}
      <div className="flex min-w-0 flex-1 flex-col">
        {win.filePath ? (
          <Suspense fallback={<LoadingPlaceholder label="Loading editor..." />}>
            <EditorCodeArea cwd={cwd} relativePath={win.filePath} />
          </Suspense>
        ) : (
          <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground/60">
            Select a file from the tree
          </div>
        )}
      </div>
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
        draftStore.clearDraftThread(typedThreadId);
      }
    };
  }, []);

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
    case "code-editor":
      return <CodeEditorContent window={win} cwd={cwd} />;
    case "diff":
      return <DiffContent windowId={win.id} />;
    default:
      return (
        <div className="flex h-full w-full items-center justify-center text-xs text-muted-foreground/60">
          Unknown window type
        </div>
      );
  }
}
