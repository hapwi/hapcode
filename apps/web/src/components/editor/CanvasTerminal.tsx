import { FitAddon } from "@xterm/addon-fit";
import { Terminal, type ITheme } from "@xterm/xterm";
import { useEffect, useRef, useCallback } from "react";
import { readNativeApi } from "~/nativeApi";

// ---------------------------------------------------------------------------
// Theme (matches ThreadTerminalDrawer)
// ---------------------------------------------------------------------------

function terminalTheme(): ITheme {
  const isDark =
    typeof document !== "undefined" && document.documentElement.classList.contains("dark");
  const bodyStyles =
    typeof document !== "undefined" ? getComputedStyle(document.body) : ({} as CSSStyleDeclaration);
  const background =
    bodyStyles.backgroundColor || (isDark ? "rgb(14, 18, 24)" : "rgb(255, 255, 255)");
  const foreground = bodyStyles.color || (isDark ? "rgb(237, 241, 247)" : "rgb(28, 33, 41)");

  if (isDark) {
    return {
      background,
      foreground,
      cursor: "rgb(180, 203, 255)",
      selectionBackground: "rgba(180, 203, 255, 0.25)",
      scrollbarSliderBackground: "rgba(255, 255, 255, 0.1)",
      scrollbarSliderHoverBackground: "rgba(255, 255, 255, 0.18)",
      scrollbarSliderActiveBackground: "rgba(255, 255, 255, 0.22)",
      black: "rgb(24, 30, 38)",
      red: "rgb(255, 122, 142)",
      green: "rgb(134, 231, 149)",
      yellow: "rgb(244, 205, 114)",
      blue: "rgb(137, 190, 255)",
      magenta: "rgb(208, 176, 255)",
      cyan: "rgb(124, 232, 237)",
      white: "rgb(210, 218, 230)",
      brightBlack: "rgb(110, 120, 136)",
      brightRed: "rgb(255, 168, 180)",
      brightGreen: "rgb(176, 245, 186)",
      brightYellow: "rgb(255, 224, 149)",
      brightBlue: "rgb(174, 210, 255)",
      brightMagenta: "rgb(229, 203, 255)",
      brightCyan: "rgb(167, 244, 247)",
      brightWhite: "rgb(244, 247, 252)",
    };
  }

  return {
    background,
    foreground,
    cursor: "rgb(38, 56, 78)",
    selectionBackground: "rgba(37, 63, 99, 0.2)",
    scrollbarSliderBackground: "rgba(0, 0, 0, 0.15)",
    scrollbarSliderHoverBackground: "rgba(0, 0, 0, 0.25)",
    scrollbarSliderActiveBackground: "rgba(0, 0, 0, 0.3)",
    black: "rgb(44, 53, 66)",
    red: "rgb(191, 70, 87)",
    green: "rgb(60, 126, 86)",
    yellow: "rgb(146, 112, 35)",
    blue: "rgb(72, 102, 163)",
    magenta: "rgb(132, 86, 149)",
    cyan: "rgb(53, 127, 141)",
    white: "rgb(210, 215, 223)",
    brightBlack: "rgb(112, 123, 140)",
    brightRed: "rgb(212, 95, 112)",
    brightGreen: "rgb(85, 148, 111)",
    brightYellow: "rgb(173, 133, 45)",
    brightBlue: "rgb(91, 124, 194)",
    brightMagenta: "rgb(153, 107, 172)",
    brightCyan: "rgb(70, 149, 164)",
    brightWhite: "rgb(236, 240, 246)",
  };
}

// ---------------------------------------------------------------------------
// Unique IDs for canvas terminals
// ---------------------------------------------------------------------------

let canvasTerminalCounter = 0;
function nextCanvasTerminalId(): string {
  return `canvas-term-${Date.now()}-${++canvasTerminalCounter}`;
}

// A synthetic "thread" ID for canvas terminals — they don't belong to a real thread
const CANVAS_THREAD_ID = "__canvas__";

// ---------------------------------------------------------------------------
// CanvasTerminal
// ---------------------------------------------------------------------------

export function CanvasTerminal(props: { cwd: string | null }) {
  const { cwd } = props;
  const mountRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const terminalIdRef = useRef<string>(nextCanvasTerminalId());

  // ResizeObserver for container
  const resizeObserverRef = useRef<ResizeObserver | null>(null);

  const containerRefCallback = useCallback((node: HTMLDivElement | null) => {
    if (resizeObserverRef.current) {
      resizeObserverRef.current.disconnect();
      resizeObserverRef.current = null;
    }
    if (!node) return;

    const observer = new ResizeObserver(() => {
      const fitAddon = fitAddonRef.current;
      if (!fitAddon) return;
      try {
        fitAddon.fit();
      } catch {
        // Terminal may not be ready
      }
    });
    observer.observe(node);
    resizeObserverRef.current = observer;
  }, []);

  useEffect(() => {
    const el = mountRef.current;
    if (!el || !cwd) return;

    const api = readNativeApi();
    if (!api) return;

    const terminalId = terminalIdRef.current;
    let disposed = false;

    const terminal = new Terminal({
      fontSize: 12,
      lineHeight: 1.2,
      fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", monospace',
      scrollback: 5000,
      theme: terminalTheme(),
      cursorBlink: true,
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(el);
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    // Fit after a frame
    requestAnimationFrame(() => {
      try {
        fitAddon.fit();
      } catch {
        // Container may not be visible yet
      }
    });

    // Open PTY session
    const openTerminal = async () => {
      try {
        fitAddon.fit();
        const snapshot = await api.terminal.open({
          threadId: CANVAS_THREAD_ID,
          terminalId,
          cwd,
          cols: terminal.cols,
          rows: terminal.rows,
        });
        if (disposed) return;
        terminal.write("\u001bc");
        if (snapshot.history.length > 0) {
          terminal.write(snapshot.history);
        }
        terminal.focus();
      } catch (err) {
        if (disposed) return;
        terminal.write(
          `\r\n[Failed to open terminal: ${err instanceof Error ? err.message : String(err)}]\r\n`,
        );
      }
    };

    // Listen for events from the PTY
    const unsubscribe = api.terminal.onEvent((event) => {
      if (event.threadId !== CANVAS_THREAD_ID || event.terminalId !== terminalId) return;
      if (event.type === "output") {
        terminal.write(event.data);
        return;
      }
      if (event.type === "started" || event.type === "restarted") {
        terminal.write("\u001bc");
        if (event.snapshot.history.length > 0) {
          terminal.write(event.snapshot.history);
        }
        return;
      }
      if (event.type === "exited") {
        const details = [
          typeof event.exitCode === "number" ? `code ${event.exitCode}` : null,
          typeof event.exitSignal === "number" ? `signal ${event.exitSignal}` : null,
        ]
          .filter((v): v is string => v !== null)
          .join(", ");
        terminal.write(`\r\n[Process exited${details ? ` (${details})` : ""}]\r\n`);
        return;
      }
      if (event.type === "error") {
        terminal.write(`\r\n[terminal] ${event.message}\r\n`);
        return;
      }
      if (event.type === "cleared") {
        terminal.clear();
        terminal.write("\u001bc");
      }
    });

    // Forward keystrokes to PTY
    const inputDisposable = terminal.onData((data) => {
      void api.terminal
        .write({ threadId: CANVAS_THREAD_ID, terminalId, data })
        .catch(() => undefined);
    });

    // Forward resize events to PTY
    terminal.onResize(({ cols, rows }) => {
      void api.terminal
        .resize({ threadId: CANVAS_THREAD_ID, terminalId, cols, rows })
        .catch(() => undefined);
    });

    // Theme observer
    const themeObserver = new MutationObserver(() => {
      terminal.options.theme = terminalTheme();
      terminal.refresh(0, terminal.rows - 1);
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });

    void openTerminal();

    return () => {
      disposed = true;
      unsubscribe();
      inputDisposable.dispose();
      themeObserver.disconnect();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      void api.terminal.close({ threadId: CANVAS_THREAD_ID, terminalId }).catch(() => undefined);
    };
  }, [cwd]);

  return (
    <div ref={containerRefCallback} className="flex h-full w-full flex-col overflow-hidden">
      <div ref={mountRef} className="min-h-0 flex-1" />
    </div>
  );
}
