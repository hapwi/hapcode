import type { OrchestrationEvent, OrchestrationReadModel } from "@t3tools/contracts";
import {
  SharedOrchestrationProjectorDecodeError,
  createEmptyOrchestrationReadModel,
  projectOrchestrationEvent,
} from "@t3tools/shared/orchestrationProjector";
import { Effect } from "effect";

import { OrchestrationProjectorDecodeError } from "./Errors";

function toServerProjectorDecodeError(
  error: SharedOrchestrationProjectorDecodeError,
): OrchestrationProjectorDecodeError {
  return new OrchestrationProjectorDecodeError({
    eventType: error.eventType,
    issue: error.issue,
    cause: error.cause,
  });
}

export function createEmptyReadModel(nowIso: string): OrchestrationReadModel {
  return createEmptyOrchestrationReadModel(nowIso);
}

export function projectEvent(
  model: OrchestrationReadModel,
  event: OrchestrationEvent,
): Effect.Effect<OrchestrationReadModel, OrchestrationProjectorDecodeError> {
  return projectOrchestrationEvent(model, event).pipe(
    Effect.mapError(toServerProjectorDecodeError),
  );
}
