import type { GitStackedAction } from "@t3tools/contracts";
import { mutationOptions, queryOptions, type QueryClient } from "@tanstack/react-query";
import { ensureNativeApi } from "../nativeApi";

/**
 * State management boundary: React Query owns **pull-based peripheral queries**.
 *
 * These queries target external system state (git working tree, branches) that
 * changes independently of our application — polling with stale-time windows
 * is the right strategy because we have no push channel for these systems.
 *
 * Orchestration data (threads, projects, messages) is NOT managed here; it
 * lives in the Zustand store (`store.ts`) and arrives via WebSocket push.
 * Cross-concern cache invalidation (e.g. refreshing git status after a commit
 * activity) happens in the EventRouter component when domain events fire.
 */

const GIT_STATUS_STALE_TIME_MS = 5_000;
const GIT_STATUS_REFETCH_INTERVAL_MS = 15_000;
const GIT_BRANCHES_STALE_TIME_MS = 15_000;
const GIT_BRANCHES_REFETCH_INTERVAL_MS = 60_000;

export const gitQueryKeys = {
  all: ["git"] as const,
  status: (cwd: string | null) => ["git", "status", cwd] as const,
  branches: (cwd: string | null) => ["git", "branches", cwd] as const,
};

export const gitMutationKeys = {
  init: (cwd: string | null) => ["git", "mutation", "init", cwd] as const,
  checkout: (cwd: string | null) => ["git", "mutation", "checkout", cwd] as const,
  deleteBranch: (cwd: string | null) => ["git", "mutation", "delete-branch", cwd] as const,
  suggestBranchName: (cwd: string | null) =>
    ["git", "mutation", "suggest-branch-name", cwd] as const,
  runStackedAction: (cwd: string | null) => ["git", "mutation", "run-stacked-action", cwd] as const,
  mergePullRequests: (cwd: string | null) =>
    ["git", "mutation", "merge-pull-requests", cwd] as const,
  pull: (cwd: string | null) => ["git", "mutation", "pull", cwd] as const,
  preparePullRequestThread: (cwd: string | null) =>
    ["git", "mutation", "prepare-pull-request-thread", cwd] as const,
};

export function invalidateGitQueries(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: gitQueryKeys.all });
}

export function gitStatusQueryOptions(cwd: string | null, opts?: { active?: boolean }) {
  const active = opts?.active ?? true;
  return queryOptions({
    queryKey: gitQueryKeys.status(cwd),
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!cwd) throw new Error("Git status is unavailable.");
      return api.git.status({ cwd });
    },
    enabled: cwd !== null,
    staleTime: GIT_STATUS_STALE_TIME_MS,
    refetchOnWindowFocus: active ? "always" : false,
    refetchOnReconnect: active ? "always" : false,
    refetchInterval: active ? GIT_STATUS_REFETCH_INTERVAL_MS : false,
  });
}

export function gitBranchesQueryOptions(cwd: string | null, opts?: { active?: boolean }) {
  const active = opts?.active ?? true;
  return queryOptions({
    queryKey: gitQueryKeys.branches(cwd),
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!cwd) throw new Error("Git branches are unavailable.");
      return api.git.listBranches({ cwd });
    },
    enabled: cwd !== null,
    staleTime: GIT_BRANCHES_STALE_TIME_MS,
    refetchOnWindowFocus: active,
    refetchOnReconnect: active,
    refetchInterval: active ? GIT_BRANCHES_REFETCH_INTERVAL_MS : false,
  });
}

export function gitResolvePullRequestQueryOptions(input: {
  cwd: string | null;
  reference: string | null;
}) {
  return queryOptions({
    queryKey: ["git", "pull-request", input.cwd, input.reference] as const,
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!input.cwd || !input.reference) {
        throw new Error("Pull request lookup is unavailable.");
      }
      return api.git.resolvePullRequest({ cwd: input.cwd, reference: input.reference });
    },
    enabled: input.cwd !== null && input.reference !== null,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

export function gitInitMutationOptions(input: { cwd: string | null; queryClient: QueryClient }) {
  return mutationOptions({
    mutationKey: gitMutationKeys.init(input.cwd),
    mutationFn: async () => {
      const api = ensureNativeApi();
      if (!input.cwd) throw new Error("Git init is unavailable.");
      return api.git.init({ cwd: input.cwd });
    },
    onSuccess: async () => {
      await invalidateGitQueries(input.queryClient);
    },
  });
}

export function gitCheckoutMutationOptions(input: {
  cwd: string | null;
  queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationKey: gitMutationKeys.checkout(input.cwd),
    mutationFn: async (branch: string) => {
      const api = ensureNativeApi();
      if (!input.cwd) throw new Error("Git checkout is unavailable.");
      return api.git.checkout({ cwd: input.cwd, branch });
    },
    onSuccess: async () => {
      await invalidateGitQueries(input.queryClient);
    },
  });
}

export function gitRunStackedActionMutationOptions(input: {
  cwd: string | null;
  queryClient: QueryClient;
  model?: string | null;
}) {
  return mutationOptions({
    mutationKey: gitMutationKeys.runStackedAction(input.cwd),
    mutationFn: async ({
      action,
      commitMessage,
      featureBranch,
      filePaths,
    }: {
      action: GitStackedAction;
      commitMessage?: string;
      featureBranch?: boolean;
      filePaths?: string[];
    }) => {
      const api = ensureNativeApi();
      if (!input.cwd) throw new Error("Git action is unavailable.");
      return api.git.runStackedAction({
        cwd: input.cwd,
        action,
        ...(commitMessage ? { commitMessage } : {}),
        ...(featureBranch ? { featureBranch } : {}),
        ...(filePaths ? { filePaths } : {}),
        ...(input.model ? { model: input.model } : {}),
      });
    },
    onSettled: async () => {
      await invalidateGitQueries(input.queryClient);
    },
  });
}

export function gitSuggestBranchNameMutationOptions(input: {
  cwd: string | null;
  model?: string | null;
}) {
  return mutationOptions({
    mutationKey: gitMutationKeys.suggestBranchName(input.cwd),
    mutationFn: async () => {
      const api = ensureNativeApi();
      if (!input.cwd) throw new Error("Branch name suggestion is unavailable.");
      return api.git.suggestBranchName({
        cwd: input.cwd,
        ...(input.model ? { textGenerationModel: input.model } : {}),
      });
    },
  });
}

export function gitDeleteBranchMutationOptions(input: {
  cwd: string | null;
  queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationKey: gitMutationKeys.deleteBranch(input.cwd),
    mutationFn: async ({
      branch,
      deleteLocal,
      deleteRemote,
      force,
    }: {
      branch: string;
      deleteLocal?: boolean;
      deleteRemote?: boolean;
      force?: boolean;
    }) => {
      const api = ensureNativeApi();
      if (!input.cwd) throw new Error("Branch deletion is unavailable.");
      return api.git.deleteBranch({
        cwd: input.cwd,
        branch,
        ...(deleteLocal !== undefined ? { deleteLocal } : {}),
        ...(deleteRemote !== undefined ? { deleteRemote } : {}),
        ...(force !== undefined ? { force } : {}),
      });
    },
    onSettled: () => {
      // Keep the mutation lifecycle tied to the delete RPC itself so the branch dialog
      // unlocks immediately after deletion, while query refresh happens in the background.
      void invalidateGitQueries(input.queryClient);
    },
  });
}

export function gitPullMutationOptions(input: { cwd: string | null; queryClient: QueryClient }) {
  return mutationOptions({
    mutationKey: gitMutationKeys.pull(input.cwd),
    mutationFn: async () => {
      const api = ensureNativeApi();
      if (!input.cwd) throw new Error("Git pull is unavailable.");
      return api.git.pull({ cwd: input.cwd });
    },
    onSettled: async () => {
      await invalidateGitQueries(input.queryClient);
    },
  });
}

export function gitMergePullRequestsMutationOptions(input: {
  cwd: string | null;
  queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationKey: gitMutationKeys.mergePullRequests(input.cwd),
    mutationFn: async ({
      scope,
      method,
      deleteBranch,
    }: {
      scope: "current" | "stack";
      method: "merge" | "squash" | "rebase";
      deleteBranch?: boolean;
    }) => {
      const api = ensureNativeApi();
      if (!input.cwd) throw new Error("Pull request merge is unavailable.");
      return api.git.mergePullRequests({
        cwd: input.cwd,
        scope,
        method,
        ...(deleteBranch !== undefined ? { deleteBranch } : {}),
      });
    },
    onSettled: async () => {
      await invalidateGitQueries(input.queryClient);
    },
  });
}

export function gitCreateWorktreeMutationOptions(input: { queryClient: QueryClient }) {
  return mutationOptions({
    mutationFn: async ({
      cwd,
      branch,
      newBranch,
      path,
    }: {
      cwd: string;
      branch: string;
      newBranch: string;
      path?: string | null;
    }) => {
      const api = ensureNativeApi();
      if (!cwd) throw new Error("Git worktree creation is unavailable.");
      return api.git.createWorktree({ cwd, branch, newBranch, path: path ?? null });
    },
    mutationKey: ["git", "mutation", "create-worktree"] as const,
    onSettled: async () => {
      await invalidateGitQueries(input.queryClient);
    },
  });
}

export function gitRemoveWorktreeMutationOptions(input: { queryClient: QueryClient }) {
  return mutationOptions({
    mutationFn: async ({ cwd, path, force }: { cwd: string; path: string; force?: boolean }) => {
      const api = ensureNativeApi();
      if (!cwd) throw new Error("Git worktree removal is unavailable.");
      return api.git.removeWorktree({ cwd, path, force });
    },
    mutationKey: ["git", "mutation", "remove-worktree"] as const,
    onSettled: async () => {
      await invalidateGitQueries(input.queryClient);
    },
  });
}

export function gitPreparePullRequestThreadMutationOptions(input: {
  cwd: string | null;
  queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationFn: async ({ reference, mode }: { reference: string; mode: "local" | "worktree" }) => {
      const api = ensureNativeApi();
      if (!input.cwd) throw new Error("Pull request thread preparation is unavailable.");
      return api.git.preparePullRequestThread({
        cwd: input.cwd,
        reference,
        mode,
      });
    },
    mutationKey: gitMutationKeys.preparePullRequestThread(input.cwd),
    onSettled: async () => {
      await invalidateGitQueries(input.queryClient);
    },
  });
}
