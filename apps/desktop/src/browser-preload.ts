/**
 * Preload script for the embedded browser webview session (`persist:browser`).
 *
 * This script polyfills `chrome.runtime.connectNative` and
 * `chrome.runtime.sendNativeMessage` so that extensions like 1Password can
 * communicate with their companion desktop apps via the standard Chrome native
 * messaging protocol (length-prefixed JSON over stdio).
 *
 * The actual host process management happens in the main process — this preload
 * simply bridges calls via Electron IPC.
 */
import { ipcRenderer } from "electron";

const NATIVE_MSG_CONNECT_CHANNEL = "browser:native-msg-connect";
const NATIVE_MSG_SEND_CHANNEL = "browser:native-msg-send";
const NATIVE_MSG_POST_CHANNEL = "browser:native-msg-post";
const NATIVE_MSG_DISCONNECT_CHANNEL = "browser:native-msg-disconnect";
const NATIVE_MSG_INCOMING_CHANNEL = "browser:native-msg-incoming";
const NATIVE_MSG_DISCONNECT_EVENT_CHANNEL = "browser:native-msg-disconnected";

// Augment the chrome.runtime API if it exists (it will for extension contexts)
function patchChromeRuntime(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chrome = (globalThis as any).chrome;
  if (!chrome?.runtime) return;

  // Only patch if not already present
  if (typeof chrome.runtime.connectNative === "function") return;

  let portIdCounter = 0;

  /**
   * chrome.runtime.connectNative(hostName) → Port
   *
   * Creates a long-lived connection to a native messaging host.
   * Returns a Port-like object with postMessage / onMessage / onDisconnect.
   */
  chrome.runtime.connectNative = (hostName: string) => {
    const portId = ++portIdCounter;

    // Ask main process to spawn the native host
    ipcRenderer.send(NATIVE_MSG_CONNECT_CHANNEL, { portId, hostName });

    // Simple EventEmitter-like for onMessage / onDisconnect
    type Listener = (...args: unknown[]) => void;
    const makeEvent = () => {
      const listeners: Listener[] = [];
      return {
        addListener: (fn: Listener) => listeners.push(fn),
        removeListener: (fn: Listener) => {
          const i = listeners.indexOf(fn);
          if (i >= 0) listeners.splice(i, 1);
        },
        hasListeners: () => listeners.length > 0,
        _fire: (...args: unknown[]) => {
          for (const fn of listeners) {
            try {
              fn(...args);
            } catch (e) {
              console.error("[native-msg] listener error:", e);
            }
          }
        },
      };
    };

    const onMessage = makeEvent();
    const onDisconnect = makeEvent();

    // Listen for incoming messages from the native host
    const incomingHandler = (
      _event: Electron.IpcRendererEvent,
      data: { portId: number; message: unknown },
    ) => {
      if (data.portId === portId) {
        onMessage._fire(data.message);
      }
    };

    const disconnectHandler = (_event: Electron.IpcRendererEvent, data: { portId: number }) => {
      if (data.portId === portId) {
        cleanup();
        onDisconnect._fire(port);
      }
    };

    ipcRenderer.on(NATIVE_MSG_INCOMING_CHANNEL, incomingHandler);
    ipcRenderer.on(NATIVE_MSG_DISCONNECT_EVENT_CHANNEL, disconnectHandler);

    const cleanup = () => {
      ipcRenderer.removeListener(NATIVE_MSG_INCOMING_CHANNEL, incomingHandler);
      ipcRenderer.removeListener(NATIVE_MSG_DISCONNECT_EVENT_CHANNEL, disconnectHandler);
    };

    const port = {
      name: hostName,
      postMessage: (message: unknown) => {
        ipcRenderer.send(NATIVE_MSG_POST_CHANNEL, { portId, message });
      },
      disconnect: () => {
        ipcRenderer.send(NATIVE_MSG_DISCONNECT_CHANNEL, { portId });
        cleanup();
      },
      onMessage,
      onDisconnect,
    };

    return port;
  };

  /**
   * chrome.runtime.sendNativeMessage(hostName, message, callback)
   *
   * One-shot native message — spawns host, sends message, returns response,
   * then disconnects.
   */
  chrome.runtime.sendNativeMessage = (
    hostName: string,
    message: unknown,
    callback?: (response: unknown) => void,
  ) => {
    ipcRenderer
      .invoke(NATIVE_MSG_SEND_CHANNEL, { hostName, message })
      .then((response: unknown) => {
        callback?.(response);
      })
      .catch((err: Error) => {
        console.error("[native-msg] sendNativeMessage error:", err);
        // Set chrome.runtime.lastError (extensions check this)
        chrome.runtime.lastError = { message: err.message };
        callback?.(undefined);
      });
  };
}

// Patch as early as possible
try {
  patchChromeRuntime();
} catch (e) {
  // Not in an extension context, ignore
}

// Also patch after DOM is ready (some extension contexts initialize chrome.runtime late)
if (typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", () => {
    try {
      patchChromeRuntime();
    } catch {
      // ignore
    }
  });
}
