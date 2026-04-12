import { useCallback, useState } from "react";
import { type ProjectId, ThreadId } from "@t3tools/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { newCommandId } from "../../lib/utils";
import { readNativeApi } from "../../nativeApi";
import { useStore } from "../../store";
import { useComposerDraftStore } from "../../composerDraftStore";
import { useTerminalStateStore } from "../../terminalStateStore";
import { gitRemoveWorktreeMutationOptions } from "../../lib/gitReactQuery";
import { toastManager } from "../ui/toast";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";

export interface DeleteProjectDialogState {
  projectId: ProjectId;
  projectName: string;
  threadCount: number;
  orphanedWorktrees: Array<{
    threadId: ThreadId;
    path: string;
    displayPath: string;
    cwd: string;
  }>;
}

export interface DeleteProjectDialogHandle {
  deleteProjectDialog: DeleteProjectDialogState | null;
  setDeleteProjectDialog: (state: DeleteProjectDialogState | null) => void;
  deleteProjectWorktrees: boolean;
  setDeleteProjectWorktrees: (value: boolean) => void;
}

export function useDeleteProjectDialogState(): DeleteProjectDialogHandle {
  const [deleteProjectDialog, setDeleteProjectDialog] = useState<DeleteProjectDialogState | null>(
    null,
  );
  const [deleteProjectWorktrees, setDeleteProjectWorktrees] = useState(true);

  return {
    deleteProjectDialog,
    setDeleteProjectDialog,
    deleteProjectWorktrees,
    setDeleteProjectWorktrees,
  };
}

export function DeleteProjectDialog({ handle }: { handle: DeleteProjectDialogHandle }) {
  const {
    deleteProjectDialog,
    setDeleteProjectDialog,
    deleteProjectWorktrees,
    setDeleteProjectWorktrees,
  } = handle;

  const threads = useStore((store) => store.threads);
  const clearComposerDraftForThread = useComposerDraftStore((store) => store.clearThreadDraft);
  const getDraftThreadByProjectId = useComposerDraftStore(
    (store) => store.getDraftThreadByProjectId,
  );
  const clearProjectDraftThreadId = useComposerDraftStore(
    (store) => store.clearProjectDraftThreadId,
  );
  const clearProjectDraftThreadById = useComposerDraftStore(
    (store) => store.clearProjectDraftThreadById,
  );
  const clearTerminalState = useTerminalStateStore((state) => state.clearTerminalState);
  const navigate = useNavigate();
  const routeThreadId = useParams({
    strict: false,
    select: (params) => (params.threadId ? ThreadId.makeUnsafe(params.threadId) : null),
  });
  const queryClient = useQueryClient();
  const removeWorktreeMutation = useMutation(gitRemoveWorktreeMutationOptions({ queryClient }));

  const [isDeletingProject, setIsDeletingProject] = useState(false);

  const executeProjectDeletion = useCallback(
    async (deleteWorktrees: boolean) => {
      if (!deleteProjectDialog) return;
      const api = readNativeApi();
      if (!api) return;

      const { projectId, projectName, orphanedWorktrees } = deleteProjectDialog;
      setIsDeletingProject(true);

      try {
        const projectThreads = threads.filter((thread) => thread.projectId === projectId);

        if (projectThreads.length > 0) {
          const allThreadIds = new Set<ThreadId>(projectThreads.map((t) => t.id));

          // Stop all active sessions in parallel
          await Promise.allSettled(
            projectThreads
              .filter((t) => t.session && t.session.status !== "closed")
              .map((t) =>
                api.orchestration.dispatchCommand({
                  type: "thread.session.stop",
                  commandId: newCommandId(),
                  threadId: t.id,
                  createdAt: new Date().toISOString(),
                }),
              ),
          );

          // Close all terminals in parallel
          await Promise.allSettled(
            projectThreads.map((t) => api.terminal.close({ threadId: t.id, deleteHistory: true })),
          );

          // Dispatch all thread.delete commands in parallel
          await Promise.allSettled(
            projectThreads.map((t) =>
              api.orchestration.dispatchCommand({
                type: "thread.delete",
                commandId: newCommandId(),
                threadId: t.id,
              }),
            ),
          );

          // Clean up client-side state for all threads
          for (const t of projectThreads) {
            clearComposerDraftForThread(t.id);
            clearProjectDraftThreadById(t.projectId, t.id);
            clearTerminalState(t.id);
          }

          // Navigate away if the current thread was deleted
          const shouldNavigateToFallback = routeThreadId && allThreadIds.has(routeThreadId);
          if (shouldNavigateToFallback) {
            const fallbackThreadId =
              threads.find((entry) => !allThreadIds.has(entry.id))?.id ?? null;
            if (fallbackThreadId) {
              void navigate({
                to: "/$threadId",
                params: { threadId: fallbackThreadId },
                replace: true,
              });
            } else {
              void navigate({ to: "/", replace: true });
            }
          }

          // Remove orphaned worktrees in parallel if user opted in
          if (deleteWorktrees && orphanedWorktrees.length > 0) {
            const worktreeResults = await Promise.allSettled(
              orphanedWorktrees.map((w) =>
                removeWorktreeMutation.mutateAsync({
                  cwd: w.cwd,
                  path: w.path,
                  force: true,
                }),
              ),
            );
            const failures = worktreeResults.filter(
              (r): r is PromiseRejectedResult => r.status === "rejected",
            );
            if (failures.length > 0) {
              toastManager.add({
                type: "error",
                title: "Some worktrees could not be removed",
                description: `${failures.length} of ${orphanedWorktrees.length} worktree${orphanedWorktrees.length === 1 ? "" : "s"} failed to delete.`,
              });
            }
          }
        }

        // Clean up project draft
        const projectDraftThread = getDraftThreadByProjectId(projectId);
        if (projectDraftThread) {
          clearComposerDraftForThread(projectDraftThread.threadId);
        }
        clearProjectDraftThreadId(projectId);

        // Delete the project itself
        await api.orchestration.dispatchCommand({
          type: "project.delete",
          commandId: newCommandId(),
          projectId,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error removing project.";
        console.error("Failed to remove project", { projectId, error });
        toastManager.add({
          type: "error",
          title: `Failed to remove "${projectName}"`,
          description: message,
        });
      } finally {
        setIsDeletingProject(false);
        setDeleteProjectDialog(null);
      }
    },
    [
      clearComposerDraftForThread,
      clearProjectDraftThreadById,
      clearProjectDraftThreadId,
      clearTerminalState,
      deleteProjectDialog,
      getDraftThreadByProjectId,
      navigate,
      removeWorktreeMutation,
      routeThreadId,
      threads,
    ],
  );

  return (
    <AlertDialog
      open={deleteProjectDialog !== null}
      onOpenChange={(open) => {
        if (!open && !isDeletingProject) {
          setDeleteProjectDialog(null);
        }
      }}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Remove project &ldquo;{deleteProjectDialog?.projectName}&rdquo;?
          </AlertDialogTitle>
          <AlertDialogDescription>
            {deleteProjectDialog && deleteProjectDialog.threadCount > 0
              ? `This will permanently delete ${deleteProjectDialog.threadCount === 1 ? "1 thread" : `all ${deleteProjectDialog.threadCount} threads`} and their history.`
              : "This project has no threads."}
          </AlertDialogDescription>
          {deleteProjectDialog && deleteProjectDialog.orphanedWorktrees.length > 0 && (
            <div className="mt-2 flex flex-col gap-2">
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <Checkbox
                  checked={deleteProjectWorktrees}
                  onCheckedChange={(checked) => setDeleteProjectWorktrees(checked === true)}
                />
                <span>
                  Also delete{" "}
                  {deleteProjectDialog.orphanedWorktrees.length === 1
                    ? "1 orphaned worktree"
                    : `${deleteProjectDialog.orphanedWorktrees.length} orphaned worktrees`}
                </span>
              </label>
              <ul className="flex flex-col gap-0.5 pl-7 text-xs text-muted-foreground">
                {deleteProjectDialog.orphanedWorktrees.map((w) => (
                  <li key={w.path} className="truncate">
                    {w.displayPath}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />} disabled={isDeletingProject}>
            Cancel
          </AlertDialogClose>
          <Button
            variant="destructive"
            disabled={isDeletingProject}
            onClick={() => void executeProjectDeletion(deleteProjectWorktrees)}
          >
            {isDeletingProject ? "Removing..." : "Remove project"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
