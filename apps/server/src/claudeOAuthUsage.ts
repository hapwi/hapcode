/**
 * Fetches Claude usage data from the Anthropic OAuth usage API.
 *
 * Reads OAuth credentials from the macOS Keychain (same store Claude Code uses)
 * and calls `https://api.anthropic.com/api/oauth/usage` to get 5-hour and 7-day
 * rate-limit utilization percentages.
 *
 * @module claudeOAuthUsage
 */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ClaudeUsageResult } from "@t3tools/contracts";

interface OAuthCredentials {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}

interface OAuthUsageWindow {
  utilization?: number;
  resets_at?: string;
}

interface OAuthUsageResponse {
  five_hour?: OAuthUsageWindow;
  seven_day?: OAuthUsageWindow;
}

/**
 * Read Claude OAuth credentials from macOS Keychain, falling back to the
 * credentials file at `~/.claude/.credentials.json`.
 */
function readCredentials(): OAuthCredentials | null {
  // Try macOS Keychain first (same approach as CodexBar / statusline script)
  try {
    const raw = execSync(
      'security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null',
      { encoding: "utf8", timeout: 5_000 },
    ).trim();
    const parsed = JSON.parse(raw);
    const oauth = parsed?.claudeAiOauth;
    if (oauth?.accessToken) {
      return {
        accessToken: oauth.accessToken,
        refreshToken: oauth.refreshToken,
        expiresAt: oauth.expiresAt,
      };
    }
  } catch {
    // Keychain not available or entry missing — try file fallback
  }

  // Fallback: ~/.claude/.credentials.json
  try {
    const credPath = join(homedir(), ".claude", ".credentials.json");
    const raw = readFileSync(credPath, "utf8");
    const parsed = JSON.parse(raw);
    const oauth = parsed?.claudeAiOauth;
    if (oauth?.accessToken) {
      return {
        accessToken: oauth.accessToken,
        refreshToken: oauth.refreshToken,
        expiresAt: oauth.expiresAt,
      };
    }
  } catch {
    // Credentials file not found
  }

  return null;
}

/**
 * Refresh the access token if it has expired.
 * Returns a fresh access token or null on failure.
 */
async function refreshTokenIfNeeded(creds: OAuthCredentials): Promise<string> {
  const nowMs = Date.now();
  const expiresAtMs =
    creds.expiresAt != null
      ? creds.expiresAt > 1e12
        ? creds.expiresAt // already ms
        : creds.expiresAt * 1000 // was seconds
      : Infinity;

  if (expiresAtMs > nowMs) {
    return creds.accessToken;
  }

  // Token expired — try refresh
  if (!creds.refreshToken) {
    return creds.accessToken; // hope for the best
  }

  const resp = await fetch("https://platform.claude.com/v1/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: creds.refreshToken,
      client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    }),
  });

  if (!resp.ok) return creds.accessToken;

  const data = (await resp.json()) as { access_token?: string };
  return data.access_token ?? creds.accessToken;
}

// Simple in-memory cache to avoid spamming the API
let usageCache: { data: ClaudeUsageResult; fetchedAt: number } | null = null;
const CACHE_TTL_MS = 60_000; // 60 seconds

/**
 * Fetch Claude OAuth usage (5h + 7d utilization).
 * Results are cached for 60 seconds to avoid excessive API calls.
 */
export async function fetchClaudeOAuthUsage(): Promise<ClaudeUsageResult> {
  // Return cached data if fresh
  if (usageCache && Date.now() - usageCache.fetchedAt < CACHE_TTL_MS) {
    return usageCache.data;
  }

  const creds = readCredentials();
  if (!creds) {
    return { fiveHour: null, sevenDay: null };
  }

  const accessToken = await refreshTokenIfNeeded(creds);

  const resp = await fetch("https://api.anthropic.com/api/oauth/usage", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      "anthropic-beta": "oauth-2025-04-20",
      "User-Agent": "claude-code/hapcode",
    },
  });

  if (!resp.ok) {
    return { fiveHour: null, sevenDay: null };
  }

  const usage = (await resp.json()) as OAuthUsageResponse;

  const result: ClaudeUsageResult = {
    fiveHour: usage.five_hour?.utilization != null
      ? {
          utilization: usage.five_hour.utilization,
          resetsAt: usage.five_hour.resets_at ?? "",
        }
      : null,
    sevenDay: usage.seven_day?.utilization != null
      ? {
          utilization: usage.seven_day.utilization,
          resetsAt: usage.seven_day.resets_at ?? "",
        }
      : null,
  };

  usageCache = { data: result, fetchedAt: Date.now() };
  return result;
}
