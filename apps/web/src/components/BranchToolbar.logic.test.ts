import type { GitBranch, OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";
import {
  dedupeRemoteBranchesWithLocalMatches,
  deriveClaudeStatusSummary,
  deriveLocalBranchNameFromRemoteRef,
  resolveBranchSelectionTarget,
  resolveDraftEnvModeAfterBranchChange,
  resolveBranchToolbarValue,
} from "./BranchToolbar.logic";

describe("resolveDraftEnvModeAfterBranchChange", () => {
  it("switches to local mode when returning from an existing worktree to the main worktree", () => {
    expect(
      resolveDraftEnvModeAfterBranchChange({
        nextWorktreePath: null,
        currentWorktreePath: "/repo/.t3/worktrees/feature-a",
        effectiveEnvMode: "worktree",
      }),
    ).toBe("local");
  });

  it("keeps new-worktree mode when selecting a base branch before worktree creation", () => {
    expect(
      resolveDraftEnvModeAfterBranchChange({
        nextWorktreePath: null,
        currentWorktreePath: null,
        effectiveEnvMode: "worktree",
      }),
    ).toBe("worktree");
  });

  it("uses worktree mode when selecting a branch already attached to a worktree", () => {
    expect(
      resolveDraftEnvModeAfterBranchChange({
        nextWorktreePath: "/repo/.t3/worktrees/feature-a",
        currentWorktreePath: null,
        effectiveEnvMode: "local",
      }),
    ).toBe("worktree");
  });
});

describe("resolveBranchToolbarValue", () => {
  it("defaults new-worktree mode to current git branch when no explicit base branch is set", () => {
    expect(
      resolveBranchToolbarValue({
        envMode: "worktree",
        activeWorktreePath: null,
        activeThreadBranch: null,
        currentGitBranch: "main",
      }),
    ).toBe("main");
  });

  it("keeps an explicitly selected worktree base branch", () => {
    expect(
      resolveBranchToolbarValue({
        envMode: "worktree",
        activeWorktreePath: null,
        activeThreadBranch: "feature/base",
        currentGitBranch: "main",
      }),
    ).toBe("feature/base");
  });

  it("shows the actual checked-out branch when not selecting a new worktree base", () => {
    expect(
      resolveBranchToolbarValue({
        envMode: "local",
        activeWorktreePath: null,
        activeThreadBranch: "feature/base",
        currentGitBranch: "main",
      }),
    ).toBe("main");
  });
});

describe("deriveLocalBranchNameFromRemoteRef", () => {
  it("strips the remote prefix from a remote ref", () => {
    expect(deriveLocalBranchNameFromRemoteRef("origin/feature/demo")).toBe("feature/demo");
  });

  it("supports remote names that contain slashes", () => {
    expect(deriveLocalBranchNameFromRemoteRef("my-org/upstream/feature/demo")).toBe(
      "upstream/feature/demo",
    );
  });

  it("returns the original name when ref is malformed", () => {
    expect(deriveLocalBranchNameFromRemoteRef("origin/")).toBe("origin/");
    expect(deriveLocalBranchNameFromRemoteRef("/feature/demo")).toBe("/feature/demo");
  });
});

describe("dedupeRemoteBranchesWithLocalMatches", () => {
  it("hides remote refs when the matching local branch exists", () => {
    const input: GitBranch[] = [
      {
        name: "feature/demo",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
      {
        name: "origin/feature/demo",
        isRemote: true,
        remoteName: "origin",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
      {
        name: "origin/feature/remote-only",
        isRemote: true,
        remoteName: "origin",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
    ];

    expect(dedupeRemoteBranchesWithLocalMatches(input).map((branch) => branch.name)).toEqual([
      "feature/demo",
      "origin/feature/remote-only",
    ]);
  });

  it("keeps all entries when no local match exists for a remote ref", () => {
    const input: GitBranch[] = [
      {
        name: "feature/local",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
      {
        name: "origin/feature/remote-only",
        isRemote: true,
        remoteName: "origin",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
    ];

    expect(dedupeRemoteBranchesWithLocalMatches(input).map((branch) => branch.name)).toEqual([
      "feature/local",
      "origin/feature/remote-only",
    ]);
  });

  it("keeps non-origin remote refs visible even when a matching local branch exists", () => {
    const input: GitBranch[] = [
      {
        name: "feature/demo",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
      {
        name: "my-org/upstream/feature/demo",
        isRemote: true,
        remoteName: "my-org/upstream",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
    ];

    expect(dedupeRemoteBranchesWithLocalMatches(input).map((branch) => branch.name)).toEqual([
      "feature/demo",
      "my-org/upstream/feature/demo",
    ]);
  });

  it("keeps non-origin remote refs visible when git tracks with first-slash local naming", () => {
    const input: GitBranch[] = [
      {
        name: "upstream/feature",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
      {
        name: "my-org/upstream/feature",
        isRemote: true,
        remoteName: "my-org/upstream",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
    ];

    expect(dedupeRemoteBranchesWithLocalMatches(input).map((branch) => branch.name)).toEqual([
      "upstream/feature",
      "my-org/upstream/feature",
    ]);
  });
});

describe("resolveBranchSelectionTarget", () => {
  it("reuses an existing secondary worktree for the selected branch", () => {
    expect(
      resolveBranchSelectionTarget({
        activeProjectCwd: "/repo",
        activeWorktreePath: "/repo/.t3/worktrees/feature-a",
        branch: {
          isDefault: false,
          worktreePath: "/repo/.t3/worktrees/feature-b",
        },
      }),
    ).toEqual({
      checkoutCwd: "/repo/.t3/worktrees/feature-b",
      nextWorktreePath: "/repo/.t3/worktrees/feature-b",
      reuseExistingWorktree: true,
    });
  });

  it("switches back to the main repo when the branch already lives there", () => {
    expect(
      resolveBranchSelectionTarget({
        activeProjectCwd: "/repo",
        activeWorktreePath: "/repo/.t3/worktrees/feature-a",
        branch: {
          isDefault: true,
          worktreePath: "/repo",
        },
      }),
    ).toEqual({
      checkoutCwd: "/repo",
      nextWorktreePath: null,
      reuseExistingWorktree: true,
    });
  });

  it("checks out the default branch in the main repo when leaving a secondary worktree", () => {
    expect(
      resolveBranchSelectionTarget({
        activeProjectCwd: "/repo",
        activeWorktreePath: "/repo/.t3/worktrees/feature-a",
        branch: {
          isDefault: true,
          worktreePath: null,
        },
      }),
    ).toEqual({
      checkoutCwd: "/repo",
      nextWorktreePath: null,
      reuseExistingWorktree: false,
    });
  });

  it("keeps checkout in the current worktree for non-default branches", () => {
    expect(
      resolveBranchSelectionTarget({
        activeProjectCwd: "/repo",
        activeWorktreePath: "/repo/.t3/worktrees/feature-a",
        branch: {
          isDefault: false,
          worktreePath: null,
        },
      }),
    ).toEqual({
      checkoutCwd: "/repo/.t3/worktrees/feature-a",
      nextWorktreePath: "/repo/.t3/worktrees/feature-a",
      reuseExistingWorktree: false,
    });
  });
});

describe("deriveClaudeStatusSummary", () => {
  it("returns the latest Claude context and five-hour reset labels", () => {
    const activities: OrchestrationThreadActivity[] = [
      {
        id: "evt-turn-complete-old" as never,
        tone: "info",
        kind: "turn.completed",
        summary: "Turn completed",
        payload: {
          modelUsage: {
            "claude-sonnet-4-6": {
              inputTokens: 10_000,
              outputTokens: 2_000,
              cacheReadInputTokens: 1_000,
              cacheCreationInputTokens: 0,
              webSearchRequests: 0,
              costUSD: 0.01,
              contextWindow: 200_000,
              maxOutputTokens: 8_000,
            },
          },
        },
        turnId: null,
        createdAt: "2026-03-21T17:00:00.000Z",
      },
      {
        id: "evt-rate-limit" as never,
        tone: "info",
        kind: "account.rate-limits.updated",
        summary: "Account rate limits updated",
        payload: {
          rateLimits: {
            rate_limit_info: {
              rateLimitType: "five_hour",
              resetsAt: Date.UTC(2026, 2, 21, 18, 43, 0) / 1000,
            },
          },
        },
        turnId: null,
        createdAt: "2026-03-21T17:03:00.000Z",
      },
      {
        id: "evt-turn-complete-new" as never,
        tone: "info",
        kind: "turn.completed",
        summary: "Turn completed",
        payload: {
          modelUsage: {
            "claude-sonnet-4-6": {
              inputTokens: 80_000,
              outputTokens: 12_000,
              cacheReadInputTokens: 18_000,
              cacheCreationInputTokens: 0,
              webSearchRequests: 0,
              costUSD: 0.12,
              contextWindow: 200_000,
              maxOutputTokens: 8_000,
            },
          },
        },
        turnId: null,
        createdAt: "2026-03-21T17:05:00.000Z",
      },
    ];

    expect(
      deriveClaudeStatusSummary({
        provider: "claudeAgent",
        activities,
        now: new Date("2026-03-21T17:13:00.000Z"),
      }),
    ).toEqual({
      contextLabel: "ctx: 49%",
      timerLabel: "5h: 70% · 1h 30m left",
      title: "Claude status: ctx: 49% · 5h: 70% · 1h 30m left",
    });
  });

  it("returns null for non-Claude providers", () => {
    expect(
      deriveClaudeStatusSummary({
        provider: "codex",
        activities: [],
        now: new Date("2026-03-21T17:13:00.000Z"),
      }),
    ).toBeNull();
  });
});
