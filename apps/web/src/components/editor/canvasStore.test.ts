import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { selectCurrentCanvasScope, useCanvasStore } from "./canvasStore";
import { createInitialCanvasTerminalPaneState } from "./canvasTerminalState";

function resetCanvasStore() {
  useCanvasStore.setState({
    scopes: {
      __default__: {
        workspaces: [
          {
            id: "ws-default",
            name: "Workspace 1",
            windows: [],
          },
        ],
        activeWorkspaceId: "ws-default",
        activeWindowId: null,
        scrollTrigger: 0,
      },
    },
    currentScopeKey: "__default__",
    isDragging: false,
    defaultWindowWidth: 700,
    defaultWindowHeight: 500,
  });
}

describe("canvasStore project scoping", () => {
  beforeEach(() => {
    resetCanvasStore();
  });

  afterEach(() => {
    resetCanvasStore();
  });

  it("keeps workspace windows isolated by scope key", () => {
    const store = useCanvasStore.getState();

    store.setCanvasScope("project:alpha");
    store.addWindow("diff", { title: "Alpha Diff" });

    store.setCanvasScope("project:beta");
    store.addWindow("terminal", { title: "Beta Terminal" });

    store.setCanvasScope("project:alpha");
    let scope = selectCurrentCanvasScope(useCanvasStore.getState());
    expect(scope.workspaces[0]?.windows.map((window) => window.title)).toEqual(["Alpha Diff"]);

    store.setCanvasScope("project:beta");
    scope = selectCurrentCanvasScope(useCanvasStore.getState());
    expect(scope.workspaces[0]?.windows.map((window) => window.title)).toEqual(["Beta Terminal"]);
  });

  it("falls back to the default scope when the scope key is empty", () => {
    const store = useCanvasStore.getState();

    store.setCanvasScope("project:alpha");
    store.addWindow("chat", { title: "Scoped Chat" });

    store.setCanvasScope("");
    const scope = selectCurrentCanvasScope(useCanvasStore.getState());

    expect(useCanvasStore.getState().currentScopeKey).toBe("__default__");
    expect(scope.workspaces[0]?.windows).toEqual([]);
  });

  it("persists terminal pane state across workspace switches", () => {
    const store = useCanvasStore.getState();

    store.setCanvasScope("project:alpha");
    const terminalWindowId = store.addWindow("terminal", { title: "Alpha Terminal" });

    let scope = selectCurrentCanvasScope(useCanvasStore.getState());
    const terminalWindow = scope.workspaces[0]?.windows.find(
      (window) => window.id === terminalWindowId,
    );
    expect(terminalWindow?.terminalPaneState).toEqual(
      createInitialCanvasTerminalPaneState(terminalWindowId),
    );

    const splitPaneState = {
      root: {
        type: "split" as const,
        direction: "vertical" as const,
        children: [
          { type: "leaf" as const, id: `pane-${terminalWindowId}-1` },
          { type: "leaf" as const, id: `pane-${terminalWindowId}-2` },
        ],
      },
      activePaneId: `pane-${terminalWindowId}-2`,
    };
    store.updateWindow(terminalWindowId, { terminalPaneState: splitPaneState });

    const newWorkspaceId = store.addWorkspace();
    store.setActiveWorkspace(newWorkspaceId);
    store.addWindow("diff", { title: "Workspace 2 Diff" });
    store.setActiveWorkspace("ws-default");

    scope = selectCurrentCanvasScope(useCanvasStore.getState());
    expect(
      scope.workspaces[0]?.windows.find((window) => window.id === terminalWindowId),
    ).toMatchObject({
      id: terminalWindowId,
      terminalPaneState: splitPaneState,
    });
  });

  it("reuses the same terminal window when ensuring it twice", () => {
    const store = useCanvasStore.getState();

    store.setCanvasScope("project:alpha");
    const firstWindowId = store.ensureTerminalWindow();
    const secondWindowId = store.ensureTerminalWindow();

    const scope = selectCurrentCanvasScope(useCanvasStore.getState());
    expect(firstWindowId).toBe(secondWindowId);
    expect(
      scope.workspaces[0]?.windows.filter((window) => window.type === "terminal"),
    ).toHaveLength(1);
    expect(scope.workspaces[0]?.windows[0]?.terminalPaneState).toEqual(
      createInitialCanvasTerminalPaneState(firstWindowId),
    );
  });
});
