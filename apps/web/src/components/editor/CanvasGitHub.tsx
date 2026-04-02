import type {
  GitBranch,
  GitPullRequestMergeMethod,
  GitStackedAction,
  GitStatusResult,
  ThreadId,
} from "@t3tools/contracts";
import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { ArrowRightIcon, CheckCircle2Icon, CloudUploadIcon, ExternalLinkIcon, GitCommitIcon, GitBranchIcon, GitMergeIcon, GitPullRequestIcon, InfoIcon, Trash2Icon, XCircleIcon, ArrowDownToLineIcon } from "lucide-react";
import { GitHubIcon } from "../Icons";
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
} from "../GitActionsControl.logic";
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
  gitStatusQueryOptions,
  invalidateGitQueries,
} from "~/lib/gitReactQuery";
import { cn } from "~/lib/utils";
import { resolvePathLinkTarget } from "~/terminal-links";
import { readNativeApi } from "~/nativeApi";
import { useCanvasStore, type CanvasWindowState } from "./canvasStore";
import { useScopeActive } from "./ScopeVisibilityContext";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

type GitProgressState = {
  title: string;
  detail?: string;
};
type BranchCreationNotice = {
  type: "info" | "error" | "success";
  message: string;
};
type GitStatusPr = NonNullable<GitStatusResult["pr"]>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
  if (quickAction.kind === "open_pr") return <ExternalLinkIcon className={iconClassName} />;
  if (quickAction.kind === "run_pull") return <ArrowDownToLineIcon className={iconClassName} />;
  if (quickAction.kind === "run_action") {
    if (quickAction.action === "commit") return <GitCommitIcon className={iconClassName} />;
    if (quickAction.action === "commit_push") return <CloudUploadIcon className={iconClassName} />;
    return <GitPullRequestIcon className={iconClassName} />;
  }
  if (quickAction.label === "Commit") return <GitCommitIcon className={iconClassName} />;
  return <InfoIcon className={iconClassName} />;
}

function SectionHeader({ children, count }: { children: React.ReactNode; count?: number }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/50">
        {children}
      </span>
      <span className="flex-1 h-px bg-border/30" />
      {count !== undefined && count > 0 && (
        <span className="text-[10px] tabular-nums text-muted-foreground/40">{count}</span>
      )}
    </div>
  );
}

function GitStackStatusCard(input: {
  title: string;
  detail?: string;
  badgeLabel: string;
  badgeVariant: "success" | "warning" | "secondary" | "outline" | "info";
  loading?: boolean;
  icon?: React.ReactNode;
}) {
  const accentColor =
    input.badgeVariant === "success"
      ? "border-l-emerald-500/70"
      : input.badgeVariant === "warning"
        ? "border-l-amber-500/70"
        : input.badgeVariant === "info"
          ? "border-l-blue-500/70"
          : "border-l-muted-foreground/30";

  return (
    <div
      className={cn(
        "flex items-start gap-2.5 rounded-lg border border-border/50 border-l-2 bg-card/50 px-3 py-2.5 transition-colors",
        accentColor,
      )}
    >
      <div className="flex shrink-0 items-center pt-0.5">
        {input.loading ? (
          <Spinner className="size-3.5 text-muted-foreground" />
        ) : input.icon ? (
          <span className="flex size-4 items-center justify-center">{input.icon}</span>
        ) : (
          <Badge variant={input.badgeVariant} size="sm">
            {input.badgeLabel}
          </Badge>
        )}
      </div>
      <div className="min-w-0 flex-1 space-y-0.5">
        {input.loading && (
          <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
            {input.badgeLabel}
          </span>
        )}
        <p className="line-clamp-2 text-[13px] leading-snug">{input.title}</p>
        {input.detail && (
          <p className="truncate text-[11px] text-muted-foreground/60">{input.detail}</p>
        )}
      </div>
    </div>
  );
}

function GitActionProgressCard({ progress }: { progress: GitProgressState }) {
  return (
    <GitStackStatusCard
      title={progress.title}
      badgeLabel="in progress"
      badgeVariant="info"
      loading
      {...(progress.detail ? { detail: progress.detail } : {})}
    />
  );
}

function GitHubNoticeCard({ notice }: { notice: BranchCreationNotice }) {
  const icon =
    notice.type === "error" ? (
      <XCircleIcon className="size-3.5 text-amber-500" />
    ) : notice.type === "success" ? (
      <CheckCircle2Icon className="size-3.5 text-emerald-500" />
    ) : (
      <InfoIcon className="size-3.5 text-muted-foreground/70" />
    );

  return (
    <GitStackStatusCard
      title={notice.message}
      badgeLabel={notice.type === "error" ? "error" : notice.type === "success" ? "done" : "info"}
      badgeVariant={
        notice.type === "error" ? "warning" : notice.type === "success" ? "success" : "info"
      }
      icon={icon}
    />
  );
}

function GitPullRequestStackCard({
  pr,
  isCurrent,
  hasConnector,
  onOpen,
  mergeActions,
}: {
  pr: GitStatusPr;
  isCurrent: boolean;
  hasConnector: boolean;
  onOpen: () => void;
  mergeActions?: React.ReactNode;
}) {
  const stateColor =
    pr.state === "open"
      ? "text-emerald-500"
      : pr.state === "merged"
        ? "text-purple-400"
        : "text-muted-foreground/40";

  return (
    <div className="relative flex items-stretch gap-3">
      {/* Timeline rail */}
      <div className="flex w-4 shrink-0 flex-col items-center">
        <span
          className={cn(
            "mt-1.5 size-2 shrink-0 rounded-full ring-2 ring-background",
            pr.state === "open"
              ? "bg-emerald-500"
              : pr.state === "merged"
                ? "bg-purple-500"
                : "bg-muted-foreground/40",
          )}
        />
        {hasConnector && <span className="mt-1 flex-1 w-px bg-border/30" />}
      </div>

      {/* Changelog entry */}
      <div className={cn("min-w-0 flex-1 pb-4", !hasConnector && "pb-0")}>
        {/* PR number + badges row */}
        <div className="flex items-center gap-1.5">
          <GitPullRequestIcon className={cn("size-3 shrink-0", stateColor)} />
          <span className="text-[11px] font-medium tabular-nums text-muted-foreground/60">
            #{pr.number}
          </span>
          {isCurrent && (
            <Badge variant="info" size="sm">
              Current
            </Badge>
          )}
          {pr.state === "merged" && (
            <Badge variant="secondary" size="sm" className="text-purple-400">
              <GitMergeIcon className="size-2.5" />
              Merged
            </Badge>
          )}
          {pr.state !== "merged" && (
            <button
              type="button"
              className="ml-auto flex items-center gap-1 rounded-sm px-1 py-0.5 text-muted-foreground/40 transition-colors hover:text-muted-foreground"
              onClick={onOpen}
              title="Open in GitHub"
            >
              <ExternalLinkIcon className="size-3" />
            </button>
          )}
        </div>

        {/* Title */}
        <p
          className={cn(
            "mt-1 line-clamp-2 text-[12px] font-medium leading-snug",
            pr.state === "merged" && "text-muted-foreground/60",
          )}
        >
          {pr.title}
        </p>

        {/* Branch flow */}
        <div className="mt-0.5 flex items-center gap-1 text-[10px] text-muted-foreground/40">
          <span className="truncate font-mono">{pr.headBranch}</span>
          <ArrowRightIcon className="size-2.5 shrink-0" />
          <span className="truncate font-mono">{pr.baseBranch}</span>
        </div>

        {/* Inline merge actions for current PR */}
        {mergeActions && <div className="mt-2">{mergeActions}</div>}
      </div>
    </div>
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

// ---------------------------------------------------------------------------
// CanvasGitHub — workspace window content for GitHub actions
// ---------------------------------------------------------------------------

export function CanvasGitHub(props: { window: CanvasWindowState; cwd: string | null }) {
  const { cwd: gitCwd } = props;
  const isScopeActive = useScopeActive();
  const { settings } = useAppSettings();
  const setActiveWindow = useCanvasStore((s) => s.setActiveWindow);
  const updateWindow = useCanvasStore((s) => s.updateWindow);
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
  const [gitActionProgress, setGitActionProgress] = useState<GitProgressState | null>(null);
  const [branchCreationNotice, setBranchCreationNotice] = useState<BranchCreationNotice | null>(
    null,
  );
  const [lastVisiblePrStack, setLastVisiblePrStack] = useState<GitStatusPr[]>([]);

  const {
    data: gitStatus = null,
    error: gitStatusError,
    isLoading: isGitStatusLoading,
  } = useQuery(gitStatusQueryOptions(gitCwd, { active: isScopeActive }));

  const { data: branchList = null } = useQuery(
    gitBranchesQueryOptions(gitCwd, { active: isScopeActive }),
  );
  const hasOriginRemote = branchList?.hasOriginRemote ?? false;
  const currentBranch = branchList?.branches.find((branch) => branch.current)?.name ?? null;
  const isGitStatusOutOfSync =
    !!gitStatus?.branch && !!currentBranch && gitStatus.branch !== currentBranch;

  useEffect(() => {
    if (!isGitStatusOutOfSync) return;
    void invalidateGitQueries(queryClient);
  }, [isGitStatusOutOfSync, queryClient]);

  const gitStatusForActions = isGitStatusOutOfSync ? null : gitStatus;

  // Sync window title with current branch
  useEffect(() => {
    const branch = gitStatusForActions?.branch ?? currentBranch;
    if (branch) {
      updateWindow(props.window.id, { title: `GitHub \u00b7 ${branch}` });
    }
  }, [gitStatusForActions?.branch, currentBranch, props.window.id, updateWindow]);

  const allFiles = gitStatusForActions?.workingTree.files ?? [];
  const selectedFiles = allFiles.filter((f) => !excludedFiles.has(f.path));
  const allSelected = excludedFiles.size === 0;
  const noneSelected = selectedFiles.length === 0;

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

  const isRunStackedActionRunning =
    useIsMutating({ mutationKey: gitMutationKeys.runStackedAction(gitCwd) }) > 0;
  const isPullRunning = useIsMutating({ mutationKey: gitMutationKeys.pull(gitCwd) }) > 0;
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
  const mergedPrDismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stackItems = useMemo(() => {
    if (displayPrStack.length > 0) return displayPrStack;
    if (isGitActionRunning || gitActionProgress || branchCreationNotice) return lastVisiblePrStack;
    return displayPrStack;
  }, [
    branchCreationNotice,
    displayPrStack,
    gitActionProgress,
    isGitActionRunning,
    lastVisiblePrStack,
  ]);

  // Auto-clear merged PR cards after 5 minutes.
  useEffect(() => {
    return () => {
      if (mergedPrDismissTimer.current) clearTimeout(mergedPrDismissTimer.current);
    };
  }, []);

  // Clear stale merged PRs from the list when new open PRs appear.
  useEffect(() => {
    if (displayPrStack.length > 0 && lastVisiblePrStack.some((pr) => pr.state === "merged")) {
      setLastVisiblePrStack([]);
      if (mergedPrDismissTimer.current) {
        clearTimeout(mergedPrDismissTimer.current);
        mergedPrDismissTimer.current = null;
      }
    }
  }, [displayPrStack, lastVisiblePrStack]);
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

  const hasPrStackContent = stackItems.length > 0 || stackNotices.length > 0;

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
  }, []);

  const openMergeDialog = useCallback((scope: MergeDialogScope) => {
    setMergeDialogScope(scope);
  }, []);

  const runMergePullRequests = useCallback(async () => {
    if (!mergeDialogScope) return;

    const scope = mergeDialogScope;

    closeMergeDialog();

    try {
      setBranchCreationNotice(null);
      startGitActionProgress(
        createGitProgressState(scope === "stack" ? "Merging stack..." : "Merging PR..."),
      );
      const result = await mergePullRequestsMutation.mutateAsync({
        scope,
        method: RECOMMENDED_MERGE_METHOD,
        deleteBranch: true,
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
        .join(" \u00b7 ");
      // Mark the merged PRs as "merged" so they render with purple dots.
      const mergedNumbers = new Set(result.merged.map((m) => m.number));
      setLastVisiblePrStack((prev) =>
        prev.map((pr) => (mergedNumbers.has(pr.number) ? { ...pr, state: "merged" as const } : pr)),
      );

      // Auto-clear the merged PR cards after 5 minutes.
      if (mergedPrDismissTimer.current) clearTimeout(mergedPrDismissTimer.current);
      mergedPrDismissTimer.current = setTimeout(
        () => {
          setLastVisiblePrStack([]);
          setBranchCreationNotice(null);
          mergedPrDismissTimer.current = null;
        },
        5 * 60 * 1000,
      );

      setBranchCreationNotice({ type: "success", message: summary });
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
    mergeDialogScope,
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
        if (resultNotice.noChanges) {
          setBranchCreationNotice({
            type: "error",
            message: resultNotice.description ?? resultNotice.title,
          });
        } else if (resultNotice.description) {
          setBranchCreationNotice({
            type: "success",
            message: `${resultNotice.title} \u00b7 ${resultNotice.description}`,
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

  const runCreateFeatureBranch = useCallback(() => {
    if (!gitStatusForActions?.hasWorkingTreeChanges) {
      setBranchCreationNotice({
        type: "info",
        message:
          "Make local changes first so a feature branch can be named, committed, and pushed.",
      });
      return;
    }

    void runGitActionWithToast({
      action: "commit_push",
      featureBranch: true,
    });
  }, [gitStatusForActions?.hasWorkingTreeChanges, runGitActionWithToast]);

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
        });
        return;
      }
      const target = resolvePathLinkTarget(filePath, gitCwd);
      void openInPreferredEditor(api, target).catch((error) => {
        toastManager.add({
          type: "error",
          title: "Unable to open file",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      });
    },
    [gitCwd],
  );

  // Activate this window on pointer interaction
  const handleActivate = useCallback(() => {
    setActiveWindow(props.window.id);
  }, [props.window.id, setActiveWindow]);

  if (!gitCwd) {
    return (
      <div className="flex h-full w-full items-center justify-center text-xs text-muted-foreground/60">
        No project selected
      </div>
    );
  }

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: activation handler
    <div className="flex h-full w-full flex-col overflow-auto" onClick={handleActivate}>
      {/* Scrollable main content */}
      <div className="flex-1 min-h-0 overflow-auto">
        <div className="p-3 space-y-3">
          {/* Branch header */}
          <div className="rounded-lg border border-border/50 bg-card/40 p-3 space-y-2.5">
            <div className="flex items-center gap-2">
              <div className="flex size-6 items-center justify-center rounded-md bg-muted/60">
                <GitBranchIcon className="size-3.5 text-muted-foreground" />
              </div>
              <span className="truncate font-semibold text-sm">
                {gitStatusForActions?.branch ?? currentBranch ?? "(detached HEAD)"}
              </span>
            </div>
            {(branchSummaryBadges.length > 0 || isDefaultBranch) && (
              <div className="flex min-h-[22px] flex-wrap items-center gap-1.5 pl-8">
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

          {/* Actions */}
          <div className="space-y-2">
            {/* Primary action */}
            {quickAction.kind !== "show_hint" && (
              <Button
                size="lg"
                variant={quickActionDisabledReason ? "outline" : "default"}
                disabled={isGitActionRunning || quickAction.disabled}
                onClick={runQuickAction}
                title={quickActionDisabledReason ?? undefined}
                className="w-full justify-center gap-2"
              >
                <GitQuickActionIcon quickAction={quickAction} />
                {quickAction.label}
              </Button>
            )}

            {/* Secondary git actions */}
            {visibleMenuItemsWithReasons.length > 0 && (
              <div className={cn("grid gap-1.5", visibleMenuItemsWithReasons.length >= 3 ? "grid-cols-3" : "grid-cols-2")}>
                {visibleMenuItemsWithReasons.map(({ item, disabledReason }) => (
                  <Button
                    key={`${item.id}-${item.label}`}
                    size="sm"
                    variant="outline"
                    disabled={isGitActionRunning || item.disabled}
                    onClick={() => openDialogForMenuItem(item)}
                    title={disabledReason ?? undefined}
                    className="justify-center gap-1.5"
                  >
                    <GitActionItemIcon icon={item.icon} />
                    {item.label}
                  </Button>
                ))}
              </div>
            )}

            {quickActionHelperText && (
              <p className="text-center text-muted-foreground/60 text-[11px] leading-relaxed">
                {quickActionHelperText}
              </p>
            )}
          </div>

          {/* Notices */}
          {stackNotices.length > 0 && (
            <div className="space-y-1.5">
              {stackNotices.map((entry) =>
                entry.type === "progress" && entry.progress ? (
                  <GitActionProgressCard key={entry.key} progress={entry.progress} />
                ) : entry.notice ? (
                  <GitHubNoticeCard key={entry.key} notice={entry.notice} />
                ) : null,
              )}
            </div>
          )}

          {/* Branch management */}
          <div className="space-y-2">
            <SectionHeader>Branches</SectionHeader>
            <div className="grid gap-1.5 grid-cols-2">
              <Button
                size="sm"
                variant="outline"
                onClick={runCreateFeatureBranch}
                disabled={isGitActionRunning || !gitStatusForActions?.hasWorkingTreeChanges}
                title={
                  gitStatusForActions?.hasWorkingTreeChanges
                    ? "Create a named feature branch, commit current changes, and push it."
                    : "Make local changes first to create, commit, and push a feature branch."
                }
                className="justify-center"
              >
                {isGitActionRunning ? (
                  <Spinner className="size-3" />
                ) : (
                  <GitBranchIcon className="size-3" />
                )}
                New branch
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => openBranchDialog("switch")}
                disabled={isGitActionRunning || switchableBranches.length === 0}
                className="justify-center"
              >
                <GitBranchIcon className="size-3" />
                Switch
              </Button>
            </div>
          </div>

          {/* PR Stack */}
          <div className="space-y-2">
            <SectionHeader count={stackItems.length}>Pull Requests</SectionHeader>
            {stackItems.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border/40 py-5 text-muted-foreground/40">
                {isGitStatusLoading ? (
                  <>
                    <Spinner className="size-4" />
                    <span className="text-[11px]">Loading pull requests...</span>
                  </>
                ) : (
                  <>
                    <GitPullRequestIcon className="size-5" />
                    <span className="text-[11px]">No pull requests yet</span>
                  </>
                )}
              </div>
            ) : (
              <div>
                {stackItems.map((pr, index) => {
                  const isCurrent = pr.number === gitStatusForActions?.pr?.number;
                  const showMergeActions =
                    isCurrent &&
                    (gitStatusForActions?.pr?.state === "open" || activePrStack.length > 1);

                  return (
                    <GitPullRequestStackCard
                      key={pr.number}
                      pr={pr}
                      isCurrent={isCurrent}
                      hasConnector={index < stackItems.length - 1}
                      onOpen={() => void openPrUrl(pr.url)}
                      mergeActions={
                        showMergeActions ? (
                          <div className="flex items-center gap-1.5">
                            {gitStatusForActions?.pr?.state === "open" && (
                              <Button
                                size="xs"
                                variant="outline"
                                disabled={isGitActionRunning}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  openMergeDialog("current");
                                }}
                              >
                                <GitMergeIcon className="size-2.5" />
                                Merge
                              </Button>
                            )}
                            {activePrStack.length > 1 && (
                              <Button
                                size="xs"
                                variant="outline"
                                disabled={isGitActionRunning}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  openMergeDialog("stack");
                                }}
                              >
                                <GitMergeIcon className="size-2.5" />
                                Merge stack
                              </Button>
                            )}
                          </div>
                        ) : undefined
                      }
                    />
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Dialogs */}
      <Dialog
        open={branchDialogMode === "switch"}
        onOpenChange={(open) => {
          if (!open) closeBranchDialog();
        }}
      >
        <DialogPopup className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Switch branch</DialogTitle>
            <DialogDescription>
              Search and switch to any local or remote branch.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-3">
            <Input
              value={branchDraft}
              onChange={(event) => setBranchDraft(event.target.value)}
              placeholder="Search branches..."
              autoFocus
            />
            <div className="max-h-72 overflow-y-auto rounded-lg border border-border/50 bg-card/30">
              {filteredSwitchableBranches.length === 0 ? (
                <div className="flex flex-col items-center gap-1.5 py-6 text-muted-foreground/50">
                  <GitBranchIcon className="size-4" />
                  <span className="text-xs">No branches found</span>
                </div>
              ) : (
                <div className="p-1 space-y-0.5">
                  {filteredSwitchableBranches.map(
                    ({ branch, deleteTarget, hasOriginRemote, remoteOnly }) => (
                      <div
                        key={branch.name}
                        className="flex items-center gap-1.5 rounded-md px-2 py-1.5 transition-colors hover:bg-accent/40"
                      >
                        <button
                          type="button"
                          className="flex min-w-0 flex-1 items-center gap-2 text-left"
                          onClick={() => void runCheckoutBranch(branch.name)}
                        >
                          <GitBranchIcon className="size-3 shrink-0 text-muted-foreground/60" />
                          <span className="truncate text-xs font-medium">{branch.name}</span>
                          {remoteOnly && (
                            <Badge variant="outline" size="sm" className="ml-auto shrink-0">
                              remote
                            </Badge>
                          )}
                        </button>
                        {!branch.isDefault && !isProtectedBranchName(deleteTarget) && (
                          <Button
                            size="icon-xs"
                            variant="ghost"
                            className="shrink-0 text-muted-foreground/50 hover:text-destructive"
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
                            <Trash2Icon className="size-3" />
                          </Button>
                        )}
                      </div>
                    ),
                  )}
                </div>
              )}
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
          if (!open) closeMergeDialog();
        }}
      >
        <DialogPopup className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {mergeDialogScope === "stack" ? "Merge stack" : "Merge pull request"}
            </DialogTitle>
            <DialogDescription>
              {mergeDialogScope === "stack"
                ? "Squash merge all PRs in the stack from base to tip. PRs are retargeted and rebased automatically."
                : "Squash merge the current open pull request from this branch."}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex items-start gap-2.5 rounded-lg border border-border/50 bg-card/30 p-3">
              <InfoIcon className="size-3.5 shrink-0 text-muted-foreground/60 mt-0.5" />
              <p className="text-xs text-muted-foreground leading-relaxed">
                Merged branches will be deleted automatically. Protected branches are synced instead
                of deleted.
              </p>
            </div>
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
              <GitMergeIcon className="size-3" />
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
            {/* Branch info */}
            <div className="flex items-center gap-2 rounded-lg border border-border/50 bg-card/30 px-3 py-2 text-xs">
              <GitBranchIcon className="size-3 shrink-0 text-muted-foreground/60" />
              <span className="font-medium">
                {gitStatusForActions?.branch ?? "(detached HEAD)"}
              </span>
              {isDefaultBranch && (
                <Badge variant="warning" size="sm" className="ml-auto">
                  Default branch
                </Badge>
              )}
            </div>

            {/* File list */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-xs">
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
                  <span className="font-medium">
                    Files
                    {!allSelected && !isEditingFiles && (
                      <span className="text-muted-foreground font-normal">
                        {" "}({selectedFiles.length} of {allFiles.length})
                      </span>
                    )}
                  </span>
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
                <div className="flex items-center justify-center rounded-lg border border-dashed border-border/40 py-4 text-xs text-muted-foreground/50">
                  No changed files
                </div>
              ) : (
                <div className="space-y-2">
                  <ScrollArea className="h-44 rounded-lg border border-border/50 bg-card/30">
                    <div className="p-1 space-y-0.5">
                      {allFiles.map((file) => {
                        const isExcluded = excludedFiles.has(file.path);
                        return (
                          <div
                            key={file.path}
                            className={cn(
                              "flex w-full items-center gap-2 rounded-md px-2 py-1.5 font-mono text-[11px] transition-colors hover:bg-accent/30",
                              isExcluded && "opacity-50",
                            )}
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
                              <span className="truncate">{file.path}</span>
                              <span className="shrink-0 tabular-nums">
                                {isExcluded ? (
                                  <span className="text-muted-foreground/60 text-[10px]">excluded</span>
                                ) : (
                                  <>
                                    <span className="text-success">+{file.insertions}</span>
                                    <span className="text-muted-foreground/40 mx-0.5">/</span>
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
                  <div className="flex justify-end font-mono text-[11px] tabular-nums text-muted-foreground/60">
                    <span className="text-success">
                      +{selectedFiles.reduce((sum, f) => sum + f.insertions, 0)}
                    </span>
                    <span className="mx-1">/</span>
                    <span className="text-destructive">
                      -{selectedFiles.reduce((sum, f) => sum + f.deletions, 0)}
                    </span>
                  </div>
                </div>
              )}
            </div>

            {/* Commit message */}
            <div className="space-y-1.5">
              <p className="text-xs font-medium">Commit message</p>
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
              <GitBranchIcon className="size-3" />
              New branch
            </Button>
            <Button size="sm" disabled={noneSelected} onClick={runDialogAction}>
              <GitCommitIcon className="size-3" />
              Commit
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <Dialog
        open={pendingDefaultBranchAction !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDefaultBranchAction(null);
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
              Cancel
            </Button>
            <Button size="sm" onClick={checkoutFeatureBranchAndContinuePendingAction}>
              <GitBranchIcon className="size-3" />
              Feature branch & continue
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  );
}
