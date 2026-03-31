import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as SqliteClient from "../NodeSqliteClient.ts";
import Migration0020 from "./020_ProjectionThreadsModel.ts";

const layer = it.layer(SqliteClient.layerMemory());

layer("020_ProjectionThreadsModel", (it) => {
  it.effect("adds model and backfills it from legacy selection JSON", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* sql`
        CREATE TABLE projection_threads (
          thread_id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          title TEXT NOT NULL,
          branch TEXT,
          worktree_path TEXT,
          latest_turn_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          deleted_at TEXT,
          runtime_mode TEXT NOT NULL DEFAULT 'full-access',
          interaction_mode TEXT NOT NULL DEFAULT 'default',
          model_selection_json TEXT
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          deleted_at,
          runtime_mode,
          interaction_mode,
          model_selection_json
        )
        VALUES (
          'thread-1',
          'project-1',
          'Legacy Thread',
          NULL,
          NULL,
          NULL,
          '2026-03-07T01:24:09.114Z',
          '2026-03-07T01:24:09.114Z',
          NULL,
          'full-access',
          'default',
          '{"provider":"codex","model":"gpt-5.4"}'
        )
      `;

      yield* Migration0020;

      const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`;
      assert.ok(columns.some((column) => column.name === "model"));

      const rows = yield* sql<{ readonly model: string | null }>`
        SELECT model
        FROM projection_threads
        WHERE thread_id = 'thread-1'
      `;
      assert.equal(rows[0]?.model, "gpt-5.4");
    }),
  );
});
