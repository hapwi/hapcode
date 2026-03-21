import type {
  GitBranch,
  GitPullRequestMergeMethod,
  GitStackedAction,
  GitStatusResult,
  ThreadId,
} from "@t3tools/contracts";
import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState, type MouseEvent } from "react";
import {
  ChevronDownIcon,
  CloudUploadIcon,
  GitCommitIcon,
  GitBranchIcon,
  InfoIcon,
  Trash2Icon,
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
import { Spinner } from "~/components/ui/spinner";
import { Textarea } from "~/components/ui/textarea";
import { toastManager } from "~/components/ui/toast";
import { openInPreferredEditor } from "~/editorPreferences";
import {
  gitBranchesQueryOptions,
  gitCheckoutMutationOptions,
  gitDeleteBranchMutationOptions,
  gitMergePullRequestsMutationOptions,
  gitInitMutationOptions,
  gitMutationKeys,
  gitPullMutationOptions,
  gitRunStackedActionMutationOptions,
  gitSuggestBranchNameMutationOptions,
  gitStatusQueryOptions,
  invalidateGitQueries,
} from "~/lib/gitReactQuery";
import { cn } from "~/lib/utils";
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

type BranchDialogMode = "switch";
type MergeDialogScope = "current" | "stack";
type BranchDialogEntry = {
  branch: GitBranch;
  deleteTarget: string;
  hasOriginRemote: boolean;
  remoteOnly: boolean;
};

const RECOMMENDED_MERGE_METHOD: GitPullRequestMergeMethod = "squash";
const MERGE_METHOD_OPTIONS: readonly GitPullRequestMergeMethod[] = ["squash", "merge", "rebase"];

type GitProgressState = {
  title: string;
  detail?: string;
};
type AiBranchCreationStage = "naming" | "creating" | null;
type BranchCreationNotice = {
  type: "info" | "error" | "success";
  message: string;
};
type GitStatusPr = NonNullable<GitStatusResult["pr"]>;

function createGitProgressState(title: string, detail?: string): GitProgressState {
  return detail ? { title, detail } : { title };
}

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

function GitStackStatusCard(input: {
  title: string;
  detail?: string;
  badgeLabel: string;
  badgeVariant: "success" | "warning" | "secondary" | "outline" | "info";
  loading?: boolean;
}) {
  return (
    <div className="flex w-full items-start gap-3 px-1 py-1.5 text-left">
      <div className="flex w-4 shrink-0 flex-col items-center pt-0.5">
        {input.loading ? (
          <Spinner className="size-3 text-muted-foreground/80" />
        ) : (
          <span className="size-2 rounded-full bg-foreground/70" />
        )}
      </div>
      <div className="min-w-0 flex-1 space-y-1.5 border-border/70 border-l pl-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant={input.badgeVariant} size="sm">
            {input.badgeLabel}
          </Badge>
          {input.loading && (
            <div className="flex items-center gap-1" aria-hidden="true">
              <span className="size-1 rounded-full bg-muted-foreground/35 animate-pulse" />
              <span className="size-1 rounded-full bg-muted-foreground/35 animate-pulse [animation-delay:180ms]" />
              <span className="size-1 rounded-full bg-muted-foreground/35 animate-pulse [animation-delay:360ms]" />
            </div>
          )}
        </div>
        <p className="line-clamp-2 font-medium text-[13px] leading-5">{input.title}</p>
        {input.detail && (
          <p className="truncate text-[11px] uppercase tracking-[0.14em] text-muted-foreground/80">
            {input.detail}
          </p>
        )}
      </div>
    </div>
  );
}

function GitActionProgressCard({ progress }: { progress: GitProgressState }) {
  return (
    <GitStackStatusCard
      title={progress.title}
      badgeLabel="working"
      badgeVariant="outline"
      loading
      {...(progress.detail ? { detail: progress.detail } : {})}
    />
  );
}

function GitHubNoticeCard({ notice }: { notice: BranchCreationNotice }) {
  return (
    <GitStackStatusCard
      title={notice.message}
      badgeLabel={notice.type === "error" ? "error" : notice.type === "success" ? "done" : "status"}
      badgeVariant={
        notice.type === "error" ? "warning" : notice.type === "success" ? "success" : "outline"
      }
    />
  );
}

function GitPullRequestStackCard({
  pr,
  isCurrent,
  hasConnector,
  onOpen,
}: {
  pr: GitStatusPr;
  isCurrent: boolean;
  hasConnector: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      className="flex w-full items-start gap-3 px-1 py-2 text-left transition-colors hover:bg-accent/10"
      onClick={onOpen}
    >
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <div className="flex w-4 shrink-0 flex-col items-center pt-0.5">
          <span className="size-2 rounded-full bg-foreground/70" />
          {hasConnector && <span className="mt-2 h-14 w-px bg-border/80" />}
        </div>
        <div className="min-w-0 flex-1 space-y-1.5 border-border/70 border-l pl-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant={statusBadgeVariant(pr.state)} size="sm">
              {pr.state}
            </Badge>
            {isCurrent && (
              <Badge variant="info" size="sm">
                Current
              </Badge>
            )}
            <span className="font-medium text-[11px] uppercase tracking-[0.14em] text-muted-foreground/80">
              PR #{pr.number}
            </span>
          </div>
          <p className="line-clamp-2 font-medium text-[13px] leading-5">{pr.title}</p>
          <div className="space-y-1 text-[11px] text-muted-foreground/85">
            <div className="flex flex-wrap items-center gap-x-2">
              <span className="uppercase tracking-[0.14em] text-muted-foreground/65">Base</span>
              <span className="font-mono">{pr.baseBranch}</span>
            </div>
            <div className="flex flex-wrap items-center gap-x-2">
              <span className="uppercase tracking-[0.14em] text-muted-foreground/65">Head</span>
              <span className="font-mono">{pr.headBranch}</span>
            </div>
          </div>
        </div>
      </div>
    </button>
  );
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

function isProtectedBranchName(branchName: string): boolean {
  return branchName === "main" || branchName === "master" || branchName === "pre-release";
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
  const [mergeMethod, setMergeMethod] =
    useState<GitPullRequestMergeMethod>(RECOMMENDED_MERGE_METHOD);
  const [deleteMergedBranches, setDeleteMergedBranches] = useState(true);
  const [gitActionProgress, setGitActionProgress] = useState<GitProgressState | null>(null);
  const [aiBranchCreationStage, setAiBranchCreationStage] = useState<AiBranchCreationStage>(null);
  const [branchCreationNotice, setBranchCreationNotice] = useState<BranchCreationNotice | null>(
    null,
  );
  const [lastVisiblePrStack, setLastVisiblePrStack] = useState<GitStatusPr[]>([]);

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
  const deleteBranchMutation = useMutation(
    gitDeleteBranchMutationOptions({
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
  const isBranchCreationBusy = aiBranchCreationStage !== null;
  const isGitActionRunning = isRunStackedActionRunning || isPullRunning;
  const isDefaultBranch = useMemo(() => {
    const branchName = gitStatusForActions?.branch;
    if (!branchName) return false;
    if (isProtectedBranchName(branchName)) return true;
    const current = branchList?.branches.find((branch) => branch.name === branchName);
    return current?.isDefault ?? false;
  }, [branchList?.branches, gitStatusForActions?.branch]);

  const gitActionMenuItems = useMemo(
    () =>
      buildMenuItems(
        gitStatusForActions,
        isGitActionRunning,
        isDefaultBranch,
        hasOriginRemote,
        gitStatusForActions?.branch,
      ),
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
  const displayPrStack = useMemo(() => activePrStack.toReversed(), [activePrStack]);
  const stackItems = useMemo(() => {
    if (displayPrStack.length > 0) return displayPrStack;
    if (isBranchCreationBusy || gitActionProgress || branchCreationNotice)
      return lastVisiblePrStack;
    return displayPrStack;
  }, [
    branchCreationNotice,
    displayPrStack,
    gitActionProgress,
    isBranchCreationBusy,
    lastVisiblePrStack,
  ]);
  const stackNotices = useMemo(() => {
    const notices: Array<{
      key: string;
      type: "progress" | "notice";
      progress?: GitProgressState;
      notice?: BranchCreationNotice;
    }> = [];
    if (gitActionProgress) {
      notices.push({
        key: `progress-${gitActionProgress.title}`,
        type: "progress",
        progress: gitActionProgress,
      });
    }
    if (branchCreationNotice && branchCreationNotice.type !== "success") {
      notices.push({
        key: `notice-${branchCreationNotice.type}-${branchCreationNotice.message}`,
        type: "notice",
        notice: branchCreationNotice,
      });
    }
    if (quickActionDisabledReason && !gitActionProgress) {
      notices.push({
        key: `disabled-${quickActionDisabledReason}`,
        type: "notice",
        notice: { type: "info", message: quickActionDisabledReason },
      });
    }
    if (gitStatusForActions?.branch === null) {
      notices.push({
        key: "detached-head",
        type: "notice",
        notice: {
          type: "info",
          message: "Detached HEAD: create and checkout a branch to enable stacked PR actions.",
        },
      });
    }
    if (isGitStatusOutOfSync) {
      notices.push({
        key: "status-refresh",
        type: "notice",
        notice: { type: "info", message: "Refreshing git status..." },
      });
    }
    if (gitStatusError) {
      notices.push({
        key: `status-error-${gitStatusError.message}`,
        type: "notice",
        notice: { type: "error", message: gitStatusError.message },
      });
    }
    return notices;
  }, [
    branchCreationNotice,
    gitActionProgress,
    gitStatusError,
    gitStatusForActions?.branch,
    isGitStatusOutOfSync,
    quickActionDisabledReason,
  ]);

  useEffect(() => {
    if (displayPrStack.length === 0) return;
    setLastVisiblePrStack(displayPrStack);
  }, [displayPrStack]);
  const switchableBranches = useMemo<BranchDialogEntry[]>(() => {
    const allBranches = branchList?.branches ?? [];
    const localBranches = allBranches.filter((branch) => !branch.current && !branch.isRemote);
    const originRemoteBranches = allBranches.filter(
      (branch) =>
        branch.isRemote &&
        branch.remoteName === "origin" &&
        branch.name.startsWith("origin/") &&
        branch.name !== "origin/HEAD",
    );
    const localNames = new Set(localBranches.map((branch) => branch.name));

    const localEntries = localBranches.map(
      (branch) =>
        ({
          branch,
          deleteTarget: branch.name,
          hasOriginRemote: originRemoteBranches.some(
            (candidate) => candidate.name === `origin/${branch.name}`,
          ),
          remoteOnly: false,
        }) satisfies BranchDialogEntry,
    );
    const remoteOnlyEntries = originRemoteBranches
      .filter((branch) => !localNames.has(branch.name.slice("origin/".length)))
      .map(
        (branch) =>
          ({
            branch,
            deleteTarget: branch.name.slice("origin/".length),
            hasOriginRemote: true,
            remoteOnly: true,
          }) satisfies BranchDialogEntry,
      );

    return [...localEntries, ...remoteOnlyEntries].toSorted((left, right) =>
      left.branch.name.localeCompare(right.branch.name),
    );
  }, [branchList?.branches]);
  const filteredSwitchableBranches = useMemo(() => {
    const query = branchDraft.trim().toLowerCase();
    if (query.length === 0) return switchableBranches;
    return switchableBranches.filter(({ branch }) => branch.name.toLowerCase().includes(query));
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
    if (stackItems.length > 1) {
      badges.push({
        label: `Stack ${stackItems.length}`,
        variant: "outline",
      });
    }
    return badges;
  }, [gitStatusForActions, stackItems.length]);

  const openExistingPr = useCallback(async () => {
    const api = readNativeApi();
    if (!api) {
      setBranchCreationNotice({ type: "error", message: "Link opening is unavailable." });
      return;
    }
    const prUrl = gitStatusForActions?.pr?.state === "open" ? gitStatusForActions.pr.url : null;
    if (!prUrl) {
      setBranchCreationNotice({ type: "error", message: "No open PR found." });
      return;
    }
    void api.shell.openExternal(prUrl).catch((err) => {
      setBranchCreationNotice({
        type: "error",
        message: err instanceof Error ? err.message : "Unable to open PR link.",
      });
    });
  }, [gitStatusForActions?.pr?.state, gitStatusForActions?.pr?.url]);

  const openPrUrl = useCallback(async (url: string) => {
    const api = readNativeApi();
    if (!api) {
      setBranchCreationNotice({ type: "error", message: "Link opening is unavailable." });
      return;
    }
    void api.shell.openExternal(url).catch((err) => {
      setBranchCreationNotice({
        type: "error",
        message: err instanceof Error ? err.message : "Unable to open PR link.",
      });
    });
  }, []);

  const openBranchDialog = useCallback((mode: BranchDialogMode) => {
    setBranchDialogMode(mode);
    setBranchDraft("");
  }, []);

  const closeBranchDialog = useCallback(() => {
    setBranchDialogMode(null);
    setBranchDraft("");
  }, []);

  const runCreateBranch = useCallback(
    async (branchName: string) => {
      const normalizedBranchName = branchName.trim();
      const mergeBaseBranch = gitStatusForActions?.branch ?? currentBranch ?? null;
      const api = readNativeApi();
      if (!api || !gitCwd || normalizedBranchName.length === 0) {
        return;
      }

      try {
        await api.git.createBranch({
          cwd: gitCwd,
          branch: normalizedBranchName,
          ...(mergeBaseBranch ? { mergeBaseBranch } : {}),
        });
        await checkoutMutation.mutateAsync(normalizedBranchName);
        await invalidateGitQueries(queryClient);
        closeBranchDialog();
        setBranchCreationNotice(null);
      } catch (err) {
        setBranchCreationNotice({
          type: "error",
          message: err instanceof Error ? err.message : "Failed to create branch.",
        });
      }
    },
    [
      checkoutMutation,
      closeBranchDialog,
      currentBranch,
      gitCwd,
      gitStatusForActions?.branch,
      queryClient,
    ],
  );

  const runCreateBranchFromAi = useCallback(async () => {
    if (!gitCwd) return;
    if (!gitStatusForActions?.hasWorkingTreeChanges) {
      setBranchCreationNotice({
        type: "info",
        message: "Make some local changes first so AI has context for the branch name.",
      });
      return;
    }

    setBranchCreationNotice(null);
    setAiBranchCreationStage("naming");
    try {
      const result = await suggestBranchNameMutation.mutateAsync();
      setAiBranchCreationStage("creating");
      await runCreateBranch(result.branch);
    } catch (err) {
      setBranchCreationNotice({
        type: "error",
        message: err instanceof Error ? err.message : "Failed to generate branch name.",
      });
    } finally {
      setAiBranchCreationStage(null);
    }
  }, [
    gitCwd,
    gitStatusForActions?.hasWorkingTreeChanges,
    runCreateBranch,
    suggestBranchNameMutation,
  ]);

  const startGitActionProgress = useCallback((progress: GitProgressState) => {
    setGitActionProgress(progress);
  }, []);

  const stopGitActionProgress = useCallback(() => {
    setGitActionProgress(null);
  }, []);

  const runCheckoutBranch = useCallback(
    async (branchName: string) => {
      setBranchCreationNotice(null);
      startGitActionProgress(createGitProgressState(`Switching to ${branchName}...`));
      const promise = checkoutMutation.mutateAsync(branchName).then(async () => {
        await invalidateGitQueries(queryClient);
        closeBranchDialog();
        setBranchCreationNotice({ type: "success", message: `Switched to ${branchName}` });
      });
      await promise.catch((err) => {
        setBranchCreationNotice({
          type: "error",
          message: err instanceof Error ? err.message : "Failed to checkout branch.",
        });
      });
      stopGitActionProgress();
    },
    [
      checkoutMutation,
      closeBranchDialog,
      queryClient,
      startGitActionProgress,
      stopGitActionProgress,
    ],
  );

  const runDeleteBranch = useCallback(
    async (branchName: string, options: { deleteLocal: boolean; deleteRemote: boolean }) => {
      const api = readNativeApi();
      if (!api || !gitCwd) return;

      const scopeLabel = options.deleteLocal
        ? options.deleteRemote
          ? "locally and on origin"
          : "locally"
        : "on origin";
      const confirmed = await api.dialogs.confirm(
        `Delete branch "${branchName}" ${scopeLabel}? This cannot be undone.`,
      );
      if (!confirmed) return;

      try {
        setBranchCreationNotice(null);
        startGitActionProgress(
          createGitProgressState(
            options.deleteLocal
              ? options.deleteRemote
                ? `Deleting ${branchName} locally and on origin...`
                : `Deleting ${branchName}...`
              : `Deleting ${branchName} on origin...`,
          ),
        );
        await deleteBranchMutation.mutateAsync({
          branch: branchName,
          deleteLocal: options.deleteLocal,
          deleteRemote: options.deleteRemote,
          force: true,
        });
        setBranchCreationNotice({
          type: "success",
          message: options.deleteLocal
            ? options.deleteRemote
              ? `Deleted ${branchName} locally and on origin`
              : `Deleted ${branchName}`
            : `Deleted ${branchName} on origin`,
        });
      } catch (err) {
        setBranchCreationNotice({
          type: "error",
          message: err instanceof Error ? err.message : "Failed to delete branch.",
        });
      } finally {
        stopGitActionProgress();
      }
    },
    [deleteBranchMutation, gitCwd, startGitActionProgress, stopGitActionProgress],
  );

  const openDeleteBranchMenu = useCallback(
    async (
      event: MouseEvent<HTMLButtonElement>,
      input: { branchName: string; deleteTarget: string; hasRemote: boolean; remoteOnly: boolean },
    ) => {
      event.preventDefault();
      event.stopPropagation();

      const api = readNativeApi();
      if (!api || deleteBranchMutation.isPending) return;

      const clicked = await api.contextMenu.show(
        [
          ...(!input.remoteOnly
            ? [
                {
                  id: "local" as const,
                  label: "Delete local branch",
                  destructive: true,
                },
              ]
            : []),
          ...(input.hasRemote
            ? [
                {
                  id: input.remoteOnly ? ("remote" as const) : ("both" as const),
                  label: input.remoteOnly ? "Delete remote branch" : "Delete local + remote branch",
                  destructive: true,
                },
              ]
            : []),
        ],
        { x: event.clientX, y: event.clientY },
      );
      if (clicked === "local") {
        await runDeleteBranch(input.deleteTarget, { deleteLocal: true, deleteRemote: false });
      } else if (clicked === "both" || clicked === "remote") {
        await runDeleteBranch(input.deleteTarget, {
          deleteLocal: clicked === "both",
          deleteRemote: true,
        });
      }
    },
    [deleteBranchMutation.isPending, runDeleteBranch],
  );

  const closeMergeDialog = useCallback(() => {
    setMergeDialogScope(null);
    setMergeMethod(RECOMMENDED_MERGE_METHOD);
    setDeleteMergedBranches(true);
  }, []);

  const openMergeDialog = useCallback((scope: MergeDialogScope) => {
    setMergeDialogScope(scope);
    setMergeMethod(RECOMMENDED_MERGE_METHOD);
    setDeleteMergedBranches(true);
  }, []);

  const runMergePullRequests = useCallback(async () => {
    if (!mergeDialogScope) return;

    try {
      setBranchCreationNotice(null);
      startGitActionProgress(
        createGitProgressState(mergeDialogScope === "stack" ? "Merging stack..." : "Merging PR..."),
      );
      const result = await mergePullRequestsMutation.mutateAsync({
        scope: mergeDialogScope,
        method: mergeMethod,
        deleteBranch: deleteMergedBranches,
      });
      const summary = [
        result.scope === "stack"
          ? `Merged ${result.merged.length} PRs`
          : `Merged PR #${result.merged[0]?.number ?? ""}`.trim(),
        result.cleanup.deletedBranches.length > 0
          ? `Deleted ${result.cleanup.deletedBranches.join(", ")}`
          : null,
        result.cleanup.syncedBranches.length > 0
          ? `Synced ${result.cleanup.syncedBranches.join(", ")}`
          : null,
      ]
        .filter((value): value is string => !!value)
        .join(" · ");
      setBranchCreationNotice({ type: "success", message: summary });
      closeMergeDialog();
    } catch (err) {
      setBranchCreationNotice({
        type: "error",
        message: err instanceof Error ? err.message : "Merge failed.",
      });
    } finally {
      stopGitActionProgress();
    }
  }, [
    startGitActionProgress,
    stopGitActionProgress,
    closeMergeDialog,
    deleteMergedBranches,
    mergeDialogScope,
    mergeMethod,
    mergePullRequestsMutation,
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
      startGitActionProgress(
        createGitProgressState(
          progressStages[0] ?? "Running git action...",
          actionBranch ? `On ${actionBranch}` : undefined,
        ),
      );
      setBranchCreationNotice(null);

      let stageIndex = 0;
      const stageInterval = setInterval(() => {
        stageIndex = Math.min(stageIndex + 1, progressStages.length - 1);
        setGitActionProgress(
          createGitProgressState(
            progressStages[stageIndex] ?? "Running git action...",
            actionBranch ? `On ${actionBranch}` : undefined,
          ),
        );
      }, 1100);

      const stopProgressUpdates = () => {
        clearInterval(stageInterval);
        stopGitActionProgress();
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
        const resultNotice = summarizeGitResult(result);
        if (resultNotice.description) {
          setBranchCreationNotice({
            type: "success",
            message: `${resultNotice.title} · ${resultNotice.description}`,
          });
        } else {
          setBranchCreationNotice({ type: "success", message: resultNotice.title });
        }
      } catch (err) {
        stopProgressUpdates();
        setBranchCreationNotice({
          type: "error",
          message: err instanceof Error ? err.message : "Action failed.",
        });
      }
    },

    [
      isDefaultBranch,
      runImmediateGitActionMutation,
      setPendingDefaultBranchAction,
      setBranchCreationNotice,
      startGitActionProgress,
      stopGitActionProgress,
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
      setBranchCreationNotice(null);
      startGitActionProgress(
        createGitProgressState(
          "Pulling latest changes...",
          gitStatusForActions?.branch ? `Into ${gitStatusForActions.branch}` : undefined,
        ),
      );
      const promise = pullMutation
        .mutateAsync()
        .then((result) => {
          setBranchCreationNotice({
            type: "success",
            message:
              result.status === "pulled"
                ? `Updated ${result.branch} from ${result.upstreamBranch ?? "upstream"}.`
                : `${result.branch} is already synchronized.`,
          });
        })
        .catch((err) => {
          setBranchCreationNotice({
            type: "error",
            message: err instanceof Error ? err.message : "Pull failed.",
          });
        })
        .finally(stopGitActionProgress);
      void promise;
      return;
    }
    if (quickAction.kind === "show_hint") {
      setBranchCreationNotice({
        type: "info",
        message: quickAction.hint ?? quickAction.label,
      });
      return;
    }
    if (quickAction.action) {
      void runGitActionWithToast({ action: quickAction.action });
    }
  }, [
    gitStatusForActions?.branch,
    openExistingPr,
    pullMutation,
    quickAction,
    runGitActionWithToast,
    setBranchCreationNotice,
    startGitActionProgress,
    stopGitActionProgress,
  ]);

  useEffect(() => {
    if (isGitActionRunning) return;
    setGitActionProgress((current) => (current === null ? current : null));
  }, [isGitActionRunning]);

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
        void runGitActionWithToast({
          action: "commit_push_pr",
          skipDefaultBranchPrompt:
            !gitStatusForActions?.hasWorkingTreeChanges &&
            (gitStatusForActions?.aheadCount ?? 0) === 0,
        });
        return;
      }
      setExcludedFiles(new Set());
      setIsEditingFiles(false);
      setIsCommitDialogOpen(true);
    },
    [
      gitStatusForActions?.aheadCount,
      gitStatusForActions?.hasWorkingTreeChanges,
      openExistingPr,
      runGitActionWithToast,
      setIsCommitDialogOpen,
    ],
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
              disabled={isGitActionRunning || isBranchCreationBusy || quickAction.disabled}
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
            <PopoverPopup
              side="bottom"
              align="end"
              className="w-[22rem] overflow-hidden p-0 sm:w-[26rem]"
            >
              <div className="flex h-[min(40rem,calc(100vh-7rem))] min-h-[30rem] flex-col gap-4 p-4">
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

                <div className="min-h-[3.75rem] space-y-2">
                  {(quickAction.kind !== "show_hint" || visibleMenuItemsWithReasons.length > 0) && (
                    <>
                      <div className="grid gap-2 sm:grid-cols-2">
                        {quickAction.kind !== "show_hint" && (
                          <Button
                            size="xs"
                            variant={quickActionDisabledReason ? "outline" : "default"}
                            disabled={
                              isGitActionRunning || isBranchCreationBusy || quickAction.disabled
                            }
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
                            disabled={isBranchCreationBusy || item.disabled}
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
                    </>
                  )}
                </div>

                <div className="space-y-2">
                  <p className="font-medium text-xs uppercase tracking-[0.18em] text-muted-foreground">
                    Branches
                  </p>
                  <div className="min-h-4">
                    {gitStatusForActions?.pr?.state === "open" && (
                      <p className="text-muted-foreground text-xs">
                        Updates current PR. New branch starts a new PR.
                      </p>
                    )}
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => void runCreateBranchFromAi()}
                      disabled={isBranchCreationBusy || !gitStatusForActions?.hasWorkingTreeChanges}
                      title={
                        gitStatusForActions?.hasWorkingTreeChanges
                          ? "Generate a branch name from current changes and switch to it."
                          : "Make local changes first to generate a branch name."
                      }
                    >
                      {aiBranchCreationStage !== null ? (
                        <Spinner className="size-3.5" />
                      ) : (
                        <GitBranchIcon className="size-3.5" />
                      )}
                      {aiBranchCreationStage === "naming"
                        ? "Naming..."
                        : aiBranchCreationStage === "creating"
                          ? "Creating..."
                          : "New branch"}
                    </Button>
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => openBranchDialog("switch")}
                      disabled={isBranchCreationBusy || switchableBranches.length === 0}
                    >
                      <GitBranchIcon className="size-3.5" />
                      Switch branch
                    </Button>
                  </div>
                </div>

                <div className="min-h-[4.5rem] space-y-2">
                  {(gitStatusForActions?.pr?.state === "open" || activePrStack.length > 1) && (
                    <>
                      <p className="font-medium text-xs uppercase tracking-[0.18em] text-muted-foreground">
                        Merge
                      </p>
                      <div className="grid gap-2 sm:grid-cols-2">
                        {gitStatusForActions?.pr?.state === "open" && (
                          <Button
                            size="xs"
                            variant="outline"
                            disabled={isBranchCreationBusy}
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
                            disabled={isBranchCreationBusy}
                            onClick={() => openMergeDialog("stack")}
                          >
                            <GitHubIcon className="size-3.5" />
                            Merge stack
                          </Button>
                        )}
                      </div>
                    </>
                  )}
                </div>

                <div className="min-h-0 flex-1 space-y-2 pb-1">
                  <div className="flex items-center justify-between">
                    <p className="font-medium text-xs uppercase tracking-[0.18em] text-muted-foreground">
                      Pull Request Stack
                    </p>
                    {stackItems.length > 0 && (
                      <span className="text-muted-foreground text-xs">
                        {stackItems.length} {stackItems.length === 1 ? "PR" : "PRs"}
                      </span>
                    )}
                  </div>
                  <div className="h-full min-h-0 overflow-y-auto rounded-lg border border-input bg-muted/20 pr-1">
                    <div className="space-y-3 p-3 pb-4">
                      {stackNotices.map((entry) =>
                        entry.type === "progress" && entry.progress ? (
                          <GitActionProgressCard key={entry.key} progress={entry.progress} />
                        ) : entry.notice ? (
                          <GitHubNoticeCard key={entry.key} notice={entry.notice} />
                        ) : null,
                      )}
                      {stackItems.length === 0 && stackNotices.length === 0 ? (
                        <div className="rounded-lg border border-dashed border-input px-3 py-4 text-muted-foreground text-xs">
                          No PR stack for this branch yet.
                        </div>
                      ) : (
                        stackItems.map((pr, index) => {
                          const isCurrent = pr.number === gitStatusForActions?.pr?.number;
                          return (
                            <GitPullRequestStackCard
                              key={pr.number}
                              pr={pr}
                              isCurrent={isCurrent}
                              hasConnector={index < stackItems.length - 1}
                              onOpen={() => void openPrUrl(pr.url)}
                            />
                          );
                        })
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </PopoverPopup>
          </Popover>
        </Group>
      )}

      <Dialog
        open={branchDialogMode === "switch"}
        onOpenChange={(open) => {
          if (!open) {
            closeBranchDialog();
          }
        }}
      >
        <DialogPopup className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Switch branch</DialogTitle>
            <DialogDescription>
              Search and switch to any local branch from this project.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-4">
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs font-medium">Search branches</p>
              </div>
              <Input
                value={branchDraft}
                onChange={(event) => setBranchDraft(event.target.value)}
                placeholder="Find a branch"
                autoFocus
              />
            </div>
            <div className="space-y-2">
              <p className="text-xs font-medium">Available branches</p>
              <div className="max-h-72 overflow-y-auto rounded-lg border border-input bg-muted/20 p-2">
                {filteredSwitchableBranches.length === 0 ? (
                  <p className="px-2 py-3 text-muted-foreground text-xs">No branches found.</p>
                ) : (
                  <div className="space-y-2">
                    {filteredSwitchableBranches.map(
                      ({ branch, deleteTarget, hasOriginRemote, remoteOnly }) => (
                        <div key={branch.name} className="flex items-center gap-2">
                          <Button
                            size="xs"
                            variant="outline"
                            className="min-w-0 flex-1 justify-start"
                            onClick={() => void runCheckoutBranch(branch.name)}
                          >
                            <GitBranchIcon className="size-3.5" />
                            <span className="truncate">{branch.name}</span>
                            {remoteOnly && (
                              <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                                remote
                              </span>
                            )}
                          </Button>
                          {!branch.isDefault && !isProtectedBranchName(deleteTarget) && (
                            <Button
                              size="icon-xs"
                              variant="outline"
                              className="shrink-0"
                              disabled={deleteBranchMutation.isPending}
                              onClick={(event) =>
                                void openDeleteBranchMenu(event, {
                                  branchName: branch.name,
                                  deleteTarget,
                                  hasRemote: hasOriginRemote,
                                  remoteOnly,
                                })
                              }
                              title={
                                remoteOnly
                                  ? "Delete remote branch."
                                  : hasOriginRemote
                                    ? "Delete branch locally or locally and on origin."
                                    : "Delete local branch."
                              }
                            >
                              <Trash2Icon className="size-3.5" />
                            </Button>
                          )}
                        </div>
                      ),
                    )}
                  </div>
                )}
              </div>
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={closeBranchDialog}>
              Close
            </Button>
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
                ? "Merge the visible pull request stack from base to tip. PRs are retargeted to the root stack base as they are merged."
                : "Merge the current open pull request from this branch."}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-4">
            <div className="space-y-2">
              <p className="text-xs font-medium">Merge method</p>
              <div className="grid gap-2 sm:grid-cols-3">
                {MERGE_METHOD_OPTIONS.map((method) => (
                  <Button
                    key={method}
                    size="xs"
                    variant={mergeMethod === method ? "default" : "outline"}
                    onClick={() => setMergeMethod(method)}
                    className={cn(
                      "capitalize",
                      method === RECOMMENDED_MERGE_METHOD &&
                        mergeMethod !== method &&
                        "border-emerald-500/50 bg-emerald-500/8 text-emerald-700 hover:bg-emerald-500/12 dark:text-emerald-300",
                    )}
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
                  Sync the merge target and delete merged branches locally and on origin. Protected
                  branches are synced instead of deleted.
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
