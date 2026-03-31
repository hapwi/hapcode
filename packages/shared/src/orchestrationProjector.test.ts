import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import {
  EventId,
  ProjectId,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import {
  createEmptyOrchestrationReadModel,
  projectOrchestrationEvent,
} from "./orchestrationProjector";

describe("orchestrationProjector", () => {
  it("applies a created project and thread incrementally", async () => {
    const now = "2026-03-27T00:00:00.000Z";
    const projectId = ProjectId.makeUnsafe("project-1");
    const threadId = ThreadId.makeUnsafe("thread-1");
    const events: OrchestrationEvent[] = [
      {
        eventId: EventId.makeUnsafe("event-1"),
        aggregateKind: "project",
        aggregateId: projectId,
        type: "project.created",
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        payload: {
          projectId,
          title: "Demo",
          workspaceRoot: "/tmp/demo",
          defaultModel: "gpt-5-codex",
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
        occurredAt: now,
        sequence: 1,
      },
      {
        eventId: EventId.makeUnsafe("event-2"),
        aggregateKind: "thread",
        aggregateId: threadId,
        type: "thread.created",
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        payload: {
          threadId,
          projectId,
          title: "Thread",
          model: "gpt-5-codex",
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
        occurredAt: now,
        sequence: 2,
      },
    ];

    let model: OrchestrationReadModel = createEmptyOrchestrationReadModel(now);
    for (const event of events) {
      model = await Effect.runPromise(projectOrchestrationEvent(model, event));
    }

    expect(model.snapshotSequence).toBe(2);
    expect(model.projects).toHaveLength(1);
    expect(model.threads).toHaveLength(1);
    expect(model.threads[0]?.projectId).toBe(projectId);
  });
});
