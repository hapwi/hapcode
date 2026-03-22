/**
 * Action buttons (OpenInPicker, GitActionsControl, ProjectScriptsControl) for the
 * workspace header bar. Resolves the active project from the canvas scope key
 * (which is persisted) so that buttons show regardless of thread state.
 */

import type {
  EditorId,
  KeybindingCommand,
  ProjectId,
  ProjectScript,
  ResolvedKeybindingsConfig,
  ThreadId,
} from "@t3tools/contracts";
import { ThreadId as ThreadIdSchema } from "@t3tools/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { useCallback } from "react";

import { useStore } from "~/store";
import { serverConfigQueryOptions, serverQueryKeys } from "~/lib/serverReactQuery";
import { readNativeApi } from "~/nativeApi";
import { isElectron } from "~/env";
import { newCommandId, randomUUID } from "~/lib/utils";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import {
  commandForProjectScript,
  nextProjectScriptId,
  projectScriptRuntimeEnv,
} from "~/projectScripts";
import { decodeProjectScriptKeybindingRule } from "~/lib/projectScriptKeybindings";
import { selectThreadTerminalState, useTerminalStateStore } from "~/terminalStateStore";
import { DEFAULT_THREAD_TERMINAL_ID } from "~/types";
import { toastManager } from "../ui/toast";

import { OpenInPicker } from "../chat/OpenInPicker";
import GitActionsControl from "../GitActionsControl";
import ProjectScriptsControl, { type NewProjectScriptInput } from "../ProjectScriptsControl";
import {
  LAST_INVOKED_SCRIPT_BY_PROJECT_KEY,
  LastInvokedScriptByProjectSchema,
} from "../ChatView.logic";
import { useCanvasStore } from "./canvasStore";

const EMPTY_KEYBINDINGS: ResolvedKeybindingsConfig = [];
const EMPTY_AVAILABLE_EDITORS: ReadonlyArray<EditorId> = [];
const SCRIPT_TERMINAL_COLS = 120;
const SCRIPT_TERMINAL_ROWS = 30;

/**
 * Extract a ProjectId from the canvas scope key.
 * Scope keys have the format "project:<projectId>" or "cwd:<path>".
 */
function projectIdFromScopeKey(scopeKey: string): ProjectId | null {
  if (scopeKey.startsWith("project:")) {
    return scopeKey.slice("project:".length) as ProjectId;
  }
  return null;
}

export function WorkspaceActions() {
  const queryClient = useQueryClient();

  // -- Resolve project from canvas scope (always available, even on cold start)
  const scopeKey = useCanvasStore((s) => s.currentScopeKey);
  const scopeProjectId = projectIdFromScopeKey(scopeKey);

  const projects = useStore((s) => s.projects);
  const activeProject = scopeProjectId ? projects.find((p) => p.id === scopeProjectId) : undefined;

  // -- Resolve thread ID (for terminal operations / git) ----------------------
  const routeThreadId = useParams({
    strict: false,
    select: (params) => (params.threadId ? ThreadIdSchema.makeUnsafe(params.threadId) : null),
  });

  const threads = useStore((s) => s.threads);
  const activeThread = routeThreadId ? threads.find((t) => t.id === routeThreadId) : undefined;
  const activeThreadId: ThreadId | null = activeThread?.id ?? routeThreadId;

  const cwd = activeThread?.worktreePath ?? activeProject?.cwd ?? null;
  const gitCwd = cwd;
  const openInCwd = cwd;

  // -- Server config (keybindings, editors) -----------------------------------
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const keybindings = serverConfigQuery.data?.keybindings ?? EMPTY_KEYBINDINGS;
  const availableEditors = serverConfigQuery.data?.availableEditors ?? EMPTY_AVAILABLE_EDITORS;

  // -- Terminal state ---------------------------------------------------------
  const terminalState = useTerminalStateStore((state) =>
    activeThreadId
      ? selectThreadTerminalState(state.terminalStateByThreadId, activeThreadId)
      : null,
  );
  const storeSetTerminalOpen = useTerminalStateStore((s) => s.setTerminalOpen);
  const storeNewTerminal = useTerminalStateStore((s) => s.newTerminal);
  const storeSetActiveTerminal = useTerminalStateStore((s) => s.setActiveTerminal);

  // -- Last invoked script tracking -------------------------------------------
  const [lastInvokedScriptByProjectId, setLastInvokedScriptByProjectId] = useLocalStorage(
    LAST_INVOKED_SCRIPT_BY_PROJECT_KEY,
    {},
    LastInvokedScriptByProjectSchema,
  );

  const preferredScriptId = activeProject
    ? (lastInvokedScriptByProjectId[activeProject.id] ?? null)
    : null;

  // -- Callbacks: project scripts ---------------------------------------------
  const runProjectScript = useCallback(
    async (script: ProjectScript) => {
      const api = readNativeApi();
      if (!api || !activeThreadId || !activeProject || !terminalState) return;

      setLastInvokedScriptByProjectId((current) => {
        if (current[activeProject.id] === script.id) return current;
        return { ...current, [activeProject.id]: script.id };
      });

      const targetCwd = gitCwd ?? activeProject.cwd;
      const baseTerminalId =
        terminalState.activeTerminalId ||
        terminalState.terminalIds[0] ||
        DEFAULT_THREAD_TERMINAL_ID;
      const isBaseTerminalBusy = terminalState.runningTerminalIds.includes(baseTerminalId);
      const shouldCreateNewTerminal = isBaseTerminalBusy;
      const targetTerminalId = shouldCreateNewTerminal
        ? `terminal-${randomUUID()}`
        : baseTerminalId;

      storeSetTerminalOpen(activeThreadId, true);
      if (shouldCreateNewTerminal) {
        storeNewTerminal(activeThreadId, targetTerminalId);
      } else {
        storeSetActiveTerminal(activeThreadId, targetTerminalId);
      }

      const runtimeEnv = projectScriptRuntimeEnv({
        project: { cwd: activeProject.cwd },
        worktreePath: cwd !== activeProject.cwd ? cwd : null,
      });

      const openTerminalInput: Parameters<typeof api.terminal.open>[0] = shouldCreateNewTerminal
        ? {
            threadId: activeThreadId,
            terminalId: targetTerminalId,
            cwd: targetCwd,
            env: runtimeEnv,
            cols: SCRIPT_TERMINAL_COLS,
            rows: SCRIPT_TERMINAL_ROWS,
          }
        : {
            threadId: activeThreadId,
            terminalId: targetTerminalId,
            cwd: targetCwd,
            env: runtimeEnv,
          };

      try {
        await api.terminal.open(openTerminalInput);
        await api.terminal.write({
          threadId: activeThreadId,
          terminalId: targetTerminalId,
          data: `${script.command}\r`,
        });
      } catch {
        // Terminal errors are surfaced via the terminal UI itself
      }
    },
    [
      activeThreadId,
      activeProject,
      gitCwd,
      cwd,
      storeSetTerminalOpen,
      storeNewTerminal,
      storeSetActiveTerminal,
      setLastInvokedScriptByProjectId,
      terminalState,
    ],
  );

  const persistProjectScripts = useCallback(
    async (input: {
      projectId: ProjectId;
      projectCwd: string;
      previousScripts: ProjectScript[];
      nextScripts: ProjectScript[];
      keybinding?: string | null;
      keybindingCommand: KeybindingCommand;
    }) => {
      const api = readNativeApi();
      if (!api) return;

      await api.orchestration.dispatchCommand({
        type: "project.meta.update",
        commandId: newCommandId(),
        projectId: input.projectId,
        scripts: input.nextScripts,
      });

      const keybindingRule = decodeProjectScriptKeybindingRule({
        keybinding: input.keybinding,
        command: input.keybindingCommand,
      });

      if (isElectron && keybindingRule) {
        await api.server.upsertKeybinding(keybindingRule);
        await queryClient.invalidateQueries({ queryKey: serverQueryKeys.all });
      }
    },
    [queryClient],
  );

  const saveProjectScript = useCallback(
    async (input: NewProjectScriptInput) => {
      if (!activeProject) return;
      const nextId = nextProjectScriptId(
        input.name,
        activeProject.scripts.map((script) => script.id),
      );
      const nextScript: ProjectScript = {
        id: nextId,
        name: input.name,
        command: input.command,
        icon: input.icon,
        runOnWorktreeCreate: input.runOnWorktreeCreate,
      };
      const nextScripts = input.runOnWorktreeCreate
        ? [
            ...activeProject.scripts.map((script) =>
              script.runOnWorktreeCreate ? { ...script, runOnWorktreeCreate: false } : script,
            ),
            nextScript,
          ]
        : [...activeProject.scripts, nextScript];

      await persistProjectScripts({
        projectId: activeProject.id,
        projectCwd: activeProject.cwd,
        previousScripts: activeProject.scripts,
        nextScripts,
        keybinding: input.keybinding,
        keybindingCommand: commandForProjectScript(nextId),
      });
    },
    [activeProject, persistProjectScripts],
  );

  const updateProjectScript = useCallback(
    async (scriptId: string, input: NewProjectScriptInput) => {
      if (!activeProject) return;
      const existingScript = activeProject.scripts.find((script) => script.id === scriptId);
      if (!existingScript) throw new Error("Script not found.");

      const updatedScript: ProjectScript = {
        ...existingScript,
        name: input.name,
        command: input.command,
        icon: input.icon,
        runOnWorktreeCreate: input.runOnWorktreeCreate,
      };
      const nextScripts = activeProject.scripts.map((script) =>
        script.id === scriptId
          ? updatedScript
          : input.runOnWorktreeCreate
            ? { ...script, runOnWorktreeCreate: false }
            : script,
      );

      await persistProjectScripts({
        projectId: activeProject.id,
        projectCwd: activeProject.cwd,
        previousScripts: activeProject.scripts,
        nextScripts,
        keybinding: input.keybinding,
        keybindingCommand: commandForProjectScript(scriptId),
      });
    },
    [activeProject, persistProjectScripts],
  );

  const deleteProjectScript = useCallback(
    async (scriptId: string) => {
      if (!activeProject) return;
      const nextScripts = activeProject.scripts.filter((script) => script.id !== scriptId);
      const deletedName = activeProject.scripts.find((s) => s.id === scriptId)?.name;

      try {
        await persistProjectScripts({
          projectId: activeProject.id,
          projectCwd: activeProject.cwd,
          previousScripts: activeProject.scripts,
          nextScripts,
          keybinding: null,
          keybindingCommand: commandForProjectScript(scriptId),
        });
        toastManager.add({
          type: "success",
          title: `Deleted action "${deletedName ?? "Unknown"}"`,
        });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Could not delete action",
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        });
      }
    },
    [activeProject, persistProjectScripts],
  );

  // -- Render -----------------------------------------------------------------
  if (!activeProject) return null;

  return (
    <>
      {activeProject.scripts.length > 0 && (
        <ProjectScriptsControl
          scripts={activeProject.scripts}
          keybindings={keybindings}
          preferredScriptId={preferredScriptId}
          onRunScript={(script) => {
            void runProjectScript(script);
          }}
          onAddScript={saveProjectScript}
          onUpdateScript={updateProjectScript}
          onDeleteScript={deleteProjectScript}
        />
      )}
      <OpenInPicker
        keybindings={keybindings}
        availableEditors={availableEditors}
        openInCwd={openInCwd}
      />
      <GitActionsControl gitCwd={gitCwd} activeThreadId={activeThreadId} />
    </>
  );
}
