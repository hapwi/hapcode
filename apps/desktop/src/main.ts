import * as ChildProcess from "node:child_process";
import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  protocol,
  session,
  shell,
} from "electron";
import type { MenuItemConstructorOptions } from "electron";
import * as Effect from "effect/Effect";
import type {
  DesktopTheme,
  DesktopUpdateActionResult,
  DesktopUpdateState,
} from "@t3tools/contracts";
import { autoUpdater } from "electron-updater";

import type { ContextMenuItem } from "@t3tools/contracts";
import { NetService } from "@t3tools/shared/Net";
import { RotatingFileSink } from "@t3tools/shared/logging";
import { showDesktopConfirmDialog } from "./confirmDialog";
import { syncShellEnvironment } from "./syncShellEnvironment";
import { getAutoUpdateDisabledReason, shouldBroadcastDownloadProgress } from "./updateState";
import {
  createInitialDesktopUpdateState,
  reduceDesktopUpdateStateOnCheckFailure,
  reduceDesktopUpdateStateOnCheckStart,
  reduceDesktopUpdateStateOnDownloadComplete,
  reduceDesktopUpdateStateOnDownloadFailure,
  reduceDesktopUpdateStateOnDownloadProgress,
  reduceDesktopUpdateStateOnDownloadStart,
  reduceDesktopUpdateStateOnInstallFailure,
  reduceDesktopUpdateStateOnNoUpdate,
  reduceDesktopUpdateStateOnUpdateAvailable,
} from "./updateMachine";
import { isArm64HostRunningIntelBuild, resolveDesktopRuntimeInfo } from "./runtimeArch";

syncShellEnvironment();

const PICK_FOLDER_CHANNEL = "desktop:pick-folder";
const CONFIRM_CHANNEL = "desktop:confirm";
const SET_THEME_CHANNEL = "desktop:set-theme";
const CONTEXT_MENU_CHANNEL = "desktop:context-menu";
const OPEN_EXTERNAL_CHANNEL = "desktop:open-external";
const MENU_ACTION_CHANNEL = "desktop:menu-action";
const UPDATE_STATE_CHANNEL = "desktop:update-state";
const UPDATE_GET_STATE_CHANNEL = "desktop:update-get-state";
const UPDATE_DOWNLOAD_CHANNEL = "desktop:update-download";
const UPDATE_INSTALL_CHANNEL = "desktop:update-install";
const BROWSER_EXTENSIONS_CHANNEL = "desktop:browser-extensions";
const GET_WS_URL_CHANNEL = "desktop:get-ws-url";
const IS_DEV_CHANNEL = "desktop:is-dev";
const DEFAULT_BASE_DIR = Path.join(OS.homedir(), ".hap");
const LEGACY_APP_BASE_DIR = Path.join(OS.homedir(), ".hapcode");
const BASE_DIR = process.env.T3CODE_HOME?.trim() || DEFAULT_BASE_DIR;
const STATE_DIR = Path.join(BASE_DIR, "userdata");
const DESKTOP_SCHEME = "t3";
const ROOT_DIR = Path.resolve(__dirname, "../../..");
const isDevelopment = Boolean(process.env.VITE_DEV_SERVER_URL);
const isDevBuild = isDevelopment || !app.isPackaged;
const APP_DISPLAY_NAME = isDevBuild ? "hapcode (Dev)" : "hapcode";
const APP_USER_MODEL_ID = "com.hapcode.hapcode";
const USER_DATA_DIR_NAME = isDevBuild ? "t3code-dev" : "t3code";
const LEGACY_USER_DATA_DIR_NAME = isDevBuild ? "T3 Code (Dev)" : "T3 Code (Alpha)"; // Keep legacy names for migration
const COMMIT_HASH_PATTERN = /^[0-9a-f]{7,40}$/i;
const COMMIT_HASH_DISPLAY_LENGTH = 12;
const LOG_DIR = Path.join(STATE_DIR, "logs");
const LOG_FILE_MAX_BYTES = 10 * 1024 * 1024;
const LOG_FILE_MAX_FILES = 10;
const APP_RUN_ID = Crypto.randomBytes(6).toString("hex");
const AUTO_UPDATE_STARTUP_DELAY_MS = 15_000;
const AUTO_UPDATE_POLL_INTERVAL_MS = 4 * 60 * 60 * 1000;
const DESKTOP_UPDATE_CHANNEL = "latest";
const DESKTOP_UPDATE_ALLOW_PRERELEASE = false;
const DESKTOP_PROFILE_OUT = process.env.T3CODE_DESKTOP_PROFILE_OUT?.trim() ?? "";
const ENABLE_BROWSER_EXTENSIONS = /^(1|true)$/i.test(
  process.env.T3CODE_ENABLE_BROWSER_EXTENSIONS?.trim() ?? "",
);

function migrateLegacyAppBaseDirIfNeeded(): void {
  if (BASE_DIR !== DEFAULT_BASE_DIR) {
    return;
  }
  if (!FS.existsSync(LEGACY_APP_BASE_DIR)) {
    return;
  }

  try {
    FS.mkdirSync(BASE_DIR, { recursive: true });
    for (const entry of FS.readdirSync(LEGACY_APP_BASE_DIR)) {
      const sourcePath = Path.join(LEGACY_APP_BASE_DIR, entry);
      const destinationPath = Path.join(BASE_DIR, entry);
      if (FS.existsSync(destinationPath)) {
        continue;
      }
      FS.cpSync(sourcePath, destinationPath, { recursive: true });
    }
    console.info(`[desktop] migrated legacy app state from ${LEGACY_APP_BASE_DIR} to ${BASE_DIR}`);
  } catch (error) {
    console.error("[desktop] failed to migrate legacy app state", error);
  }
}

migrateLegacyAppBaseDirIfNeeded();

type DesktopUpdateErrorContext = DesktopUpdateState["errorContext"];

let mainWindow: BrowserWindow | null = null;
let backendProcess: ChildProcess.ChildProcess | null = null;
let backendPort = 0;
let backendAuthToken = "";
let backendWsUrl = "";
let restartAttempt = 0;
let restartTimer: ReturnType<typeof setTimeout> | null = null;
let isQuitting = false;
let desktopProtocolRegistered = false;
let aboutCommitHashCache: string | null | undefined;
let desktopLogSink: RotatingFileSink | null = null;
let backendLogSink: RotatingFileSink | null = null;
let restoreStdIoCapture: (() => void) | null = null;

let destructiveMenuIconCache: Electron.NativeImage | null | undefined;
const desktopRuntimeInfo = resolveDesktopRuntimeInfo({
  platform: process.platform,
  processArch: process.arch,
  runningUnderArm64Translation: app.runningUnderARM64Translation === true,
});
const initialUpdateState = (): DesktopUpdateState =>
  createInitialDesktopUpdateState(app.getVersion(), desktopRuntimeInfo);

function logTimestamp(): string {
  return new Date().toISOString();
}

function logScope(scope: string): string {
  return `${scope} run=${APP_RUN_ID}`;
}

function sanitizeLogValue(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function backendChildEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.T3CODE_PORT;
  delete env.T3CODE_AUTH_TOKEN;
  delete env.T3CODE_MODE;
  delete env.T3CODE_NO_BROWSER;
  delete env.T3CODE_HOST;
  delete env.T3CODE_DESKTOP_WS_URL;
  return env;
}

function writeDesktopLogHeader(message: string): void {
  if (!desktopLogSink) return;
  desktopLogSink.write(`[${logTimestamp()}] [${logScope("desktop")}] ${message}\n`);
}

function writeBackendSessionBoundary(phase: "START" | "END", details: string): void {
  if (!backendLogSink) return;
  const normalizedDetails = sanitizeLogValue(details);
  backendLogSink.write(
    `[${logTimestamp()}] ---- APP SESSION ${phase} run=${APP_RUN_ID} ${normalizedDetails} ----\n`,
  );
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function getSafeExternalUrl(rawUrl: unknown): string | null {
  if (typeof rawUrl !== "string" || rawUrl.length === 0) {
    return null;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    return null;
  }

  if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
    return null;
  }

  return parsedUrl.toString();
}

function getSafeTheme(rawTheme: unknown): DesktopTheme | null {
  if (rawTheme === "light" || rawTheme === "dark" || rawTheme === "system") {
    return rawTheme;
  }

  return null;
}

function writeDesktopStreamChunk(
  streamName: "stdout" | "stderr",
  chunk: unknown,
  encoding: BufferEncoding | undefined,
): void {
  if (!desktopLogSink) return;
  const buffer = Buffer.isBuffer(chunk)
    ? chunk
    : Buffer.from(String(chunk), typeof chunk === "string" ? encoding : undefined);
  desktopLogSink.write(`[${logTimestamp()}] [${logScope(streamName)}] `);
  desktopLogSink.write(buffer);
  if (buffer.length === 0 || buffer[buffer.length - 1] !== 0x0a) {
    desktopLogSink.write("\n");
  }
}

function installStdIoCapture(): void {
  if (!app.isPackaged || desktopLogSink === null || restoreStdIoCapture !== null) {
    return;
  }

  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);

  const patchWrite =
    (streamName: "stdout" | "stderr", originalWrite: typeof process.stdout.write) =>
    (
      chunk: string | Uint8Array,
      encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
      callback?: (error?: Error | null) => void,
    ): boolean => {
      const encoding = typeof encodingOrCallback === "string" ? encodingOrCallback : undefined;
      writeDesktopStreamChunk(streamName, chunk, encoding);
      if (typeof encodingOrCallback === "function") {
        return originalWrite(chunk, encodingOrCallback);
      }
      if (callback !== undefined) {
        return originalWrite(chunk, encoding, callback);
      }
      if (encoding !== undefined) {
        return originalWrite(chunk, encoding);
      }
      return originalWrite(chunk);
    };

  process.stdout.write = patchWrite("stdout", originalStdoutWrite);
  process.stderr.write = patchWrite("stderr", originalStderrWrite);

  restoreStdIoCapture = () => {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    restoreStdIoCapture = null;
  };
}

function initializePackagedLogging(): void {
  if (!app.isPackaged) return;
  try {
    desktopLogSink = new RotatingFileSink({
      filePath: Path.join(LOG_DIR, "desktop-main.log"),
      maxBytes: LOG_FILE_MAX_BYTES,
      maxFiles: LOG_FILE_MAX_FILES,
    });
    backendLogSink = new RotatingFileSink({
      filePath: Path.join(LOG_DIR, "server-child.log"),
      maxBytes: LOG_FILE_MAX_BYTES,
      maxFiles: LOG_FILE_MAX_FILES,
    });
    installStdIoCapture();
    writeDesktopLogHeader(`runtime log capture enabled logDir=${LOG_DIR}`);
  } catch (error) {
    // Logging setup should never block app startup.
    console.error("[desktop] failed to initialize packaged logging", error);
  }
}

function captureBackendOutput(child: ChildProcess.ChildProcess): void {
  if (!app.isPackaged || backendLogSink === null) return;
  const writeChunk = (chunk: unknown): void => {
    if (!backendLogSink) return;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
    backendLogSink.write(buffer);
  };
  child.stdout?.on("data", writeChunk);
  child.stderr?.on("data", writeChunk);
}

initializePackagedLogging();

function getDestructiveMenuIcon(): Electron.NativeImage | undefined {
  if (process.platform !== "darwin") return undefined;
  if (destructiveMenuIconCache !== undefined) {
    return destructiveMenuIconCache ?? undefined;
  }
  try {
    const icon = nativeImage.createFromNamedImage("trash").resize({
      width: 14,
      height: 14,
    });
    if (icon.isEmpty()) {
      destructiveMenuIconCache = null;
      return undefined;
    }
    icon.setTemplateImage(true);
    destructiveMenuIconCache = icon;
    return icon;
  } catch {
    destructiveMenuIconCache = null;
    return undefined;
  }
}
let updatePollTimer: ReturnType<typeof setInterval> | null = null;
let updateStartupTimer: ReturnType<typeof setTimeout> | null = null;
let updateCheckInFlight = false;
let updateDownloadInFlight = false;
let desktopProfileCaptured = false;

const DESKTOP_PROFILE_WORKLOAD = `
  (async () => {
    const [{ useStore }] = await Promise.all([import('/src/store.ts')]);
    const projectCount = 10;
    const threadsPerProject = 3;
    const messagesPerThread = 60;
    const activitiesPerThread = 120;
    const checkpointsPerThread = 20;
    const baseTime = Date.parse("2026-03-27T00:00:00.000Z");
    const activeThreadId = "profile-thread-0-0";

    function iso(offsetMs) {
      return new Date(baseTime + offsetMs).toISOString();
    }

    function buildMessages(threadKey, iteration, isActiveThread) {
      const messages = [];
      for (let index = 0; index < messagesPerThread; index += 1) {
        const role = index % 2 === 0 ? "user" : "assistant";
        const streaming = isActiveThread && role === "assistant" && index === messagesPerThread - 1;
        messages.push({
          id: "message-" + threadKey + "-" + index,
          role,
          text: streaming
            ? "Streaming payload " + iteration + " " + "x".repeat(200 + iteration * 8)
            : role + " message " + index + " " + "x".repeat(120),
          turnId: "turn-" + threadKey + "-" + Math.floor(index / 2),
          streaming,
          createdAt: iso(index * 1_000),
          updatedAt: iso(index * 1_000 + iteration * 25),
        });
      }
      return messages;
    }

    function buildActivities(threadKey, iteration, isActiveThread) {
      const activities = [];
      for (let index = 0; index < activitiesPerThread; index += 1) {
        activities.push({
          id: "activity-" + threadKey + "-" + index,
          tone: index % 5 === 0 ? "tool" : "info",
          kind: index % 5 === 0 ? "tool.updated" : "turn.plan.updated",
          summary: index % 5 === 0 ? "Tool step " + index : "Plan step " + index,
          payload:
            index % 5 === 0
              ? {
                  title: "exec_command",
                  detail: isActiveThread && index === activitiesPerThread - 1
                    ? "iteration " + iteration + " " + "x".repeat(160)
                    : "detail " + index,
                  requestKind: "command",
                  itemType: "exec_command",
                }
              : {
                  plan: [
                    { step: "Inspect", status: "completed" },
                    { step: "Render", status: isActiveThread ? "inProgress" : "pending" },
                  ],
                },
          turnId: "turn-" + threadKey + "-" + Math.floor(index / 8),
          sequence: index + 1,
          createdAt: iso(index * 500 + iteration * 10),
        });
      }
      return activities;
    }

    function buildCheckpoints(threadKey) {
      const checkpoints = [];
      for (let index = 0; index < checkpointsPerThread; index += 1) {
        checkpoints.push({
          turnId: "turn-" + threadKey + "-" + index,
          checkpointTurnCount: index + 1,
          checkpointRef: "checkpoint-" + threadKey + "-" + index,
          status: "ready",
          files: [
            { path: "src/file-" + index + ".ts", kind: "modified", additions: 5 + index, deletions: 2 },
          ],
          assistantMessageId: "message-" + threadKey + "-" + (index * 2 + 1),
          completedAt: iso(index * 2_000),
        });
      }
      return checkpoints;
    }

    function buildSnapshot(iteration) {
      const projects = [];
      const threads = [];
      for (let projectIndex = 0; projectIndex < projectCount; projectIndex += 1) {
        const projectId = "project-" + projectIndex;
        projects.push({
          id: projectId,
          title: "Project " + projectIndex,
          workspaceRoot: "/tmp/project-" + projectIndex,
          defaultModel: "gpt-5-codex",
          scripts: [],
          createdAt: iso(projectIndex * 10_000),
          updatedAt: iso(projectIndex * 10_000 + iteration * 50),
          deletedAt: null,
        });
        for (let threadIndex = 0; threadIndex < threadsPerProject; threadIndex += 1) {
          const threadKey = projectIndex + "-" + threadIndex;
          const threadId = "profile-thread-" + threadKey;
          const isActiveThread = threadId === activeThreadId;
          threads.push({
            id: threadId,
            projectId,
            title: "Thread " + threadKey,
            model: "gpt-5-codex",
            runtimeMode: "full-access",
            interactionMode: isActiveThread ? "plan" : "default",
            branch: isActiveThread ? "feature/profile" : null,
            worktreePath: null,
            latestTurn: {
              turnId: "turn-" + threadKey + "-latest",
              state: isActiveThread ? "running" : "completed",
              requestedAt: iso(200_000),
              startedAt: iso(200_100),
              completedAt: isActiveThread ? null : iso(205_000),
              assistantMessageId: "message-" + threadKey + "-" + (messagesPerThread - 1),
            },
            createdAt: iso(projectIndex * 10_000 + threadIndex * 1_000),
            updatedAt: iso(projectIndex * 10_000 + threadIndex * 1_000 + iteration * 50),
            deletedAt: null,
            messages: buildMessages(threadKey, iteration, isActiveThread),
            proposedPlans: isActiveThread
              ? [
                  {
                    id: "plan-" + threadKey,
                    turnId: "turn-" + threadKey + "-latest",
                    planMarkdown: "# Profile plan\\n\\n- step one\\n- step two\\n- step three",
                    implementedAt: null,
                    implementationThreadId: null,
                    createdAt: iso(210_000),
                    updatedAt: iso(210_000 + iteration * 25),
                  },
                ]
              : [],
            activities: buildActivities(threadKey, iteration, isActiveThread),
            checkpoints: buildCheckpoints(threadKey),
            session: {
              threadId,
              status: isActiveThread ? "running" : "ready",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: isActiveThread ? "turn-" + threadKey + "-latest" : null,
              lastError: null,
              updatedAt: iso(220_000 + iteration * 25),
            },
          });
        }
      }
      return {
        snapshotSequence: iteration + 1,
        projects,
        threads,
        updatedAt: iso(300_000 + iteration * 50),
      };
    }

    const snapshot = buildSnapshot(0);
    const activeThread = snapshot.threads.find((thread) => thread.id === activeThreadId);
    const streamingMessage = activeThread.messages[activeThread.messages.length - 1];
    const trailingActivity = activeThread.activities[activeThread.activities.length - 1];
    const activePlan = activeThread.proposedPlans[0];

    useStore.getState().syncServerReadModel(snapshot);
    history.pushState({}, "", "/" + activeThreadId);
    window.dispatchEvent(new PopStateEvent("popstate"));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

    const startedAt = performance.now();
    for (let iteration = 1; iteration <= 40; iteration += 1) {
      snapshot.snapshotSequence = iteration + 1;
      snapshot.updatedAt = iso(300_000 + iteration * 50);
      activeThread.updatedAt = iso(220_000 + iteration * 50);
      activeThread.latestTurn.startedAt = iso(200_100 + iteration * 25);
      activeThread.session.updatedAt = iso(220_000 + iteration * 25);
      streamingMessage.text = "Streaming payload " + iteration + " " + "x".repeat(200 + iteration * 8);
      streamingMessage.updatedAt = iso(200_500 + iteration * 25);
      trailingActivity.createdAt = iso(260_000 + iteration * 25);
      trailingActivity.payload.detail = "iteration " + iteration + " " + "x".repeat(160);
      activePlan.updatedAt = iso(210_000 + iteration * 25);
      useStore.getState().syncServerReadModel(snapshot);
      if (iteration % 5 === 0) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
    }

    return { durationMs: performance.now() - startedAt };
  })();
`;
let updaterConfigured = false;
let updateState: DesktopUpdateState = initialUpdateState();

function resolveUpdaterErrorContext(): DesktopUpdateErrorContext {
  if (updateDownloadInFlight) return "download";
  if (updateCheckInFlight) return "check";
  return updateState.errorContext;
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: DESKTOP_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);

function resolveAppRoot(): string {
  if (!app.isPackaged) {
    return ROOT_DIR;
  }
  return app.getAppPath();
}

/** Read the baked-in app-update.yml config (if applicable). */
function readAppUpdateYml(): Record<string, string> | null {
  try {
    // electron-updater reads from process.resourcesPath in packaged builds,
    // or dev-app-update.yml via app.getAppPath() in dev.
    const ymlPath = app.isPackaged
      ? Path.join(process.resourcesPath, "app-update.yml")
      : Path.join(app.getAppPath(), "dev-app-update.yml");
    const raw = FS.readFileSync(ymlPath, "utf-8");
    // The YAML is simple key-value pairs — avoid pulling in a YAML parser by
    // doing a line-based parse (fields: provider, owner, repo, releaseType, …).
    const entries: Record<string, string> = {};
    for (const line of raw.split("\n")) {
      const match = line.match(/^(\w+):\s*(.+)$/);
      if (match?.[1] && match[2]) entries[match[1]] = match[2].trim();
    }
    return entries.provider ? entries : null;
  } catch {
    return null;
  }
}

function normalizeCommitHash(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!COMMIT_HASH_PATTERN.test(trimmed)) {
    return null;
  }
  return trimmed.slice(0, COMMIT_HASH_DISPLAY_LENGTH).toLowerCase();
}

function resolveEmbeddedCommitHash(): string | null {
  const packageJsonPath = Path.join(resolveAppRoot(), "package.json");
  if (!FS.existsSync(packageJsonPath)) {
    return null;
  }

  try {
    const raw = FS.readFileSync(packageJsonPath, "utf8");
    const parsed = JSON.parse(raw) as { t3codeCommitHash?: unknown };
    return normalizeCommitHash(parsed.t3codeCommitHash);
  } catch {
    return null;
  }
}

function resolveAboutCommitHash(): string | null {
  if (aboutCommitHashCache !== undefined) {
    return aboutCommitHashCache;
  }

  const envCommitHash = normalizeCommitHash(process.env.T3CODE_COMMIT_HASH);
  if (envCommitHash) {
    aboutCommitHashCache = envCommitHash;
    return aboutCommitHashCache;
  }

  // Only packaged builds are required to expose commit metadata.
  if (!app.isPackaged) {
    aboutCommitHashCache = null;
    return aboutCommitHashCache;
  }

  aboutCommitHashCache = resolveEmbeddedCommitHash();

  return aboutCommitHashCache;
}

function resolveBackendEntry(): string {
  return Path.join(resolveAppRoot(), "apps/server/dist/index.mjs");
}

function resolveBackendCwd(): string {
  if (!app.isPackaged) {
    return resolveAppRoot();
  }
  return OS.homedir();
}

function resolveDesktopStaticDir(): string | null {
  const appRoot = resolveAppRoot();
  const candidates = [
    Path.join(appRoot, "apps/server/dist/client"),
    Path.join(appRoot, "apps/web/dist"),
  ];

  for (const candidate of candidates) {
    if (FS.existsSync(Path.join(candidate, "index.html"))) {
      return candidate;
    }
  }

  return null;
}

function resolveDesktopStaticPath(staticRoot: string, requestUrl: string): string {
  const url = new URL(requestUrl);
  const rawPath = decodeURIComponent(url.pathname);
  const normalizedPath = Path.posix.normalize(rawPath).replace(/^\/+/, "");
  if (normalizedPath.includes("..")) {
    return Path.join(staticRoot, "index.html");
  }

  const requestedPath = normalizedPath.length > 0 ? normalizedPath : "index.html";
  const resolvedPath = Path.join(staticRoot, requestedPath);

  if (Path.extname(resolvedPath)) {
    return resolvedPath;
  }

  const nestedIndex = Path.join(resolvedPath, "index.html");
  if (FS.existsSync(nestedIndex)) {
    return nestedIndex;
  }

  return Path.join(staticRoot, "index.html");
}

function isStaticAssetRequest(requestUrl: string): boolean {
  try {
    const url = new URL(requestUrl);
    return Path.extname(url.pathname).length > 0;
  } catch {
    return false;
  }
}

function handleFatalStartupError(stage: string, error: unknown): void {
  const message = formatErrorMessage(error);
  const detail =
    error instanceof Error && typeof error.stack === "string" ? `\n${error.stack}` : "";
  writeDesktopLogHeader(`fatal startup error stage=${stage} message=${message}`);
  console.error(`[desktop] fatal startup error (${stage})`, error);
  if (!isQuitting) {
    isQuitting = true;
    dialog.showErrorBox("T3 Code failed to start", `Stage: ${stage}\n${message}${detail}`);
  }
  stopBackend();
  restoreStdIoCapture?.();
  app.quit();
}

function registerDesktopProtocol(): void {
  if (isDevelopment || desktopProtocolRegistered) return;

  const staticRoot = resolveDesktopStaticDir();
  if (!staticRoot) {
    throw new Error(
      "Desktop static bundle missing. Build apps/server (with bundled client) first.",
    );
  }

  const staticRootResolved = Path.resolve(staticRoot);
  const staticRootPrefix = `${staticRootResolved}${Path.sep}`;
  const fallbackIndex = Path.join(staticRootResolved, "index.html");

  protocol.registerFileProtocol(DESKTOP_SCHEME, (request, callback) => {
    try {
      const candidate = resolveDesktopStaticPath(staticRootResolved, request.url);
      const resolvedCandidate = Path.resolve(candidate);
      const isInRoot =
        resolvedCandidate === fallbackIndex || resolvedCandidate.startsWith(staticRootPrefix);
      const isAssetRequest = isStaticAssetRequest(request.url);

      if (!isInRoot || !FS.existsSync(resolvedCandidate)) {
        if (isAssetRequest) {
          callback({ error: -6 });
          return;
        }
        callback({ path: fallbackIndex });
        return;
      }

      callback({ path: resolvedCandidate });
    } catch {
      callback({ path: fallbackIndex });
    }
  });

  desktopProtocolRegistered = true;
}

function dispatchMenuAction(action: string): void {
  const existingWindow =
    BrowserWindow.getFocusedWindow() ?? mainWindow ?? BrowserWindow.getAllWindows()[0];
  const targetWindow = existingWindow ?? createWindow();
  if (!existingWindow) {
    mainWindow = targetWindow;
  }

  const send = () => {
    if (targetWindow.isDestroyed()) return;
    targetWindow.webContents.send(MENU_ACTION_CHANNEL, action);
    if (!targetWindow.isVisible()) {
      targetWindow.show();
    }
    targetWindow.focus();
  };

  if (targetWindow.webContents.isLoadingMainFrame()) {
    targetWindow.webContents.once("did-finish-load", send);
    return;
  }

  send();
}

function handleCheckForUpdatesMenuClick(): void {
  const disabledReason = getAutoUpdateDisabledReason({
    isDevelopment,
    isPackaged: app.isPackaged,
    platform: process.platform,
    appImage: process.env.APPIMAGE,
    disabledByEnv: process.env.T3CODE_DISABLE_AUTO_UPDATE === "1",
  });
  if (disabledReason) {
    console.info("[desktop-updater] Manual update check requested, but updates are disabled.");
    void dialog.showMessageBox({
      type: "info",
      title: "Updates unavailable",
      message: "Automatic updates are not available right now.",
      detail: disabledReason,
      buttons: ["OK"],
    });
    return;
  }

  if (!BrowserWindow.getAllWindows().length) {
    mainWindow = createWindow();
  }
  void checkForUpdatesFromMenu();
}

async function checkForUpdatesFromMenu(): Promise<void> {
  await checkForUpdates("menu");

  if (updateState.status === "up-to-date") {
    void dialog.showMessageBox({
      type: "info",
      title: "You're up to date!",
      message: `T3 Code ${updateState.currentVersion} is currently the newest version available.`,
      buttons: ["OK"],
    });
  } else if (updateState.status === "error") {
    void dialog.showMessageBox({
      type: "warning",
      title: "Update check failed",
      message: "Could not check for updates.",
      detail: updateState.message ?? "An unknown error occurred. Please try again later.",
      buttons: ["OK"],
    });
  }
}

function configureApplicationMenu(): void {
  const template: MenuItemConstructorOptions[] = [];

  if (process.platform === "darwin") {
    template.push({
      label: app.name,
      submenu: [
        { role: "about" },
        {
          label: "Check for Updates...",
          click: () => handleCheckForUpdatesMenuClick(),
        },
        { type: "separator" },
        {
          label: "Settings...",
          accelerator: "CmdOrCtrl+,",
          click: () => dispatchMenuAction("open-settings"),
        },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    });
  }

  template.push(
    {
      label: "File",
      submenu: [
        {
          label: "New Chat",
          accelerator: "CmdOrCtrl+N",
          click: () => dispatchMenuAction("chat.new"),
        },
        {
          label: "New Local Chat",
          accelerator: "CmdOrCtrl+Shift+N",
          click: () => dispatchMenuAction("chat.newLocal"),
        },
        { type: "separator" as const },
        ...(process.platform === "darwin"
          ? []
          : [
              {
                label: "Settings...",
                accelerator: "CmdOrCtrl+,",
                click: () => dispatchMenuAction("open-settings"),
              },
              { type: "separator" as const },
            ]),
        { role: process.platform === "darwin" ? "close" : "quit" },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn", accelerator: "CmdOrCtrl+=" },
        { role: "zoomIn", accelerator: "CmdOrCtrl+Plus", visible: false },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
        { type: "separator" },
        {
          label: "Toggle Canvas Fullscreen",
          accelerator: "Alt+Enter",
          click: () => dispatchMenuAction("canvas.toggleMaximize"),
          visible: false,
        },
        {
          label: "Toggle Canvas Fullscreen",
          accelerator: "CmdOrCtrl+Shift+Enter",
          click: () => dispatchMenuAction("canvas.toggleMaximize"),
          visible: false,
        },
      ],
    },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        {
          label: "Check for Updates...",
          click: () => handleCheckForUpdatesMenuClick(),
        },
      ],
    },
  );

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function resolveResourcePath(fileName: string): string | null {
  const candidates = [
    Path.join(__dirname, "../resources", fileName),
    Path.join(__dirname, "../prod-resources", fileName),
    Path.join(process.resourcesPath, "resources", fileName),
    Path.join(process.resourcesPath, fileName),
  ];

  for (const candidate of candidates) {
    if (FS.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function resolveIconPath(ext: "ico" | "icns" | "png"): string | null {
  return resolveResourcePath(`icon.${ext}`);
}

/**
 * Resolve the Electron userData directory path.
 *
 * Electron derives the default userData path from `productName` in
 * package.json, which currently produces directories with spaces and
 * parentheses (e.g. `~/.config/T3 Code (Alpha)` on Linux). This is
 * unfriendly for shell usage and violates Linux naming conventions.
 *
 * We override it to a clean lowercase name (`t3code`). If the legacy
 * directory already exists we keep using it so existing users don't
 * lose their Chromium profile data (localStorage, cookies, sessions).
 */
function resolveUserDataPath(): string {
  const appDataBase =
    process.platform === "win32"
      ? process.env.APPDATA || Path.join(OS.homedir(), "AppData", "Roaming")
      : process.platform === "darwin"
        ? Path.join(OS.homedir(), "Library", "Application Support")
        : process.env.XDG_CONFIG_HOME || Path.join(OS.homedir(), ".config");

  const legacyPath = Path.join(appDataBase, LEGACY_USER_DATA_DIR_NAME);
  if (FS.existsSync(legacyPath)) {
    return legacyPath;
  }

  return Path.join(appDataBase, USER_DATA_DIR_NAME);
}

function configureAppIdentity(): void {
  app.setName(APP_DISPLAY_NAME);
  const commitHash = resolveAboutCommitHash();
  app.setAboutPanelOptions({
    applicationName: APP_DISPLAY_NAME,
    applicationVersion: app.getVersion(),
    version: commitHash ?? "unknown",
  });

  if (process.platform === "win32") {
    app.setAppUserModelId(APP_USER_MODEL_ID);
  }

  if (process.platform === "darwin" && app.dock) {
    const iconPath = resolveIconPath("png");
    if (iconPath) {
      app.dock.setIcon(iconPath);
    }
  }
}

function clearUpdatePollTimer(): void {
  if (updateStartupTimer) {
    clearTimeout(updateStartupTimer);
    updateStartupTimer = null;
  }
  if (updatePollTimer) {
    clearInterval(updatePollTimer);
    updatePollTimer = null;
  }
}

function emitUpdateState(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue;
    window.webContents.send(UPDATE_STATE_CHANNEL, updateState);
  }
}

function setUpdateState(patch: Partial<DesktopUpdateState>): void {
  updateState = { ...updateState, ...patch };
  emitUpdateState();
}

function shouldEnableAutoUpdates(): boolean {
  return (
    getAutoUpdateDisabledReason({
      isDevelopment,
      isPackaged: app.isPackaged,
      platform: process.platform,
      appImage: process.env.APPIMAGE,
      disabledByEnv: process.env.T3CODE_DISABLE_AUTO_UPDATE === "1",
    }) === null
  );
}

async function checkForUpdates(reason: string): Promise<void> {
  if (isQuitting || !updaterConfigured || updateCheckInFlight) return;
  if (updateState.status === "downloading" || updateState.status === "downloaded") {
    console.info(
      `[desktop-updater] Skipping update check (${reason}) while status=${updateState.status}.`,
    );
    return;
  }
  updateCheckInFlight = true;
  setUpdateState(reduceDesktopUpdateStateOnCheckStart(updateState, new Date().toISOString()));
  console.info(`[desktop-updater] Checking for updates (${reason})...`);

  try {
    await autoUpdater.checkForUpdates();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    setUpdateState(
      reduceDesktopUpdateStateOnCheckFailure(updateState, message, new Date().toISOString()),
    );
    console.error(`[desktop-updater] Failed to check for updates: ${message}`);
  } finally {
    updateCheckInFlight = false;
  }
}

async function downloadAvailableUpdate(): Promise<{ accepted: boolean; completed: boolean }> {
  if (!updaterConfigured || updateDownloadInFlight || updateState.status !== "available") {
    return { accepted: false, completed: false };
  }
  updateDownloadInFlight = true;
  setUpdateState(reduceDesktopUpdateStateOnDownloadStart(updateState));
  autoUpdater.disableDifferentialDownload = isArm64HostRunningIntelBuild(desktopRuntimeInfo);
  console.info("[desktop-updater] Downloading update...");

  try {
    await autoUpdater.downloadUpdate();
    return { accepted: true, completed: true };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    setUpdateState(reduceDesktopUpdateStateOnDownloadFailure(updateState, message));
    console.error(`[desktop-updater] Failed to download update: ${message}`);
    return { accepted: true, completed: false };
  } finally {
    updateDownloadInFlight = false;
  }
}

async function installDownloadedUpdate(): Promise<{ accepted: boolean; completed: boolean }> {
  if (isQuitting || !updaterConfigured || updateState.status !== "downloaded") {
    return { accepted: false, completed: false };
  }

  isQuitting = true;
  clearUpdatePollTimer();
  try {
    await stopBackendAndWaitForExit();
    autoUpdater.quitAndInstall();
    return { accepted: true, completed: true };
  } catch (error: unknown) {
    const message = formatErrorMessage(error);
    isQuitting = false;
    setUpdateState(reduceDesktopUpdateStateOnInstallFailure(updateState, message));
    console.error(`[desktop-updater] Failed to install update: ${message}`);
    return { accepted: true, completed: false };
  }
}

function configureAutoUpdater(): void {
  const enabled = shouldEnableAutoUpdates();
  setUpdateState({
    ...createInitialDesktopUpdateState(app.getVersion(), desktopRuntimeInfo),
    enabled,
    status: enabled ? "idle" : "disabled",
  });
  if (!enabled) {
    return;
  }
  updaterConfigured = true;

  const githubToken =
    process.env.T3CODE_DESKTOP_UPDATE_GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim() || "";
  if (githubToken) {
    // When a token is provided, re-configure the feed with `private: true` so
    // electron-updater uses the GitHub API (api.github.com) instead of the
    // public Atom feed (github.com/…/releases.atom) which rejects Bearer auth.
    const appUpdateYml = readAppUpdateYml();
    if (appUpdateYml?.provider === "github") {
      autoUpdater.setFeedURL({
        ...appUpdateYml,
        provider: "github" as const,
        private: true,
        token: githubToken,
      });
    }
  }

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  // Keep alpha branding, but force all installs onto the stable update track.
  autoUpdater.channel = DESKTOP_UPDATE_CHANNEL;
  autoUpdater.allowPrerelease = DESKTOP_UPDATE_ALLOW_PRERELEASE;
  autoUpdater.allowDowngrade = false;
  autoUpdater.disableDifferentialDownload = isArm64HostRunningIntelBuild(desktopRuntimeInfo);
  let lastLoggedDownloadMilestone = -1;

  if (isArm64HostRunningIntelBuild(desktopRuntimeInfo)) {
    console.info(
      "[desktop-updater] Apple Silicon host detected while running Intel build; updates will switch to arm64 packages.",
    );
  }

  autoUpdater.on("checking-for-update", () => {
    console.info("[desktop-updater] Looking for updates...");
  });
  autoUpdater.on("update-available", (info) => {
    setUpdateState(
      reduceDesktopUpdateStateOnUpdateAvailable(
        updateState,
        info.version,
        new Date().toISOString(),
      ),
    );
    lastLoggedDownloadMilestone = -1;
    console.info(`[desktop-updater] Update available: ${info.version}`);
  });
  autoUpdater.on("update-not-available", () => {
    setUpdateState(reduceDesktopUpdateStateOnNoUpdate(updateState, new Date().toISOString()));
    lastLoggedDownloadMilestone = -1;
    console.info("[desktop-updater] No updates available.");
  });
  autoUpdater.on("error", (error) => {
    const message = formatErrorMessage(error);
    if (!updateCheckInFlight && !updateDownloadInFlight) {
      setUpdateState({
        status: "error",
        message,
        checkedAt: new Date().toISOString(),
        downloadPercent: null,
        errorContext: resolveUpdaterErrorContext(),
        canRetry: updateState.availableVersion !== null || updateState.downloadedVersion !== null,
      });
    }
    console.error(`[desktop-updater] Updater error: ${message}`);
  });
  autoUpdater.on("download-progress", (progress) => {
    const percent = Math.floor(progress.percent);
    if (
      shouldBroadcastDownloadProgress(updateState, progress.percent) ||
      updateState.message !== null
    ) {
      setUpdateState(reduceDesktopUpdateStateOnDownloadProgress(updateState, progress.percent));
    }
    const milestone = percent - (percent % 10);
    if (milestone > lastLoggedDownloadMilestone) {
      lastLoggedDownloadMilestone = milestone;
      console.info(`[desktop-updater] Download progress: ${percent}%`);
    }
  });
  autoUpdater.on("update-downloaded", (info) => {
    setUpdateState(reduceDesktopUpdateStateOnDownloadComplete(updateState, info.version));
    console.info(`[desktop-updater] Update downloaded: ${info.version}`);
  });

  clearUpdatePollTimer();

  updateStartupTimer = setTimeout(() => {
    updateStartupTimer = null;
    void checkForUpdates("startup");
  }, AUTO_UPDATE_STARTUP_DELAY_MS);
  updateStartupTimer.unref();

  updatePollTimer = setInterval(() => {
    void checkForUpdates("poll");
  }, AUTO_UPDATE_POLL_INTERVAL_MS);
  updatePollTimer.unref();
}
function scheduleBackendRestart(reason: string): void {
  if (isQuitting || restartTimer) return;

  const delayMs = Math.min(500 * 2 ** restartAttempt, 10_000);
  restartAttempt += 1;
  console.error(`[desktop] backend exited unexpectedly (${reason}); restarting in ${delayMs}ms`);

  restartTimer = setTimeout(() => {
    restartTimer = null;
    startBackend();
  }, delayMs);
}

function startBackend(): void {
  if (isQuitting || backendProcess) return;

  const backendEntry = resolveBackendEntry();
  if (!FS.existsSync(backendEntry)) {
    scheduleBackendRestart(`missing server entry at ${backendEntry}`);
    return;
  }

  const captureBackendLogs = app.isPackaged && backendLogSink !== null;
  const child = ChildProcess.spawn(process.execPath, [backendEntry, "--bootstrap-fd", "3"], {
    cwd: resolveBackendCwd(),
    // In Electron main, process.execPath points to the Electron binary.
    // Run the child in Node mode so this backend process does not become a GUI app instance.
    env: {
      ...backendChildEnv(),
      ELECTRON_RUN_AS_NODE: "1",
    },
    stdio: captureBackendLogs
      ? ["ignore", "pipe", "pipe", "pipe"]
      : ["ignore", "inherit", "inherit", "pipe"],
  });
  const bootstrapStream = child.stdio[3];
  if (bootstrapStream && "write" in bootstrapStream) {
    bootstrapStream.write(
      `${JSON.stringify({
        mode: "desktop",
        noBrowser: true,
        port: backendPort,
        t3Home: BASE_DIR,
        authToken: backendAuthToken,
      })}\n`,
    );
    bootstrapStream.end();
  } else {
    child.kill("SIGTERM");
    scheduleBackendRestart("missing desktop bootstrap pipe");
    return;
  }
  backendProcess = child;
  let backendSessionClosed = false;
  const closeBackendSession = (details: string) => {
    if (backendSessionClosed) return;
    backendSessionClosed = true;
    writeBackendSessionBoundary("END", details);
  };
  writeBackendSessionBoundary(
    "START",
    `pid=${child.pid ?? "unknown"} port=${backendPort} cwd=${resolveBackendCwd()}`,
  );
  captureBackendOutput(child);

  child.once("spawn", () => {
    restartAttempt = 0;
  });

  child.on("error", (error) => {
    if (backendProcess === child) {
      backendProcess = null;
    }
    closeBackendSession(`pid=${child.pid ?? "unknown"} error=${error.message}`);
    scheduleBackendRestart(error.message);
  });

  child.on("exit", (code, signal) => {
    if (backendProcess === child) {
      backendProcess = null;
    }
    closeBackendSession(
      `pid=${child.pid ?? "unknown"} code=${code ?? "null"} signal=${signal ?? "null"}`,
    );
    if (isQuitting) return;
    const reason = `code=${code ?? "null"} signal=${signal ?? "null"}`;
    scheduleBackendRestart(reason);
  });
}

function stopBackend(): void {
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }

  const child = backendProcess;
  backendProcess = null;
  if (!child) return;

  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }, 2_000).unref();
  }
}

async function stopBackendAndWaitForExit(timeoutMs = 5_000): Promise<void> {
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }

  const child = backendProcess;
  backendProcess = null;
  if (!child) return;
  const backendChild = child;
  if (backendChild.exitCode !== null || backendChild.signalCode !== null) return;

  await new Promise<void>((resolve) => {
    let settled = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
    let exitTimeoutTimer: ReturnType<typeof setTimeout> | null = null;

    function settle(): void {
      if (settled) return;
      settled = true;
      backendChild.off("exit", onExit);
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      if (exitTimeoutTimer) {
        clearTimeout(exitTimeoutTimer);
      }
      resolve();
    }

    function onExit(): void {
      settle();
    }

    backendChild.once("exit", onExit);
    backendChild.kill("SIGTERM");

    forceKillTimer = setTimeout(() => {
      if (backendChild.exitCode === null && backendChild.signalCode === null) {
        backendChild.kill("SIGKILL");
      }
    }, 2_000);
    forceKillTimer.unref();

    exitTimeoutTimer = setTimeout(() => {
      settle();
    }, timeoutMs);
    exitTimeoutTimer.unref();
  });
}

function registerIpcHandlers(): void {
  ipcMain.removeAllListeners(IS_DEV_CHANNEL);
  ipcMain.on(IS_DEV_CHANNEL, (event) => {
    event.returnValue = isDevBuild;
  });

  ipcMain.removeAllListeners(GET_WS_URL_CHANNEL);
  ipcMain.on(GET_WS_URL_CHANNEL, (event) => {
    event.returnValue = backendWsUrl;
  });

  ipcMain.removeHandler(PICK_FOLDER_CHANNEL);
  ipcMain.handle(PICK_FOLDER_CHANNEL, async () => {
    const owner = BrowserWindow.getFocusedWindow() ?? mainWindow;
    const result = owner
      ? await dialog.showOpenDialog(owner, {
          properties: ["openDirectory", "createDirectory"],
        })
      : await dialog.showOpenDialog({
          properties: ["openDirectory", "createDirectory"],
        });
    if (result.canceled) return null;
    return result.filePaths[0] ?? null;
  });

  ipcMain.removeHandler(CONFIRM_CHANNEL);
  ipcMain.handle(CONFIRM_CHANNEL, async (_event, message: unknown) => {
    if (typeof message !== "string") {
      return false;
    }

    const owner = BrowserWindow.getFocusedWindow() ?? mainWindow;
    return showDesktopConfirmDialog(message, owner);
  });

  ipcMain.removeHandler(SET_THEME_CHANNEL);
  ipcMain.handle(SET_THEME_CHANNEL, async (_event, rawTheme: unknown) => {
    const theme = getSafeTheme(rawTheme);
    if (!theme) {
      return;
    }

    nativeTheme.themeSource = theme;
  });

  ipcMain.removeHandler(CONTEXT_MENU_CHANNEL);
  ipcMain.handle(
    CONTEXT_MENU_CHANNEL,
    async (_event, items: ContextMenuItem[], position?: { x: number; y: number }) => {
      const normalizedItems = items
        .filter((item) => typeof item.id === "string" && typeof item.label === "string")
        .map((item) => ({
          id: item.id,
          label: item.label,
          destructive: item.destructive === true,
        }));
      if (normalizedItems.length === 0) {
        return null;
      }

      const popupPosition =
        position &&
        Number.isFinite(position.x) &&
        Number.isFinite(position.y) &&
        position.x >= 0 &&
        position.y >= 0
          ? {
              x: Math.floor(position.x),
              y: Math.floor(position.y),
            }
          : null;

      const window = BrowserWindow.getFocusedWindow() ?? mainWindow;
      if (!window) return null;

      return new Promise<string | null>((resolve) => {
        const template: MenuItemConstructorOptions[] = [];
        let hasInsertedDestructiveSeparator = false;
        for (const item of normalizedItems) {
          if (item.destructive && !hasInsertedDestructiveSeparator && template.length > 0) {
            template.push({ type: "separator" });
            hasInsertedDestructiveSeparator = true;
          }
          const itemOption: MenuItemConstructorOptions = {
            label: item.label,
            click: () => resolve(item.id),
          };
          if (item.destructive) {
            const destructiveIcon = getDestructiveMenuIcon();
            if (destructiveIcon) {
              itemOption.icon = destructiveIcon;
            }
          }
          template.push(itemOption);
        }

        const menu = Menu.buildFromTemplate(template);
        menu.popup({
          window,
          ...popupPosition,
          callback: () => resolve(null),
        });
      });
    },
  );

  ipcMain.removeHandler(OPEN_EXTERNAL_CHANNEL);
  ipcMain.handle(OPEN_EXTERNAL_CHANNEL, async (_event, rawUrl: unknown) => {
    const externalUrl = getSafeExternalUrl(rawUrl);
    if (!externalUrl) {
      return false;
    }

    try {
      await shell.openExternal(externalUrl);
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.removeHandler(UPDATE_GET_STATE_CHANNEL);
  ipcMain.handle(UPDATE_GET_STATE_CHANNEL, async () => updateState);

  ipcMain.removeHandler(UPDATE_DOWNLOAD_CHANNEL);
  ipcMain.handle(UPDATE_DOWNLOAD_CHANNEL, async () => {
    const result = await downloadAvailableUpdate();
    return {
      accepted: result.accepted,
      completed: result.completed,
      state: updateState,
    } satisfies DesktopUpdateActionResult;
  });

  ipcMain.removeHandler(UPDATE_INSTALL_CHANNEL);
  ipcMain.handle(UPDATE_INSTALL_CHANNEL, async () => {
    if (isQuitting) {
      return {
        accepted: false,
        completed: false,
        state: updateState,
      } satisfies DesktopUpdateActionResult;
    }
    const result = await installDownloadedUpdate();
    return {
      accepted: result.accepted,
      completed: result.completed,
      state: updateState,
    } satisfies DesktopUpdateActionResult;
  });

  ipcMain.removeHandler(BROWSER_EXTENSIONS_CHANNEL);
  ipcMain.handle(BROWSER_EXTENSIONS_CHANNEL, async () => {
    const browserSession = session.fromPartition("persist:browser");
    return browserSession.getAllExtensions().map((ext) => ({
      id: ext.id,
      name: ext.name,
      version: ext.version,
    }));
  });
}

function getIconOption(): { icon: string } | Record<string, never> {
  if (process.platform === "darwin") return {}; // macOS uses .icns from app bundle
  const ext = process.platform === "win32" ? "ico" : "png";
  const iconPath = resolveIconPath(ext);
  return iconPath ? { icon: iconPath } : {};
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 840,
    minHeight: 620,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: process.platform === "darwin" ? "#00000000" : "#09090b",
    ...(process.platform === "darwin"
      ? {
          transparent: true,
          vibrancy: "under-window" as const,
          visualEffectState: "active" as const,
        }
      : {}),
    ...getIconOption(),
    title: APP_DISPLAY_NAME,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 18 },
    webPreferences: {
      preload: Path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
    },
  });

  window.webContents.on("context-menu", (event, params) => {
    event.preventDefault();

    // Only show the native edit context menu on editable elements (inputs,
    // textareas, contenteditable). Non-editable areas use IPC-based custom
    // context menus (e.g. sidebar thread Delete/Rename) which would be
    // dismissed by a competing native popup menu.
    if (!params.isEditable && !params.misspelledWord) {
      return;
    }

    const menuTemplate: MenuItemConstructorOptions[] = [];

    if (params.misspelledWord) {
      for (const suggestion of params.dictionarySuggestions.slice(0, 5)) {
        menuTemplate.push({
          label: suggestion,
          click: () => window.webContents.replaceMisspelling(suggestion),
        });
      }
      if (params.dictionarySuggestions.length === 0) {
        menuTemplate.push({ label: "No suggestions", enabled: false });
      }
      menuTemplate.push({ type: "separator" });
    }

    menuTemplate.push(
      { role: "cut", enabled: params.editFlags.canCut },
      { role: "copy", enabled: params.editFlags.canCopy },
      { role: "paste", enabled: params.editFlags.canPaste },
      { role: "selectAll", enabled: params.editFlags.canSelectAll },
    );

    Menu.buildFromTemplate(menuTemplate).popup({ window });
  });

  // Configure embedded <webview> guests so extensions work properly
  window.webContents.on("will-attach-webview", (_event, webPreferences, _params) => {
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    // Disable sandbox for the webview guest so that extension content
    // scripts can be injected and run correctly.
    webPreferences.sandbox = false;
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    const externalUrl = getSafeExternalUrl(url);
    if (externalUrl) {
      void shell.openExternal(externalUrl);
    }
    return { action: "deny" };
  });

  window.on("page-title-updated", (event) => {
    event.preventDefault();
    window.setTitle(APP_DISPLAY_NAME);
  });
  window.webContents.on("did-finish-load", () => {
    window.setTitle(APP_DISPLAY_NAME);
    emitUpdateState();
    void maybeCaptureDesktopProfile(window);
  });
  window.once("ready-to-show", () => {
    window.show();
  });

  if (isDevelopment) {
    void window.loadURL(process.env.VITE_DEV_SERVER_URL as string);
    window.webContents.openDevTools({ mode: "detach" });
  } else {
    void window.loadURL(`${DESKTOP_SCHEME}://app/index.html`);
  }

  window.on("closed", () => {
    if (mainWindow === window) {
      mainWindow = null;
    }
  });

  return window;
}

async function maybeCaptureDesktopProfile(window: BrowserWindow): Promise<void> {
  if (desktopProfileCaptured || DESKTOP_PROFILE_OUT.length === 0) {
    return;
  }
  desktopProfileCaptured = true;

  const debuggerSession = window.webContents.debugger;

  try {
    if (!debuggerSession.isAttached()) {
      debuggerSession.attach("1.3");
    }
    await debuggerSession.sendCommand("Profiler.enable");
    await debuggerSession.sendCommand("Profiler.setSamplingInterval", { interval: 100 });
    await debuggerSession.sendCommand("Profiler.start");
    const workloadResult = await window.webContents.executeJavaScript(
      DESKTOP_PROFILE_WORKLOAD,
      true,
    );
    const profileResult = (await debuggerSession.sendCommand("Profiler.stop")) as {
      profile: unknown;
    };

    FS.mkdirSync(Path.dirname(DESKTOP_PROFILE_OUT), { recursive: true });
    FS.writeFileSync(
      DESKTOP_PROFILE_OUT,
      JSON.stringify(
        {
          capturedAt: new Date().toISOString(),
          workloadResult,
          profile: profileResult.profile,
        },
        null,
        2,
      ),
    );
    console.log(`[desktop] renderer CPU profile written to ${DESKTOP_PROFILE_OUT}`);
  } catch (error) {
    console.error("[desktop] failed to capture renderer CPU profile", error);
  } finally {
    if (debuggerSession.isAttached()) {
      debuggerSession.detach();
    }
    setTimeout(() => {
      if (!isQuitting) {
        app.quit();
      }
    }, 300).unref?.();
  }
}

// Override Electron's userData path before the `ready` event so that
// Chromium session data uses a filesystem-friendly directory name.
// Must be called synchronously at the top level — before `app.whenReady()`.
app.setPath("userData", resolveUserDataPath());

configureAppIdentity();

/**
 * Discovers Chrome/Chromium extension directories on the current platform
 * and loads them into the `persist:browser` webview session so the embedded
 * browser has access to the user's installed extensions.
 *
 * We scan well-known browser profile directories for Manifest V3 extensions.
 * If the same extension ID appears in multiple browsers, the first match wins.
 */
async function loadChromeExtensions(): Promise<void> {
  const browserSession = session.fromPartition("persist:browser");
  const home = OS.homedir();
  const platform = process.platform;

  // Build list of candidate Chrome profile extension directories
  const extensionRoots: string[] = [];
  if (platform === "darwin") {
    extensionRoots.push(
      Path.join(
        home,
        "Library",
        "Application Support",
        "Dia",
        "User Data",
        "Default",
        "Extensions",
      ),
      Path.join(
        home,
        "Library",
        "Application Support",
        "Google",
        "Chrome",
        "Default",
        "Extensions",
      ),
      Path.join(home, "Library", "Application Support", "Chromium", "Default", "Extensions"),
      Path.join(
        home,
        "Library",
        "Application Support",
        "Arc",
        "User Data",
        "Default",
        "Extensions",
      ),
      Path.join(
        home,
        "Library",
        "Application Support",
        "BraveSoftware",
        "Brave-Browser",
        "Default",
        "Extensions",
      ),
    );
  } else if (platform === "linux") {
    extensionRoots.push(
      Path.join(home, ".config", "Dia", "User Data", "Default", "Extensions"),
      Path.join(home, ".config", "google-chrome", "Default", "Extensions"),
      Path.join(home, ".config", "chromium", "Default", "Extensions"),
      Path.join(home, ".config", "BraveSoftware", "Brave-Browser", "Default", "Extensions"),
    );
  } else if (platform === "win32") {
    const appData = process.env.LOCALAPPDATA ?? Path.join(home, "AppData", "Local");
    extensionRoots.push(
      Path.join(appData, "Dia", "User Data", "Default", "Extensions"),
      Path.join(appData, "Google", "Chrome", "User Data", "Default", "Extensions"),
      Path.join(appData, "Chromium", "User Data", "Default", "Extensions"),
      Path.join(appData, "BraveSoftware", "Brave-Browser", "User Data", "Default", "Extensions"),
    );
  }

  // Track which extension IDs we've already loaded to deduplicate across browsers
  const loadedIds = new Set<string>();
  let loadedCount = 0;
  let skippedCount = 0;

  for (const extRoot of extensionRoots) {
    if (!FS.existsSync(extRoot)) continue;
    console.log(`[desktop] scanning extensions in: ${extRoot}`);

    let extensionIds: string[];
    try {
      extensionIds = FS.readdirSync(extRoot).filter(
        (name) => !name.startsWith(".") && name !== "Temp",
      );
    } catch {
      continue;
    }

    for (const extId of extensionIds) {
      // Skip if we already loaded this extension from another browser
      if (loadedIds.has(extId)) continue;

      const extIdDir = Path.join(extRoot, extId);

      // Each extension ID dir contains version subdirectories — pick the latest
      let versions: string[];
      try {
        versions = FS.readdirSync(extIdDir)
          .filter((v) => !v.startsWith(".") && v !== "Temp")
          .sort()
          .reverse();
      } catch {
        continue;
      }

      if (versions.length === 0) continue;
      const extPath = Path.join(extIdDir, versions[0]!);
      const manifestPath = Path.join(extPath, "manifest.json");

      // Verify manifest.json exists
      if (!FS.existsSync(manifestPath)) continue;

      // Read manifest to get extension name for better logging
      let extName = extId;
      try {
        const manifest = JSON.parse(FS.readFileSync(manifestPath, "utf-8"));
        extName = manifest.name ?? extId;
        // Skip Manifest V2 extensions — Electron only supports MV3
        if (manifest.manifest_version < 3) {
          console.log(`[desktop] skipping MV${manifest.manifest_version} extension: ${extName}`);
          skippedCount++;
          continue;
        }
      } catch {
        // If we can't read the manifest, try loading anyway
      }

      try {
        await browserSession.loadExtension(extPath, { allowFileAccess: true });
        loadedIds.add(extId);
        loadedCount++;
        console.log(`[desktop] loaded extension: ${extName} (${extId})`);
      } catch (err) {
        skippedCount++;
        console.warn(`[desktop] failed to load extension "${extName}" (${extId}): ${err}`);
      }
    }
  }

  console.log(
    `[desktop] extension loading complete: ${loadedCount} loaded, ${skippedCount} skipped`,
  );

  // Log all successfully loaded extensions for verification
  const allLoaded = browserSession.getAllExtensions();
  if (allLoaded.length > 0) {
    console.log(`[desktop] active extensions in browser session:`);
    for (const ext of allLoaded) {
      console.log(`  - ${ext.name} (${ext.id})`);
    }
  }
}

/**
 * Copies native messaging host manifests from Chrome / Dia / Brave / etc. into
 * our app's NativeMessagingHosts directory so that extensions like 1Password
 * can launch their companion native host binary (e.g. 1Password-BrowserSupport)
 * and communicate via the standard Chrome native messaging protocol.
 *
 * Chromium (inside Electron) looks for host manifests at:
 *   <userData>/NativeMessagingHosts/<host-name>.json
 * By copying manifests there, `chrome.runtime.connectNative()` calls from
 * loaded extensions will resolve to the correct host binary.
 */
function registerNativeMessagingHosts(): void {
  const userData = app.getPath("userData");
  const destDir = Path.join(userData, "NativeMessagingHosts");
  const home = OS.homedir();
  const platform = process.platform;

  // Directories where browsers store native messaging host manifests
  const sourceDirs: string[] = [];
  if (platform === "darwin") {
    sourceDirs.push(
      Path.join(home, "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts"),
      Path.join(home, "Library", "Application Support", "Chromium", "NativeMessagingHosts"),
      Path.join(home, "Library", "Application Support", "Dia", "NativeMessagingHosts"),
      Path.join(home, "Library", "Application Support", "Dia", "User Data", "NativeMessagingHosts"),
      Path.join(
        home,
        "Library",
        "Application Support",
        "BraveSoftware",
        "Brave-Browser",
        "NativeMessagingHosts",
      ),
      // System-wide hosts
      "/Library/Google/Chrome/NativeMessagingHosts",
    );
  } else if (platform === "linux") {
    sourceDirs.push(
      Path.join(home, ".config", "google-chrome", "NativeMessagingHosts"),
      Path.join(home, ".config", "chromium", "NativeMessagingHosts"),
      Path.join(home, ".config", "Dia", "NativeMessagingHosts"),
      Path.join(home, ".config", "BraveSoftware", "Brave-Browser", "NativeMessagingHosts"),
      "/etc/opt/chrome/native-messaging-hosts",
      "/etc/chromium/native-messaging-hosts",
    );
  } else if (platform === "win32") {
    // On Windows, native messaging hosts are registered via the Windows
    // Registry rather than manifest files in a directory, so this approach
    // doesn't directly apply.  Extension native messaging on Windows may
    // require separate Registry-based registration.
  }

  // Collect all unique manifest files (first source wins for duplicates)
  const seenNames = new Set<string>();
  const manifests: Array<{ name: string; srcPath: string }> = [];

  for (const dir of sourceDirs) {
    if (!FS.existsSync(dir)) continue;
    try {
      for (const file of FS.readdirSync(dir)) {
        if (!file.endsWith(".json")) continue;
        if (seenNames.has(file)) continue;

        const srcPath = Path.join(dir, file);
        try {
          const content = JSON.parse(FS.readFileSync(srcPath, "utf-8"));
          // Validate it looks like a native messaging host manifest
          if (content.name && content.path && content.type === "stdio") {
            // Verify the host binary exists
            if (FS.existsSync(content.path)) {
              seenNames.add(file);
              manifests.push({ name: file, srcPath });
            } else {
              console.log(
                `[desktop] skipping native host "${content.name}" — binary not found: ${content.path}`,
              );
            }
          }
        } catch {
          // Not a valid manifest, skip
        }
      }
    } catch {
      // Can't read directory, skip
    }
  }

  if (manifests.length === 0) {
    console.log("[desktop] no native messaging hosts found to register");
    return;
  }

  // Ensure destination directory exists
  try {
    FS.mkdirSync(destDir, { recursive: true });
  } catch (err) {
    console.warn("[desktop] failed to create NativeMessagingHosts directory:", err);
    return;
  }

  let registeredCount = 0;
  for (const { name, srcPath } of manifests) {
    const destPath = Path.join(destDir, name);
    try {
      // Read the source manifest
      const content = JSON.parse(FS.readFileSync(srcPath, "utf-8"));

      // Get the IDs of all loaded extensions in our browser session so we can
      // add them to allowed_origins (the extension ID may differ from Chrome's
      // if Electron assigns a different ID).
      const browserSession = session.fromPartition("persist:browser");
      const loadedExtensions = browserSession.getAllExtensions();
      const loadedOrigins = loadedExtensions.map((ext) => `chrome-extension://${ext.id}/`);

      // Merge our extension origins with the existing allowed_origins
      const existingOrigins: string[] = content.allowed_origins ?? [];
      const allOrigins = [...new Set([...existingOrigins, ...loadedOrigins])];
      content.allowed_origins = allOrigins;

      // Write the updated manifest to our NativeMessagingHosts directory
      FS.writeFileSync(destPath, JSON.stringify(content, null, 2));
      registeredCount++;
      console.log(`[desktop] registered native messaging host: ${content.name}`);
    } catch (err) {
      console.warn(`[desktop] failed to register native host "${name}":`, err);
    }
  }

  console.log(`[desktop] native messaging hosts registered: ${registeredCount}`);
}

// ---------------------------------------------------------------------------
// Native messaging bridge
// ---------------------------------------------------------------------------

/** Parsed native messaging host manifest. */
interface NativeHostManifest {
  name: string;
  path: string;
  type: "stdio";
  allowed_origins?: string[];
}

/** Resolved manifests keyed by host name (e.g. "com.1password.1password"). */
const nativeHostManifests = new Map<string, NativeHostManifest>();

/**
 * Scan for native messaging host manifests and index them so the IPC handlers
 * can look them up quickly when an extension calls connectNative.
 */
function indexNativeMessagingHosts(): void {
  const home = OS.homedir();
  const platform = process.platform;

  const dirs: string[] = [];
  if (platform === "darwin") {
    dirs.push(
      Path.join(home, "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts"),
      Path.join(home, "Library", "Application Support", "Chromium", "NativeMessagingHosts"),
      Path.join(home, "Library", "Application Support", "Dia", "NativeMessagingHosts"),
      Path.join(home, "Library", "Application Support", "Dia", "User Data", "NativeMessagingHosts"),
      Path.join(
        home,
        "Library",
        "Application Support",
        "BraveSoftware",
        "Brave-Browser",
        "NativeMessagingHosts",
      ),
      "/Library/Google/Chrome/NativeMessagingHosts",
    );
  } else if (platform === "linux") {
    dirs.push(
      Path.join(home, ".config", "google-chrome", "NativeMessagingHosts"),
      Path.join(home, ".config", "chromium", "NativeMessagingHosts"),
      Path.join(home, ".config", "Dia", "NativeMessagingHosts"),
      Path.join(home, ".config", "BraveSoftware", "Brave-Browser", "NativeMessagingHosts"),
      "/etc/opt/chrome/native-messaging-hosts",
      "/etc/chromium/native-messaging-hosts",
    );
  } else if (platform === "win32") {
    // Windows uses the registry; not implemented here.
  }

  for (const dir of dirs) {
    if (!FS.existsSync(dir)) continue;
    try {
      for (const file of FS.readdirSync(dir)) {
        if (!file.endsWith(".json")) continue;
        try {
          const manifest: NativeHostManifest = JSON.parse(
            FS.readFileSync(Path.join(dir, file), "utf-8"),
          );
          if (
            manifest.name &&
            manifest.path &&
            manifest.type === "stdio" &&
            FS.existsSync(manifest.path) &&
            !nativeHostManifests.has(manifest.name)
          ) {
            nativeHostManifests.set(manifest.name, manifest);
            console.log(`[desktop] indexed native host: ${manifest.name} → ${manifest.path}`);
          }
        } catch {
          // skip invalid manifests
        }
      }
    } catch {
      // skip unreadable dirs
    }
  }

  console.log(`[desktop] indexed ${nativeHostManifests.size} native messaging hosts`);
}

/**
 * Active native host connections keyed by port ID.
 * Each entry holds the spawned child process.
 */
const activeNativePorts = new Map<number, { proc: ChildProcess.ChildProcess; hostName: string }>();

/**
 * Read a single length-prefixed native message from a buffer.
 * Returns [parsed message, remaining buffer] or null if incomplete.
 */
function readNativeMessage(buf: Buffer): [unknown, Buffer] | null {
  if (buf.length < 4) return null;
  const len = buf.readUInt32LE(0);
  if (buf.length < 4 + len) return null;
  const json = buf.subarray(4, 4 + len).toString("utf-8");
  const remaining = Buffer.from(buf.subarray(4 + len));
  return [JSON.parse(json), remaining];
}

/** Encode a message in Chrome's native messaging wire format. */
function encodeNativeMessage(message: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(message), "utf-8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  return Buffer.concat([header, json]);
}

/**
 * Register IPC handlers for the native messaging bridge.
 * Called once during bootstrap.
 */
function registerNativeMessagingIpc(): void {
  // Long-lived connection: spawn host, wire up stdio
  ipcMain.on("browser:native-msg-connect", (event, data: { portId: number; hostName: string }) => {
    const manifest = nativeHostManifests.get(data.hostName);
    if (!manifest) {
      console.warn(`[native-msg] unknown host: ${data.hostName}`);
      event.sender.send("browser:native-msg-disconnected", {
        portId: data.portId,
      });
      return;
    }

    try {
      const proc = ChildProcess.spawn(manifest.path, [], {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          // Chrome passes the extension's origin as an arg; some hosts need it
          CHROME_EXTENSION_ID: "",
        },
      });

      let stdoutBuffer: Buffer = Buffer.alloc(0);

      proc.stdout?.on("data", (chunk: Buffer) => {
        stdoutBuffer = Buffer.from(Buffer.concat([stdoutBuffer, chunk]));
        // Drain all complete messages
        let result = readNativeMessage(stdoutBuffer);
        while (result) {
          const [message, remaining] = result;
          stdoutBuffer = Buffer.from(remaining);
          try {
            event.sender.send("browser:native-msg-incoming", {
              portId: data.portId,
              message,
            });
          } catch {
            // Sender may be destroyed
          }
          result = readNativeMessage(stdoutBuffer);
        }
      });

      proc.stderr?.on("data", (chunk: Buffer) => {
        console.warn(`[native-msg] ${data.hostName} stderr:`, chunk.toString());
      });

      proc.on("exit", () => {
        activeNativePorts.delete(data.portId);
        try {
          event.sender.send("browser:native-msg-disconnected", {
            portId: data.portId,
          });
        } catch {
          // Sender may be destroyed
        }
      });

      activeNativePorts.set(data.portId, { proc, hostName: data.hostName });
      console.log(`[native-msg] connected to ${data.hostName} (port ${data.portId})`);
    } catch (err) {
      console.error(`[native-msg] failed to spawn ${data.hostName}:`, err);
      event.sender.send("browser:native-msg-disconnected", {
        portId: data.portId,
      });
    }
  });

  // Post message to an active native port
  ipcMain.on("browser:native-msg-post", (_event, data: { portId: number; message: unknown }) => {
    const entry = activeNativePorts.get(data.portId);
    if (!entry) return;
    try {
      entry.proc.stdin?.write(encodeNativeMessage(data.message));
    } catch (err) {
      console.warn(`[native-msg] write error:`, err);
    }
  });

  // Disconnect a native port
  ipcMain.on("browser:native-msg-disconnect", (_event, data: { portId: number }) => {
    const entry = activeNativePorts.get(data.portId);
    if (!entry) return;
    try {
      entry.proc.kill();
    } catch {
      // already dead
    }
    activeNativePorts.delete(data.portId);
  });

  // One-shot sendNativeMessage: spawn, send, read one response, kill
  ipcMain.handle(
    "browser:native-msg-send",
    async (_event, data: { hostName: string; message: unknown }) => {
      const manifest = nativeHostManifests.get(data.hostName);
      if (!manifest) {
        throw new Error(`Unknown native messaging host: ${data.hostName}`);
      }

      return new Promise((resolve, reject) => {
        const proc = ChildProcess.spawn(manifest.path, [], {
          stdio: ["pipe", "pipe", "pipe"],
        });

        let stdoutBuffer = Buffer.alloc(0);
        const timeout = setTimeout(() => {
          proc.kill();
          reject(new Error("Native messaging timeout"));
        }, 10_000);

        proc.stdout?.on("data", (chunk: Buffer) => {
          stdoutBuffer = Buffer.concat([stdoutBuffer, chunk]);
          const result = readNativeMessage(stdoutBuffer);
          if (result) {
            clearTimeout(timeout);
            proc.kill();
            resolve(result[0]);
          }
        });

        proc.on("error", (err) => {
          clearTimeout(timeout);
          reject(err);
        });

        proc.on("exit", () => {
          clearTimeout(timeout);
        });

        try {
          proc.stdin?.write(encodeNativeMessage(data.message));
          // Signal end of input for one-shot messages
          proc.stdin?.end();
        } catch (err) {
          clearTimeout(timeout);
          proc.kill();
          reject(err);
        }
      });
    },
  );

  console.log("[desktop] native messaging IPC handlers registered");
}

async function bootstrap(): Promise<void> {
  writeDesktopLogHeader("bootstrap start");
  backendPort = await Effect.service(NetService).pipe(
    Effect.flatMap((net) => net.reserveLoopbackPort()),
    Effect.provide(NetService.layer),
    Effect.runPromise,
  );
  writeDesktopLogHeader(`reserved backend port via NetService port=${backendPort}`);
  backendAuthToken = Crypto.randomBytes(24).toString("hex");
  const baseUrl = `ws://127.0.0.1:${backendPort}`;
  backendWsUrl = `${baseUrl}/?token=${encodeURIComponent(backendAuthToken)}`;
  writeDesktopLogHeader(`bootstrap resolved websocket endpoint baseUrl=${baseUrl}`);

  registerIpcHandlers();
  writeDesktopLogHeader("bootstrap ipc handlers registered");

  let extensionLoadPromise: Promise<void> = Promise.resolve();
  if (ENABLE_BROWSER_EXTENSIONS) {
    // Index native messaging hosts (1Password, etc.) before loading extensions
    // so the bridge is ready when extensions try to connect.
    indexNativeMessagingHosts();

    // Register IPC handlers for the native messaging bridge
    registerNativeMessagingIpc();

    // Set up a preload script for the browser session so extensions get
    // polyfilled chrome.runtime.connectNative / sendNativeMessage.
    const browserSession = session.fromPartition("persist:browser");
    const browserPreloadPath = Path.join(__dirname, "browser-preload.js");
    if (FS.existsSync(browserPreloadPath)) {
      browserSession.setPreloads([browserPreloadPath]);
      console.log("[desktop] browser session preload registered:", browserPreloadPath);
    } else {
      console.warn("[desktop] browser-preload.js not found at:", browserPreloadPath);
    }

    // Load Chrome extensions into the embedded browser session.
    // We await this so extensions are available before the webview is used,
    // but it runs concurrently with the backend starting below.
    extensionLoadPromise = loadChromeExtensions().catch((err) => {
      console.warn("[desktop] failed to load Chrome extensions:", err);
    });
  } else {
    console.log(
      "[desktop] browser extension loading disabled; set T3CODE_ENABLE_BROWSER_EXTENSIONS=1 to enable",
    );
  }

  startBackend();
  writeDesktopLogHeader("bootstrap backend start requested");
  mainWindow = createWindow();
  writeDesktopLogHeader("bootstrap main window created");

  // Wait for extensions to finish loading (they run concurrently with backend start + window creation)
  await extensionLoadPromise;

  if (ENABLE_BROWSER_EXTENSIONS) {
    // Write native messaging host manifests into the app's userData directory
    // so Chromium's built-in host lookup can also find them (belt-and-suspenders
    // alongside our IPC bridge).
    registerNativeMessagingHosts();
  }
}

app.on("before-quit", () => {
  isQuitting = true;
  writeDesktopLogHeader("before-quit received");
  clearUpdatePollTimer();
  stopBackend();
  restoreStdIoCapture?.();
});

app
  .whenReady()
  .then(() => {
    writeDesktopLogHeader("app ready");
    configureAppIdentity();
    configureApplicationMenu();
    registerDesktopProtocol();
    configureAutoUpdater();
    void bootstrap().catch((error) => {
      handleFatalStartupError("bootstrap", error);
    });

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createWindow();
      }
    });
  })
  .catch((error) => {
    handleFatalStartupError("whenReady", error);
  });

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

if (process.platform !== "win32") {
  process.on("SIGINT", () => {
    if (isQuitting) return;
    isQuitting = true;
    writeDesktopLogHeader("SIGINT received");
    clearUpdatePollTimer();
    stopBackend();
    restoreStdIoCapture?.();
    app.quit();
  });

  process.on("SIGTERM", () => {
    if (isQuitting) return;
    isQuitting = true;
    writeDesktopLogHeader("SIGTERM received");
    clearUpdatePollTimer();
    stopBackend();
    restoreStdIoCapture?.();
    app.quit();
  });
}
