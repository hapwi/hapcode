import type {
  GitPullRequestMergeMethod,
  GitStackedAction,
  GitStatusResult,
  ThreadId,
} from "@t3tools/contracts";
import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ChevronDownIcon,
  CloudUploadIcon,
  GitCommitIcon,
  GitBranchIcon,
  InfoIcon,
  SparklesIcon,
} from "lucide-react";
import { GitHubIcon } from "./Icons";
import {
  buildGitActionProgressStages,
  buildMenuItems,
  type GitActionIconName,
  type GitActionMenuItem,
  type GitQuickAction,
  type DefaultBranchConfirmableAction,
  requiresDefaultBranchConfirmation,
  resolveDefaultBranchActionDialogCopy,
  resolveQuickAction,
  summarizeGitResult,
} from "./GitActionsControl.logic";
import { useAppSettings } from "~/appSettings";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Group, GroupSeparator } from "~/components/ui/group";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import { toastManager } from "~/components/ui/toast";
import { openInPreferredEditor } from "~/editorPreferences";
import {
  gitBranchesQueryOptions,
  gitCheckoutMutationOptions,
  gitMergePullRequestsMutationOptions,
  gitInitMutationOptions,
  gitMutationKeys,
  gitPullMutationOptions,
  gitRunStackedActionMutationOptions,
  gitSuggestBranchNameMutationOptions,
  gitStatusQueryOptions,
  invalidateGitQueries,
} from "~/lib/gitReactQuery";
import { resolvePathLinkTarget } from "~/terminal-links";
import { readNativeApi } from "~/nativeApi";

interface GitActionsControlProps {
  gitCwd: string | null;
  activeThreadId: ThreadId | null;
}

interface PendingDefaultBranchAction {
  action: DefaultBranchConfirmableAction;
  branchName: string;
  includesCommit: boolean;
  commitMessage?: string;
  forcePushOnlyProgress: boolean;
  onConfirmed?: () => void;
  filePaths?: string[];
}

type BranchDialogMode = "create" | "switch";
type MergeDialogScope = "current" | "stack";

type GitActionToastId = ReturnType<typeof toastManager.add>;

function getMenuActionDisabledReason({
  item,
  gitStatus,
  isBusy,
  hasOriginRemote,
}: {
  item: GitActionMenuItem;
  gitStatus: GitStatusResult | null;
  isBusy: boolean;
  hasOriginRemote: boolean;
}): string | null {
  if (!item.disabled) return null;
  if (isBusy) return "Git action in progress.";
  if (!gitStatus) return "Git status is unavailable.";

  const hasBranch = gitStatus.branch !== null;
  const hasChanges = gitStatus.hasWorkingTreeChanges;
  const hasOpenPr = gitStatus.pr?.state === "open";
  const isAhead = gitStatus.aheadCount > 0;
  const isBehind = gitStatus.behindCount > 0;

  if (item.id === "commit") {
    if (!hasChanges) {
      return "Worktree is clean. Make changes before committing.";
    }
    return "Commit is currently unavailable.";
  }

  if (item.id === "push") {
    if (!hasBranch) {
      return "Detached HEAD: checkout a branch before pushing.";
    }
    if (hasChanges) {
      return "Commit or stash local changes before pushing.";
    }
    if (isBehind) {
      return "Branch is behind upstream. Pull/rebase before pushing.";
    }
    if (!gitStatus.hasUpstream && !hasOriginRemote) {
      return 'Add an "origin" remote before pushing.';
    }
    if (!isAhead) {
      return "No local commits to push.";
    }
    return "Push is currently unavailable.";
  }

  if (hasOpenPr) {
    return "View PR is currently unavailable.";
  }
  if (!hasBranch) {
    return "Detached HEAD: checkout a branch before creating a PR.";
  }
  if (hasChanges) {
    return "Commit local changes before creating a PR.";
  }
  if (!gitStatus.hasUpstream && !hasOriginRemote) {
    return 'Add an "origin" remote before creating a PR.';
  }
  if (!isAhead) {
    return "No local commits to include in a PR.";
  }
  if (isBehind) {
    return "Branch is behind upstream. Pull/rebase before creating a PR.";
  }
  return "Create PR is currently unavailable.";
}

const COMMIT_DIALOG_TITLE = "Commit changes";
const COMMIT_DIALOG_DESCRIPTION =
  "Review and confirm your commit. Leave the message blank to auto-generate one.";

function GitActionItemIcon({ icon }: { icon: GitActionIconName }) {
  if (icon === "commit") return <GitCommitIcon />;
  if (icon === "push") return <CloudUploadIcon />;
  return <GitHubIcon />;
}

function GitQuickActionIcon({ quickAction }: { quickAction: GitQuickAction }) {
  const iconClassName = "size-3.5";
  if (quickAction.kind === "open_pr") return <GitHubIcon className={iconClassName} />;
  if (quickAction.kind === "run_pull") return <InfoIcon className={iconClassName} />;
  if (quickAction.kind === "run_action") {
    if (quickAction.action === "commit") return <GitCommitIcon className={iconClassName} />;
    if (quickAction.action === "commit_push") return <CloudUploadIcon className={iconClassName} />;
    return <GitHubIcon className={iconClassName} />;
  }
  if (quickAction.label === "Commit") return <GitCommitIcon className={iconClassName} />;
  return <InfoIcon className={iconClassName} />;
}

function resolveQuickActionHelperText(input: {
  quickAction: GitQuickAction;
  gitStatus: GitStatusResult | null;
}): string | null {
  const { quickAction, gitStatus } = input;
  const openPr = gitStatus?.pr?.state === "open" ? gitStatus.pr : null;
  if (!openPr) return null;

  if (quickAction.kind === "run_action" && quickAction.action === "commit_push") {
    return `Updates PR #${openPr.number}. New branch starts a new PR.`;
  }

  if (quickAction.kind === "open_pr") {
    return `Attached to PR #${openPr.number}. New branch starts a new PR.`;
  }

  return null;
}

function statusBadgeVariant(
  state: "open" | "closed" | "merged",
): "success" | "outline" | "secondary" {
  if (state === "open") return "success";
  if (state === "merged") return "secondary";
  return "outline";
}

function isDuplicateQuickActionMenuItem(
  quickAction: GitQuickAction,
  item: GitActionMenuItem,
): boolean {
  if (quickAction.kind === "open_pr") {
    return item.kind === "open_pr";
  }
  if (quickAction.kind !== "run_action") {
    return false;
  }
  if (quickAction.action === "commit") {
    return item.id === "commit";
  }
  if (quickAction.action === "commit_push") {
    return item.id === "commit" || item.id === "push";
  }
  return item.id === "commit" || item.id === "push" || item.id === "pr";
}

export default function GitActionsControl({ gitCwd, activeThreadId }: GitActionsControlProps) {
  const { settings } = useAppSettings();
  const threadToastData = useMemo(
    () => (activeThreadId ? { threadId: activeThreadId } : undefined),
    [activeThreadId],
  );
  const queryClient = useQueryClient();
  const [isCommitDialogOpen, setIsCommitDialogOpen] = useState(false);
  const [dialogCommitMessage, setDialogCommitMessage] = useState("");
  const [excludedFiles, setExcludedFiles] = useState<ReadonlySet<string>>(new Set());
  const [isEditingFiles, setIsEditingFiles] = useState(false);
  const [pendingDefaultBranchAction, setPendingDefaultBranchAction] =
    useState<PendingDefaultBranchAction | null>(null);
  const [branchDialogMode, setBranchDialogMode] = useState<BranchDialogMode | null>(null);
  const [branchDraft, setBranchDraft] = useState("");
  const [mergeDialogScope, setMergeDialogScope] = useState<MergeDialogScope | null>(null);
  const [mergeMethod, setMergeMethod] = useState<GitPullRequestMergeMethod>("merge");
  const [deleteMergedBranches, setDeleteMergedBranches] = useState(true);

  const { data: gitStatus = null, error: gitStatusError } = useQuery(gitStatusQueryOptions(gitCwd));

  const { data: branchList = null } = useQuery(gitBranchesQueryOptions(gitCwd));
  // Default to true while loading so we don't flash init controls.
  const isRepo = branchList?.isRepo ?? true;
  const hasOriginRemote = branchList?.hasOriginRemote ?? false;
  const currentBranch = branchList?.branches.find((branch) => branch.current)?.name ?? null;
  const isGitStatusOutOfSync =
    !!gitStatus?.branch && !!currentBranch && gitStatus.branch !== currentBranch;

  useEffect(() => {
    if (!isGitStatusOutOfSync) return;
    void invalidateGitQueries(queryClient);
  }, [isGitStatusOutOfSync, queryClient]);

  const gitStatusForActions = isGitStatusOutOfSync ? null : gitStatus;

  const allFiles = gitStatusForActions?.workingTree.files ?? [];
  const selectedFiles = allFiles.filter((f) => !excludedFiles.has(f.path));
  const allSelected = excludedFiles.size === 0;
  const noneSelected = selectedFiles.length === 0;

  const initMutation = useMutation(gitInitMutationOptions({ cwd: gitCwd, queryClient }));

  const runImmediateGitActionMutation = useMutation(
    gitRunStackedActionMutationOptions({
      cwd: gitCwd,
      queryClient,
      model: settings.textGenerationModel ?? null,
    }),
  );
  const pullMutation = useMutation(gitPullMutationOptions({ cwd: gitCwd, queryClient }));
  const checkoutMutation = useMutation(
    gitCheckoutMutationOptions({
      cwd: gitCwd,
      queryClient,
    }),
  );
  const mergePullRequestsMutation = useMutation(
    gitMergePullRequestsMutationOptions({
      cwd: gitCwd,
      queryClient,
    }),
  );
  const suggestBranchNameMutation = useMutation(
    gitSuggestBranchNameMutationOptions({
      cwd: gitCwd,
      model: settings.textGenerationModel ?? null,
    }),
  );

  const isRunStackedActionRunning =
    useIsMutating({ mutationKey: gitMutationKeys.runStackedAction(gitCwd) }) > 0;
  const isPullRunning = useIsMutating({ mutationKey: gitMutationKeys.pull(gitCwd) }) > 0;
  const isGitActionRunning = isRunStackedActionRunning || isPullRunning;
  const isDefaultBranch = useMemo(() => {
    const branchName = gitStatusForActions?.branch;
    if (!branchName) return false;
    const current = branchList?.branches.find((branch) => branch.name === branchName);
    return current?.isDefault ?? (branchName === "main" || branchName === "master");
  }, [branchList?.branches, gitStatusForActions?.branch]);

  const gitActionMenuItems = useMemo(
    () => buildMenuItems(gitStatusForActions, isGitActionRunning, isDefaultBranch, hasOriginRemote),
    [gitStatusForActions, hasOriginRemote, isDefaultBranch, isGitActionRunning],
  );
  const quickAction = useMemo(
    () =>
      resolveQuickAction(gitStatusForActions, isGitActionRunning, isDefaultBranch, hasOriginRemote),
    [gitStatusForActions, hasOriginRemote, isDefaultBranch, isGitActionRunning],
  );
  const quickActionDisabledReason = quickAction.disabled
    ? (quickAction.hint ?? "This action is currently unavailable.")
    : null;
  const quickActionHelperText = useMemo(
    () => resolveQuickActionHelperText({ quickAction, gitStatus: gitStatusForActions }),
    [gitStatusForActions, quickAction],
  );
  const pendingDefaultBranchActionCopy = pendingDefaultBranchAction
    ? resolveDefaultBranchActionDialogCopy({
        action: pendingDefaultBranchAction.action,
        branchName: pendingDefaultBranchAction.branchName,
        includesCommit: pendingDefaultBranchAction.includesCommit,
      })
    : null;
  const activePrStack = useMemo(
    () =>
      (
        gitStatusForActions?.prStack ?? (gitStatusForActions?.pr ? [gitStatusForActions.pr] : [])
      ).filter((pr) => pr.state === "open"),
    [gitStatusForActions?.pr, gitStatusForActions?.prStack],
  );
  const switchableBranches = useMemo(
    () =>
      (branchList?.branches ?? [])
        .filter((branch) => !branch.current && !branch.isRemote)
        .toSorted((left, right) => left.name.localeCompare(right.name)),
    [branchList?.branches],
  );
  const filteredSwitchableBranches = useMemo(() => {
    const query = branchDraft.trim().toLowerCase();
    if (query.length === 0) return switchableBranches;
    return switchableBranches.filter((branch) => branch.name.toLowerCase().includes(query));
  }, [branchDraft, switchableBranches]);
  const menuItemsWithReasons = useMemo(
    () =>
      gitActionMenuItems.map((item) => ({
        item,
        disabledReason: getMenuActionDisabledReason({
          item,
          gitStatus: gitStatusForActions,
          isBusy: isGitActionRunning,
          hasOriginRemote,
        }),
      })),
    [gitActionMenuItems, gitStatusForActions, hasOriginRemote, isGitActionRunning],
  );
  const visibleMenuItemsWithReasons = useMemo(
    () =>
      menuItemsWithReasons.filter(
        ({ item }) =>
          !item.disabled &&
          (quickAction.kind === "show_hint" || !isDuplicateQuickActionMenuItem(quickAction, item)),
      ),
    [menuItemsWithReasons, quickAction],
  );
  const branchSummaryBadges = useMemo(() => {
    if (!gitStatusForActions) return [];
    const badges: Array<{
      label: string;
      variant: "outline" | "success" | "warning" | "secondary";
    }> = [];
    badges.push({
      label: gitStatusForActions.hasWorkingTreeChanges
        ? `${gitStatusForActions.workingTree.files.length} changed`
        : "Clean",
      variant: gitStatusForActions.hasWorkingTreeChanges ? "warning" : "success",
    });
    if (gitStatusForActions.aheadCount > 0) {
      badges.push({
        label: `Ahead ${gitStatusForActions.aheadCount}`,
        variant: "secondary",
      });
    }
    if (gitStatusForActions.behindCount > 0) {
      badges.push({
        label: `Behind ${gitStatusForActions.behindCount}`,
        variant: "warning",
      });
    }
    if (activePrStack.length > 1) {
      badges.push({
        label: `Stack ${activePrStack.length}`,
        variant: "outline",
      });
    }
    return badges;
  }, [activePrStack.length, gitStatusForActions]);

  const openExistingPr = useCallback(async () => {
    const api = readNativeApi();
    if (!api) {
      toastManager.add({
        type: "error",
        title: "Link opening is unavailable.",
        data: threadToastData,
      });
      return;
    }
    const prUrl = gitStatusForActions?.pr?.state === "open" ? gitStatusForActions.pr.url : null;
    if (!prUrl) {
      toastManager.add({
        type: "error",
        title: "No open PR found.",
        data: threadToastData,
      });
      return;
    }
    void api.shell.openExternal(prUrl).catch((err) => {
      toastManager.add({
        type: "error",
        title: "Unable to open PR link",
        description: err instanceof Error ? err.message : "An error occurred.",
        data: threadToastData,
      });
    });
  }, [gitStatusForActions?.pr?.state, gitStatusForActions?.pr?.url, threadToastData]);

  const openPrUrl = useCallback(
    async (url: string) => {
      const api = readNativeApi();
      if (!api) {
        toastManager.add({
          type: "error",
          title: "Link opening is unavailable.",
          data: threadToastData,
        });
        return;
      }
      void api.shell.openExternal(url).catch((err) => {
        toastManager.add({
          type: "error",
          title: "Unable to open PR link",
          description: err instanceof Error ? err.message : "An error occurred.",
          data: threadToastData,
        });
      });
    },
    [threadToastData],
  );

  const openBranchDialog = useCallback((mode: BranchDialogMode) => {
    setBranchDialogMode(mode);
    setBranchDraft("");
  }, []);

  const closeBranchDialog = useCallback(() => {
    setBranchDialogMode(null);
    setBranchDraft("");
  }, []);

  const runCreateBranch = useCallback(async () => {
    const branchName = branchDraft.trim();
    const api = readNativeApi();
    if (!api || !gitCwd || branchName.length === 0) {
      return;
    }

    const promise = (async () => {
      await api.git.createBranch({ cwd: gitCwd, branch: branchName });
      await checkoutMutation.mutateAsync(branchName);
      await invalidateGitQueries(queryClient);
      closeBranchDialog();
    })();

    toastManager.promise(promise, {
      loading: { title: `Creating ${branchName}...`, data: threadToastData },
      success: () => ({
        title: `Switched to ${branchName}`,
        data: threadToastData,
      }),
      error: (err) => ({
        title: "Failed to create branch",
        description: err instanceof Error ? err.message : "An error occurred.",
        data: threadToastData,
      }),
    });

    await promise.catch(() => undefined);
  }, [branchDraft, checkoutMutation, closeBranchDialog, gitCwd, queryClient, threadToastData]);

  const runSuggestBranchName = useCallback(async () => {
    if (!gitCwd) return;

    const promise = suggestBranchNameMutation.mutateAsync();
    toastManager.promise(promise, {
      loading: { title: "Generating branch name...", data: threadToastData },
      success: (result) => {
        setBranchDraft(result.branch);
        return {
          title: "Branch name ready",
          description: result.branch,
          data: threadToastData,
        };
      },
      error: (err) => ({
        title: "Failed to generate branch name",
        description: err instanceof Error ? err.message : "An error occurred.",
        data: threadToastData,
      }),
    });

    await promise.catch(() => undefined);
  }, [gitCwd, suggestBranchNameMutation, threadToastData]);

  const runCheckoutBranch = useCallback(
    async (branchName: string) => {
      const promise = checkoutMutation.mutateAsync(branchName).then(async () => {
        await invalidateGitQueries(queryClient);
        closeBranchDialog();
      });

      toastManager.promise(promise, {
        loading: { title: `Checking out ${branchName}...`, data: threadToastData },
        success: () => ({
          title: `Switched to ${branchName}`,
          data: threadToastData,
        }),
        error: (err) => ({
          title: "Failed to checkout branch",
          description: err instanceof Error ? err.message : "An error occurred.",
          data: threadToastData,
        }),
      });

      await promise.catch(() => undefined);
    },
    [checkoutMutation, closeBranchDialog, queryClient, threadToastData],
  );

  const closeMergeDialog = useCallback(() => {
    setMergeDialogScope(null);
    setMergeMethod("merge");
    setDeleteMergedBranches(true);
  }, []);

  const openMergeDialog = useCallback((scope: MergeDialogScope) => {
    setMergeDialogScope(scope);
    setMergeMethod("merge");
    setDeleteMergedBranches(true);
  }, []);

  const runMergePullRequests = useCallback(async () => {
    if (!mergeDialogScope) return;

    const promise = mergePullRequestsMutation.mutateAsync({
      scope: mergeDialogScope,
      method: mergeMethod,
      deleteBranch: deleteMergedBranches,
    });

    toastManager.promise(promise, {
      loading: {
        title: mergeDialogScope === "stack" ? "Merging stack..." : "Merging PR...",
        data: threadToastData,
      },
      success: (result) => ({
        title:
          result.scope === "stack"
            ? `Merged ${result.merged.length} PRs`
            : `Merged PR #${result.merged[0]?.number ?? ""}`.trim(),
        description:
          result.scope === "stack"
            ? result.merged.map((pullRequest) => `#${pullRequest.number}`).join(", ")
            : result.merged[0]?.title,
        data: threadToastData,
      }),
      error: (err) => ({
        title: "Merge failed",
        description: err instanceof Error ? err.message : "An error occurred.",
        data: threadToastData,
      }),
    });

    try {
      await promise;
      closeMergeDialog();
    } catch {
      // toastManager.promise already surfaces the failure.
    }
  }, [
    closeMergeDialog,
    deleteMergedBranches,
    mergeDialogScope,
    mergeMethod,
    mergePullRequestsMutation,
    threadToastData,
  ]);

  const runGitActionWithToast = useCallback(
    async ({
      action,
      commitMessage,
      forcePushOnlyProgress = false,
      onConfirmed,
      skipDefaultBranchPrompt = false,
      statusOverride,
      featureBranch = false,
      isDefaultBranchOverride,
      progressToastId,
      filePaths,
    }: {
      action: GitStackedAction;
      commitMessage?: string;
      forcePushOnlyProgress?: boolean;
      onConfirmed?: () => void;
      skipDefaultBranchPrompt?: boolean;
      statusOverride?: GitStatusResult | null;
      featureBranch?: boolean;
      isDefaultBranchOverride?: boolean;
      progressToastId?: GitActionToastId;
      filePaths?: string[];
    }) => {
      const actionStatus = statusOverride ?? gitStatusForActions;
      const actionBranch = actionStatus?.branch ?? null;
      const actionIsDefaultBranch =
        isDefaultBranchOverride ?? (featureBranch ? false : isDefaultBranch);
      const includesCommit =
        !forcePushOnlyProgress && (action === "commit" || !!actionStatus?.hasWorkingTreeChanges);
      if (
        !skipDefaultBranchPrompt &&
        requiresDefaultBranchConfirmation(action, actionIsDefaultBranch) &&
        actionBranch
      ) {
        if (action !== "commit_push" && action !== "commit_push_pr") {
          return;
        }
        setPendingDefaultBranchAction({
          action,
          branchName: actionBranch,
          includesCommit,
          ...(commitMessage ? { commitMessage } : {}),
          forcePushOnlyProgress,
          ...(onConfirmed ? { onConfirmed } : {}),
          ...(filePaths ? { filePaths } : {}),
        });
        return;
      }
      onConfirmed?.();

      const progressStages = buildGitActionProgressStages({
        action,
        hasCustomCommitMessage: !!commitMessage?.trim(),
        hasWorkingTreeChanges: !!actionStatus?.hasWorkingTreeChanges,
        forcePushOnly: forcePushOnlyProgress,
        featureBranch,
      });
      const resolvedProgressToastId =
        progressToastId ??
        toastManager.add({
          type: "loading",
          title: progressStages[0] ?? "Running git action...",
          timeout: 0,
          data: threadToastData,
        });

      if (progressToastId) {
        toastManager.update(progressToastId, {
          type: "loading",
          title: progressStages[0] ?? "Running git action...",
          timeout: 0,
          data: threadToastData,
        });
      }

      let stageIndex = 0;
      const stageInterval = setInterval(() => {
        stageIndex = Math.min(stageIndex + 1, progressStages.length - 1);
        toastManager.update(resolvedProgressToastId, {
          title: progressStages[stageIndex] ?? "Running git action...",
          type: "loading",
          timeout: 0,
          data: threadToastData,
        });
      }, 1100);

      const stopProgressUpdates = () => {
        clearInterval(stageInterval);
      };

      const promise = runImmediateGitActionMutation.mutateAsync({
        action,
        ...(commitMessage ? { commitMessage } : {}),
        ...(featureBranch ? { featureBranch } : {}),
        ...(filePaths ? { filePaths } : {}),
      });

      try {
        const result = await promise;
        stopProgressUpdates();
        const resultToast = summarizeGitResult(result);

        const existingOpenPrUrl =
          actionStatus?.pr?.state === "open" ? actionStatus.pr.url : undefined;
        const prUrl = result.pr.url ?? existingOpenPrUrl;
        const shouldOfferPushCta = action === "commit" && result.commit.status === "created";
        const shouldOfferOpenPrCta =
          (action === "commit_push" || action === "commit_push_pr") &&
          !!prUrl &&
          (!actionIsDefaultBranch ||
            result.pr.status === "created" ||
            result.pr.status === "opened_existing");
        const shouldOfferCreatePrCta =
          action === "commit_push" &&
          !prUrl &&
          result.push.status === "pushed" &&
          !actionIsDefaultBranch;
        const closeResultToast = () => {
          toastManager.close(resolvedProgressToastId);
        };

        toastManager.update(resolvedProgressToastId, {
          type: "success",
          title: resultToast.title,
          description: resultToast.description,
          timeout: 0,
          data: {
            ...threadToastData,
            dismissAfterVisibleMs: 10_000,
          },
          ...(shouldOfferPushCta
            ? {
                actionProps: {
                  children: "Push",
                  onClick: () => {
                    void runGitActionWithToast({
                      action: "commit_push",
                      forcePushOnlyProgress: true,
                      onConfirmed: closeResultToast,
                      statusOverride: actionStatus,
                      isDefaultBranchOverride: actionIsDefaultBranch,
                    });
                  },
                },
              }
            : shouldOfferOpenPrCta
              ? {
                  actionProps: {
                    children: "View PR",
                    onClick: () => {
                      const api = readNativeApi();
                      if (!api) return;
                      closeResultToast();
                      void api.shell.openExternal(prUrl);
                    },
                  },
                }
              : shouldOfferCreatePrCta
                ? {
                    actionProps: {
                      children: "Create PR",
                      onClick: () => {
                        closeResultToast();
                        void runGitActionWithToast({
                          action: "commit_push_pr",
                          forcePushOnlyProgress: true,
                          statusOverride: actionStatus,
                          isDefaultBranchOverride: actionIsDefaultBranch,
                        });
                      },
                    },
                  }
                : {}),
        });
      } catch (err) {
        stopProgressUpdates();
        toastManager.update(resolvedProgressToastId, {
          type: "error",
          title: "Action failed",
          description: err instanceof Error ? err.message : "An error occurred.",
          data: threadToastData,
        });
      }
    },

    [
      isDefaultBranch,
      runImmediateGitActionMutation,
      setPendingDefaultBranchAction,
      threadToastData,
      gitStatusForActions,
    ],
  );

  const checkoutNewBranchAndRunAction = useCallback(
    (actionParams: {
      action: GitStackedAction;
      commitMessage?: string;
      forcePushOnlyProgress?: boolean;
      onConfirmed?: () => void;
      filePaths?: string[];
    }) => {
      void runGitActionWithToast({
        ...actionParams,
        featureBranch: true,
        skipDefaultBranchPrompt: true,
      });
    },
    [runGitActionWithToast],
  );

  const checkoutFeatureBranchAndContinuePendingAction = useCallback(() => {
    if (!pendingDefaultBranchAction) return;
    const { action, commitMessage, forcePushOnlyProgress, onConfirmed, filePaths } =
      pendingDefaultBranchAction;
    setPendingDefaultBranchAction(null);
    checkoutNewBranchAndRunAction({
      action,
      ...(commitMessage ? { commitMessage } : {}),
      forcePushOnlyProgress,
      ...(onConfirmed ? { onConfirmed } : {}),
      ...(filePaths ? { filePaths } : {}),
    });
  }, [pendingDefaultBranchAction, checkoutNewBranchAndRunAction]);

  const runDialogActionOnNewBranch = useCallback(() => {
    if (!isCommitDialogOpen) return;
    const commitMessage = dialogCommitMessage.trim();

    setIsCommitDialogOpen(false);
    setDialogCommitMessage("");
    setExcludedFiles(new Set());
    setIsEditingFiles(false);

    checkoutNewBranchAndRunAction({
      action: "commit",
      ...(commitMessage ? { commitMessage } : {}),
      ...(!allSelected ? { filePaths: selectedFiles.map((f) => f.path) } : {}),
    });
  }, [
    allSelected,
    isCommitDialogOpen,
    dialogCommitMessage,
    checkoutNewBranchAndRunAction,
    selectedFiles,
  ]);

  const runQuickAction = useCallback(() => {
    if (quickAction.kind === "open_pr") {
      void openExistingPr();
      return;
    }
    if (quickAction.kind === "run_pull") {
      const promise = pullMutation.mutateAsync();
      toastManager.promise(promise, {
        loading: { title: "Pulling...", data: threadToastData },
        success: (result) => ({
          title: result.status === "pulled" ? "Pulled" : "Already up to date",
          description:
            result.status === "pulled"
              ? `Updated ${result.branch} from ${result.upstreamBranch ?? "upstream"}`
              : `${result.branch} is already synchronized.`,
          data: threadToastData,
        }),
        error: (err) => ({
          title: "Pull failed",
          description: err instanceof Error ? err.message : "An error occurred.",
          data: threadToastData,
        }),
      });
      void promise.catch(() => undefined);
      return;
    }
    if (quickAction.kind === "show_hint") {
      toastManager.add({
        type: "info",
        title: quickAction.label,
        description: quickAction.hint,
        data: threadToastData,
      });
      return;
    }
    if (quickAction.action) {
      void runGitActionWithToast({ action: quickAction.action });
    }
  }, [openExistingPr, pullMutation, quickAction, runGitActionWithToast, threadToastData]);

  const openDialogForMenuItem = useCallback(
    (item: GitActionMenuItem) => {
      if (item.disabled) return;
      if (item.kind === "open_pr") {
        void openExistingPr();
        return;
      }
      if (item.dialogAction === "push") {
        void runGitActionWithToast({ action: "commit_push", forcePushOnlyProgress: true });
        return;
      }
      if (item.dialogAction === "create_pr") {
        void runGitActionWithToast({ action: "commit_push_pr" });
        return;
      }
      setExcludedFiles(new Set());
      setIsEditingFiles(false);
      setIsCommitDialogOpen(true);
    },
    [openExistingPr, runGitActionWithToast, setIsCommitDialogOpen],
  );

  const runDialogAction = useCallback(() => {
    if (!isCommitDialogOpen) return;
    const commitMessage = dialogCommitMessage.trim();
    setIsCommitDialogOpen(false);
    setDialogCommitMessage("");
    setExcludedFiles(new Set());
    setIsEditingFiles(false);
    void runGitActionWithToast({
      action: "commit",
      ...(commitMessage ? { commitMessage } : {}),
      ...(!allSelected ? { filePaths: selectedFiles.map((f) => f.path) } : {}),
    });
  }, [
    allSelected,
    dialogCommitMessage,
    isCommitDialogOpen,
    runGitActionWithToast,
    selectedFiles,
    setDialogCommitMessage,
    setIsCommitDialogOpen,
  ]);

  const openChangedFileInEditor = useCallback(
    (filePath: string) => {
      const api = readNativeApi();
      if (!api || !gitCwd) {
        toastManager.add({
          type: "error",
          title: "Editor opening is unavailable.",
          data: threadToastData,
        });
        return;
      }
      const target = resolvePathLinkTarget(filePath, gitCwd);
      void openInPreferredEditor(api, target).catch((error) => {
        toastManager.add({
          type: "error",
          title: "Unable to open file",
          description: error instanceof Error ? error.message : "An error occurred.",
          data: threadToastData,
        });
      });
    },
    [gitCwd, threadToastData],
  );

  if (!gitCwd) return null;

  return (
    <>
      {!isRepo ? (
        <Button
          variant="outline"
          size="xs"
          disabled={initMutation.isPending}
          onClick={() => initMutation.mutate()}
        >
          {initMutation.isPending ? "Initializing..." : "Initialize Git"}
        </Button>
      ) : (
        <Group aria-label="GitHub actions">
          {quickAction.kind === "show_hint" ? (
            <Popover>
              <PopoverTrigger
                openOnHover
                render={
                  <Button
                    aria-disabled="true"
                    className="cursor-not-allowed"
                    size="xs"
                    variant="outline"
                  />
                }
              >
                <GitHubIcon className="size-3.5" />
                <span className="hidden @sm/header-actions:inline">GitHub</span>
              </PopoverTrigger>
              <PopoverPopup tooltipStyle side="bottom" align="start">
                {quickActionDisabledReason}
              </PopoverPopup>
            </Popover>
          ) : (
            <Button
              size="xs"
              variant="outline"
              disabled={isGitActionRunning || quickAction.disabled}
              onClick={runQuickAction}
            >
              <GitHubIcon className="size-3.5" />
              <span className="hidden @sm/header-actions:inline">
                {quickAction.kind === "open_pr" ? "View PR" : "GitHub"}
              </span>
            </Button>
          )}
          <GroupSeparator className="hidden @sm/header-actions:block" />
          <Popover
            onOpenChange={(open) => {
              if (open) void invalidateGitQueries(queryClient);
            }}
          >
            <PopoverTrigger
              render={<Button size="icon-xs" variant="outline" aria-label="GitHub menu" />}
            >
              <ChevronDownIcon aria-hidden="true" className="size-4 opacity-60" />
            </PopoverTrigger>
            <PopoverPopup side="bottom" align="end" className="w-[22rem] p-0 sm:w-[26rem]">
              <div className="space-y-4 p-4">
                <div className="space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 space-y-1">
                      <div className="flex items-center gap-2 text-muted-foreground text-xs">
                        <GitBranchIcon className="size-3.5" />
                        <span className="truncate">
                          {gitStatusForActions?.branch ?? currentBranch ?? "(detached HEAD)"}
                        </span>
                      </div>
                    </div>
                    {gitStatusForActions?.pr?.state === "open" && (
                      <Button size="xs" variant="ghost" onClick={() => void openExistingPr()}>
                        View PR
                      </Button>
                    )}
                  </div>
                  {branchSummaryBadges.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {branchSummaryBadges.map((badge) => (
                        <Badge key={badge.label} variant={badge.variant} size="sm">
                          {badge.label}
                        </Badge>
                      ))}
                      {isDefaultBranch && (
                        <Badge variant="warning" size="sm">
                          Default branch
                        </Badge>
                      )}
                    </div>
                  )}
                </div>

                {(quickAction.kind !== "show_hint" || visibleMenuItemsWithReasons.length > 0) && (
                  <div className="space-y-2">
                    <div className="grid gap-2 sm:grid-cols-2">
                      {quickAction.kind !== "show_hint" && (
                        <Button
                          size="xs"
                          variant={quickActionDisabledReason ? "outline" : "default"}
                          disabled={isGitActionRunning || quickAction.disabled}
                          onClick={runQuickAction}
                          title={quickActionDisabledReason ?? undefined}
                          className="justify-start"
                        >
                          <GitQuickActionIcon quickAction={quickAction} />
                          {quickAction.label}
                        </Button>
                      )}
                      {visibleMenuItemsWithReasons.map(({ item, disabledReason }) => (
                        <Button
                          key={`${item.id}-${item.label}`}
                          size="xs"
                          variant="outline"
                          disabled={item.disabled}
                          onClick={() => openDialogForMenuItem(item)}
                          title={disabledReason ?? undefined}
                          className="justify-start"
                        >
                          <GitActionItemIcon icon={item.icon} />
                          {item.label}
                        </Button>
                      ))}
                    </div>
                    {quickActionHelperText && (
                      <p className="text-muted-foreground text-xs">{quickActionHelperText}</p>
                    )}
                  </div>
                )}

                <div className="space-y-2">
                  <p className="font-medium text-xs uppercase tracking-[0.18em] text-muted-foreground">
                    Branches
                  </p>
                  {gitStatusForActions?.pr?.state === "open" && (
                    <p className="text-muted-foreground text-xs">
                      Updates current PR. New branch starts a new PR.
                    </p>
                  )}
                  <div className="grid gap-2 sm:grid-cols-2">
                    <Button size="xs" variant="outline" onClick={() => openBranchDialog("create")}>
                      <GitBranchIcon className="size-3.5" />
                      New branch
                    </Button>
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => openBranchDialog("switch")}
                      disabled={switchableBranches.length === 0}
                    >
                      <GitBranchIcon className="size-3.5" />
                      Switch branch
                    </Button>
                  </div>
                </div>

                {(gitStatusForActions?.pr?.state === "open" || activePrStack.length > 1) && (
                  <div className="space-y-2">
                    <p className="font-medium text-xs uppercase tracking-[0.18em] text-muted-foreground">
                      Merge
                    </p>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {gitStatusForActions?.pr?.state === "open" && (
                        <Button
                          size="xs"
                          variant="outline"
                          onClick={() => openMergeDialog("current")}
                        >
                          <GitHubIcon className="size-3.5" />
                          Merge PR
                        </Button>
                      )}
                      {activePrStack.length > 1 && (
                        <Button
                          size="xs"
                          variant="outline"
                          onClick={() => openMergeDialog("stack")}
                        >
                          <GitHubIcon className="size-3.5" />
                          Merge stack
                        </Button>
                      )}
                    </div>
                  </div>
                )}

                {(quickActionDisabledReason ||
                  gitStatusForActions?.branch === null ||
                  isGitStatusOutOfSync ||
                  gitStatusError) && (
                  <div className="space-y-1 rounded-lg border border-input bg-muted/30 p-3 text-xs">
                    {quickActionDisabledReason && (
                      <p className="text-muted-foreground">{quickActionDisabledReason}</p>
                    )}
                    {gitStatusForActions?.branch === null && (
                      <p className="text-warning">
                        Detached HEAD: create and checkout a branch to enable stacked PR actions.
                      </p>
                    )}
                    {isGitStatusOutOfSync && (
                      <p className="text-muted-foreground">Refreshing git status...</p>
                    )}
                    {gitStatusError && <p className="text-destructive">{gitStatusError.message}</p>}
                  </div>
                )}

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <p className="font-medium text-xs uppercase tracking-[0.18em] text-muted-foreground">
                      Pull Request Stack
                    </p>
                    {activePrStack.length > 0 && (
                      <span className="text-muted-foreground text-xs">
                        {activePrStack.length} {activePrStack.length === 1 ? "PR" : "PRs"}
                      </span>
                    )}
                  </div>
                  {activePrStack.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-input px-3 py-4 text-muted-foreground text-xs">
                      No PR stack for this branch yet.
                    </div>
                  ) : (
                    <div className="max-h-80 overflow-y-auto rounded-lg border border-input bg-muted/20 pr-1">
                      <div className="space-y-3 p-3 pb-4">
                        {activePrStack.map((pr, index) => {
                          const isCurrent = pr.number === gitStatusForActions?.pr?.number;
                          return (
                            <button
                              key={pr.number}
                              type="button"
                              className="flex w-full items-start gap-3 rounded-lg border border-input/60 bg-background/65 px-3 py-3 text-left transition-colors hover:border-input hover:bg-accent/30"
                              onClick={() => void openPrUrl(pr.url)}
                            >
                              <div className="flex min-w-0 flex-1 items-start gap-3">
                                <div className="flex w-4 shrink-0 flex-col items-center pt-1">
                                  <span className="size-2 rounded-full bg-foreground/70" />
                                  {index < activePrStack.length - 1 && (
                                    <span className="mt-2 h-12 w-px bg-border" />
                                  )}
                                </div>
                                <div className="min-w-0 flex-1 space-y-2">
                                  <div className="flex flex-wrap items-center gap-1.5">
                                    <Badge variant={statusBadgeVariant(pr.state)} size="sm">
                                      {pr.state}
                                    </Badge>
                                    {isCurrent && (
                                      <Badge variant="info" size="sm">
                                        Current
                                      </Badge>
                                    )}
                                    <span className="font-medium text-muted-foreground text-xs">
                                      #{pr.number}
                                    </span>
                                  </div>
                                  <p className="line-clamp-2 font-medium text-sm leading-5">
                                    {pr.title}
                                  </p>
                                  <div className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-xs">
                                    <span className="text-muted-foreground">Base</span>
                                    <span className="truncate font-mono text-muted-foreground">
                                      {pr.baseBranch}
                                    </span>
                                    <span className="text-muted-foreground">Head</span>
                                    <span className="truncate font-mono text-muted-foreground">
                                      {pr.headBranch}
                                    </span>
                                  </div>
                                </div>
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </PopoverPopup>
          </Popover>
        </Group>
      )}

      <Dialog
        open={branchDialogMode !== null}
        onOpenChange={(open) => {
          if (!open) {
            closeBranchDialog();
          }
        }}
      >
        <DialogPopup className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {branchDialogMode === "create" ? "Create branch" : "Switch branch"}
            </DialogTitle>
            <DialogDescription>
              {branchDialogMode === "create"
                ? "Create a new branch and check it out from this project."
                : "Search and switch to any local branch from this project."}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-4">
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs font-medium">
                  {branchDialogMode === "create" ? "Branch name" : "Search branches"}
                </p>
                {branchDialogMode === "create" && (
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => void runSuggestBranchName()}
                    disabled={
                      suggestBranchNameMutation.isPending ||
                      !gitStatusForActions?.hasWorkingTreeChanges
                    }
                    title={
                      gitStatusForActions?.hasWorkingTreeChanges
                        ? "Generate a branch name from current local changes."
                        : "Make local changes first to generate a branch name."
                    }
                  >
                    <SparklesIcon className="size-3.5" />
                    Use AI
                  </Button>
                )}
              </div>
              <Input
                value={branchDraft}
                onChange={(event) => setBranchDraft(event.target.value)}
                placeholder={
                  branchDialogMode === "create" ? "feature/my-new-branch" : "Find a branch"
                }
                autoFocus
              />
              {branchDialogMode === "create" && (
                <p className="text-muted-foreground text-xs">
                  AI suggests a name from your current local changes.
                </p>
              )}
            </div>
            {branchDialogMode === "switch" && (
              <div className="space-y-2">
                <p className="text-xs font-medium">Available branches</p>
                <div className="max-h-72 overflow-y-auto rounded-lg border border-input bg-muted/20 p-2">
                  {filteredSwitchableBranches.length === 0 ? (
                    <p className="px-2 py-3 text-muted-foreground text-xs">No branches found.</p>
                  ) : (
                    <div className="space-y-2">
                      {filteredSwitchableBranches.map((branch) => (
                        <Button
                          key={branch.name}
                          size="xs"
                          variant="outline"
                          className="w-full justify-start"
                          onClick={() => void runCheckoutBranch(branch.name)}
                        >
                          <GitBranchIcon className="size-3.5" />
                          <span className="truncate">{branch.name}</span>
                        </Button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={closeBranchDialog}>
              Cancel
            </Button>
            {branchDialogMode === "create" && (
              <Button
                size="sm"
                onClick={() => void runCreateBranch()}
                disabled={branchDraft.trim().length === 0}
              >
                Create & checkout
              </Button>
            )}
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <Dialog
        open={mergeDialogScope !== null}
        onOpenChange={(open) => {
          if (!open) {
            closeMergeDialog();
          }
        }}
      >
        <DialogPopup className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {mergeDialogScope === "stack" ? "Merge stack" : "Merge pull request"}
            </DialogTitle>
            <DialogDescription>
              {mergeDialogScope === "stack"
                ? "Merge the visible pull request stack from base to tip. PRs are retargeted to the default branch as they are merged."
                : "Merge the current open pull request from this branch."}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-4">
            <div className="space-y-2">
              <p className="text-xs font-medium">Merge method</p>
              <div className="grid gap-2 sm:grid-cols-3">
                {(["merge", "squash", "rebase"] as const).map((method) => (
                  <Button
                    key={method}
                    size="xs"
                    variant={mergeMethod === method ? "default" : "outline"}
                    onClick={() => setMergeMethod(method)}
                    className="justify-center capitalize"
                  >
                    {method}
                  </Button>
                ))}
              </div>
            </div>
            <label className="flex items-start gap-2 rounded-lg border border-input bg-muted/20 p-3 text-sm">
              <Checkbox
                checked={deleteMergedBranches}
                onCheckedChange={(checked) => setDeleteMergedBranches(checked === true)}
              />
              <span className="space-y-1">
                <span className="block font-medium text-sm">Delete branch after merge</span>
                <span className="block text-muted-foreground text-xs">
                  Uses GitHub branch cleanup as each PR is merged.
                </span>
              </span>
            </label>
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={closeMergeDialog}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => void runMergePullRequests()}
              disabled={mergePullRequestsMutation.isPending}
            >
              {mergeDialogScope === "stack" ? "Merge stack" : "Merge PR"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <Dialog
        open={isCommitDialogOpen}
        onOpenChange={(open) => {
          if (!open) {
            setIsCommitDialogOpen(false);
            setDialogCommitMessage("");
            setExcludedFiles(new Set());
            setIsEditingFiles(false);
          }
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>{COMMIT_DIALOG_TITLE}</DialogTitle>
            <DialogDescription>{COMMIT_DIALOG_DESCRIPTION}</DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-4">
            <div className="space-y-3 rounded-lg border border-input bg-muted/40 p-3 text-xs">
              <div className="grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1">
                <span className="text-muted-foreground">Branch</span>
                <span className="flex items-center justify-between gap-2">
                  <span className="font-medium">
                    {gitStatusForActions?.branch ?? "(detached HEAD)"}
                  </span>
                  {isDefaultBranch && (
                    <span className="text-right text-warning text-xs">Warning: default branch</span>
                  )}
                </span>
              </div>
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    {isEditingFiles && allFiles.length > 0 && (
                      <Checkbox
                        checked={allSelected}
                        indeterminate={!allSelected && !noneSelected}
                        onCheckedChange={() => {
                          setExcludedFiles(
                            allSelected ? new Set(allFiles.map((f) => f.path)) : new Set(),
                          );
                        }}
                      />
                    )}
                    <span className="text-muted-foreground">Files</span>
                    {!allSelected && !isEditingFiles && (
                      <span className="text-muted-foreground">
                        ({selectedFiles.length} of {allFiles.length})
                      </span>
                    )}
                  </div>
                  {allFiles.length > 0 && (
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() => setIsEditingFiles((prev) => !prev)}
                    >
                      {isEditingFiles ? "Done" : "Edit"}
                    </Button>
                  )}
                </div>
                {!gitStatusForActions || allFiles.length === 0 ? (
                  <p className="font-medium">none</p>
                ) : (
                  <div className="space-y-2">
                    <ScrollArea className="h-44 rounded-md border border-input bg-background">
                      <div className="space-y-1 p-1">
                        {allFiles.map((file) => {
                          const isExcluded = excludedFiles.has(file.path);
                          return (
                            <div
                              key={file.path}
                              className="flex w-full items-center gap-2 rounded-md px-2 py-1 font-mono text-xs transition-colors hover:bg-accent/50"
                            >
                              {isEditingFiles && (
                                <Checkbox
                                  checked={!excludedFiles.has(file.path)}
                                  onCheckedChange={() => {
                                    setExcludedFiles((prev) => {
                                      const next = new Set(prev);
                                      if (next.has(file.path)) {
                                        next.delete(file.path);
                                      } else {
                                        next.add(file.path);
                                      }
                                      return next;
                                    });
                                  }}
                                />
                              )}
                              <button
                                type="button"
                                className="flex flex-1 items-center justify-between gap-3 text-left truncate"
                                onClick={() => openChangedFileInEditor(file.path)}
                              >
                                <span
                                  className={`truncate${isExcluded ? " text-muted-foreground" : ""}`}
                                >
                                  {file.path}
                                </span>
                                <span className="shrink-0">
                                  {isExcluded ? (
                                    <span className="text-muted-foreground">Excluded</span>
                                  ) : (
                                    <>
                                      <span className="text-success">+{file.insertions}</span>
                                      <span className="text-muted-foreground"> / </span>
                                      <span className="text-destructive">-{file.deletions}</span>
                                    </>
                                  )}
                                </span>
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    </ScrollArea>
                    <div className="flex justify-end font-mono">
                      <span className="text-success">
                        +{selectedFiles.reduce((sum, f) => sum + f.insertions, 0)}
                      </span>
                      <span className="text-muted-foreground"> / </span>
                      <span className="text-destructive">
                        -{selectedFiles.reduce((sum, f) => sum + f.deletions, 0)}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            </div>
            <div className="space-y-1">
              <p className="text-xs font-medium">Commit message (optional)</p>
              <Textarea
                value={dialogCommitMessage}
                onChange={(event) => setDialogCommitMessage(event.target.value)}
                placeholder="Leave empty to auto-generate"
                size="sm"
              />
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setIsCommitDialogOpen(false);
                setDialogCommitMessage("");
                setExcludedFiles(new Set());
                setIsEditingFiles(false);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={noneSelected}
              onClick={runDialogActionOnNewBranch}
            >
              Commit on new branch
            </Button>
            <Button size="sm" disabled={noneSelected} onClick={runDialogAction}>
              Commit
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <Dialog
        open={pendingDefaultBranchAction !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPendingDefaultBranchAction(null);
          }
        }}
      >
        <DialogPopup className="max-w-xl">
          <DialogHeader>
            <DialogTitle>
              {pendingDefaultBranchActionCopy?.title ?? "Run action on default branch?"}
            </DialogTitle>
            <DialogDescription>{pendingDefaultBranchActionCopy?.description}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setPendingDefaultBranchAction(null)}>
              Abort
            </Button>
            <Button size="sm" onClick={checkoutFeatureBranchAndContinuePendingAction}>
              Checkout feature branch & continue
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
