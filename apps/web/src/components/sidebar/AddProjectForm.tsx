import { FolderIcon } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { DEFAULT_MODEL_BY_PROVIDER } from "@t3tools/contracts";
import { isNonEmpty as isNonEmptyString } from "effect/String";
import { isElectron } from "../../env";
import { isLinuxPlatform, newCommandId, newProjectId } from "../../lib/utils";
import { readNativeApi } from "../../nativeApi";
import { useHandleNewThread } from "../../hooks/useHandleNewThread";
import { toastManager } from "../ui/toast";
import { sortThreadsForSidebar } from "../Sidebar.logic";
import type { Project, Thread } from "../../types";
import type { SidebarNewThreadEnvMode } from "../Sidebar.logic";
import type { SidebarThreadSortOrder } from "../../appSettings";
import { useNavigate } from "@tanstack/react-router";

interface AddProjectFormProps {
  projects: readonly Project[];
  threads: readonly Thread[];
  defaultThreadEnvMode: SidebarNewThreadEnvMode;
  sidebarThreadSortOrder: SidebarThreadSortOrder;
}

export function AddProjectForm({
  projects,
  threads,
  defaultThreadEnvMode,
  sidebarThreadSortOrder,
}: AddProjectFormProps) {
  const [addingProject, setAddingProject] = useState(false);
  const [newCwd, setNewCwd] = useState("");
  const [isPickingFolder, setIsPickingFolder] = useState(false);
  const [isAddingProject, setIsAddingProject] = useState(false);
  const [addProjectError, setAddProjectError] = useState<string | null>(null);
  const addProjectInputRef = useRef<HTMLInputElement | null>(null);
  const navigate = useNavigate();
  const { handleNewThread } = useHandleNewThread();

  const isLinuxDesktop = isElectron && isLinuxPlatform(navigator.platform);
  const shouldBrowseForProjectImmediately = isElectron && !isLinuxDesktop;
  const shouldShowProjectPathEntry = addingProject && !shouldBrowseForProjectImmediately;

  const focusMostRecentThreadForProject = useCallback(
    (projectId: string) => {
      const latestThread = sortThreadsForSidebar(
        threads.filter((thread) => thread.projectId === projectId),
        sidebarThreadSortOrder,
      )[0];
      if (!latestThread) return;

      void navigate({
        to: "/$threadId",
        params: { threadId: latestThread.id },
      });
    },
    [sidebarThreadSortOrder, navigate, threads],
  );

  const addProjectFromPath = useCallback(
    async (rawCwd: string) => {
      const cwd = rawCwd.trim();
      if (!cwd || isAddingProject) return;
      const api = readNativeApi();
      if (!api) return;

      setIsAddingProject(true);
      const finishAddingProject = () => {
        setIsAddingProject(false);
        setNewCwd("");
        setAddProjectError(null);
        setAddingProject(false);
      };

      const existing = projects.find((project) => project.cwd === cwd);
      if (existing) {
        focusMostRecentThreadForProject(existing.id);
        finishAddingProject();
        return;
      }

      const projectId = newProjectId();
      const createdAt = new Date().toISOString();
      const title = cwd.split(/[/\\]/).findLast(isNonEmptyString) ?? cwd;
      try {
        await api.orchestration.dispatchCommand({
          type: "project.create",
          commandId: newCommandId(),
          projectId,
          title,
          workspaceRoot: cwd,
          defaultModel: DEFAULT_MODEL_BY_PROVIDER.codex,
          createdAt,
        });
        await handleNewThread(projectId, {
          envMode: defaultThreadEnvMode,
        }).catch(() => undefined);
      } catch (error) {
        const description =
          error instanceof Error ? error.message : "An error occurred while adding the project.";
        setIsAddingProject(false);
        if (shouldBrowseForProjectImmediately) {
          toastManager.add({
            type: "error",
            title: "Failed to add project",
            description,
          });
        } else {
          setAddProjectError(description);
        }
        return;
      }
      finishAddingProject();
    },
    [
      focusMostRecentThreadForProject,
      handleNewThread,
      isAddingProject,
      projects,
      shouldBrowseForProjectImmediately,
      defaultThreadEnvMode,
    ],
  );

  const handleAddProject = () => {
    void addProjectFromPath(newCwd);
  };

  const canAddProject = newCwd.trim().length > 0 && !isAddingProject;

  const handlePickFolder = async () => {
    const api = readNativeApi();
    if (!api || isPickingFolder) return;
    setIsPickingFolder(true);
    let pickedPath: string | null = null;
    try {
      pickedPath = await api.dialogs.pickFolder();
    } catch {
      // Ignore picker failures and leave the current thread selection unchanged.
    }
    if (pickedPath) {
      await addProjectFromPath(pickedPath);
    } else if (!shouldBrowseForProjectImmediately) {
      addProjectInputRef.current?.focus();
    }
    setIsPickingFolder(false);
  };

  const handleStartAddProject = useCallback(() => {
    setAddProjectError(null);
    if (shouldBrowseForProjectImmediately) {
      void handlePickFolder();
      return;
    }
    setAddingProject((prev) => !prev);
  }, [shouldBrowseForProjectImmediately]);

  return {
    shouldShowProjectPathEntry,
    handleStartAddProject,
    addProjectFormJsx: shouldShowProjectPathEntry ? (
      <div className="mb-2 px-1">
        {isElectron && (
          <button
            type="button"
            className="mb-1.5 flex w-full items-center justify-center gap-2 rounded-md border border-border bg-secondary py-1.5 text-xs text-foreground/80 transition-colors duration-150 hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
            onClick={() => void handlePickFolder()}
            disabled={isPickingFolder || isAddingProject}
          >
            <FolderIcon className="size-3.5" />
            {isPickingFolder ? "Picking folder..." : "Browse for folder"}
          </button>
        )}
        <div className="flex gap-1.5">
          <input
            ref={addProjectInputRef}
            className={`min-w-0 flex-1 rounded-md border bg-secondary px-2 py-1 font-mono text-xs text-foreground placeholder:text-muted-foreground/40 focus:outline-none ${
              addProjectError
                ? "border-red-500/70 focus:border-red-500"
                : "border-border focus:border-ring"
            }`}
            placeholder="/path/to/project"
            value={newCwd}
            onChange={(event) => {
              setNewCwd(event.target.value);
              setAddProjectError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") handleAddProject();
              if (event.key === "Escape") {
                setAddingProject(false);
                setAddProjectError(null);
              }
            }}
            autoFocus
          />
          <button
            type="button"
            className="shrink-0 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground transition-colors duration-150 hover:bg-primary/90 disabled:opacity-60"
            onClick={handleAddProject}
            disabled={!canAddProject}
          >
            {isAddingProject ? "Adding..." : "Add"}
          </button>
        </div>
        {addProjectError && (
          <p className="mt-1 px-0.5 text-[11px] leading-tight text-red-400">
            {addProjectError}
          </p>
        )}
        <div className="mt-1.5 px-0.5">
          <button
            type="button"
            className="text-[11px] text-muted-foreground/50 transition-colors hover:text-muted-foreground"
            onClick={() => {
              setAddingProject(false);
              setAddProjectError(null);
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    ) : null,
  };
}
