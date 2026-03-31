import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as SqliteClient from "../NodeSqliteClient.ts";
import Migration0019 from "./019_ProjectionProjectsDefaultModel.ts";

const layer = it.layer(SqliteClient.layerMemory());

layer("019_ProjectionProjectsDefaultModel", (it) => {
  it.effect("adds default_model and backfills it from legacy selection JSON", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* sql`
        CREATE TABLE projection_projects (
          project_id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          workspace_root TEXT NOT NULL,
          scripts_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          deleted_at TEXT,
          default_model_selection_json TEXT
        )
      `;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          scripts_json,
          created_at,
          updated_at,
          deleted_at,
          default_model_selection_json
        )
        VALUES (
          'project-1',
          'Legacy Project',
          '/tmp/legacy-project',
          '[]',
          '2026-03-07T00:58:38.334Z',
          '2026-03-07T00:58:38.334Z',
          NULL,
          '{"provider":"codex","model":"gpt-5.4"}'
        )
      `;

      yield* Migration0019;

      const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_projects)`;
      assert.ok(columns.some((column) => column.name === "default_model"));

      const rows = yield* sql<{ readonly defaultModel: string | null }>`
        SELECT default_model AS "defaultModel"
        FROM projection_projects
        WHERE project_id = 'project-1'
      `;
      assert.equal(rows[0]?.defaultModel, "gpt-5.4");
    }),
  );
});
