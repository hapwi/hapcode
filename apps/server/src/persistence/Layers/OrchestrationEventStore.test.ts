import { CommandId, EventId, MessageId, ProjectId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Schema, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { PersistenceDecodeError } from "../Errors.ts";
import { OrchestrationEventStore } from "../Services/OrchestrationEventStore.ts";
import { OrchestrationEventStoreLive } from "./OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  OrchestrationEventStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("OrchestrationEventStore", (it) => {
  it.effect("stores json columns as strings and replays decoded events", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = new Date().toISOString();

      const appended = yield* eventStore.append({
        type: "project.created",
        eventId: EventId.makeUnsafe("evt-store-roundtrip"),
        aggregateKind: "project",
        aggregateId: ProjectId.makeUnsafe("project-roundtrip"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-store-roundtrip"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-store-roundtrip"),
        metadata: {
          adapterKey: "codex",
        },
        payload: {
          projectId: ProjectId.makeUnsafe("project-roundtrip"),
          title: "Roundtrip Project",
          workspaceRoot: "/tmp/project-roundtrip",
          defaultModel: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      const storedRows = yield* sql<{
        readonly payloadJson: string;
        readonly metadataJson: string;
      }>`
        SELECT
          payload_json AS "payloadJson",
          metadata_json AS "metadataJson"
        FROM orchestration_events
        WHERE event_id = ${appended.eventId}
      `;
      assert.equal(storedRows.length, 1);
      assert.equal(typeof storedRows[0]?.payloadJson, "string");
      assert.equal(typeof storedRows[0]?.metadataJson, "string");

      const replayed = yield* Stream.runCollect(eventStore.readFromSequence(0, 10)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      );
      assert.equal(replayed.length, 1);
      assert.equal(replayed[0]?.type, "project.created");
      assert.equal(replayed[0]?.metadata.adapterKey, "codex");
    }),
  );

  it.effect("fails with PersistenceDecodeError when stored json is invalid", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = new Date().toISOString();

      yield* sql`
        INSERT INTO orchestration_events (
          event_id,
          aggregate_kind,
          stream_id,
          stream_version,
          event_type,
          occurred_at,
          command_id,
          causation_event_id,
          correlation_id,
          actor_kind,
          payload_json,
          metadata_json
        )
        VALUES (
          ${EventId.makeUnsafe("evt-store-invalid-json")},
          ${"project"},
          ${ProjectId.makeUnsafe("project-invalid-json")},
          ${0},
          ${"project.created"},
          ${now},
          ${CommandId.makeUnsafe("cmd-store-invalid-json")},
          ${null},
          ${null},
          ${"server"},
          ${"{"},
          ${"{}"}
        )
      `;

      const replayResult = yield* Effect.result(
        Stream.runCollect(eventStore.readFromSequence(0, 10)),
      );
      assert.equal(replayResult._tag, "Failure");
      if (replayResult._tag === "Failure") {
        assert.ok(Schema.is(PersistenceDecodeError)(replayResult.failure));
        assert.ok(
          replayResult.failure.operation.includes(
            "OrchestrationEventStore.readFromSequence:decodeRows",
          ),
        );
      }
    }),
  );

  it.effect("replays legacy project.created rows with defaultModelSelection", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = new Date().toISOString();
      const baselineRows = yield* sql<{ readonly maxSequence: number | null }>`
        SELECT MAX(sequence) AS "maxSequence" FROM orchestration_events
      `;
      const baselineSequence = baselineRows[0]?.maxSequence ?? 0;

      yield* sql`
        INSERT INTO orchestration_events (
          event_id,
          aggregate_kind,
          stream_id,
          stream_version,
          event_type,
          occurred_at,
          command_id,
          causation_event_id,
          correlation_id,
          actor_kind,
          payload_json,
          metadata_json
        )
        VALUES (
          ${EventId.makeUnsafe("evt-store-legacy-project-default-model-selection")},
          ${"project"},
          ${ProjectId.makeUnsafe("project-legacy-default-model-selection")},
          ${0},
          ${"project.created"},
          ${now},
          ${CommandId.makeUnsafe("cmd-store-legacy-project-default-model-selection")},
          ${null},
          ${null},
          ${"server"},
          ${JSON.stringify({
            projectId: ProjectId.makeUnsafe("project-legacy-default-model-selection"),
            title: "Legacy Project",
            workspaceRoot: "/tmp/legacy-project",
            scripts: [],
            createdAt: now,
            updatedAt: now,
            defaultModelSelection: {
              provider: "codex",
              model: "gpt-5.4",
            },
          })},
          ${"{}"}
        )
      `;

      const replayed = yield* Stream.runCollect(
        eventStore.readFromSequence(baselineSequence, 10),
      ).pipe(Effect.map((chunk) => Array.from(chunk)));
      assert.equal(replayed.length, 1);
      const event = replayed[0];
      assert.ok(event);
      if (event.type !== "project.created") {
        assert.fail(`Expected project.created event, received ${event.type}`);
      }
      assert.equal(event.payload.defaultModel, "gpt-5.4");
    }),
  );

  it.effect("replays legacy thread.created rows with modelSelection", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = new Date().toISOString();
      const baselineRows = yield* sql<{ readonly maxSequence: number | null }>`
        SELECT MAX(sequence) AS "maxSequence" FROM orchestration_events
      `;
      const baselineSequence = baselineRows[0]?.maxSequence ?? 0;

      yield* sql`
        INSERT INTO orchestration_events (
          event_id,
          aggregate_kind,
          stream_id,
          stream_version,
          event_type,
          occurred_at,
          command_id,
          causation_event_id,
          correlation_id,
          actor_kind,
          payload_json,
          metadata_json
        )
        VALUES (
          ${EventId.makeUnsafe("evt-store-legacy-thread-model-selection")},
          ${"thread"},
          ${ThreadId.makeUnsafe("thread-legacy-model-selection")},
          ${0},
          ${"thread.created"},
          ${now},
          ${CommandId.makeUnsafe("cmd-store-legacy-thread-model-selection")},
          ${null},
          ${null},
          ${"server"},
          ${JSON.stringify({
            threadId: ThreadId.makeUnsafe("thread-legacy-model-selection"),
            projectId: ProjectId.makeUnsafe("project-legacy-default-model-selection"),
            title: "Legacy Thread",
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: now,
            updatedAt: now,
            modelSelection: {
              provider: "codex",
              model: "gpt-5.4",
            },
          })},
          ${"{}"}
        )
      `;

      const replayed = yield* Stream.runCollect(
        eventStore.readFromSequence(baselineSequence, 10),
      ).pipe(Effect.map((chunk) => Array.from(chunk)));
      assert.equal(replayed.length, 1);
      const event = replayed[0];
      assert.ok(event);
      if (event.type !== "thread.created") {
        assert.fail(`Expected thread.created event, received ${event.type}`);
      }
      assert.equal(event.payload.model, "gpt-5.4");
    }),
  );

  it.effect("replays legacy thread.turn-start-requested rows with modelSelection", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = new Date().toISOString();
      const baselineRows = yield* sql<{ readonly maxSequence: number | null }>`
        SELECT MAX(sequence) AS "maxSequence" FROM orchestration_events
      `;
      const baselineSequence = baselineRows[0]?.maxSequence ?? 0;

      yield* sql`
        INSERT INTO orchestration_events (
          event_id,
          aggregate_kind,
          stream_id,
          stream_version,
          event_type,
          occurred_at,
          command_id,
          causation_event_id,
          correlation_id,
          actor_kind,
          payload_json,
          metadata_json
        )
        VALUES (
          ${EventId.makeUnsafe("evt-store-legacy-turn-start-model-selection")},
          ${"thread"},
          ${ThreadId.makeUnsafe("thread-legacy-turn-start-model-selection")},
          ${0},
          ${"thread.turn-start-requested"},
          ${now},
          ${CommandId.makeUnsafe("cmd-store-legacy-turn-start-model-selection")},
          ${null},
          ${null},
          ${"server"},
          ${JSON.stringify({
            threadId: ThreadId.makeUnsafe("thread-legacy-turn-start-model-selection"),
            messageId: MessageId.makeUnsafe("message-legacy-turn-start-model-selection"),
            assistantDeliveryMode: "buffered",
            runtimeMode: "full-access",
            interactionMode: "default",
            createdAt: now,
            modelSelection: {
              provider: "codex",
              model: "gpt-5.4",
              options: {
                reasoningEffort: "high",
              },
            },
          })},
          ${"{}"}
        )
      `;

      const replayed = yield* Stream.runCollect(
        eventStore.readFromSequence(baselineSequence, 10),
      ).pipe(Effect.map((chunk) => Array.from(chunk)));
      assert.equal(replayed.length, 1);
      const event = replayed[0];
      assert.ok(event);
      if (event.type !== "thread.turn-start-requested") {
        assert.fail(`Expected thread.turn-start-requested event, received ${event.type}`);
      }
      assert.equal(event.payload.provider, "codex");
      assert.equal(event.payload.model, "gpt-5.4");
      assert.equal(event.payload.modelOptions?.codex?.reasoningEffort, "high");
    }),
  );
});
