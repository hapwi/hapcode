import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { selectCurrentCanvasScope, useCanvasStore } from "./canvasStore";

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
});
