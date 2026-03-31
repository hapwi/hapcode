import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

type TableInfoRow = {
  readonly name: string;
};

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = yield* sql<TableInfoRow>`PRAGMA table_info(projection_projects)`;
  const columnNames = new Set(columns.map((column) => column.name));

  if (!columnNames.has("default_model")) {
    yield* sql`
      ALTER TABLE projection_projects
      ADD COLUMN default_model TEXT
    `;
  }

  if (!columnNames.has("default_model_selection_json")) {
    return;
  }

  yield* sql`
    UPDATE projection_projects
    SET default_model = COALESCE(
      default_model,
      CASE
        WHEN json_valid(default_model_selection_json)
          THEN json_extract(default_model_selection_json, '$.model')
        ELSE NULL
      END
    )
    WHERE default_model IS NULL
      AND default_model_selection_json IS NOT NULL
  `;
});
