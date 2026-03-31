/**
 * App Registry — descriptors for embeddable applications.
 *
 * Each descriptor defines how to display the app in the UI, what server-side
 * process to spawn, and how to derive the embed URL once the process is ready.
 */
import { CodeIcon, type LucideIcon } from "lucide-react";
import type { CanvasWindowType } from "./canvasStore";

export interface AppDescriptor {
  /** Canvas window type identifier. */
  type: CanvasWindowType;
  /** Human-readable display name. */
  displayName: string;
  /** Lucide icon component for UI. */
  icon: LucideIcon;
  /** Keyboard shortcut hint shown in the add menu. */
  hotkey?: string;
  /** Keyboard shortcut key (for Cmd/Ctrl+<key> detection). */
  hotkeyKey?: string;
  /** How to derive the embed URL from the assigned port and cwd. */
  urlPattern: (port: number, cwd: string) => string;
  /** Server-side process configuration. */
  processConfig: {
    /** CLI command to spawn (e.g. "code-server"). */
    command: string;
    /** Build argument list for the process. */
    args: (opts: { cwd: string; port: number }) => string[];
    /** HTTP endpoint to poll for readiness. */
    healthCheckUrl: (port: number) => string;
    /** Message shown when the command is not installed. */
    installHint: string;
  };
}

export const APP_REGISTRY: AppDescriptor[] = [
  {
    type: "vscode",
    displayName: "VS Code",
    icon: CodeIcon,
    hotkey: "⌘⇧V",
    hotkeyKey: "v",
    urlPattern: (port, cwd) => `http://localhost:${port}/?folder=${encodeURIComponent(cwd)}`,
    processConfig: {
      command: "code-server",
      args: ({ cwd, port }) => [
        "--port",
        String(port),
        "--auth",
        "none",
        "--disable-telemetry",
        cwd,
      ],
      healthCheckUrl: (port) => `http://localhost:${port}/healthz`,
      installHint: "Install code-server: npm install -g code-server",
    },
  },
];

/** Look up an app descriptor by window type. */
export function getAppDescriptor(type: CanvasWindowType): AppDescriptor | undefined {
  return APP_REGISTRY.find((a) => a.type === type);
}
