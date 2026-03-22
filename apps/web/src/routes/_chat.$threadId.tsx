import { ThreadId } from "@t3tools/contracts";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { useComposerDraftStore } from "../composerDraftStore";
import { useStore } from "../store";

function ChatThreadRouteView() {
  const threadsHydrated = useStore((store) => store.threadsHydrated);
  const navigate = useNavigate();
  const threadId = Route.useParams({
    select: (params) => ThreadId.makeUnsafe(params.threadId),
  });
  const threadExists = useStore((store) => store.threads.some((thread) => thread.id === threadId));
  const draftThreadExists = useComposerDraftStore((store) =>
    Object.hasOwn(store.draftThreadsByThreadId, threadId),
  );
  const routeThreadExists = threadExists || draftThreadExists;

  // Chat window creation is handled by EditorPanel (co-located with scope
  // management to avoid race conditions between scope changes and window creation).

  // Redirect if thread doesn't exist
  useEffect(() => {
    if (!threadsHydrated) return;
    if (!routeThreadExists) {
      void navigate({ to: "/", replace: true });
    }
  }, [navigate, routeThreadExists, threadsHydrated, threadId]);

  // EditorPanel is rendered by the persistent _chat layout — nothing to render here.
  return null;
}

export const Route = createFileRoute("/_chat/$threadId")({
  component: ChatThreadRouteView,
});
