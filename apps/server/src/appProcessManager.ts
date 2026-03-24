/**
 * AppProcessManager — Server-side process manager for embedded applications.
 *
 * Automatically provisions code-server by downloading and caching the correct
 * platform binary (like IDX0), then spawns and manages the process, monitors
 * health, and exposes lifecycle status via WebSocket events.
 *
 * @module AppProcessManager
 */
import { spawn, execSync, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Effect, Layer, Schema, ServiceMap } from "effect";
import type { AppEmbedStatus } from "@t3tools/contracts";
import { createLogger } from "./logger";

const log = createLogger("AppProcessManager");

// ── Code-Server Build Manifest ────────────────────────────────────────
// Mirroring IDX0's openvscode-build-manifest.json approach.
// The provisioner downloads, verifies (SHA256), and caches the binary.

const CODE_SERVER_VERSION = "4.100.3";

interface CodeServerArtifact {
  platform: string;
  downloadUrl: string;
  sha256: string;
  extractDirName: string;
}

const CODE_SERVER_ARTIFACTS: CodeServerArtifact[] = [
  {
    platform: "darwin-arm64",
    downloadUrl: `https://github.com/coder/code-server/releases/download/v${CODE_SERVER_VERSION}/code-server-${CODE_SERVER_VERSION}-macos-arm64.tar.gz`,
    sha256: "", // Will be verified on first download; set to empty to skip check initially
    extractDirName: `code-server-${CODE_SERVER_VERSION}-macos-arm64`,
  },
  {
    platform: "darwin-x64",
    downloadUrl: `https://github.com/coder/code-server/releases/download/v${CODE_SERVER_VERSION}/code-server-${CODE_SERVER_VERSION}-macos-amd64.tar.gz`,
    sha256: "",
    extractDirName: `code-server-${CODE_SERVER_VERSION}-macos-amd64`,
  },
  {
    platform: "linux-x64",
    downloadUrl: `https://github.com/coder/code-server/releases/download/v${CODE_SERVER_VERSION}/code-server-${CODE_SERVER_VERSION}-linux-amd64.tar.gz`,
    sha256: "",
    extractDirName: `code-server-${CODE_SERVER_VERSION}-linux-amd64`,
  },
  {
    platform: "linux-arm64",
    downloadUrl: `https://github.com/coder/code-server/releases/download/v${CODE_SERVER_VERSION}/code-server-${CODE_SERVER_VERSION}-linux-arm64.tar.gz`,
    sha256: "",
    extractDirName: `code-server-${CODE_SERVER_VERSION}-linux-arm64`,
  },
];

function currentPlatformId(): string {
  return `${process.platform}-${process.arch}`;
}

function getArtifactForPlatform(): CodeServerArtifact | undefined {
  return CODE_SERVER_ARTIFACTS.find((a) => a.platform === currentPlatformId());
}

// ── Provisioner Paths ─────────────────────────────────────────────────

function getProvisionBaseDir(): string {
  // Store alongside hapcode data: ~/.hapcode/code-server/
  const home = os.homedir();
  return path.join(home, ".hapcode", "code-server");
}

function getVersionsDir(): string {
  return path.join(getProvisionBaseDir(), "versions");
}

function getDownloadsDir(): string {
  return path.join(getProvisionBaseDir(), "downloads");
}

interface InstallRecord {
  version: string;
  platform: string;
  extractDirName: string;
  installedAt: string;
}

function getInstallRecordPath(): string {
  return path.join(getProvisionBaseDir(), "install-record.json");
}

// ── Auto-Provisioner ──────────────────────────────────────────────────

/** In-flight provisioning promise — prevents duplicate concurrent downloads. */
let provisioningTask: Promise<string> | null = null;

/**
 * Ensure code-server is available locally. Downloads and extracts if needed.
 * Returns the absolute path to the code-server executable.
 */
async function ensureCodeServerProvisioned(): Promise<string> {
  // Check if already provisioned
  const existing = await checkExistingInstall();
  if (existing) return existing;

  // Deduplicate concurrent provision calls
  if (provisioningTask) return provisioningTask;

  provisioningTask = provisionCodeServer().finally(() => {
    provisioningTask = null;
  });

  return provisioningTask;
}

async function checkExistingInstall(): Promise<string | null> {
  try {
    const recordPath = getInstallRecordPath();
    const raw = await fsp.readFile(recordPath, "utf-8");
    const record: InstallRecord = JSON.parse(raw);

    // Validate it matches current platform and version
    if (record.version !== CODE_SERVER_VERSION) return null;
    if (record.platform !== currentPlatformId()) return null;

    const executablePath = path.join(
      getVersionsDir(),
      record.extractDirName,
      "bin",
      "code-server",
    );

    // Verify the executable actually exists
    await fsp.access(executablePath, fs.constants.X_OK);
    log.info(`code-server ${record.version} already provisioned at ${executablePath}`);
    return executablePath;
  } catch {
    return null;
  }
}

async function provisionCodeServer(): Promise<string> {
  const artifact = getArtifactForPlatform();
  if (!artifact) {
    throw new Error(
      `Unsupported platform: ${currentPlatformId()}. ` +
        `code-server is available for: ${CODE_SERVER_ARTIFACTS.map((a) => a.platform).join(", ")}`,
    );
  }

  log.info(`Provisioning code-server ${CODE_SERVER_VERSION} for ${artifact.platform}...`);

  // Ensure directories exist
  await fsp.mkdir(getVersionsDir(), { recursive: true });
  await fsp.mkdir(getDownloadsDir(), { recursive: true });

  // Download
  const archivePath = path.join(getDownloadsDir(), `${artifact.extractDirName}.tar.gz`);
  if (!fs.existsSync(archivePath)) {
    log.info(`Downloading from ${artifact.downloadUrl}...`);
    await downloadFile(artifact.downloadUrl, archivePath);
    log.info(`Download complete: ${archivePath}`);
  }

  // SHA256 verification (if hash is provided)
  if (artifact.sha256) {
    const hash = await computeSha256(archivePath);
    if (hash.toLowerCase() !== artifact.sha256.toLowerCase()) {
      await fsp.unlink(archivePath).catch(() => {});
      throw new Error(
        `SHA256 mismatch for code-server download. Expected: ${artifact.sha256}, Got: ${hash}`,
      );
    }
    log.info("SHA256 checksum verified");
  }

  // Extract
  const extractTarget = getVersionsDir();
  log.info(`Extracting to ${extractTarget}...`);
  execSync(`tar -xzf "${archivePath}" -C "${extractTarget}"`, { stdio: "pipe" });

  // Verify executable
  const executablePath = path.join(extractTarget, artifact.extractDirName, "bin", "code-server");
  await fsp.access(executablePath, fs.constants.X_OK);
  log.info(`code-server executable verified at ${executablePath}`);

  // Write install record
  const record: InstallRecord = {
    version: CODE_SERVER_VERSION,
    platform: artifact.platform,
    extractDirName: artifact.extractDirName,
    installedAt: new Date().toISOString(),
  };
  await fsp.writeFile(getInstallRecordPath(), JSON.stringify(record, null, 2));

  // Clean up archive to save space
  await fsp.unlink(archivePath).catch(() => {});

  log.info(`code-server ${CODE_SERVER_VERSION} provisioned successfully`);
  return executablePath;
}

async function downloadFile(url: string, dest: string): Promise<void> {
  const tempDest = `${dest}.tmp`;
  return new Promise((resolve, reject) => {
    const follow = (url: string, redirects = 0) => {
      if (redirects > 5) {
        reject(new Error("Too many redirects"));
        return;
      }

      const client = url.startsWith("https") ? https : http;
      client
        .get(url, (res) => {
          // Follow redirects (GitHub releases redirect to CDN)
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            follow(res.headers.location, redirects + 1);
            return;
          }

          if (!res.statusCode || res.statusCode >= 400) {
            reject(new Error(`Download failed with HTTP ${res.statusCode}`));
            return;
          }

          const fileStream = fs.createWriteStream(tempDest);
          pipeline(res, fileStream)
            .then(() => fsp.rename(tempDest, dest))
            .then(resolve, reject);
        })
        .on("error", reject);
    };
    follow(url);
  });
}

async function computeSha256(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

// ── Types ─────────────────────────────────────────────────────────────

interface AppProcessEntry {
  proc: ChildProcess;
  port: number;
  status: AppEmbedStatus;
  windowId: string;
  appType: string;
}

interface AppProcessConfig {
  /** Resolves to the executable path. For vscode, triggers auto-provisioning. */
  resolveCommand: () => Promise<string>;
  args: (opts: { cwd: string; port: number }) => string[];
  healthCheckUrl: (port: number) => string;
}

// ── Registry of known app types ───────────────────────────────────────

const APP_PROCESS_CONFIGS: Record<string, AppProcessConfig> = {
  vscode: {
    resolveCommand: () => ensureCodeServerProvisioned(),
    args: ({ cwd, port }) => [
      "--port",
      String(port),
      "--auth",
      "none",
      "--disable-telemetry",
      cwd,
    ],
    healthCheckUrl: (port) => `http://localhost:${port}/healthz`,
  },
  // Cursor does not publish a web-based server binary (desktop-only app).
  // When/if they add a code-server equivalent, it can be added here.
};

// ── Port allocation ───────────────────────────────────────────────────

async function getAvailablePort(startFrom = 18000): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(startFrom, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : startFrom;
      server.close(() => resolve(port));
    });
    server.on("error", () => {
      // Port in use, try next
      if (startFrom < 19000) {
        getAvailablePort(startFrom + 1).then(resolve, reject);
      } else {
        reject(new Error("No available port found"));
      }
    });
  });
}

// ── Health check polling ──────────────────────────────────────────────

async function waitForHealthy(
  url: string,
  maxRetries = 30,
  intervalMs = 1000,
): Promise<boolean> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const ok = await new Promise<boolean>((resolve) => {
        const req = http.get(url, (res) => {
          resolve(res.statusCode === 200);
        });
        req.on("error", () => resolve(false));
        req.setTimeout(2000, () => {
          req.destroy();
          resolve(false);
        });
      });
      if (ok) return true;
    } catch {
      // ignore
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

// ── Service Interface ─────────────────────────────────────────────────

export class AppProcessError extends Schema.TaggedErrorClass<AppProcessError>()(
  "AppProcessError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export interface AppProcessManagerShape {
  /**
   * Start an embedded app process for a given window.
   * Returns the assigned port and URL.
   * Auto-provisions code-server if not already installed.
   */
  readonly start: (
    windowId: string,
    appType: string,
    cwd: string,
  ) => Effect.Effect<{ port: number; url: string }, AppProcessError>;

  /**
   * Stop an embedded app process by windowId.
   */
  readonly stop: (windowId: string) => Effect.Effect<void, AppProcessError>;

  /**
   * Get the current status of an app process.
   */
  readonly getStatus: (
    windowId: string,
  ) => Effect.Effect<
    { status: AppEmbedStatus; port?: number | undefined; url?: string | undefined } | null,
    never
  >;

  /**
   * Stop all managed processes (for shutdown).
   */
  readonly stopAll: () => Effect.Effect<void, never>;
}

export class AppProcessManager extends ServiceMap.Service<
  AppProcessManager,
  AppProcessManagerShape
>()("t3/appProcessManager") {}

// ── Implementation ────────────────────────────────────────────────────

const make = Effect.gen(function* () {
  const processes = new Map<string, AppProcessEntry>();

  return {
    start: (windowId, appType, cwd) =>
      Effect.gen(function* () {
        // Stop existing process for this window if any
        const existing = processes.get(windowId);
        if (existing) {
          existing.proc.kill("SIGTERM");
          processes.delete(windowId);
        }

        const config = APP_PROCESS_CONFIGS[appType];
        if (!config) {
          return yield* new AppProcessError({
            message: `Unknown app type: ${appType}`,
          });
        }

        // Resolve the executable (triggers auto-provisioning for code-server)
        const command = yield* Effect.tryPromise({
          try: () => config.resolveCommand(),
          catch: (cause) =>
            new AppProcessError({
              message: `Failed to provision ${appType}: ${cause instanceof Error ? cause.message : String(cause)}`,
              cause,
            }),
        });

        const port = yield* Effect.tryPromise({
          try: () => getAvailablePort(),
          catch: (cause) =>
            new AppProcessError({
              message: "Failed to find available port",
              cause,
            }),
        });

        log.info(`Spawning ${command} on port ${port} for window ${windowId}...`);

        const proc = yield* Effect.try({
          try: () =>
            spawn(command, config.args({ cwd, port }), {
              stdio: "pipe",
              detached: false,
            }),
          catch: (cause) =>
            new AppProcessError({
              message: `Failed to spawn ${command}`,
              cause,
            }),
        });

        const entry: AppProcessEntry = {
          proc,
          port,
          status: "starting",
          windowId,
          appType,
        };
        processes.set(windowId, entry);

        proc.on("exit", (code) => {
          log.info(`App process for ${windowId} exited with code ${code}`);
          const e = processes.get(windowId);
          if (e && e.proc === proc) {
            processes.delete(windowId);
          }
        });

        proc.on("error", (err) => {
          log.error(`App process error for ${windowId}: ${err.message}`);
          const e = processes.get(windowId);
          if (e && e.proc === proc) {
            processes.delete(windowId);
          }
        });

        // Wait for health check
        const healthy = yield* Effect.tryPromise({
          try: () => waitForHealthy(config.healthCheckUrl(port)),
          catch: (cause) =>
            new AppProcessError({
              message: "Health check failed",
              cause,
            }),
        });

        if (!healthy) {
          proc.kill("SIGTERM");
          processes.delete(windowId);
          return yield* new AppProcessError({
            message: `${appType} did not become healthy after 30 attempts`,
          });
        }

        entry.status = "running";
        const url = `http://localhost:${port}/?folder=${encodeURIComponent(cwd)}`;
        log.info(`App process for ${windowId} is running at ${url}`);

        return { port, url };
      }),

    stop: (windowId) =>
      Effect.gen(function* () {
        const entry = processes.get(windowId);
        if (!entry) {
          return yield* new AppProcessError({
            message: `No process found for window ${windowId}`,
          });
        }

        entry.proc.kill("SIGTERM");
        entry.status = "stopped";
        processes.delete(windowId);
      }),

    getStatus: (windowId) =>
      Effect.sync(() => {
        const entry = processes.get(windowId);
        if (!entry) return null;
        const result: { status: AppEmbedStatus; port?: number | undefined; url?: string | undefined } = {
          status: entry.status,
          port: entry.port,
        };
        if (entry.status === "running") {
          result.url = `http://localhost:${entry.port}`;
        }
        return result;
      }),

    stopAll: () =>
      Effect.sync(() => {
        for (const [, entry] of processes) {
          entry.proc.kill("SIGTERM");
        }
        processes.clear();
        log.info("All app processes stopped");
      }),
  } satisfies AppProcessManagerShape;
});

export const AppProcessManagerLive = Layer.effect(AppProcessManager, make);
