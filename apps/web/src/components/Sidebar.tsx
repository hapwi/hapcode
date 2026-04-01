import {
  AppWindowIcon,
  ArrowUpDownIcon,
  ChevronRightIcon,
  FolderIcon,
  GitPullRequestIcon,
  PlusIcon,
  RocketIcon,
  SettingsIcon,
  SquarePenIcon,
  TerminalIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import {
  DndContext,
  type DragCancelEvent,
  type CollisionDetection,
  PointerSensor,
  type DragStartEvent,
  closestCorners,
  pointerWithin,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { restrictToFirstScrollableAncestor, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { CSS } from "@dnd-kit/utilities";
import {
  ProjectId,
  ThreadId,
  type GitStatusResult,
  type ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import {
  useAppSettings,
  type SidebarProjectSortOrder,
  type SidebarThreadSortOrder,
} from "../appSettings";
import { useSettingsDialogStore } from "./settings/settingsDialogStore";
import { isElectron } from "../env";
import { APP_STAGE_LABEL, APP_VERSION } from "../branding";
import { isMacPlatform, newCommandId } from "../lib/utils";
import { useStore } from "../store";
import { shortcutLabelForCommand } from "../keybindings";
import { deriveThreadActivityState } from "../session-logic";
import { gitStatusQueryOptions } from "../lib/gitReactQuery";
import { serverConfigQueryOptions } from "../lib/serverReactQuery";
import { readNativeApi } from "../nativeApi";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { toastManager } from "./ui/toast";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "./ui/alert";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { Button } from "./ui/button";
import { Collapsible, CollapsibleContent } from "./ui/collapsible";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenuAction,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarSeparator,
  SidebarTrigger,
} from "./ui/sidebar";
import { useThreadSelectionStore } from "../threadSelectionStore";
import { formatWorktreePathForDisplay, getOrphanedWorktreePathForThread } from "../worktreeCleanup";
import {
  resolveProjectStatusIndicator,
  resolveSidebarNewThreadEnvMode,
  resolveThreadRowClassName,
  resolveThreadStatusPill,
  shouldClearThreadSelectionOnMouseDown,
  sortProjectsForSidebar,
  sortThreadsForSidebar,
} from "./Sidebar.logic";
import {
  Menu,
  MenuGroup,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "./ui/menu";
import {
  useActiveWindowThreadId,
  useCanvasStore,
  useThreadIdsWithOpenChatWindows,
  useTotalWindowCount,
  useWindowCountForScope,
} from "./editor/canvasStore";
import { useDesktopUpdateState } from "./sidebar/useDesktopUpdateState";
import { AddProjectForm } from "./sidebar/AddProjectForm";
import { DeleteProjectDialog, useDeleteProjectDialogState } from "./sidebar/DeleteProjectDialog";
import { useSidebarThreadActions } from "./sidebar/useSidebarThreadActions";

const EMPTY_KEYBINDINGS: ResolvedKeybindingsConfig = [];
const THREAD_PREVIEW_LIMIT = 6;

const SIDEBAR_SORT_LABELS: Record<SidebarProjectSortOrder, string> = {
  updated_at: "Last user message",
  created_at: "Created at",
  manual: "Manual",
};
const SIDEBAR_THREAD_SORT_LABELS: Record<SidebarThreadSortOrder, string> = {
  updated_at: "Last user message",
  created_at: "Created at",
};

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

interface TerminalStatusIndicator {
  label: "Terminal process running";
  colorClass: string;
  pulse: boolean;
}

interface PrStatusIndicator {
  label: "PR open" | "PR closed" | "PR merged";
  colorClass: string;
  tooltip: string;
  url: string;
}

type ThreadPr = GitStatusResult["pr"];

function terminalStatusFromRunningIds(
  runningTerminalIds: string[],
): TerminalStatusIndicator | null {
  if (runningTerminalIds.length === 0) {
    return null;
  }
  return {
    label: "Terminal process running",
    colorClass: "text-teal-600 dark:text-teal-300/90",
    pulse: true,
  };
}

function prStatusIndicator(pr: ThreadPr): PrStatusIndicator | null {
  if (!pr) return null;

  const branchInfo =
    pr.headBranch && pr.baseBranch ? `${pr.headBranch} \u2192 ${pr.baseBranch}` : "";
  const branchSuffix = branchInfo ? `\n${branchInfo}` : "";

  if (pr.state === "open") {
    return {
      label: "PR open",
      colorClass: "text-emerald-600 dark:text-emerald-300/90",
      tooltip: `#${pr.number} PR open: ${pr.title}${branchSuffix}`,
      url: pr.url,
    };
  }
  if (pr.state === "closed") {
    return {
      label: "PR closed",
      colorClass: "text-zinc-500 dark:text-zinc-400/80",
      tooltip: `#${pr.number} PR closed: ${pr.title}${branchSuffix}`,
      url: pr.url,
    };
  }
  if (pr.state === "merged") {
    return {
      label: "PR merged",
      colorClass: "text-violet-600 dark:text-violet-300/90",
      tooltip: `#${pr.number} PR merged: ${pr.title}${branchSuffix}`,
      url: pr.url,
    };
  }
  return null;
}

/**
 * Derives the server's HTTP origin (scheme + host + port) from the same
 * sources WsTransport uses, converting ws(s) to http(s).
 */
function getServerHttpOrigin(): string {
  const bridgeUrl = window.desktopBridge?.getWsUrl();
  const envUrl = import.meta.env.VITE_WS_URL as string | undefined;
  const wsUrl =
    bridgeUrl && bridgeUrl.length > 0
      ? bridgeUrl
      : envUrl && envUrl.length > 0
        ? envUrl
        : `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.hostname}:${window.location.port}`;
  // Parse to extract just the origin, dropping path/query (e.g. ?token=\u2026)
  const httpUrl = wsUrl.replace(/^wss:/, "https:").replace(/^ws:/, "http:");
  try {
    return new URL(httpUrl).origin;
  } catch {
    return httpUrl;
  }
}

const serverHttpOrigin = getServerHttpOrigin();

function ProjectFavicon({ cwd }: { cwd: string }) {
  const [status, setStatus] = useState<"loading" | "loaded" | "error">("loading");

  const src = `${serverHttpOrigin}/api/project-favicon?cwd=${encodeURIComponent(cwd)}`;

  if (status === "error") {
    return <FolderIcon className="size-3.5 shrink-0 text-muted-foreground/50" />;
  }

  return (
    <img
      src={src}
      alt=""
      className={`size-3.5 shrink-0 rounded-sm object-contain ${status === "loading" ? "hidden" : ""}`}
      onLoad={() => setStatus("loaded")}
      onError={() => setStatus("error")}
    />
  );
}

function ProjectSortMenu({
  projectSortOrder,
  threadSortOrder,
  onProjectSortOrderChange,
  onThreadSortOrderChange,
}: {
  projectSortOrder: SidebarProjectSortOrder;
  threadSortOrder: SidebarThreadSortOrder;
  onProjectSortOrderChange: (sortOrder: SidebarProjectSortOrder) => void;
  onThreadSortOrderChange: (sortOrder: SidebarThreadSortOrder) => void;
}) {
  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger className="inline-flex size-5 cursor-pointer items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground" />
          }
        >
          <ArrowUpDownIcon className="size-3.5" />
        </TooltipTrigger>
        <TooltipPopup side="right">Sort projects</TooltipPopup>
      </Tooltip>
      <MenuPopup align="end" side="bottom" className="min-w-44">
        <MenuGroup>
          <div className="px-2 py-1 sm:text-xs font-medium text-muted-foreground">
            Sort projects
          </div>
          <MenuRadioGroup
            value={projectSortOrder}
            onValueChange={(value) => {
              onProjectSortOrderChange(value as SidebarProjectSortOrder);
            }}
          >
            {(Object.entries(SIDEBAR_SORT_LABELS) as Array<[SidebarProjectSortOrder, string]>).map(
              ([value, label]) => (
                <MenuRadioItem key={value} value={value} className="min-h-7 py-1 sm:text-xs">
                  {label}
                </MenuRadioItem>
              ),
            )}
          </MenuRadioGroup>
        </MenuGroup>
        <MenuGroup>
          <div className="px-2 pt-2 pb-1 sm:text-xs font-medium text-muted-foreground">
            Sort threads
          </div>
          <MenuRadioGroup
            value={threadSortOrder}
            onValueChange={(value) => {
              onThreadSortOrderChange(value as SidebarThreadSortOrder);
            }}
          >
            {(
              Object.entries(SIDEBAR_THREAD_SORT_LABELS) as Array<[SidebarThreadSortOrder, string]>
            ).map(([value, label]) => (
              <MenuRadioItem key={value} value={value} className="min-h-7 py-1 sm:text-xs">
                {label}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}

type SortableProjectHandleProps = Pick<ReturnType<typeof useSortable>, "attributes" | "listeners">;

function SortableProjectItem({
  projectId,
  children,
}: {
  projectId: ProjectId;
  children: (handleProps: SortableProjectHandleProps) => React.ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging, isOver } =
    useSortable({ id: projectId });
  return (
    <li
      ref={setNodeRef}
      style={{
        transform: CSS.Translate.toString(transform),
        transition,
      }}
      className={`group/menu-item relative rounded-md ${
        isDragging ? "z-20 opacity-80" : ""
      } ${isOver && !isDragging ? "ring-1 ring-primary/40" : ""}`}
      data-sidebar="menu-item"
      data-slot="sidebar-menu-item"
    >
      {children({ attributes, listeners })}
    </li>
  );
}

function ProjectCloseWindowsButton({
  projectId,
  projectName,
}: {
  projectId: ProjectId;
  projectName: string;
}) {
  const scopeKey = `project:${projectId}`;
  const windowCount = useWindowCountForScope(scopeKey);
  const closeAllWindowsInScope = useCanvasStore((s) => s.closeAllWindowsInScope);

  if (windowCount === 0) return null;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <SidebarMenuAction
            render={<button type="button" aria-label={`Close all windows in ${projectName}`} />}
            showOnHover
            className="top-1 right-7 size-5 rounded-md p-0 text-muted-foreground/70 hover:bg-secondary hover:text-foreground"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              closeAllWindowsInScope(scopeKey);
            }}
          >
            <XIcon className="size-3.5" />
          </SidebarMenuAction>
        }
      />
      <TooltipPopup side="top">Close all windows ({windowCount})</TooltipPopup>
    </Tooltip>
  );
}

function CloseAllWindowsFooterItem() {
  const totalWindows = useTotalWindowCount();
  const closeAllWindows = useCanvasStore((s) => s.closeAllWindows);
  const [confirmOpen, setConfirmOpen] = useState(false);

  if (totalWindows === 0) return null;

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        size="sm"
        className="gap-2 px-2 py-1.5 text-muted-foreground/70 hover:bg-accent hover:text-foreground"
        onClick={() => setConfirmOpen(true)}
      >
        <XIcon className="size-3.5" />
        <span className="text-xs">Close all windows</span>
        <span className="ml-auto text-[10px] tabular-nums text-muted-foreground/50">
          {totalWindows}
        </span>
      </SidebarMenuButton>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Close all windows?</AlertDialogTitle>
            <AlertDialogDescription>
              This will close {totalWindows} open {totalWindows === 1 ? "window" : "windows"} across
              all projects.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                closeAllWindows();
                setConfirmOpen(false);
              }}
            >
              Close all
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SidebarMenuItem>
  );
}

export default function Sidebar() {
  const projects = useStore((store) => store.projects);
  const threads = useStore((store) => store.threads);
  const toggleProject = useStore((store) => store.toggleProject);
  const reorderProjects = useStore((store) => store.reorderProjects);
  const terminalStateByThreadId = useTerminalStateStore((state) => state.terminalStateByThreadId);
  const threadIdsWithOpenWindows = useThreadIdsWithOpenChatWindows();
  const navigate = useNavigate();
  const openSettings = useSettingsDialogStore((s) => s.openSettings);
  const { settings: appSettings, updateSettings } = useAppSettings();
  const { handleNewThread } = useHandleNewThread();
  const routeThreadId = useParams({
    strict: false,
    select: (params) => (params.threadId ? ThreadId.makeUnsafe(params.threadId) : null),
  });
  const activeWindowThreadId = useActiveWindowThreadId();
  const { data: keybindings = EMPTY_KEYBINDINGS } = useQuery({
    ...serverConfigQueryOptions(),
    select: (config) => config.keybindings,
  });
  const [renamingThreadId, setRenamingThreadId] = useState<ThreadId | null>(null);
  const [renamingTitle, setRenamingTitle] = useState("");
  const [expandedThreadListsByProject, setExpandedThreadListsByProject] = useState<
    ReadonlySet<ProjectId>
  >(() => new Set());
  const threadActivityStateById = useMemo(
    () =>
      new Map(
        threads.map((thread) => [
          thread.id,
          deriveThreadActivityState(thread.activities, thread.latestTurn?.turnId),
        ]),
      ),
    [threads],
  );
  const sortedProjects = useMemo(
    () => sortProjectsForSidebar(projects, threads, appSettings.sidebarProjectSortOrder),
    [appSettings.sidebarProjectSortOrder, projects, threads],
  );
  const isManualProjectSorting = appSettings.sidebarProjectSortOrder === "manual";
  const renamingCommittedRef = useRef(false);
  const renamingInputRef = useRef<HTMLInputElement | null>(null);
  const dragInProgressRef = useRef(false);
  const suppressProjectClickAfterDragRef = useRef(false);
  const deleteProjectDialogHandle = useDeleteProjectDialogState();
  const { setDeleteProjectDialog, setDeleteProjectWorktrees } = deleteProjectDialogHandle;
  const selectedThreadIds = useThreadSelectionStore((s) => s.selectedThreadIds);
  const toggleThreadSelection = useThreadSelectionStore((s) => s.toggleThread);
  const rangeSelectTo = useThreadSelectionStore((s) => s.rangeSelectTo);
  const clearSelection = useThreadSelectionStore((s) => s.clearSelection);
  const setSelectionAnchor = useThreadSelectionStore((s) => s.setAnchor);
  const projectCwdById = useMemo(
    () => new Map(projects.map((project) => [project.id, project.cwd] as const)),
    [projects],
  );

  // ── Extracted hooks ──────────────────────────────────────────────
  const {
    showDesktopUpdateButton,
    desktopUpdateTooltip,
    desktopUpdateButtonDisabled,
    desktopUpdateButtonAction,
    desktopUpdateButtonInteractivityClasses,
    desktopUpdateButtonClasses,
    showArm64IntelBuildWarning,
    arm64IntelBuildWarningDescription,
    handleDesktopUpdateButtonClick,
  } = useDesktopUpdateState();

  const { shouldShowProjectPathEntry, handleStartAddProject, addProjectFormJsx } = AddProjectForm({
    projects,
    threads,
    defaultThreadEnvMode: appSettings.defaultThreadEnvMode,
    sidebarThreadSortOrder: appSettings.sidebarThreadSortOrder,
  });

  const {
    copyPathToClipboard,
    handleThreadContextMenu,
    handleMultiSelectContextMenu,
  } = useSidebarThreadActions({
    projectCwdById,
    setRenamingThreadId,
    setRenamingTitle,
    renamingCommittedRef,
  });

  // ── Remaining state & callbacks ──────────────────────────────────
  const threadGitTargets = useMemo(
    () =>
      threads.map((thread) => ({
        threadId: thread.id,
        branch: thread.branch,
        cwd: thread.worktreePath ?? projectCwdById.get(thread.projectId) ?? null,
      })),
    [projectCwdById, threads],
  );
  const threadGitStatusCwds = useMemo(
    () => [
      ...new Set(
        threadGitTargets
          .filter((target) => target.branch !== null)
          .map((target) => target.cwd)
          .filter((cwd): cwd is string => cwd !== null),
      ),
    ],
    [threadGitTargets],
  );
  const threadGitStatusQueries = useQueries({
    queries: threadGitStatusCwds.map((cwd) => ({
      ...gitStatusQueryOptions(cwd),
      staleTime: 30_000,
      refetchInterval: 60_000,
    })),
  });
  const prByThreadId = useMemo(() => {
    const statusByCwd = new Map<string, GitStatusResult>();
    for (let index = 0; index < threadGitStatusCwds.length; index += 1) {
      const cwd = threadGitStatusCwds[index];
      if (!cwd) continue;
      const status = threadGitStatusQueries[index]?.data;
      if (status) {
        statusByCwd.set(cwd, status);
      }
    }

    const map = new Map<ThreadId, ThreadPr>();
    for (const target of threadGitTargets) {
      const status = target.cwd ? statusByCwd.get(target.cwd) : undefined;
      const branchMatches =
        target.branch !== null && status?.branch !== null && status?.branch === target.branch;
      map.set(target.threadId, branchMatches ? (status?.pr ?? null) : null);
    }
    return map;
  }, [threadGitStatusCwds, threadGitStatusQueries, threadGitTargets]);

  const openPrLink = useCallback((event: React.MouseEvent<HTMLElement>, prUrl: string) => {
    event.preventDefault();
    event.stopPropagation();

    const api = readNativeApi();
    if (!api) {
      toastManager.add({
        type: "error",
        title: "Link opening is unavailable.",
      });
      return;
    }

    void api.shell.openExternal(prUrl).catch((error) => {
      toastManager.add({
        type: "error",
        title: "Unable to open PR link",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    });
  }, []);

  const cancelRename = useCallback(() => {
    setRenamingThreadId(null);
    renamingInputRef.current = null;
  }, []);

  const commitRename = useCallback(
    async (threadId: ThreadId, newTitle: string, originalTitle: string) => {
      const finishRename = () => {
        setRenamingThreadId((current) => {
          if (current !== threadId) return current;
          renamingInputRef.current = null;
          return null;
        });
      };

      const trimmed = newTitle.trim();
      if (trimmed.length === 0) {
        toastManager.add({ type: "warning", title: "Thread title cannot be empty" });
        finishRename();
        return;
      }
      if (trimmed === originalTitle) {
        finishRename();
        return;
      }
      const api = readNativeApi();
      if (!api) {
        finishRename();
        return;
      }
      try {
        await api.orchestration.dispatchCommand({
          type: "thread.meta.update",
          commandId: newCommandId(),
          threadId,
          title: trimmed,
        });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Failed to rename thread",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      }
      finishRename();
    },
    [],
  );

  const handleThreadClick = useCallback(
    (event: MouseEvent, threadId: ThreadId, orderedProjectThreadIds: readonly ThreadId[]) => {
      const isMac = isMacPlatform(navigator.platform);
      const isModClick = isMac ? event.metaKey : event.ctrlKey;
      const isShiftClick = event.shiftKey;

      if (isModClick) {
        event.preventDefault();
        toggleThreadSelection(threadId);
        return;
      }

      if (isShiftClick) {
        event.preventDefault();
        rangeSelectTo(threadId, orderedProjectThreadIds);
        return;
      }

      // Plain click \u2014 clear selection, set anchor for future shift-clicks, and navigate
      if (selectedThreadIds.size > 0) {
        clearSelection();
      }
      setSelectionAnchor(threadId);
      void navigate({
        to: "/$threadId",
        params: { threadId },
      });
    },
    [
      clearSelection,
      navigate,
      rangeSelectTo,
      selectedThreadIds.size,
      setSelectionAnchor,
      toggleThreadSelection,
    ],
  );

  const handleProjectContextMenu = useCallback(
    async (projectId: ProjectId, position: { x: number; y: number }) => {
      const api = readNativeApi();
      if (!api) return;
      const scopeKey = `project:${projectId}`;
      const scopeState = useCanvasStore.getState().scopes[scopeKey];
      const hasWindows = scopeState && scopeState.workspaces.some((w) => w.windows.length > 0);
      const project = projects.find((entry) => entry.id === projectId);
      if (!project) return;

      const menuItems = [
        { id: "copy-path" as const, label: "Copy Project Path" },
        ...(hasWindows ? [{ id: "close-windows" as const, label: "Close all windows" }] : []),
        { id: "delete" as const, label: "Remove project", destructive: true },
      ];

      const clicked = await api.contextMenu.show(menuItems, position);

      if (clicked === "copy-path") {
        copyPathToClipboard(project.cwd, { path: project.cwd });
        return;
      }

      if (clicked === "close-windows") {
        useCanvasStore.getState().closeAllWindowsInScope(scopeKey);
        return;
      }
      if (clicked !== "delete") return;

      const projectThreads = threads.filter((thread) => thread.projectId === projectId);

      // Pre-compute orphaned worktrees for the dialog
      const allThreadIds = new Set<ThreadId>(projectThreads.map((t) => t.id));
      const orphanedWorktrees: Array<{
        threadId: ThreadId;
        path: string;
        displayPath: string;
        cwd: string;
      }> = [];
      const seenPaths = new Set<string>();
      for (const thread of projectThreads) {
        const survivingThreads = threads.filter(
          (t) => t.id === thread.id || !allThreadIds.has(t.id),
        );
        const orphanedPath = getOrphanedWorktreePathForThread(survivingThreads, thread.id);
        if (orphanedPath && !seenPaths.has(orphanedPath)) {
          seenPaths.add(orphanedPath);
          orphanedWorktrees.push({
            threadId: thread.id,
            path: orphanedPath,
            displayPath: formatWorktreePathForDisplay(orphanedPath) ?? orphanedPath,
            cwd: project.cwd,
          });
        }
      }

      setDeleteProjectWorktrees(true);
      setDeleteProjectDialog({
        projectId,
        projectName: project.name,
        threadCount: projectThreads.length,
        orphanedWorktrees,
      });
    },
    [copyPathToClipboard, projects, setDeleteProjectDialog, setDeleteProjectWorktrees, threads],
  );

  const projectDnDSensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
  );
  const projectCollisionDetection = useCallback<CollisionDetection>((args) => {
    const pointerCollisions = pointerWithin(args);
    if (pointerCollisions.length > 0) {
      return pointerCollisions;
    }

    return closestCorners(args);
  }, []);

  const handleProjectDragEnd = useCallback(
    (event: DragEndEvent) => {
      dragInProgressRef.current = false;
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const activeProject = projects.find((project) => project.id === active.id);
      const overProject = projects.find((project) => project.id === over.id);
      if (!activeProject || !overProject) return;
      reorderProjects(activeProject.id, overProject.id);
    },
    [projects, reorderProjects],
  );

  const handleProjectDragStart = useCallback((_event: DragStartEvent) => {
    dragInProgressRef.current = true;
    suppressProjectClickAfterDragRef.current = true;
  }, []);

  const handleProjectDragCancel = useCallback((_event: DragCancelEvent) => {
    dragInProgressRef.current = false;
  }, []);

  const handleProjectTitlePointerDownCapture = useCallback(() => {
    suppressProjectClickAfterDragRef.current = false;
  }, []);

  const handleProjectTitleClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>, projectId: ProjectId) => {
      if (dragInProgressRef.current) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (suppressProjectClickAfterDragRef.current) {
        // Consume the synthetic click emitted after a drag release.
        suppressProjectClickAfterDragRef.current = false;
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (selectedThreadIds.size > 0) {
        clearSelection();
      }
      toggleProject(projectId);
    },
    [clearSelection, selectedThreadIds.size, toggleProject],
  );

  const handleProjectTitleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>, projectId: ProjectId) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      if (dragInProgressRef.current) {
        return;
      }
      toggleProject(projectId);
    },
    [toggleProject],
  );

  useEffect(() => {
    const onMouseDown = (event: globalThis.MouseEvent) => {
      if (selectedThreadIds.size === 0) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (!shouldClearThreadSelectionOnMouseDown(target)) return;
      clearSelection();
    };

    window.addEventListener("mousedown", onMouseDown);
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
    };
  }, [clearSelection, selectedThreadIds.size]);

  const newThreadShortcutLabel = useMemo(
    () =>
      shortcutLabelForCommand(keybindings, "chat.newLocal") ??
      shortcutLabelForCommand(keybindings, "chat.new"),
    [keybindings],
  );

  const expandThreadListForProject = useCallback((projectId: ProjectId) => {
    setExpandedThreadListsByProject((current) => {
      if (current.has(projectId)) return current;
      const next = new Set(current);
      next.add(projectId);
      return next;
    });
  }, []);

  const collapseThreadListForProject = useCallback((projectId: ProjectId) => {
    setExpandedThreadListsByProject((current) => {
      if (!current.has(projectId)) return current;
      const next = new Set(current);
      next.delete(projectId);
      return next;
    });
  }, []);

  const wordmark = (
    <div className="flex items-center gap-2">
      <SidebarTrigger className="shrink-0 md:hidden" />
      <Tooltip>
        <TooltipTrigger
          render={
            <div className="flex min-w-0 flex-1 items-center gap-1.5 ml-1 cursor-pointer">
              <span className="text-sm font-semibold tracking-tight">
                <span className="text-white">hap</span>
                <span className="text-muted-foreground">code</span>
              </span>
              <span className="inline-flex items-center justify-center rounded-full border border-yellow-600/30 bg-yellow-500/20 px-1.5 pt-[3px] pb-[2px] text-[8px] font-medium uppercase leading-none tracking-[0.18em] text-yellow-700 dark:border-yellow-500/20 dark:bg-yellow-600/15 dark:text-yellow-300/80 backdrop-blur-sm shadow-[inset_0_1px_0_0_rgba(255,255,255,0.05)]">
                {APP_STAGE_LABEL}
              </span>
            </div>
          }
        />
        <TooltipPopup side="bottom" sideOffset={2}>
          Version {APP_VERSION}
        </TooltipPopup>
      </Tooltip>
    </div>
  );

  return (
    <>
      {isElectron ? (
        <>
          <SidebarHeader className="drag-region h-[52px] flex-row items-center gap-2 px-4 py-0 pl-[90px]">
            {wordmark}
            {showDesktopUpdateButton && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label={desktopUpdateTooltip}
                      aria-disabled={desktopUpdateButtonDisabled || undefined}
                      disabled={desktopUpdateButtonDisabled}
                      className={`inline-flex size-7 ml-auto mt-1.5 items-center justify-center rounded-md text-muted-foreground transition-colors ${desktopUpdateButtonInteractivityClasses} ${desktopUpdateButtonClasses}`}
                      onClick={handleDesktopUpdateButtonClick}
                    >
                      <RocketIcon className="size-3.5" />
                    </button>
                  }
                />
                <TooltipPopup side="bottom">{desktopUpdateTooltip}</TooltipPopup>
              </Tooltip>
            )}
          </SidebarHeader>
        </>
      ) : (
        <SidebarHeader className="gap-3 px-3 py-2 sm:gap-2.5 sm:px-4 sm:py-3">
          {wordmark}
        </SidebarHeader>
      )}

      <SidebarContent className="gap-0">
        {showArm64IntelBuildWarning && arm64IntelBuildWarningDescription ? (
          <SidebarGroup className="px-2 pt-2 pb-0">
            <Alert variant="warning" className="rounded-2xl border-warning/40 bg-warning/8">
              <TriangleAlertIcon />
              <AlertTitle>Intel build on Apple Silicon</AlertTitle>
              <AlertDescription>{arm64IntelBuildWarningDescription}</AlertDescription>
              {desktopUpdateButtonAction !== "none" ? (
                <AlertAction>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={desktopUpdateButtonDisabled}
                    onClick={handleDesktopUpdateButtonClick}
                  >
                    {desktopUpdateButtonAction === "download"
                      ? "Download ARM build"
                      : "Install ARM build"}
                  </Button>
                </AlertAction>
              ) : null}
            </Alert>
          </SidebarGroup>
        ) : null}
        <SidebarGroup className="px-2 py-2">
          <div className="mb-1 flex items-center justify-between px-2">
            <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
              Projects
            </span>
            <div className="flex items-center gap-1">
              <ProjectSortMenu
                projectSortOrder={appSettings.sidebarProjectSortOrder}
                threadSortOrder={appSettings.sidebarThreadSortOrder}
                onProjectSortOrderChange={(sortOrder) => {
                  updateSettings({ sidebarProjectSortOrder: sortOrder });
                }}
                onThreadSortOrderChange={(sortOrder) => {
                  updateSettings({ sidebarThreadSortOrder: sortOrder });
                }}
              />
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label={shouldShowProjectPathEntry ? "Cancel add project" : "Add project"}
                      aria-pressed={shouldShowProjectPathEntry}
                      className="inline-flex size-5 cursor-pointer items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
                      onClick={handleStartAddProject}
                    />
                  }
                >
                  <PlusIcon
                    className={`size-3.5 transition-transform duration-150 ${
                      shouldShowProjectPathEntry ? "rotate-45" : "rotate-0"
                    }`}
                  />
                </TooltipTrigger>
                <TooltipPopup side="right">
                  {shouldShowProjectPathEntry ? "Cancel add project" : "Add project"}
                </TooltipPopup>
              </Tooltip>
            </div>
          </div>

          {addProjectFormJsx}

          <DndContext
            sensors={projectDnDSensors}
            collisionDetection={projectCollisionDetection}
            modifiers={[restrictToVerticalAxis, restrictToFirstScrollableAncestor]}
            onDragStart={handleProjectDragStart}
            onDragEnd={handleProjectDragEnd}
            onDragCancel={handleProjectDragCancel}
          >
            <SidebarMenu>
              <SortableContext
                items={sortedProjects.map((project) => project.id)}
                strategy={verticalListSortingStrategy}
              >
                {sortedProjects.map((project) => {
                  const projectThreads = sortThreadsForSidebar(
                    threads.filter((thread) => thread.projectId === project.id),
                    appSettings.sidebarThreadSortOrder,
                  );
                  const projectStatus = resolveProjectStatusIndicator(
                    projectThreads.map((thread) =>
                      resolveThreadStatusPill({
                        thread,
                        hasPendingApprovals:
                          (threadActivityStateById.get(thread.id)?.pendingApprovals.length ?? 0) >
                          0,
                        hasPendingUserInput:
                          (threadActivityStateById.get(thread.id)?.pendingUserInputs.length ?? 0) >
                          0,
                      }),
                    ),
                  );
                  const isThreadListExpanded = expandedThreadListsByProject.has(project.id);
                  const hasHiddenThreads = projectThreads.length > THREAD_PREVIEW_LIMIT;
                  const displayedThreads =
                    hasHiddenThreads && !isThreadListExpanded
                      ? projectThreads.slice(0, THREAD_PREVIEW_LIMIT)
                      : projectThreads;
                  const orderedProjectThreadIds = projectThreads.map((thread) => thread.id);

                  return (
                    <SortableProjectItem key={project.id} projectId={project.id}>
                      {(dragHandleProps) => (
                        <Collapsible className="group/collapsible" open={project.expanded}>
                          <div className="group/project-header relative">
                            <SidebarMenuButton
                              size="sm"
                              className={`gap-2 px-2 py-1.5 text-left hover:bg-accent group-hover/project-header:bg-accent group-hover/project-header:text-sidebar-accent-foreground ${
                                isManualProjectSorting ? "cursor-grab active:cursor-grabbing" : "cursor-pointer"
                              }`}
                              {...(isManualProjectSorting ? dragHandleProps.attributes : {})}
                              {...(isManualProjectSorting ? dragHandleProps.listeners : {})}
                              onPointerDownCapture={handleProjectTitlePointerDownCapture}
                              onClick={(event) => handleProjectTitleClick(event, project.id)}
                              onKeyDown={(event) => handleProjectTitleKeyDown(event, project.id)}
                              onContextMenu={(event) => {
                                event.preventDefault();
                                void handleProjectContextMenu(project.id, {
                                  x: event.clientX,
                                  y: event.clientY,
                                });
                              }}
                            >
                              {!project.expanded && projectStatus ? (
                                <span
                                  aria-hidden="true"
                                  title={projectStatus.label}
                                  className={`-ml-0.5 relative inline-flex size-3.5 shrink-0 items-center justify-center ${projectStatus.colorClass}`}
                                >
                                  <span className="absolute inset-0 flex items-center justify-center transition-opacity duration-150 group-hover/project-header:opacity-0">
                                    <span
                                      className={`size-[9px] rounded-full ${projectStatus.dotClass} ${
                                        projectStatus.pulse ? "animate-pulse" : ""
                                      }`}
                                    />
                                  </span>
                                  <ChevronRightIcon className="absolute inset-0 m-auto size-3.5 text-muted-foreground/70 opacity-0 transition-opacity duration-150 group-hover/project-header:opacity-100" />
                                </span>
                              ) : (
                                <ChevronRightIcon
                                  className={`-ml-0.5 size-3.5 shrink-0 text-muted-foreground/70 transition-transform duration-150 ${
                                    project.expanded ? "rotate-90" : ""
                                  }`}
                                />
                              )}
                              <ProjectFavicon cwd={project.cwd} />
                              <span className="flex-1 truncate text-xs font-medium text-foreground/90">
                                {project.name}
                              </span>
                            </SidebarMenuButton>
                            <Tooltip>
                              <TooltipTrigger
                                render={
                                  <SidebarMenuAction
                                    render={
                                      <button
                                        type="button"
                                        aria-label={`Create new thread in ${project.name}`}
                                        data-testid="new-thread-button"
                                      />
                                    }
                                    showOnHover
                                    className="top-1 right-1 size-5 rounded-md p-0 text-muted-foreground/70 hover:bg-secondary hover:text-foreground"
                                    onClick={(event) => {
                                      event.preventDefault();
                                      event.stopPropagation();
                                      void handleNewThread(project.id, {
                                        envMode: resolveSidebarNewThreadEnvMode({
                                          defaultEnvMode: appSettings.defaultThreadEnvMode,
                                        }),
                                      });
                                    }}
                                  >
                                    <SquarePenIcon className="size-3.5" />
                                  </SidebarMenuAction>
                                }
                              />
                              <TooltipPopup side="top">
                                {newThreadShortcutLabel
                                  ? `New thread (${newThreadShortcutLabel})`
                                  : "New thread"}
                              </TooltipPopup>
                            </Tooltip>
                            <ProjectCloseWindowsButton
                              projectId={project.id}
                              projectName={project.name}
                            />
                          </div>

                          <CollapsibleContent keepMounted>
                            <SidebarMenuSub className="mx-1 my-0 w-full translate-x-0 gap-0.5 px-1.5 py-0">
                              {displayedThreads.map((thread) => {
                                const isActive =
                                  routeThreadId === thread.id || activeWindowThreadId === thread.id;
                                const isSelected = selectedThreadIds.has(thread.id);
                                const isHighlighted = isActive || isSelected;
                                const threadActivityState = threadActivityStateById.get(thread.id);
                                const threadStatus = resolveThreadStatusPill({
                                  thread,
                                  hasPendingApprovals:
                                    (threadActivityState?.pendingApprovals.length ?? 0) > 0,
                                  hasPendingUserInput:
                                    (threadActivityState?.pendingUserInputs.length ?? 0) > 0,
                                });
                                const prStatus = prStatusIndicator(
                                  prByThreadId.get(thread.id) ?? null,
                                );
                                const terminalStatus = terminalStatusFromRunningIds(
                                  selectThreadTerminalState(terminalStateByThreadId, thread.id)
                                    .runningTerminalIds,
                                );

                                return (
                                  <SidebarMenuSubItem
                                    key={thread.id}
                                    className="w-full"
                                    data-thread-item
                                  >
                                    <SidebarMenuSubButton
                                      render={<div role="button" tabIndex={0} />}
                                      size="sm"
                                      isActive={isActive}
                                      className={resolveThreadRowClassName({
                                        isActive,
                                        isSelected,
                                      })}
                                      onClick={(event) => {
                                        handleThreadClick(
                                          event,
                                          thread.id,
                                          orderedProjectThreadIds,
                                        );
                                      }}
                                      onKeyDown={(event) => {
                                        if (event.key !== "Enter" && event.key !== " ") return;
                                        event.preventDefault();
                                        if (selectedThreadIds.size > 0) {
                                          clearSelection();
                                        }
                                        setSelectionAnchor(thread.id);
                                        void navigate({
                                          to: "/$threadId",
                                          params: { threadId: thread.id },
                                        });
                                      }}
                                      onContextMenu={(event) => {
                                        event.preventDefault();
                                        if (
                                          selectedThreadIds.size > 0 &&
                                          selectedThreadIds.has(thread.id)
                                        ) {
                                          void handleMultiSelectContextMenu({
                                            x: event.clientX,
                                            y: event.clientY,
                                          });
                                        } else {
                                          if (selectedThreadIds.size > 0) {
                                            clearSelection();
                                          }
                                          void handleThreadContextMenu(thread.id, {
                                            x: event.clientX,
                                            y: event.clientY,
                                          });
                                        }
                                      }}
                                    >
                                      <div className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
                                        {prStatus && (
                                          <Tooltip>
                                            <TooltipTrigger
                                              render={
                                                <button
                                                  type="button"
                                                  aria-label={prStatus.tooltip}
                                                  className={`inline-flex items-center justify-center ${prStatus.colorClass} cursor-pointer rounded-sm outline-hidden focus-visible:ring-1 focus-visible:ring-ring`}
                                                  onClick={(event) => {
                                                    openPrLink(event, prStatus.url);
                                                  }}
                                                >
                                                  <GitPullRequestIcon className="size-3" />
                                                </button>
                                              }
                                            />
                                            <TooltipPopup side="top" className="max-w-xs">
                                              <div className="flex flex-col gap-0.5">
                                                {prStatus.tooltip
                                                  .split("\n")
                                                  .map((line, idx) => (
                                                    <span
                                                      key={idx}
                                                      className={
                                                        idx > 0
                                                          ? "text-muted-foreground font-mono text-[10px]"
                                                          : undefined
                                                      }
                                                    >
                                                      {line}
                                                    </span>
                                                  ))}
                                              </div>
                                            </TooltipPopup>
                                          </Tooltip>
                                        )}
                                        {threadStatus && (
                                          <span
                                            className={`inline-flex items-center gap-1 text-[10px] ${threadStatus.colorClass}`}
                                          >
                                            <span
                                              className={`h-1.5 w-1.5 rounded-full ${threadStatus.dotClass} ${
                                                threadStatus.pulse ? "animate-pulse" : ""
                                              }`}
                                            />
                                            <span className="hidden md:inline">
                                              {threadStatus.label}
                                            </span>
                                          </span>
                                        )}
                                        {renamingThreadId === thread.id ? (
                                          <input
                                            ref={(el) => {
                                              if (el && renamingInputRef.current !== el) {
                                                renamingInputRef.current = el;
                                                el.focus();
                                                el.select();
                                              }
                                            }}
                                            className="min-w-0 flex-1 truncate text-xs bg-transparent outline-none border border-ring rounded px-0.5"
                                            value={renamingTitle}
                                            onChange={(e) => setRenamingTitle(e.target.value)}
                                            onKeyDown={(e) => {
                                              e.stopPropagation();
                                              if (e.key === "Enter") {
                                                e.preventDefault();
                                                renamingCommittedRef.current = true;
                                                void commitRename(
                                                  thread.id,
                                                  renamingTitle,
                                                  thread.title,
                                                );
                                              } else if (e.key === "Escape") {
                                                e.preventDefault();
                                                renamingCommittedRef.current = true;
                                                cancelRename();
                                              }
                                            }}
                                            onBlur={() => {
                                              if (!renamingCommittedRef.current) {
                                                void commitRename(
                                                  thread.id,
                                                  renamingTitle,
                                                  thread.title,
                                                );
                                              }
                                            }}
                                            onClick={(e) => e.stopPropagation()}
                                          />
                                        ) : (
                                          <span className="min-w-0 flex-1 truncate text-xs">
                                            {thread.title}
                                          </span>
                                        )}
                                      </div>
                                      <div className="ml-auto flex shrink-0 items-center gap-1.5">
                                        <span
                                          className={`text-[10px] ${
                                            isHighlighted
                                              ? "text-foreground/72 dark:text-foreground/82"
                                              : "text-muted-foreground/40"
                                          }`}
                                        >
                                          {formatRelativeTime(thread.createdAt)}
                                        </span>
                                        {threadIdsWithOpenWindows.has(thread.id) && (
                                          <Tooltip>
                                            <TooltipTrigger
                                              render={
                                                <span
                                                  aria-label="Open in window"
                                                  className="inline-flex items-center justify-center text-muted-foreground/50"
                                                >
                                                  <AppWindowIcon className="size-3" />
                                                </span>
                                              }
                                            />
                                            <TooltipPopup side="top">Open in window</TooltipPopup>
                                          </Tooltip>
                                        )}
                                        {terminalStatus && (
                                          <span
                                            role="img"
                                            aria-label={terminalStatus.label}
                                            title={terminalStatus.label}
                                            className={`inline-flex items-center justify-center ${terminalStatus.colorClass}`}
                                          >
                                            <TerminalIcon
                                              className={`size-3 ${terminalStatus.pulse ? "animate-pulse" : ""}`}
                                            />
                                          </span>
                                        )}
                                      </div>
                                    </SidebarMenuSubButton>
                                  </SidebarMenuSubItem>
                                );
                              })}

                              {hasHiddenThreads && !isThreadListExpanded && (
                                <SidebarMenuSubItem className="w-full">
                                  <SidebarMenuSubButton
                                    render={<button type="button" />}
                                    data-thread-selection-safe
                                    size="sm"
                                    className="h-6 w-full translate-x-0 justify-start px-2 text-left text-[10px] text-muted-foreground/60 hover:bg-accent hover:text-muted-foreground/80"
                                    onClick={() => {
                                      expandThreadListForProject(project.id);
                                    }}
                                  >
                                    <span>Show more</span>
                                  </SidebarMenuSubButton>
                                </SidebarMenuSubItem>
                              )}
                              {hasHiddenThreads && isThreadListExpanded && (
                                <SidebarMenuSubItem className="w-full">
                                  <SidebarMenuSubButton
                                    render={<button type="button" />}
                                    data-thread-selection-safe
                                    size="sm"
                                    className="h-6 w-full translate-x-0 justify-start px-2 text-left text-[10px] text-muted-foreground/60 hover:bg-accent hover:text-muted-foreground/80"
                                    onClick={() => {
                                      collapseThreadListForProject(project.id);
                                    }}
                                  >
                                    <span>Show less</span>
                                  </SidebarMenuSubButton>
                                </SidebarMenuSubItem>
                              )}
                            </SidebarMenuSub>
                          </CollapsibleContent>
                        </Collapsible>
                      )}
                    </SortableProjectItem>
                  );
                })}
              </SortableContext>
            </SidebarMenu>
          </DndContext>

          {projects.length === 0 && !shouldShowProjectPathEntry && (
            <div className="px-2 pt-4 text-center text-xs text-muted-foreground/60">
              No projects yet
            </div>
          )}
        </SidebarGroup>
      </SidebarContent>

      <SidebarSeparator />
      <SidebarFooter className="p-2">
        <SidebarMenu>
          <CloseAllWindowsFooterItem />
          <SidebarMenuItem>
              <SidebarMenuButton
                size="sm"
                className="gap-2 px-2 py-1.5 text-muted-foreground/70 hover:bg-accent hover:text-foreground"
                onClick={openSettings}
              >
                <SettingsIcon className="size-3.5" />
                <span className="text-xs">Settings</span>
              </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>

      <DeleteProjectDialog handle={deleteProjectDialogHandle} />
    </>
  );
}
