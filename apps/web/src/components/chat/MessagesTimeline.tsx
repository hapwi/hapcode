import { type MessageId, type TurnId } from "@t3tools/contracts";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  measureElement as measureVirtualElement,
  type VirtualItem,
  useVirtualizer,
} from "@tanstack/react-virtual";
import { deriveTimelineEntries, formatElapsed } from "../../session-logic";
import { AUTO_SCROLL_BOTTOM_THRESHOLD_PX } from "../../chat-scroll";
import { type TurnDiffSummary } from "../../types";
import { summarizeTurnDiffStats } from "../../lib/turnDiffTree";
import ChatMarkdown from "../ChatMarkdown";
import {
  BotIcon,
  ArrowLeftIcon,
  BugIcon,
  CheckIcon,
  CircleAlertIcon,
  CodeIcon,
  EyeIcon,
  FileCodeIcon,
  GlobeIcon,
  HammerIcon,
  LayoutIcon,
  type LucideIcon,
  SearchIcon,
  SparklesIcon,
  SquarePenIcon,
  TerminalIcon,
  Undo2Icon,
  WrenchIcon,
  ZapIcon,
} from "lucide-react";
import { Button } from "../ui/button";
import { clamp } from "effect/Number";
import { estimateTimelineMessageHeight } from "../timelineHeight";
import { buildExpandedImagePreview, ExpandedImagePreview } from "./ExpandedImagePreview";
import { ProposedPlanCard } from "./ProposedPlanCard";
import { ChangedFilesTree } from "./ChangedFilesTree";
import { DiffStatLabel, hasNonZeroStat } from "./DiffStatLabel";
import { MessageCopyButton } from "./MessageCopyButton";
import { computeMessageDurationStart, normalizeCompactToolLabel } from "./MessagesTimeline.logic";
import { TerminalContextInlineChip } from "./TerminalContextInlineChip";
import {
  deriveDisplayedUserMessageState,
  type ParsedTerminalContextEntry,
} from "~/lib/terminalContext";
import { cn } from "~/lib/utils";
import { type TimestampFormat } from "../../appSettings";
import { formatTimestamp } from "../../timestampFormat";
import {
  buildInlineTerminalContextText,
  formatInlineTerminalContextLabel,
  textContainsInlineTerminalContextLabels,
} from "./userMessageTerminalContexts";
import { ThinkingBar } from "../ui/thinking-bar";
import { Steps, StepsTrigger, StepsContent, StepsItem } from "../ui/steps";
import { Reasoning, ReasoningTrigger, ReasoningContent } from "../ui/reasoning";
import { TextShimmer } from "../ui/text-shimmer";

const MAX_VISIBLE_WORK_LOG_ENTRIES = 6;
const ALWAYS_UNVIRTUALIZED_TAIL_ROWS = 8;

/** Labels that are status updates, not real work. Filter them from the work log. */
const NOISE_LABELS = new Set([
  "context window updated",
  "account rate limits updated",
  "checkpoint captured",
  "turn",
  "turn completed",
  "turn complete",
]);

function isNoiseWorkEntry(entry: { label: string; tone: string; detail?: string }): boolean {
  const lower = entry.label.toLowerCase().trim();
  if (NOISE_LABELS.has(lower)) return true;
  // "Turn", "Turn (1)", "Turn completed", "Turn complete" etc.
  if (/^turn(\s*\(\d+\))?(\s+completed?)?$/i.test(entry.label.trim())) return true;
  return false;
}

/** Fun verbs shown while the agent is working. */
const SPINNER_VERBS = [
  "Thinking",
  "Conjuring",
  "Brewing",
  "Crafting",
  "Pondering",
  "Weaving",
  "Tinkering",
  "Composing",
  "Architecting",
  "Orchestrating",
  "Synthesizing",
  "Channeling",
  "Manifesting",
  "Cooking",
  "Calculating",
  "Crunching",
  "Forging",
  "Spinning",
  "Percolating",
  "Noodling",
];

function pickSpinnerVerb(index: number): string {
  return SPINNER_VERBS[((index % SPINNER_VERBS.length) + SPINNER_VERBS.length) % SPINNER_VERBS.length]!;
}

/** Rotates through spinner verbs every `intervalMs` (default 4s). */
function useRotatingVerb(active: boolean, intervalMs = 4000): string {
  const [index, setIndex] = useState(() => Math.floor(Math.random() * SPINNER_VERBS.length));
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => {
      setIndex((prev) => prev + 1);
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [active, intervalMs]);
  return pickSpinnerVerb(index);
}

const SUGGESTION_CATEGORIES = [
  {
    title: "Understand",
    icon: SearchIcon,
    suggestions: [
      "Explain this codebase architecture",
      "Walk me through the data flow",
      "What does this project do?",
    ],
  },
  {
    title: "Build",
    icon: CodeIcon,
    suggestions: [
      "Add a new API endpoint",
      "Create a reusable component",
      "Implement authentication",
    ],
  },
  {
    title: "Fix",
    icon: BugIcon,
    suggestions: [
      "Find and fix bugs in this file",
      "Debug why tests are failing",
      "Fix TypeScript type errors",
    ],
  },
  {
    title: "Improve",
    icon: LayoutIcon,
    suggestions: [
      "Refactor for better readability",
      "Optimize performance",
      "Add tests for uncovered code",
    ],
  },
] as const;

function WelcomeScreen({
  onSendSuggestion,
}: {
  onSendSuggestion?: ((text: string) => void) | undefined;
}) {
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);

  const activeCategory = selectedCategory
    ? SUGGESTION_CATEGORIES.find((c) => c.title === selectedCategory)
    : null;

  return (
    <div className="flex h-full flex-col items-center justify-center px-4">
      <div className="flex flex-col items-center gap-2 mb-8">
        <SparklesIcon className="size-8 text-muted-foreground/20" />
        <p className="text-sm text-muted-foreground/40">
          What would you like to work on?
        </p>
      </div>

      {activeCategory ? (
        /* ---- Expanded: show suggestions for the selected category ---- */
        <div className="w-full max-w-md flex flex-col gap-2">
          <button
            type="button"
            onClick={() => setSelectedCategory(null)}
            className="flex items-center gap-1.5 text-[12px] text-muted-foreground/50 hover:text-foreground transition-colors mb-1 w-fit"
          >
            <ArrowLeftIcon className="size-3.5" />
            <span>Back</span>
          </button>

          <div className="rounded-xl border border-border/50 bg-card/40 p-4">
            <div className="flex items-center gap-2 mb-3">
              <activeCategory.icon className="size-4 text-muted-foreground/60" />
              <span className="text-[12px] font-medium uppercase tracking-wider text-muted-foreground/60">
                {activeCategory.title}
              </span>
            </div>
            <div className="flex flex-col gap-1">
              {activeCategory.suggestions.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  className="w-full rounded-lg px-3 py-2 text-left text-[13px] text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
                  onClick={() => onSendSuggestion?.(suggestion)}
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : (
        /* ---- Collapsed: show 4 category buttons in a 2x2 grid ---- */
        <div className="grid w-full max-w-md grid-cols-2 gap-3">
          {SUGGESTION_CATEGORIES.map((category) => (
            <button
              key={category.title}
              type="button"
              onClick={() => setSelectedCategory(category.title)}
              className="flex items-center gap-3 rounded-xl border border-border/50 bg-card/40 px-4 py-4 text-left transition-colors hover:bg-accent/60 hover:border-border"
            >
              <category.icon className="size-4 text-muted-foreground/50 shrink-0" />
              <span className="text-[13px] font-medium text-muted-foreground/70">
                {category.title}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

interface MessagesTimelineProps {
  hasMessages: boolean;
  isWorking: boolean;
  activeTurnInProgress: boolean;
  activeTurnStartedAt: string | null;
  scrollContainer: HTMLDivElement | null;
  timelineEntries: ReturnType<typeof deriveTimelineEntries>;
  completionDividerBeforeEntryId: string | null;
  completionSummary: string | null;
  turnDiffSummaryByAssistantMessageId: Map<MessageId, TurnDiffSummary>;
  expandedWorkGroups: Record<string, boolean>;
  onToggleWorkGroup: (groupId: string) => void;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  revertTurnCountByUserMessageId: Map<MessageId, number>;
  onRevertUserMessage: (messageId: MessageId) => void;
  isRevertingCheckpoint: boolean;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  markdownCwd: string | undefined;
  resolvedTheme: "light" | "dark";
  timestampFormat: TimestampFormat;
  workspaceRoot: string | undefined;
  onSendSuggestion?: (text: string) => void;
}

export const MessagesTimeline = memo(function MessagesTimeline({
  hasMessages,
  isWorking,
  activeTurnInProgress,
  activeTurnStartedAt,
  scrollContainer,
  timelineEntries,
  completionDividerBeforeEntryId,
  completionSummary,
  turnDiffSummaryByAssistantMessageId,
  expandedWorkGroups,
  onToggleWorkGroup,
  onOpenTurnDiff,
  revertTurnCountByUserMessageId,
  onRevertUserMessage,
  isRevertingCheckpoint,
  onImageExpand,
  markdownCwd,
  resolvedTheme,
  timestampFormat,
  workspaceRoot,
  onSendSuggestion,
}: MessagesTimelineProps) {
  const timelineRootRef = useRef<HTMLDivElement | null>(null);
  const [timelineWidthPx, setTimelineWidthPx] = useState<number | null>(null);

  useLayoutEffect(() => {
    const timelineRoot = timelineRootRef.current;
    if (!timelineRoot) return;

    const updateWidth = (nextWidth: number) => {
      setTimelineWidthPx((previousWidth) => {
        if (previousWidth !== null && Math.abs(previousWidth - nextWidth) < 0.5) {
          return previousWidth;
        }
        return nextWidth;
      });
    };

    updateWidth(timelineRoot.getBoundingClientRect().width);

    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      updateWidth(timelineRoot.getBoundingClientRect().width);
    });
    observer.observe(timelineRoot);
    return () => {
      observer.disconnect();
    };
  }, [hasMessages, isWorking]);

  const rows = useMemo<TimelineRow[]>(() => {
    const nextRows: TimelineRow[] = [];
    const durationStartByMessageId = computeMessageDurationStart(
      timelineEntries.flatMap((entry) => (entry.kind === "message" ? [entry.message] : [])),
    );

    for (let index = 0; index < timelineEntries.length; index += 1) {
      const timelineEntry = timelineEntries[index];
      if (!timelineEntry) {
        continue;
      }

      if (timelineEntry.kind === "work") {
        const rawEntries = [timelineEntry.entry];
        let cursor = index + 1;
        while (cursor < timelineEntries.length) {
          const nextEntry = timelineEntries[cursor];
          if (!nextEntry || nextEntry.kind !== "work") break;
          rawEntries.push(nextEntry.entry);
          cursor += 1;
        }
        const groupedEntries = rawEntries.filter((e) => !isNoiseWorkEntry(e));
        if (groupedEntries.length > 0) {
          nextRows.push({
            kind: "work",
            id: timelineEntry.id,
            createdAt: timelineEntry.createdAt,
            groupedEntries,
          });
        }
        index = cursor - 1;
        continue;
      }

      if (timelineEntry.kind === "proposed-plan") {
        nextRows.push({
          kind: "proposed-plan",
          id: timelineEntry.id,
          createdAt: timelineEntry.createdAt,
          proposedPlan: timelineEntry.proposedPlan,
        });
        continue;
      }

      nextRows.push({
        kind: "message",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        message: timelineEntry.message,
        durationStart:
          durationStartByMessageId.get(timelineEntry.message.id) ?? timelineEntry.message.createdAt,
        showCompletionDivider:
          timelineEntry.message.role === "assistant" &&
          completionDividerBeforeEntryId === timelineEntry.id,
      });
    }

    if (isWorking) {
      // Only show the standalone thinking bar if there are no work entries
      // already visible (the work group trigger shows its own spinner).
      const hasWorkRows = nextRows.some((r) => r.kind === "work");
      if (!hasWorkRows) {
        nextRows.push({
          kind: "working",
          id: "working-indicator-row",
          createdAt: activeTurnStartedAt,
        });
      }
    }

    return nextRows;
  }, [timelineEntries, completionDividerBeforeEntryId, isWorking, activeTurnStartedAt]);

  const firstUnvirtualizedRowIndex = useMemo(() => {
    const firstTailRowIndex = Math.max(rows.length - ALWAYS_UNVIRTUALIZED_TAIL_ROWS, 0);
    if (!activeTurnInProgress) return firstTailRowIndex;

    const turnStartedAtMs =
      typeof activeTurnStartedAt === "string" ? Date.parse(activeTurnStartedAt) : Number.NaN;
    let firstCurrentTurnRowIndex = -1;
    if (!Number.isNaN(turnStartedAtMs)) {
      firstCurrentTurnRowIndex = rows.findIndex((row) => {
        if (row.kind === "working") return true;
        if (!row.createdAt) return false;
        const rowCreatedAtMs = Date.parse(row.createdAt);
        return !Number.isNaN(rowCreatedAtMs) && rowCreatedAtMs >= turnStartedAtMs;
      });
    }

    if (firstCurrentTurnRowIndex < 0) {
      firstCurrentTurnRowIndex = rows.findIndex(
        (row) => row.kind === "message" && row.message.streaming,
      );
    }

    if (firstCurrentTurnRowIndex < 0) return firstTailRowIndex;

    for (let index = firstCurrentTurnRowIndex - 1; index >= 0; index -= 1) {
      const previousRow = rows[index];
      if (!previousRow || previousRow.kind !== "message") continue;
      if (previousRow.message.role === "user") {
        return Math.min(index, firstTailRowIndex);
      }
      if (previousRow.message.role === "assistant" && !previousRow.message.streaming) {
        break;
      }
    }

    return Math.min(firstCurrentTurnRowIndex, firstTailRowIndex);
  }, [activeTurnInProgress, activeTurnStartedAt, rows]);

  const virtualizedRowCount = clamp(firstUnvirtualizedRowIndex, {
    minimum: 0,
    maximum: rows.length,
  });

  const rowVirtualizer = useVirtualizer({
    count: virtualizedRowCount,
    getScrollElement: () => scrollContainer,
    // Use stable row ids so virtual measurements do not leak across thread switches.
    getItemKey: (index: number) => rows[index]?.id ?? index,
    estimateSize: (index: number) => {
      const row = rows[index];
      if (!row) return 96;
      if (row.kind === "work") return 112;
      if (row.kind === "proposed-plan") return estimateTimelineProposedPlanHeight(row.proposedPlan);
      if (row.kind === "working") return 40;
      return estimateTimelineMessageHeight(row.message, { timelineWidthPx });
    },
    measureElement: measureVirtualElement,
    useAnimationFrameWithResizeObserver: true,
    overscan: 8,
  });
  useEffect(() => {
    if (timelineWidthPx === null) return;
    rowVirtualizer.measure();
  }, [rowVirtualizer, timelineWidthPx]);
  useEffect(() => {
    rowVirtualizer.shouldAdjustScrollPositionOnItemSizeChange = (_item, _delta, instance) => {
      const viewportHeight = instance.scrollRect?.height ?? 0;
      const scrollOffset = instance.scrollOffset ?? 0;
      const remainingDistance = instance.getTotalSize() - (scrollOffset + viewportHeight);
      return remainingDistance > AUTO_SCROLL_BOTTOM_THRESHOLD_PX;
    };
    return () => {
      rowVirtualizer.shouldAdjustScrollPositionOnItemSizeChange = undefined;
    };
  }, [rowVirtualizer]);
  const pendingMeasureFrameRef = useRef<number | null>(null);
  const onTimelineImageLoad = useCallback(() => {
    if (pendingMeasureFrameRef.current !== null) return;
    pendingMeasureFrameRef.current = window.requestAnimationFrame(() => {
      pendingMeasureFrameRef.current = null;
      rowVirtualizer.measure();
    });
  }, [rowVirtualizer]);
  useEffect(() => {
    return () => {
      const frame = pendingMeasureFrameRef.current;
      if (frame !== null) {
        window.cancelAnimationFrame(frame);
      }
    };
  }, []);

  const virtualRows = rowVirtualizer.getVirtualItems();
  const nonVirtualizedRows = rows.slice(virtualizedRowCount);
  const [allDirectoriesExpandedByTurnId, setAllDirectoriesExpandedByTurnId] = useState<
    Record<string, boolean>
  >({});
  const onToggleAllDirectories = useCallback((turnId: TurnId) => {
    setAllDirectoriesExpandedByTurnId((current) => ({
      ...current,
      [turnId]: !(current[turnId] ?? true),
    }));
  }, []);

  const renderRowContent = (row: TimelineRow) => (
    <div
      className="pb-4"
      data-timeline-row-kind={row.kind}
      data-message-id={row.kind === "message" ? row.message.id : undefined}
      data-message-role={row.kind === "message" ? row.message.role : undefined}
    >
      {row.kind === "work" &&
        (() => {
          const groupId = row.id;
          const groupedEntries = row.groupedEntries;
          const isExpanded = expandedWorkGroups[groupId] ?? false;
          const hasOverflow = groupedEntries.length > MAX_VISIBLE_WORK_LOG_ENTRIES;
          const visibleEntries =
            hasOverflow && !isExpanded
              ? groupedEntries.slice(-MAX_VISIBLE_WORK_LOG_ENTRIES)
              : groupedEntries;
          const hiddenCount = groupedEntries.length - visibleEntries.length;
          const lastEntry = groupedEntries[groupedEntries.length - 1]!;
          const lastHeading = toolWorkEntryHeading(lastEntry);

          return (
            <Steps defaultOpen={false}>
              <WorkGroupTrigger
                entryCount={groupedEntries.length}
                singleHeading={lastHeading}
                isWorking={isWorking}
              />
              <StepsContent>
                <div className="flex flex-col gap-0.5">
                  {hasOverflow && !isExpanded && (
                    <button
                      type="button"
                      className="mb-1 self-start text-[10px] text-muted-foreground/55 transition-colors duration-150 hover:text-foreground/75"
                      onClick={() => onToggleWorkGroup(groupId)}
                    >
                      Show {hiddenCount} more...
                    </button>
                  )}
                  {visibleEntries.map((workEntry) => (
                    <SimpleWorkEntryRow key={`work-row:${workEntry.id}`} workEntry={workEntry} />
                  ))}
                  {hasOverflow && isExpanded && (
                    <button
                      type="button"
                      className="mt-1 self-start text-[10px] text-muted-foreground/55 transition-colors duration-150 hover:text-foreground/75"
                      onClick={() => onToggleWorkGroup(groupId)}
                    >
                      Show less
                    </button>
                  )}
                </div>
              </StepsContent>
            </Steps>
          );
        })()}

      {row.kind === "message" &&
        row.message.role === "user" &&
        (() => {
          const userImages = row.message.attachments ?? [];
          const displayedUserMessage = deriveDisplayedUserMessageState(row.message.text);
          const terminalContexts = displayedUserMessage.contexts;
          const canRevertAgentWork = revertTurnCountByUserMessageId.has(row.message.id);
          return (
            <div className="flex justify-end">
              <div className="group relative max-w-[80%] rounded-2xl rounded-br-sm border border-border bg-secondary px-4 py-3">
                {userImages.length > 0 && (
                  <div className="mb-2 grid max-w-[420px] grid-cols-2 gap-2">
                    {userImages.map(
                      (image: NonNullable<TimelineMessage["attachments"]>[number]) => (
                        <div
                          key={image.id}
                          className="overflow-hidden rounded-lg border border-border/80 bg-background/70"
                        >
                          {image.previewUrl ? (
                            <button
                              type="button"
                              className="h-full w-full cursor-zoom-in"
                              aria-label={`Preview ${image.name}`}
                              onClick={() => {
                                const preview = buildExpandedImagePreview(userImages, image.id);
                                if (!preview) return;
                                onImageExpand(preview);
                              }}
                            >
                              <img
                                src={image.previewUrl}
                                alt={image.name}
                                className="h-full max-h-[220px] w-full object-cover"
                                onLoad={onTimelineImageLoad}
                                onError={onTimelineImageLoad}
                              />
                            </button>
                          ) : (
                            <div className="flex min-h-[72px] items-center justify-center px-2 py-3 text-center text-[11px] text-muted-foreground/70">
                              {image.name}
                            </div>
                          )}
                        </div>
                      ),
                    )}
                  </div>
                )}
                {(displayedUserMessage.visibleText.trim().length > 0 ||
                  terminalContexts.length > 0) && (
                  <UserMessageBody
                    text={displayedUserMessage.visibleText}
                    terminalContexts={terminalContexts}
                  />
                )}
                <div className="mt-1.5 flex items-center justify-end gap-2">
                  <div className="flex items-center gap-1.5 opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover:opacity-100">
                    {displayedUserMessage.copyText && (
                      <MessageCopyButton text={displayedUserMessage.copyText} />
                    )}
                    {canRevertAgentWork && (
                      <Button
                        type="button"
                        size="xs"
                        variant="outline"
                        disabled={isRevertingCheckpoint || isWorking}
                        onClick={() => onRevertUserMessage(row.message.id)}
                        title="Revert to this message"
                      >
                        <Undo2Icon className="size-3" />
                      </Button>
                    )}
                  </div>
                  <p className="text-right text-[10px] text-muted-foreground/30">
                    {formatTimestamp(row.message.createdAt, timestampFormat)}
                  </p>
                </div>
              </div>
            </div>
          );
        })()}

      {row.kind === "message" &&
        row.message.role === "assistant" &&
        (() => {
          const messageText = row.message.text || (row.message.streaming ? "" : "(empty response)");
          return (
            <>
              {row.showCompletionDivider && (
                <div className="my-2">
                  <span className="h-px block w-full bg-border/40" />
                </div>
              )}
              <div className="group min-w-0 px-1 py-0.5">
                <ChatMarkdown
                  text={messageText}
                  cwd={markdownCwd}
                  isStreaming={Boolean(row.message.streaming)}
                />
                {(() => {
                  const turnSummary = turnDiffSummaryByAssistantMessageId.get(row.message.id);
                  if (!turnSummary) return null;
                  const checkpointFiles = turnSummary.files;
                  if (checkpointFiles.length === 0) return null;
                  const summaryStat = summarizeTurnDiffStats(checkpointFiles);
                  const changedFileCountLabel = String(checkpointFiles.length);
                  const allDirectoriesExpanded =
                    allDirectoriesExpandedByTurnId[turnSummary.turnId] ?? true;
                  return (
                    <div className="mt-2 rounded-lg border border-border/80 bg-card/45 p-2.5">
                      <div className="mb-1.5 flex items-center justify-between gap-2">
                        <p className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground/65">
                          <span>Changed files ({changedFileCountLabel})</span>
                          {hasNonZeroStat(summaryStat) && (
                            <>
                              <span className="mx-1">•</span>
                              <DiffStatLabel
                                additions={summaryStat.additions}
                                deletions={summaryStat.deletions}
                              />
                            </>
                          )}
                        </p>
                        <div className="flex items-center gap-1.5">
                          <Button
                            type="button"
                            size="xs"
                            variant="outline"
                            onClick={() => onToggleAllDirectories(turnSummary.turnId)}
                          >
                            {allDirectoriesExpanded ? "Collapse all" : "Expand all"}
                          </Button>
                          <Button
                            type="button"
                            size="xs"
                            variant="outline"
                            onClick={() =>
                              onOpenTurnDiff(turnSummary.turnId, checkpointFiles[0]?.path)
                            }
                            aria-label="Open files"
                          >
                            <FileCodeIcon className="size-3" />
                          </Button>
                        </div>
                      </div>
                      <ChangedFilesTree
                        key={`changed-files-tree:${turnSummary.turnId}`}
                        turnId={turnSummary.turnId}
                        files={checkpointFiles}
                        allDirectoriesExpanded={allDirectoriesExpanded}
                        resolvedTheme={resolvedTheme}
                        onOpenTurnDiff={onOpenTurnDiff}
                      />
                    </div>
                  );
                })()}
                <div className="mt-1.5 flex items-center justify-between gap-2">
                  <p className="text-[10px] text-muted-foreground/30">
                    {row.message.streaming ? (
                      <LiveElapsedTime
                        durationStart={row.durationStart}
                        createdAt={row.message.createdAt}
                        timestampFormat={timestampFormat}
                      />
                    ) : (
                      formatMessageMeta(
                        row.message.createdAt,
                        formatElapsed(row.durationStart, row.message.completedAt),
                        timestampFormat,
                      )
                    )}
                  </p>
                  {!row.message.streaming && row.message.text && (
                    <div className="flex items-center gap-1 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
                      <MessageCopyButton text={row.message.text} />
                    </div>
                  )}
                </div>
              </div>
            </>
          );
        })()}

      {row.kind === "proposed-plan" && (
        <div className="min-w-0 px-1 py-0.5">
          <ProposedPlanCard
            planMarkdown={row.proposedPlan.planMarkdown}
            cwd={markdownCwd}
            workspaceRoot={workspaceRoot}
          />
        </div>
      )}

      {row.kind === "working" && (
        <div className="py-1 pl-1">
          <ThinkingBar
            text={
              row.createdAt ? (
                <LiveWorkingTimer createdAt={row.createdAt} />
              ) : (
                "Working..."
              )
            }
            className="text-[12px]"
          />
        </div>
      )}
    </div>
  );

  if (!hasMessages && !isWorking) {
    return (
      <WelcomeScreen onSendSuggestion={onSendSuggestion} />
    );
  }

  return (
    <div
      ref={timelineRootRef}
      data-timeline-root="true"
      className="mx-auto w-full min-w-0 max-w-3xl overflow-x-hidden"
    >
      {virtualizedRowCount > 0 && (
        <div className="relative" style={{ height: `${rowVirtualizer.getTotalSize()}px` }}>
          {virtualRows.map((virtualRow: VirtualItem) => {
            const row = rows[virtualRow.index];
            if (!row) return null;

            return (
              <div
                key={`virtual-row:${row.id}`}
                data-index={virtualRow.index}
                ref={rowVirtualizer.measureElement}
                className="absolute left-0 top-0 w-full"
                style={{ transform: `translateY(${virtualRow.start}px)` }}
              >
                {renderRowContent(row)}
              </div>
            );
          })}
        </div>
      )}

      {nonVirtualizedRows.map((row) => (
        <div key={`non-virtual-row:${row.id}`}>{renderRowContent(row)}</div>
      ))}
    </div>
  );
});

type TimelineEntry = ReturnType<typeof deriveTimelineEntries>[number];
type TimelineMessage = Extract<TimelineEntry, { kind: "message" }>["message"];
type TimelineProposedPlan = Extract<TimelineEntry, { kind: "proposed-plan" }>["proposedPlan"];
type TimelineWorkEntry = Extract<TimelineEntry, { kind: "work" }>["entry"];
type TimelineRow =
  | {
      kind: "work";
      id: string;
      createdAt: string;
      groupedEntries: TimelineWorkEntry[];
    }
  | {
      kind: "message";
      id: string;
      createdAt: string;
      message: TimelineMessage;
      durationStart: string;
      showCompletionDivider: boolean;
    }
  | {
      kind: "proposed-plan";
      id: string;
      createdAt: string;
      proposedPlan: TimelineProposedPlan;
    }
  | { kind: "working"; id: string; createdAt: string | null };

function estimateTimelineProposedPlanHeight(proposedPlan: TimelineProposedPlan): number {
  const estimatedLines = Math.max(1, Math.ceil(proposedPlan.planMarkdown.length / 72));
  return 120 + Math.min(estimatedLines * 22, 880);
}

// ---------------------------------------------------------------------------
// Self-updating elapsed time components
//
// These hold their own 1-second timer so the parent tree (ChatView →
// MessagesTimeline) does NOT re-render every second.  Only these tiny
// leaf components update.
// ---------------------------------------------------------------------------

function useElapsedNow(active: boolean): string {
  const [now, setNow] = useState(() => new Date().toISOString());
  useEffect(() => {
    if (!active) return;
    // Immediately sync so the first render is fresh.
    setNow(new Date().toISOString());
    const timer = window.setInterval(() => setNow(new Date().toISOString()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

/** Self-updating "Working for Xs" label. */
function LiveWorkingTimer({ createdAt }: { createdAt: string }) {
  const now = useElapsedNow(true);
  const verb = useRotatingVerb(true);
  const elapsed = formatWorkingTimer(createdAt, now);
  return <>{elapsed ? `${verb} for ${elapsed}` : `${verb}...`}</>;
}

/** Self-updating streaming elapsed time for assistant messages. */
function LiveElapsedTime({
  durationStart,
  createdAt,
  timestampFormat,
}: {
  durationStart: string | undefined;
  createdAt: string;
  timestampFormat: TimestampFormat;
}) {
  const now = useElapsedNow(true);
  const elapsed = durationStart ? formatElapsed(durationStart, now) : null;
  return <>{formatMessageMeta(createdAt, elapsed, timestampFormat)}</>;
}

function formatWorkingTimer(startIso: string, endIso: string): string | null {
  const startedAtMs = Date.parse(startIso);
  const endedAtMs = Date.parse(endIso);
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs)) {
    return null;
  }

  const elapsedSeconds = Math.max(0, Math.floor((endedAtMs - startedAtMs) / 1000));
  if (elapsedSeconds < 60) {
    return `${elapsedSeconds}s`;
  }

  const hours = Math.floor(elapsedSeconds / 3600);
  const minutes = Math.floor((elapsedSeconds % 3600) / 60);
  const seconds = elapsedSeconds % 60;

  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }

  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function formatMessageMeta(
  createdAt: string,
  duration: string | null,
  timestampFormat: TimestampFormat,
): string {
  if (!duration) return formatTimestamp(createdAt, timestampFormat);
  return `${formatTimestamp(createdAt, timestampFormat)} • ${duration}`;
}

const UserMessageTerminalContextInlineLabel = memo(
  function UserMessageTerminalContextInlineLabel(props: { context: ParsedTerminalContextEntry }) {
    const tooltipText =
      props.context.body.length > 0
        ? `${props.context.header}\n${props.context.body}`
        : props.context.header;

    return <TerminalContextInlineChip label={props.context.header} tooltipText={tooltipText} />;
  },
);

const UserMessageBody = memo(function UserMessageBody(props: {
  text: string;
  terminalContexts: ParsedTerminalContextEntry[];
}) {
  if (props.terminalContexts.length > 0) {
    const hasEmbeddedInlineLabels = textContainsInlineTerminalContextLabels(
      props.text,
      props.terminalContexts,
    );
    const inlinePrefix = buildInlineTerminalContextText(props.terminalContexts);
    const inlineNodes: ReactNode[] = [];

    if (hasEmbeddedInlineLabels) {
      let cursor = 0;

      for (const context of props.terminalContexts) {
        const label = formatInlineTerminalContextLabel(context.header);
        const matchIndex = props.text.indexOf(label, cursor);
        if (matchIndex === -1) {
          inlineNodes.length = 0;
          break;
        }
        if (matchIndex > cursor) {
          inlineNodes.push(
            <span key={`user-terminal-context-inline-before:${context.header}:${cursor}`}>
              {props.text.slice(cursor, matchIndex)}
            </span>,
          );
        }
        inlineNodes.push(
          <UserMessageTerminalContextInlineLabel
            key={`user-terminal-context-inline:${context.header}`}
            context={context}
          />,
        );
        cursor = matchIndex + label.length;
      }

      if (inlineNodes.length > 0) {
        if (cursor < props.text.length) {
          inlineNodes.push(
            <span key={`user-message-terminal-context-inline-rest:${cursor}`}>
              {props.text.slice(cursor)}
            </span>,
          );
        }

        return (
          <div className="wrap-break-word whitespace-pre-wrap font-mono text-sm leading-relaxed text-foreground">
            {inlineNodes}
          </div>
        );
      }
    }

    for (const context of props.terminalContexts) {
      inlineNodes.push(
        <UserMessageTerminalContextInlineLabel
          key={`user-terminal-context-inline:${context.header}`}
          context={context}
        />,
      );
      inlineNodes.push(
        <span key={`user-terminal-context-inline-space:${context.header}`} aria-hidden="true">
          {" "}
        </span>,
      );
    }

    if (props.text.length > 0) {
      inlineNodes.push(<span key="user-message-terminal-context-inline-text">{props.text}</span>);
    } else if (inlinePrefix.length === 0) {
      return null;
    }

    return (
      <div className="wrap-break-word whitespace-pre-wrap font-mono text-sm leading-relaxed text-foreground">
        {inlineNodes}
      </div>
    );
  }

  if (props.text.length === 0) {
    return null;
  }

  return (
    <pre className="whitespace-pre-wrap wrap-break-word font-mono text-sm leading-relaxed text-foreground">
      {props.text}
    </pre>
  );
});

function workToneIcon(tone: TimelineWorkEntry["tone"]): {
  icon: LucideIcon;
  className: string;
} {
  if (tone === "error") {
    return {
      icon: CircleAlertIcon,
      className: "text-foreground/92",
    };
  }
  if (tone === "thinking") {
    return {
      icon: BotIcon,
      className: "text-foreground/92",
    };
  }
  if (tone === "info") {
    return {
      icon: CheckIcon,
      className: "text-foreground/92",
    };
  }
  return {
    icon: ZapIcon,
    className: "text-foreground/92",
  };
}

function workToneClass(tone: "thinking" | "tool" | "info" | "error"): string {
  if (tone === "error") return "text-rose-300/50 dark:text-rose-300/50";
  if (tone === "tool") return "text-muted-foreground/70";
  if (tone === "thinking") return "text-muted-foreground/50";
  return "text-muted-foreground/40";
}

function workEntryPreview(
  workEntry: Pick<TimelineWorkEntry, "detail" | "command" | "changedFiles">,
) {
  if (workEntry.command) return workEntry.command;
  if (workEntry.detail) {
    const cleaned = cleanDetailText(workEntry.detail);
    if (cleaned) return cleaned;
  }
  if ((workEntry.changedFiles?.length ?? 0) === 0) return null;
  const [firstPath] = workEntry.changedFiles ?? [];
  if (!firstPath) return null;
  return workEntry.changedFiles!.length === 1
    ? firstPath
    : `${firstPath} +${workEntry.changedFiles!.length - 1} more`;
}

function workEntryIcon(workEntry: TimelineWorkEntry): LucideIcon {
  if (workEntry.requestKind === "command") return TerminalIcon;
  if (workEntry.requestKind === "file-read") return EyeIcon;
  if (workEntry.requestKind === "file-change") return SquarePenIcon;

  if (workEntry.itemType === "command_execution" || workEntry.command) {
    return TerminalIcon;
  }
  if (workEntry.itemType === "file_change" || (workEntry.changedFiles?.length ?? 0) > 0) {
    return SquarePenIcon;
  }
  if (workEntry.itemType === "web_search") return GlobeIcon;
  if (workEntry.itemType === "image_view") return EyeIcon;

  switch (workEntry.itemType) {
    case "mcp_tool_call":
      return WrenchIcon;
    case "dynamic_tool_call":
    case "collab_agent_tool_call":
      return HammerIcon;
  }

  return workToneIcon(workEntry.tone).icon;
}

function capitalizePhrase(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return value;
  }
  return `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`;
}

/** Labels that are too generic — promote the detail or command to the heading instead. */
const GENERIC_LABELS = new Set([
  "reasoning update",
  "subagent task",
  "tool update",
  "tool call",
  "turn",
]);

/** Try to extract a human-readable summary from a detail string that might be JSON. */
function cleanDetailText(detail: string): string | null {
  const trimmed = detail.trim();
  // If it looks like raw JSON or Agent: {json...}, try to extract the description.
  if (trimmed.startsWith("{") || trimmed.startsWith("Agent:")) {
    try {
      const jsonStr = trimmed.startsWith("Agent:")
        ? trimmed.slice(trimmed.indexOf("{"))
        : trimmed;
      const parsed = JSON.parse(jsonStr);
      if (typeof parsed.description === "string" && parsed.description.length > 0) {
        return parsed.description;
      }
      if (typeof parsed.prompt === "string" && parsed.prompt.length > 0) {
        return parsed.prompt.length > 80
          ? `${parsed.prompt.slice(0, 77)}...`
          : parsed.prompt;
      }
    } catch {
      // Not valid JSON, skip
    }
    return null; // Don't show raw JSON as a heading
  }
  return trimmed.length > 0 ? trimmed : null;
}

function toolWorkEntryHeading(workEntry: TimelineWorkEntry): string {
  const rawLabel = workEntry.toolTitle
    ? normalizeCompactToolLabel(workEntry.toolTitle)
    : normalizeCompactToolLabel(workEntry.label);

  // If the label is generic, try to show the actual action from detail/command.
  if (GENERIC_LABELS.has(rawLabel.toLowerCase())) {
    if (workEntry.detail) {
      const cleaned = cleanDetailText(workEntry.detail);
      if (cleaned) return capitalizePhrase(cleaned);
    }
    if (workEntry.command) return capitalizePhrase(workEntry.command);
  }

  return capitalizePhrase(rawLabel);
}

/** When the heading already includes the detail, don't repeat it in preview. */
function workEntryPreviewForDisplay(workEntry: TimelineWorkEntry): string | null {
  const heading = toolWorkEntryHeading(workEntry);
  const preview = workEntryPreview(workEntry);
  // If the heading already IS the detail/command, skip the preview.
  if (preview && heading === capitalizePhrase(preview)) return null;
  return preview;
}

/** Trigger for a work group that shows a rotating shimmer verb while loading. */
const WorkGroupTrigger = memo(function WorkGroupTrigger({
  entryCount,
  singleHeading,
  isWorking,
}: {
  entryCount: number;
  singleHeading: string;
  isWorking: boolean;
}) {
  const verb = useRotatingVerb(isWorking);
  const label =
    entryCount === 1
      ? singleHeading
      : isWorking
        ? `${verb} \u00b7 ${entryCount} steps`
        : `Completed \u00b7 ${entryCount} steps`;

  return (
    <StepsTrigger
      leftIcon={
        isWorking ? (
          <span className="flex size-4 items-center justify-center text-primary">
            <span className="size-3 animate-spin rounded-full border-[1.5px] border-current border-t-transparent" />
          </span>
        ) : (
          <span className="flex size-4 items-center justify-center text-muted-foreground">
            <CheckIcon className="size-3.5" />
          </span>
        )
      }
      className="text-[11px] text-muted-foreground/70"
    >
      {isWorking ? <TextShimmer duration={3}>{label}</TextShimmer> : label}
    </StepsTrigger>
  );
});

const SimpleWorkEntryRow = memo(function SimpleWorkEntryRow(props: {
  workEntry: TimelineWorkEntry;
}) {
  const { workEntry } = props;
  const iconConfig = workToneIcon(workEntry.tone);
  const EntryIcon = workEntryIcon(workEntry);
  const heading = toolWorkEntryHeading(workEntry);
  const preview = workEntryPreviewForDisplay(workEntry);
  const displayText = preview ? `${heading} - ${preview}` : heading;
  const hasChangedFiles = (workEntry.changedFiles?.length ?? 0) > 0;
  const previewIsChangedFiles = hasChangedFiles && !workEntry.command && !workEntry.detail;

  // Use Reasoning component for thinking-tone entries with detail
  if (workEntry.tone === "thinking" && workEntry.detail) {
    return (
      <Reasoning>
        <div className="rounded-lg px-1 py-1">
          <ReasoningTrigger className="text-[11px]">
            <span className="flex items-center gap-2">
              <span className={cn("flex size-4 shrink-0 items-center justify-center", iconConfig.className)}>
                <EntryIcon className="size-3" />
              </span>
              <span className="text-muted-foreground/70">{heading}</span>
            </span>
          </ReasoningTrigger>
          <ReasoningContent className="pl-6 pt-1">
            <p className="text-[11px] leading-relaxed text-muted-foreground/60 whitespace-pre-wrap">
              {workEntry.detail}
            </p>
          </ReasoningContent>
        </div>
      </Reasoning>
    );
  }

  return (
    <div className="rounded-lg px-1 py-1">
      <div className="flex items-center gap-2 transition-[opacity,translate] duration-200">
        <span
          className={cn("flex size-4 shrink-0 items-center justify-center", iconConfig.className)}
        >
          <EntryIcon className="size-3" />
        </span>
        <div className="min-w-0 flex-1 overflow-hidden">
          <p
            className={cn(
              "truncate text-[11px] leading-5",
              workToneClass(workEntry.tone),
              preview ? "text-muted-foreground/70" : "",
            )}
            title={displayText}
          >
            <span className={cn("text-foreground/80", workToneClass(workEntry.tone))}>
              {heading}
            </span>
            {preview && <span className="text-muted-foreground/55"> - {preview}</span>}
          </p>
        </div>
      </div>
      {hasChangedFiles && !previewIsChangedFiles && (
        <div className="mt-1 flex flex-wrap gap-1 pl-6">
          {workEntry.changedFiles?.slice(0, 4).map((filePath) => (
            <span
              key={`${workEntry.id}:${filePath}`}
              className="rounded-md border border-border/55 bg-background/75 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground/75"
              title={filePath}
            >
              {filePath}
            </span>
          ))}
          {(workEntry.changedFiles?.length ?? 0) > 4 && (
            <span className="px-1 text-[10px] text-muted-foreground/55">
              +{(workEntry.changedFiles?.length ?? 0) - 4}
            </span>
          )}
        </div>
      )}
    </div>
  );
});
