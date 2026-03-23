export type CanvasTerminalSplitDirection = "vertical" | "horizontal";

export type CanvasTerminalPaneNode =
  | { type: "leaf"; id: string }
  | { type: "split"; direction: CanvasTerminalSplitDirection; children: CanvasTerminalPaneNode[] };

export interface CanvasTerminalPaneState {
  root: CanvasTerminalPaneNode;
  activePaneId: string;
}

function initialPaneId(windowId: string): string {
  return `pane-${windowId}-1`;
}

export function createInitialCanvasTerminalPaneState(windowId: string): CanvasTerminalPaneState {
  const paneId = initialPaneId(windowId);
  return {
    root: { type: "leaf", id: paneId },
    activePaneId: paneId,
  };
}
