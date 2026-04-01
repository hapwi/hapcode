import { useMemo } from "react";
import type {
  MessageId,
  OrchestrationThreadActivity,
  ProviderInteractionMode,
} from "@t3tools/contracts";
import {
  deriveThreadActivityState,
  deriveTimelineEntries,
  findLatestProposedPlan,
  hasActionableProposedPlan,
  isLatestTurnSettled,
  formatElapsed,
  type ActivePlanState,
  type DerivedThreadActivityState,
  type LatestProposedPlanState,
  type PendingApproval,
  type PendingUserInput,
  type TimelineEntry,
  type WorkLogEntry,
} from "../../session-logic";
import { deriveLatestContextWindowSnapshot, type ContextWindowSnapshot } from "../../lib/contextWindow";
import { useTurnDiffSummaries } from "../../hooks/useTurnDiffSummaries";
import type { ChatMessage, ProposedPlan, Thread, TurnDiffSummary } from "../../types";

const EMPTY_ACTIVITIES: OrchestrationThreadActivity[] = [];

export interface UseThreadDerivedStateInput {
  activeThread: Thread | undefined;
  sourceProposedPlan: ProposedPlan | undefined;
  interactionMode: ProviderInteractionMode;
  optimisticUserMessages: ChatMessage[];
  attachmentPreviewHandoffByMessageId: Record<string, string[]>;
}

export interface UseThreadDerivedStateResult {
  derivedActivityState: DerivedThreadActivityState;
  activeContextWindow: ContextWindowSnapshot | null;
  workLogEntries: WorkLogEntry[];
  latestTurnHasToolActivity: boolean;
  pendingApprovals: PendingApproval[];
  pendingUserInputs: PendingUserInput[];
  activeProposedPlan: LatestProposedPlanState | null;
  sidebarProposedPlan: LatestProposedPlanState | null;
  activePlan: ActivePlanState | null;
  showPlanFollowUpPrompt: boolean;
  isComposerApprovalState: boolean;
  hasComposerHeader: boolean;
  timelineEntries: TimelineEntry[];
  turnDiffSummaryByAssistantMessageId: Map<MessageId, TurnDiffSummary>;
  revertTurnCountByUserMessageId: Map<MessageId, number>;
  completionSummary: string | null;
  completionDividerBeforeEntryId: string | null;
  latestTurnSettled: boolean;
  activePendingApproval: PendingApproval | null;
  timelineMessages: ChatMessage[];
  turnDiffSummaries: TurnDiffSummary[];
  inferredCheckpointTurnCountByTurnId: Record<string, number>;
}

export function useThreadDerivedState(
  input: UseThreadDerivedStateInput,
): UseThreadDerivedStateResult {
  const {
    activeThread,
    sourceProposedPlan,
    interactionMode,
    optimisticUserMessages,
    attachmentPreviewHandoffByMessageId,
  } = input;

  const activeLatestTurn = activeThread?.latestTurn ?? null;
  const latestTurnSettled = isLatestTurnSettled(activeLatestTurn, activeThread?.session ?? null);

  const threadActivities = activeThread?.activities ?? EMPTY_ACTIVITIES;
  const derivedActivityState = useMemo(
    () => deriveThreadActivityState(threadActivities, activeLatestTurn?.turnId),
    [activeLatestTurn?.turnId, threadActivities],
  );
  const activeContextWindow = useMemo(
    () => deriveLatestContextWindowSnapshot(threadActivities),
    [threadActivities],
  );
  const workLogEntries = derivedActivityState.workLogEntries;
  const latestTurnHasToolActivity = derivedActivityState.latestTurnHasToolActivity;
  const pendingApprovals = derivedActivityState.pendingApprovals;
  const pendingUserInputs = derivedActivityState.pendingUserInputs;

  const activeProposedPlan = useMemo(() => {
    if (!latestTurnSettled) {
      return null;
    }
    return findLatestProposedPlan(
      activeThread?.proposedPlans ?? [],
      activeLatestTurn?.turnId ?? null,
    );
  }, [activeLatestTurn?.turnId, activeThread?.proposedPlans, latestTurnSettled]);
  const sidebarProposedPlan = useMemo(
    () =>
      !latestTurnSettled && sourceProposedPlan
        ? {
            id: sourceProposedPlan.id,
            createdAt: sourceProposedPlan.createdAt,
            updatedAt: sourceProposedPlan.updatedAt,
            turnId: sourceProposedPlan.turnId,
            planMarkdown: sourceProposedPlan.planMarkdown,
            implementedAt: sourceProposedPlan.implementedAt,
            implementationThreadId: sourceProposedPlan.implementationThreadId,
          }
        : findLatestProposedPlan(
            activeThread?.proposedPlans ?? [],
            activeLatestTurn?.turnId ?? null,
          ),
    [activeLatestTurn?.turnId, activeThread?.proposedPlans, latestTurnSettled, sourceProposedPlan],
  );
  const activePlan = derivedActivityState.activePlan;
  const showPlanFollowUpPrompt =
    pendingUserInputs.length === 0 &&
    interactionMode === "plan" &&
    latestTurnSettled &&
    hasActionableProposedPlan(activeProposedPlan);
  const activePendingApproval = pendingApprovals[0] ?? null;
  const isComposerApprovalState = activePendingApproval !== null;
  const hasComposerHeader =
    isComposerApprovalState ||
    pendingUserInputs.length > 0 ||
    (showPlanFollowUpPrompt && activeProposedPlan !== null);
  const serverMessages = activeThread?.messages;
  const timelineMessages = useMemo(() => {
    const messages = serverMessages ?? [];
    const serverMessagesWithPreviewHandoff =
      Object.keys(attachmentPreviewHandoffByMessageId).length === 0
        ? messages
        : // Spread only fires for the few messages that actually changed;
          // unchanged ones early-return their original reference.
          // In-place mutation would break React's immutable state contract.
          // oxlint-disable-next-line no-map-spread
          messages.map((message) => {
            if (
              message.role !== "user" ||
              !message.attachments ||
              message.attachments.length === 0
            ) {
              return message;
            }
            const handoffPreviewUrls = attachmentPreviewHandoffByMessageId[message.id];
            if (!handoffPreviewUrls || handoffPreviewUrls.length === 0) {
              return message;
            }

            let changed = false;
            let imageIndex = 0;
            const attachments = message.attachments.map((attachment) => {
              if (attachment.type !== "image") {
                return attachment;
              }
              const handoffPreviewUrl = handoffPreviewUrls[imageIndex];
              imageIndex += 1;
              if (!handoffPreviewUrl || attachment.previewUrl === handoffPreviewUrl) {
                return attachment;
              }
              changed = true;
              return {
                ...attachment,
                previewUrl: handoffPreviewUrl,
              };
            });

            return changed ? { ...message, attachments } : message;
          });

    if (optimisticUserMessages.length === 0) {
      return serverMessagesWithPreviewHandoff;
    }
    const serverIds = new Set(serverMessagesWithPreviewHandoff.map((message) => message.id));
    const pendingMessages = optimisticUserMessages.filter((message) => !serverIds.has(message.id));
    if (pendingMessages.length === 0) {
      return serverMessagesWithPreviewHandoff;
    }
    return [...serverMessagesWithPreviewHandoff, ...pendingMessages];
  }, [serverMessages, attachmentPreviewHandoffByMessageId, optimisticUserMessages]);
  const timelineEntries = useMemo(
    () =>
      deriveTimelineEntries(timelineMessages, activeThread?.proposedPlans ?? [], workLogEntries),
    [activeThread?.proposedPlans, timelineMessages, workLogEntries],
  );
  const { turnDiffSummaries, inferredCheckpointTurnCountByTurnId } =
    useTurnDiffSummaries(activeThread);
  const turnDiffSummaryByAssistantMessageId = useMemo(() => {
    const byMessageId = new Map<MessageId, TurnDiffSummary>();
    for (const summary of turnDiffSummaries) {
      if (!summary.assistantMessageId) continue;
      byMessageId.set(summary.assistantMessageId, summary);
    }
    return byMessageId;
  }, [turnDiffSummaries]);
  const revertTurnCountByUserMessageId = useMemo(() => {
    const byUserMessageId = new Map<MessageId, number>();
    for (let index = 0; index < timelineEntries.length; index += 1) {
      const entry = timelineEntries[index];
      if (!entry || entry.kind !== "message" || entry.message.role !== "user") {
        continue;
      }

      for (let nextIndex = index + 1; nextIndex < timelineEntries.length; nextIndex += 1) {
        const nextEntry = timelineEntries[nextIndex];
        if (!nextEntry || nextEntry.kind !== "message") {
          continue;
        }
        if (nextEntry.message.role === "user") {
          break;
        }
        const summary = turnDiffSummaryByAssistantMessageId.get(nextEntry.message.id);
        if (!summary) {
          continue;
        }
        const turnCount =
          summary.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[summary.turnId];
        if (typeof turnCount !== "number") {
          break;
        }
        byUserMessageId.set(entry.message.id, Math.max(0, turnCount - 1));
        break;
      }
    }

    return byUserMessageId;
  }, [inferredCheckpointTurnCountByTurnId, timelineEntries, turnDiffSummaryByAssistantMessageId]);

  const completionSummary = useMemo(() => {
    if (!latestTurnSettled) return null;
    if (!activeLatestTurn?.startedAt) return null;
    if (!activeLatestTurn.completedAt) return null;
    if (!latestTurnHasToolActivity) return null;

    const elapsed = formatElapsed(activeLatestTurn.startedAt, activeLatestTurn.completedAt);
    return elapsed ? `Worked for ${elapsed}` : null;
  }, [
    activeLatestTurn?.completedAt,
    activeLatestTurn?.startedAt,
    latestTurnHasToolActivity,
    latestTurnSettled,
  ]);
  const completionDividerBeforeEntryId = useMemo(() => {
    if (!latestTurnSettled) return null;
    if (!activeLatestTurn?.startedAt) return null;
    if (!activeLatestTurn.completedAt) return null;
    if (!completionSummary) return null;

    const turnStartedAt = Date.parse(activeLatestTurn.startedAt);
    const turnCompletedAt = Date.parse(activeLatestTurn.completedAt);
    if (Number.isNaN(turnStartedAt)) return null;
    if (Number.isNaN(turnCompletedAt)) return null;

    let inRangeMatch: string | null = null;
    let fallbackMatch: string | null = null;
    for (const timelineEntry of timelineEntries) {
      if (timelineEntry.kind !== "message") continue;
      if (timelineEntry.message.role !== "assistant") continue;
      const messageAt = Date.parse(timelineEntry.message.createdAt);
      if (Number.isNaN(messageAt) || messageAt < turnStartedAt) continue;
      fallbackMatch = timelineEntry.id;
      if (messageAt <= turnCompletedAt) {
        inRangeMatch = timelineEntry.id;
      }
    }
    return inRangeMatch ?? fallbackMatch;
  }, [
    activeLatestTurn?.completedAt,
    activeLatestTurn?.startedAt,
    completionSummary,
    latestTurnSettled,
    timelineEntries,
  ]);

  return {
    derivedActivityState,
    activeContextWindow,
    workLogEntries,
    latestTurnHasToolActivity,
    pendingApprovals,
    pendingUserInputs,
    activeProposedPlan,
    sidebarProposedPlan,
    activePlan,
    showPlanFollowUpPrompt,
    isComposerApprovalState,
    hasComposerHeader,
    timelineEntries,
    turnDiffSummaryByAssistantMessageId,
    revertTurnCountByUserMessageId,
    completionSummary,
    completionDividerBeforeEntryId,
    latestTurnSettled,
    activePendingApproval,
    timelineMessages,
    turnDiffSummaries,
    inferredCheckpointTurnCountByTurnId,
  };
}
