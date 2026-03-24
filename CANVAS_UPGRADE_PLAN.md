# Canvas Upgrade Plan — Overview Mode, Camera System, App Embedding & Resize HUD

> Inspired by IDX0's Niri tiled canvas. Adapted for hapcode's React/Zustand/Electron architecture.

---

## Table of Contents

1. [Feature 1: Camera System](#feature-1-camera-system)
2. [Feature 2: App Embedding (VS Code & Cursor)](#feature-2-app-embedding-vs-code--cursor)
3. [Feature 3: Resize Visualizer HUD](#feature-3-resize-visualizer-hud)
4. [Implementation Order](#implementation-order)
5. [TODO Checklist](#todo-checklist)

---

## Feature 1: Camera System

### What It Does

Replace the current DOM scroll-based panning with a **virtual camera** that positions all canvas content via CSS transforms. This gives us smooth spring-animated navigation, velocity-based snapping between columns, and the foundation needed for overview mode's zoom.

### Current State

- Canvas is a `div` with `overflow-x-auto overflow-y-hidden`
- Horizontal navigation via native scroll (`container.scrollLeft`)
- Middle-click pan with momentum (friction-based `requestAnimationFrame` loop)
- Wheel events on background converted from deltaY → scrollLeft
- Scroll-into-view uses `container.scrollTo({ behavior: "smooth" })`

### Target State

- Canvas content wrapper positioned via `transform: translate3d(x, y, 0) scale(s)`
- Camera state in Zustand: `{ offsetX, offsetY, scale, transientX, transientY }`
- Spring-animated transitions (using `requestAnimationFrame` + spring physics or CSS spring())
- Velocity-based column snapping on trackpad/mouse release
- Keyboard navigation (←/→) animates camera to center the target window
- `scale` defaults to `1.0`, set to overview scale (e.g. `0.5`) when in overview mode

### Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `apps/web/src/components/editor/cameraStore.ts` | **Create** | Zustand store for camera state (offsetX, offsetY, scale, transientX, transientY, velocity, isAnimating) |
| `apps/web/src/components/editor/cameraPhysics.ts` | **Create** | Spring interpolation, velocity tracking, snap-to-column logic |
| `apps/web/src/components/editor/CanvasViewport.tsx` | **Create** | New wrapper component that applies `transform` to children, handles wheel/pan/gesture input |
| `apps/web/src/components/editor/CanvasWorkspace.tsx` | **Modify** | Replace `scrollContainerRef` + overflow scroll with `<CanvasViewport>` wrapper. Remove momentum scroll code. Delegate pan/wheel to camera. |
| `apps/web/src/components/editor/canvasStore.ts` | **Modify** | Remove `scrollTrigger` (camera handles focus-scroll now). Add `focusWindow(windowId)` that tells camera to center on a window. |

### Architecture Details

```
CanvasWorkspace
└── CanvasViewport (captures input, applies transform)
    └── <div style="transform: translate3d(camX, camY, 0) scale(camScale)">
        └── columns layout (same as today, but no overflow scroll)
```

**Camera Store Shape:**
```ts
interface CameraState {
  // Persistent offset (where the camera "is")
  offsetX: number;
  offsetY: number;
  scale: number; // 1.0 = normal, 0.5 = overview

  // Transient offset (spring animation in progress)
  transientX: number;
  transientY: number;

  // Velocity tracking for momentum/snapping
  velocityX: number;
  velocityY: number;

  // Actions
  panBy: (dx: number, dy: number) => void;
  panTo: (x: number, y: number, animated?: boolean) => void;
  setScale: (scale: number, animated?: boolean) => void;
  snapToColumn: (columnIndex: number) => void;
  focusWindow: (windowId: string) => void;
  commitPan: () => void; // merge transient into offset
}
```

**Spring Physics:**
```ts
// Interpolating spring (like IDX0)
function springStep(current: number, target: number, velocity: number, config: SpringConfig): { value: number; velocity: number } {
  const { stiffness, damping } = config;
  const displacement = current - target;
  const springForce = -stiffness * displacement;
  const dampingForce = -damping * velocity;
  const acceleration = springForce + dampingForce;
  const newVelocity = velocity + acceleration * DT;
  const newValue = current + newVelocity * DT;
  return { value: newValue, velocity: newVelocity };
}
```

**Snap Logic:**
- On pan end, calculate projected position from velocity
- Find nearest column boundary
- Spring-animate to that position
- Threshold: ~200px/sec minimum velocity for snap (otherwise stay put)

### Migration Strategy

1. Build `CanvasViewport` as opt-in wrapper (feature flag `useCamera`)
2. Move pan/wheel handlers from `WorkspaceScrollArea` into `CanvasViewport`
3. Replace `scrollTo` calls with `cameraStore.focusWindow(id)`
4. Remove `scrollTrigger` from canvas store
5. Test scroll-into-view, keyboard nav, new window auto-scroll all work via camera
6. Remove feature flag, delete old scroll code

---

## Feature 2: App Embedding (VS Code & Cursor)

### What It Does

Replace the current read-only code editor window type with embeddable web-based editors:
- **VS Code** via [code-server](https://github.com/coder/code-server) (self-hosted VS Code in browser)
- **Cursor** via its web/server mode (if available) or as a webview to a local dev server

These render as full editor experiences inside canvas windows using Electron's `<webview>` tag (same as the browser window type already does).

### Current State

- `code-editor` window type: read-only file viewer with `EditorFileTree` (200px sidebar) + `EditorCodeArea` (syntax-highlighted read-only)
- `browser` window type: Electron `<webview>` with toolbar (back/forward/reload/URL bar)
- No external editor embedding

### Target State

- New window types: `"vscode"` and `"cursor"`
- Each uses `<webview>` pointing at a local server URL
- **VS Code**: spawn code-server process, embed at `http://localhost:{port}`
- **Cursor**: if Cursor exposes a web UI, embed similarly; otherwise open as external app and provide a status tile
- App registry pattern (inspired by IDX0's `NiriAppRegistry`) for adding more editors later
- Each app tile has: status indicator (starting/running/error), retry button, stop button
- Lifecycle managed server-side (server spawns/monitors the process, client displays the webview)

### Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `apps/web/src/components/editor/canvasStore.ts` | **Modify** | Add `"vscode" \| "cursor"` to `CanvasWindowType`. Add `appUrl?: string` and `appStatus?: "starting" \| "running" \| "error" \| "stopped"` to `CanvasWindowState`. |
| `apps/web/src/components/editor/CanvasWindowContent.tsx` | **Modify** | Add cases for `"vscode"` and `"cursor"` that render `<AppEmbedContent>`. |
| `apps/web/src/components/editor/AppEmbedContent.tsx` | **Create** | Generic webview-based app embed component. Shows status overlay while starting, webview when running, error state with retry. |
| `apps/web/src/components/editor/appRegistry.ts` | **Create** | App descriptor registry (display name, icon, default URL pattern, server-side process type). |
| `apps/web/src/components/editor/CanvasAddMenu.tsx` | **Modify** | Add VS Code and Cursor to the add menu. |
| `apps/server/src/appProcessManager.ts` | **Create** | Server-side process manager. Spawns code-server, tracks port/PID, health checks, exposes status via WebSocket. |
| `packages/contracts/src/appEmbed.ts` | **Create** | Shared types for app embed protocol (start/stop/status messages). |

### Architecture Details

**App Registry:**
```ts
// appRegistry.ts
export interface AppDescriptor {
  type: CanvasWindowType;
  displayName: string;
  icon: LucideIcon;
  hotkey?: string;
  hotkeyLabel?: string;
  // How to determine the URL once the server process is ready
  urlPattern: (port: number) => string;
  // Server-side process config
  processConfig: {
    command: string; // e.g. "code-server"
    args: (opts: { cwd: string; port: number }) => string[];
    healthCheckUrl: (port: number) => string;
    installHint: string; // shown if command not found
  };
}

export const APP_REGISTRY: AppDescriptor[] = [
  {
    type: "vscode",
    displayName: "VS Code",
    icon: CodeIcon,
    hotkey: "⌘⇧V",
    hotkeyLabel: "v",
    urlPattern: (port) => `http://localhost:${port}/?folder=${encodeURIComponent(cwd)}`,
    processConfig: {
      command: "code-server",
      args: ({ cwd, port }) => ["--port", String(port), "--auth", "none", "--disable-telemetry", cwd],
      healthCheckUrl: (port) => `http://localhost:${port}/healthz`,
      installHint: "Install code-server: npm install -g code-server",
    },
  },
  {
    type: "cursor",
    displayName: "Cursor",
    icon: MousePointerIcon,
    hotkey: "⌘⇧C",
    hotkeyLabel: "c",
    urlPattern: (port) => `http://localhost:${port}`,
    processConfig: {
      command: "cursor-server", // TBD — depends on Cursor's server mode
      args: ({ cwd, port }) => ["--port", String(port), cwd],
      healthCheckUrl: (port) => `http://localhost:${port}/healthz`,
      installHint: "Cursor web server mode is experimental",
    },
  },
];
```

**Server-Side Process Manager:**
```ts
// appProcessManager.ts — runs on the server
class AppProcessManager {
  private processes: Map<string, {
    proc: ChildProcess;
    port: number;
    status: "starting" | "running" | "error" | "stopped";
    windowId: string;
  }> = new Map();

  async start(windowId: string, appType: string, cwd: string): Promise<{ port: number }> {
    const port = await getAvailablePort();
    const descriptor = APP_REGISTRY.find(a => a.type === appType);
    if (!descriptor) throw new Error(`Unknown app type: ${appType}`);

    const proc = spawn(descriptor.processConfig.command, descriptor.processConfig.args({ cwd, port }));
    this.processes.set(windowId, { proc, port, status: "starting", windowId });

    // Poll health endpoint
    await this.waitForHealthy(windowId, descriptor.processConfig.healthCheckUrl(port));
    return { port };
  }

  async stop(windowId: string): Promise<void> { /* kill process */ }
  getStatus(windowId: string): AppStatus { /* return current status */ }
}
```

**Client-Side Embed Component:**
```tsx
// AppEmbedContent.tsx
function AppEmbedContent({ window, cwd }: { window: CanvasWindowState; cwd: string | null }) {
  const { appUrl, appStatus } = window;
  const isDragging = useCanvasStore((s) => s.isDragging);

  if (appStatus === "starting") {
    return <StatusOverlay icon={<Spinner />} label="Starting VS Code..." />;
  }

  if (appStatus === "error") {
    return <StatusOverlay icon={<AlertIcon />} label="Failed to start" action={<RetryButton />} />;
  }

  if (!appUrl) {
    return <StatusOverlay icon={<CodeIcon />} label="Initializing..." />;
  }

  return (
    <div className="relative h-full w-full">
      <webview src={appUrl} className="h-full w-full" />
      {isDragging && <div className="absolute inset-0 z-50" />}
    </div>
  );
}
```

**Communication Flow:**
```
1. User clicks "VS Code" in add menu
2. canvasStore.addWindow("vscode") → creates window with appStatus: "starting"
3. Client sends WebSocket message: { type: "app.start", windowId, appType: "vscode", cwd }
4. Server spawns code-server, polls health endpoint
5. Server sends back: { type: "app.started", windowId, port: 8443, url: "http://localhost:8443" }
6. Client updates window: { appUrl: "http://localhost:8443", appStatus: "running" }
7. webview renders the full VS Code editor
8. On window close: client sends { type: "app.stop", windowId }, server kills process
```

### Migration: Existing Code Editor

The existing `code-editor` type stays as-is (it's a lightweight read-only viewer — still useful). VS Code and Cursor are new, separate types for full editing.

---

## Feature 3: Resize Visualizer HUD

### What It Does

When a user is actively resizing a window (dragging edge/corner handles), show a floating **heads-up display** with:
- A miniature viewport preview showing all columns with the resizing column highlighted
- The current width × height dimensions in pixels
- A percentage of viewport width
- Warning indicator if the window exceeds viewport bounds

### Current State

- Resize handles on right edge, bottom edge, and corner of each `CanvasWindow`
- Direct pointer event tracking → updates `window.width` / `window.height` in store
- No visual feedback beyond the window itself changing size
- `isDragging` boolean in canvas store (set during resize and title-bar drag)

### Target State

- **HUD appears** when any resize handle is being dragged
- **Position**: fixed at top-center of canvas viewport (doesn't scroll with canvas)
- **Shows**: mini-map of columns + resize dimension readout
- **Disappears** with a brief fade when resize ends
- Lightweight — no perf impact on resize (reads from store, doesn't cause extra re-renders in windows)

### Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `apps/web/src/components/editor/ResizeHUD.tsx` | **Create** | The HUD component. Renders mini-map + dimensions. |
| `apps/web/src/components/editor/canvasStore.ts` | **Modify** | Add `resizingWindowId: string \| null` and `resizeDimensions: { width: number; height: number } \| null` to state. Set on resize start/move/end. |
| `apps/web/src/components/editor/CanvasWindow.tsx` | **Modify** | On resize start: set `resizingWindowId`. On resize move: update `resizeDimensions`. On resize end: clear both. |
| `apps/web/src/components/editor/CanvasWorkspace.tsx` | **Modify** | Render `<ResizeHUD />` as a fixed overlay when `resizingWindowId` is set. |

### Architecture Details

**Store Additions:**
```ts
// In canvasStore.ts
interface CanvasState {
  // ... existing ...
  resizingWindowId: string | null;
  resizeDimensions: { width: number; height: number } | null;

  // Actions
  startResize: (windowId: string) => void;
  updateResizeDimensions: (dimensions: { width: number; height: number }) => void;
  endResize: () => void;
}
```

**HUD Component:**
```tsx
// ResizeHUD.tsx
function ResizeHUD() {
  const resizingWindowId = useCanvasStore((s) => s.resizingWindowId);
  const dimensions = useCanvasStore((s) => s.resizeDimensions);
  const workspace = useActiveWorkspace();
  const [fading, setFading] = useState(false);

  // Fade out on resize end
  useEffect(() => {
    if (!resizingWindowId) {
      setFading(true);
      const t = setTimeout(() => setFading(false), 300);
      return () => clearTimeout(t);
    }
  }, [resizingWindowId]);

  if (!resizingWindowId && !fading) return null;
  if (!workspace || !dimensions) return null;

  const columns = groupWindowsIntoColumns(workspace.windows);
  const viewportWidth = window.innerWidth; // or from ref
  const pct = Math.round((dimensions.width / viewportWidth) * 100);

  return (
    <div className={cn(
      "fixed top-4 left-1/2 -translate-x-1/2 z-[9999]",
      "rounded-lg border bg-popover/90 backdrop-blur-sm shadow-lg px-3 py-2",
      "transition-opacity duration-200",
      fading ? "opacity-0" : "opacity-100",
    )}>
      {/* Mini column map */}
      <div className="flex gap-0.5 mb-1.5">
        {columns.map((col) => {
          const isResizing = col.windows.some((w) => w.id === resizingWindowId);
          return (
            <div
              key={col.groupId}
              className={cn(
                "h-4 rounded-sm",
                isResizing ? "bg-blue-500" : "bg-muted-foreground/20",
              )}
              style={{ width: Math.max(8, (col.windows[0]?.width ?? 100) / 20) }}
            />
          );
        })}
      </div>
      {/* Dimensions readout */}
      <div className="text-[10px] font-mono text-muted-foreground text-center">
        {dimensions.width} × {dimensions.height}px
        <span className="ml-1.5 text-muted-foreground/60">({pct}% viewport)</span>
        {pct > 90 && <span className="ml-1 text-amber-400">⚠</span>}
      </div>
    </div>
  );
}
```

**CanvasWindow Integration:**
In the existing resize handlers, add store calls:
```ts
// On pointer down (any resize handle)
startResize(win.id);

// On pointer move
updateResizeDimensions({ width: newWidth, height: newHeight });

// On pointer up
endResize();
```

---

## Implementation Order

The features should be built in this order due to dependencies:

```
1. Camera System         ← foundation for everything else
   ↓
2. Resize Visualizer HUD ← independent, but benefits from camera context
   ↓
3. App Embedding         ← independent, can be built in parallel with 2
```

**Feature 1 (Camera)** must come first. Features 2 and 3 are independent of each other and can be built in parallel.

---

## TODO Checklist

### Phase 1: Camera System
- [x] Create `cameraStore.ts` with offset, scale, velocity, and transient state
- [x] Create `cameraPhysics.ts` with spring interpolation and velocity tracking
- [x] Create `CanvasViewport.tsx` wrapper component with transform-based positioning
- [x] Implement wheel handler (vertical → horizontal pan, horizontal passthrough)
- [x] Implement middle-click pan with momentum (migrate from WorkspaceScrollArea)
- [x] Implement velocity-based column snapping on pan end
- [x] Add `focusWindow(windowId)` that spring-animates camera to center a window
- [x] Migrate keyboard navigation (⌘[/⌘]) to use camera.focusWindow
- [x] Migrate new-window auto-scroll to use camera
- [x] Migrate maximize scroll-centering to use camera
- [x] Wire up CanvasViewport in CanvasWorkspace (replace scroll container)
- [x] Remove old scroll-based code (scrollTrigger, scrollContainerRef, scrollTo calls)
- [ ] Test: trackpad scroll, middle-click pan, keyboard nav, new window focus, maximize

### Phase 2: Resize Visualizer HUD
- [x] Add `resizingWindowId` and `resizeDimensions` to canvasStore
- [x] Add `startResize()`, `updateResizeDimensions()`, `endResize()` actions
- [x] Create `ResizeHUD.tsx` component with mini-map and dimension readout
- [x] Wire CanvasWindow resize handlers to set/clear resize state
- [x] Add fade-out animation on resize end
- [x] Add viewport percentage display
- [x] Add warning indicator when window exceeds 90% viewport width
- [x] Render ResizeHUD as fixed overlay in CanvasWorkspace
- [ ] Test: right resize, bottom resize, corner resize, HUD positioning, fade animation

### Phase 3: App Embedding (VS Code & Cursor)
- [x] Define shared types in `packages/contracts/src/appEmbed.ts`
- [x] Create `appRegistry.ts` with VS Code and Cursor descriptors
- [x] Add `"vscode" | "cursor"` to `CanvasWindowType`
- [x] Add `appUrl`, `appStatus` fields to `CanvasWindowState`
- [x] Create `AppEmbedContent.tsx` with webview + status overlay + error/retry
- [x] Add VS Code and Cursor cases to `CanvasWindowContent.tsx` switch
- [x] Add VS Code and Cursor to `CanvasAddMenu.tsx` with icons and hotkeys
- [x] Create `appProcessManager.ts` on server (spawn code-server, health check, port management)
- [x] Add WebSocket messages for app lifecycle (start/stop/status)
- [x] Wire client: on addWindow("vscode") → send start message → update URL on ready
- [x] Wire client: on removeWindow → send stop message → server kills process
- [x] Handle code-server not installed (show install hint in error state)
- [x] Handle Cursor server mode (TBD — may need external app launch fallback)
- [x] Add drag overlay protection for webview (same as browser windows)
- [ ] Test: VS Code spawn, embed, resize, close, error recovery, multiple instances
