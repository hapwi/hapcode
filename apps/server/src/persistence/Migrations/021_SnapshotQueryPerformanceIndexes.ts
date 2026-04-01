import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Partial index for pending turn lookups
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_turns_pending
    ON projection_turns(thread_id, requested_at DESC)
    WHERE turn_id IS NULL AND state = 'pending' AND checkpoint_turn_count IS NULL
  `;

  // Index for latest-turn snapshot query
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_turns_latest_by_thread
    ON projection_turns(thread_id, requested_at DESC, turn_id DESC)
    WHERE turn_id IS NOT NULL
  `;

  // Index for threads ordered by created_at for snapshot query
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_created
    ON projection_threads(created_at ASC, thread_id ASC)
  `;

  // Index for proposed plans ordered by thread for snapshot bulk load
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_proposed_plans_thread
    ON projection_thread_proposed_plans(thread_id ASC, created_at ASC, plan_id ASC)
  `;
});
