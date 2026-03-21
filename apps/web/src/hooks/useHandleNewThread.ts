import { DEFAULT_RUNTIME_MODE, type ProjectId, ThreadId } from "@t3tools/contracts";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useCallback } from "react";
import { inferProviderForModel } from "@t3tools/shared/model";
import {
  type DraftThreadEnvMode,
  type DraftThreadState,
  useComposerDraftStore,
} from "../composerDraftStore";
import { newThreadId } from "../lib/utils";
import { useStore } from "../store";

export function useHandleNewThread() {
  const projects = useStore((store) => store.projects);
  const threads = useStore((store) => store.threads);
  const stickyModel = useComposerDraftStore((store) => store.stickyModel);
  const stickyModelOptions = useComposerDraftStore((store) => store.stickyModelOptions);
  const navigate = useNavigate();
  const routeThreadId = useParams({
    strict: false,
    select: (params) => (params.threadId ? ThreadId.makeUnsafe(params.threadId) : null),
  });
  const activeDraftThread = useComposerDraftStore((store) =>
    routeThreadId ? (store.draftThreadsByThreadId[routeThreadId] ?? null) : null,
  );
  const activeComposerDraftModel = useComposerDraftStore((store) =>
    routeThreadId ? (store.draftsByThreadId[routeThreadId]?.model ?? null) : null,
  );

  const activeThread = routeThreadId
    ? threads.find((thread) => thread.id === routeThreadId)
    : undefined;
  const activeProject = projects.find(
    (project) => project.id === (activeDraftThread?.projectId ?? activeThread?.projectId),
  );

  const handleNewThread = useCallback(
    (
      projectId: ProjectId,
      options?: {
        branch?: string | null;
        worktreePath?: string | null;
        envMode?: DraftThreadEnvMode;
      },
    ): Promise<void> => {
      const {
        clearProjectDraftThreadId,
        getDraftThread,
        getDraftThreadByProjectId,
        setModel,
        setModelOptions,
        setProvider,
        setDraftThreadContext,
        setProjectDraftThreadId,
      } = useComposerDraftStore.getState();
      const hasBranchOption = options?.branch !== undefined;
      const hasWorktreePathOption = options?.worktreePath !== undefined;
      const hasEnvModeOption = options?.envMode !== undefined;
      const storedDraftThread = getDraftThreadByProjectId(projectId);
      const latestActiveDraftThread: DraftThreadState | null = routeThreadId
        ? getDraftThread(routeThreadId)
        : null;
      if (storedDraftThread) {
        return (async () => {
          if (hasBranchOption || hasWorktreePathOption || hasEnvModeOption) {
            setDraftThreadContext(storedDraftThread.threadId, {
              ...(hasBranchOption ? { branch: options?.branch ?? null } : {}),
              ...(hasWorktreePathOption ? { worktreePath: options?.worktreePath ?? null } : {}),
              ...(hasEnvModeOption ? { envMode: options?.envMode } : {}),
            });
          }
          setProjectDraftThreadId(projectId, storedDraftThread.threadId);
          if (routeThreadId === storedDraftThread.threadId) {
            return;
          }
          await navigate({
            to: "/$threadId",
            params: { threadId: storedDraftThread.threadId },
          });
        })();
      }

      clearProjectDraftThreadId(projectId);

      if (
        latestActiveDraftThread &&
        routeThreadId &&
        latestActiveDraftThread.projectId === projectId
      ) {
        if (hasBranchOption || hasWorktreePathOption || hasEnvModeOption) {
          setDraftThreadContext(routeThreadId, {
            ...(hasBranchOption ? { branch: options?.branch ?? null } : {}),
            ...(hasWorktreePathOption ? { worktreePath: options?.worktreePath ?? null } : {}),
            ...(hasEnvModeOption ? { envMode: options?.envMode } : {}),
          });
        }
        setProjectDraftThreadId(projectId, routeThreadId);
        return Promise.resolve();
      }

      const threadId = newThreadId();
      const createdAt = new Date().toISOString();
      const initialModel = stickyModel ?? activeComposerDraftModel ?? activeThread?.model ?? null;
      return (async () => {
        setProjectDraftThreadId(projectId, threadId, {
          createdAt,
          branch: options?.branch ?? null,
          worktreePath: options?.worktreePath ?? null,
          envMode: options?.envMode ?? "local",
          runtimeMode: DEFAULT_RUNTIME_MODE,
        });
        if (initialModel) {
          setProvider(threadId, inferProviderForModel(initialModel));
          setModel(threadId, initialModel);
        } else if (activeProject) {
          setProvider(threadId, inferProviderForModel(activeProject.model));
          setModel(threadId, activeProject.model);
        }
        if (Object.keys(stickyModelOptions).length > 0) {
          setModelOptions(threadId, stickyModelOptions);
        }

        await navigate({
          to: "/$threadId",
          params: { threadId },
        });
      })();
    },
    [
      activeComposerDraftModel,
      activeProject,
      activeThread?.model,
      navigate,
      routeThreadId,
      stickyModel,
      stickyModelOptions,
    ],
  );

  return {
    activeDraftThread,
    activeThread,
    handleNewThread,
    projects,
    routeThreadId,
  };
}
