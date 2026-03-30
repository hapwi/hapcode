import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

type TableInfoRow = {
  readonly name: string;
};

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = yield* sql<TableInfoRow>`PRAGMA table_info(projection_threads)`;
  const columnNames = new Set(columns.map((column) => column.name));

  if (!columnNames.has("model")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN model TEXT
    `;
  }

  if (!columnNames.has("model_selection_json")) {
    return;
  }

  yield* sql`
    UPDATE projection_threads
    SET model = COALESCE(
      model,
      CASE
        WHEN json_valid(model_selection_json)
          THEN json_extract(model_selection_json, '$.model')
        ELSE NULL
      END
    )
    WHERE model IS NULL
      AND model_selection_json IS NOT NULL
  `;
});
