import { type ResolvedKeybindingsConfig, ThreadId } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { resolveShortcutCommand } from "~/keybindings";
import { isTerminalFocused } from "~/lib/terminalFocus";
import type { TerminalContextSelection } from "~/lib/terminalContext";
import { serverConfigQueryOptions } from "~/lib/serverReactQuery";
import { TerminalViewport } from "../ThreadTerminalDrawer";

// ---------------------------------------------------------------------------
// Synthetic thread ID per canvas window
// ---------------------------------------------------------------------------

function canvasThreadId(windowId: string): ThreadId {
  return ThreadId.makeUnsafe(`__canvas__:${windowId}`);
}

// ---------------------------------------------------------------------------
// Tree-based pane state — supports vertical & horizontal splits
// ---------------------------------------------------------------------------

type SplitDirection = "vertical" | "horizontal";

type PaneNode =
  | { type: "leaf"; id: string }
  | { type: "split"; direction: SplitDirection; children: PaneNode[] };

interface PaneState {
  root: PaneNode;
  activePaneId: string;
}

function createInitialPane(): PaneState {
  const id = `pane-${crypto.randomUUID()}`;
  return { root: { type: "leaf", id }, activePaneId: id };
}

/** Collect all leaf pane IDs from the tree */
function collectLeafIds(node: PaneNode): string[] {
  if (node.type === "leaf") return [node.id];
  return node.children.flatMap(collectLeafIds);
}

/** Count total leaf panes */
function countLeaves(node: PaneNode): number {
  if (node.type === "leaf") return 1;
  return node.children.reduce((sum, child) => sum + countLeaves(child), 0);
}

/**
 * Split the active pane in a given direction.
 * If the active pane's parent split has the same direction, we insert alongside.
 * Otherwise we replace the leaf with a new split node.
 */
function splitActivePane(
  root: PaneNode,
  activePaneId: string,
  direction: SplitDirection,
): { root: PaneNode; newPaneId: string } {
  const newId = `pane-${crypto.randomUUID()}`;

  function walk(node: PaneNode): PaneNode {
    if (node.type === "leaf") {
      if (node.id === activePaneId) {
        // Replace this leaf with a split containing the old leaf + new leaf
        return {
          type: "split",
          direction,
          children: [node, { type: "leaf", id: newId }],
        };
      }
      return node;
    }

    // Check if any direct child is the active leaf AND direction matches
    // In that case, insert the new pane right after the active one in this split
    if (node.direction === direction) {
      const activeIndex = node.children.findIndex(
        (child) => child.type === "leaf" && child.id === activePaneId,
      );
      if (activeIndex >= 0) {
        const newChildren = [...node.children];
        newChildren.splice(activeIndex + 1, 0, { type: "leaf", id: newId });
        return { ...node, children: newChildren };
      }
    }

    // Recurse into children
    return { ...node, children: node.children.map(walk) };
  }

  return { root: walk(root), newPaneId: newId };
}

/**
 * Remove a pane from the tree. If a split node ends up with a single child,
 * collapse it to that child.
 */
function removePane(root: PaneNode, paneId: string): PaneNode | null {
  if (root.type === "leaf") {
    return root.id === paneId ? null : root;
  }

  const newChildren: PaneNode[] = [];
  for (const child of root.children) {
    const result = removePane(child, paneId);
    if (result !== null) {
      newChildren.push(result);
    }
  }

  if (newChildren.length === 0) return null;
  if (newChildren.length === 1) return newChildren[0]!;
  return { ...root, children: newChildren };
}

/** Find the next pane to activate after closing one */
function findNextActive(root: PaneNode, closedId: string): string {
  const allIds = collectLeafIds(root);
  const filtered = allIds.filter((id) => id !== closedId);
  const closedIndex = allIds.indexOf(closedId);
  if (filtered.length === 0) return allIds[0]!;
  return filtered[Math.min(closedIndex, filtered.length - 1)] ?? filtered[0]!;
}

// ---------------------------------------------------------------------------
// Recursive pane renderer
// ---------------------------------------------------------------------------

function PaneSplitView(props: {
  node: PaneNode;
  threadId: ThreadId;
  cwd: string;
  activePaneId: string;
  focusRequestId: number;
  resizeEpoch: number;
  onClosePane: (paneId: string) => void;
  onActivatePane: (paneId: string) => void;
  onAddTerminalContext: (selection: TerminalContextSelection) => void;
}) {
  const {
    node,
    threadId,
    cwd,
    activePaneId,
    focusRequestId,
    resizeEpoch,
    onClosePane,
    onActivatePane,
    onAddTerminalContext,
  } = props;

  if (node.type === "leaf") {
    return (
      <div
        className="h-full w-full min-h-0 min-w-0"
        onMouseDown={() => {
          if (node.id !== activePaneId) {
            onActivatePane(node.id);
          }
        }}
      >
        <div className="h-full p-0.5">
          <TerminalViewport
            threadId={threadId}
            terminalId={node.id}
            terminalLabel="Terminal"
            cwd={cwd}
            onSessionExited={() => onClosePane(node.id)}
            onAddTerminalContext={onAddTerminalContext}
            focusRequestId={focusRequestId}
            autoFocus={node.id === activePaneId}
            resizeEpoch={resizeEpoch}
            drawerHeight={0}
          />
        </div>
      </div>
    );
  }

  const isVertical = node.direction === "vertical";
  const gridStyle = isVertical
    ? { gridTemplateColumns: `repeat(${node.children.length}, minmax(0, 1fr))` }
    : { gridTemplateRows: `repeat(${node.children.length}, minmax(0, 1fr))` };

  const borderClass = isVertical ? "border-l border-border/40" : "border-t border-border/40";

  return (
    <div className="grid h-full w-full gap-0 overflow-hidden" style={gridStyle}>
      {node.children.map((child, index) => {
        const key = child.type === "leaf" ? child.id : `split-${index}`;
        return (
          <div key={key} className={`min-h-0 min-w-0 ${index > 0 ? borderClass : ""}`}>
            <PaneSplitView
              node={child}
              threadId={threadId}
              cwd={cwd}
              activePaneId={activePaneId}
              focusRequestId={focusRequestId}
              resizeEpoch={resizeEpoch}
              onClosePane={onClosePane}
              onActivatePane={onActivatePane}
              onAddTerminalContext={onAddTerminalContext}
            />
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// CanvasTerminal — tree-based pane splits (vertical & horizontal)
// ---------------------------------------------------------------------------

export function CanvasTerminal(props: { cwd: string | null; windowId: string }) {
  const { cwd, windowId } = props;
  const threadId = useMemo(() => canvasThreadId(windowId), [windowId]);

  const [panes, setPanes] = useState<PaneState>(createInitialPane);
  const [resizeEpoch, setResizeEpoch] = useState(0);
  const [focusRequestId, setFocusRequestId] = useState(0);

  // ResizeObserver to trigger terminal re-fit when container resizes
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => {
      setResizeEpoch((v) => v + 1);
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // Pane actions
  const splitPane = useCallback((direction: SplitDirection) => {
    setPanes((prev) => {
      const { root, newPaneId } = splitActivePane(prev.root, prev.activePaneId, direction);
      return { root, activePaneId: newPaneId };
    });
    setFocusRequestId((v) => v + 1);
  }, []);

  const closePane = useCallback((paneId: string) => {
    setPanes((prev) => {
      if (countLeaves(prev.root) <= 1) return prev; // Don't close the last pane
      const nextActive =
        prev.activePaneId === paneId ? findNextActive(prev.root, paneId) : prev.activePaneId;
      const newRoot = removePane(prev.root, paneId);
      if (!newRoot) return prev;
      return { root: newRoot, activePaneId: nextActive };
    });
    setFocusRequestId((v) => v + 1);
  }, []);

  const activatePane = useCallback((paneId: string) => {
    setPanes((prev) => {
      if (prev.activePaneId === paneId) return prev;
      return { ...prev, activePaneId: paneId };
    });
    setFocusRequestId((v) => v + 1);
  }, []);

  // No-op for terminal context in canvas (no associated chat)
  const addTerminalContext = useCallback((_selection: TerminalContextSelection) => {}, []);

  // Keyboard shortcuts
  const EMPTY_KEYBINDINGS: ResolvedKeybindingsConfig = useMemo(() => [], []);
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const keybindings = serverConfigQuery.data?.keybindings ?? EMPTY_KEYBINDINGS;

  useEffect(() => {
    const handler = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (!isTerminalFocused()) return;

      const container = containerRef.current;
      if (!container || !container.contains(document.activeElement)) return;

      const command = resolveShortcutCommand(event, keybindings, {
        context: { terminalFocus: true, terminalOpen: true },
      });
      if (!command) return;

      if (command === "terminal.split") {
        event.preventDefault();
        event.stopPropagation();
        splitPane("vertical");
        return;
      }

      if (command === "terminal.splitHorizontal") {
        event.preventDefault();
        event.stopPropagation();
        splitPane("horizontal");
        return;
      }

      if (command === "terminal.close") {
        event.preventDefault();
        event.stopPropagation();
        closePane(panes.activePaneId);
        return;
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [keybindings, splitPane, closePane, panes.activePaneId]);

  if (!cwd) {
    return (
      <div className="flex h-full w-full items-center justify-center text-xs text-muted-foreground/60">
        No project directory
      </div>
    );
  }

  return (
    <div ref={containerRef} className="flex h-full w-full overflow-hidden bg-background">
      <PaneSplitView
        node={panes.root}
        threadId={threadId}
        cwd={cwd}
        activePaneId={panes.activePaneId}
        focusRequestId={focusRequestId}
        resizeEpoch={resizeEpoch}
        onClosePane={closePane}
        onActivatePane={activatePane}
        onAddTerminalContext={addTerminalContext}
      />
    </div>
  );
}
