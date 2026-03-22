import { ThreadId } from "@t3tools/contracts";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { useComposerDraftStore } from "../composerDraftStore";
import { useStore } from "../store";
import { SidebarInset } from "~/components/ui/sidebar";
import { useCanvasStore } from "~/components/editor/canvasStore";
import EditorPanel from "../components/editor/EditorPanel";

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
  const ensureChatWindow = useCanvasStore((s) => s.ensureChatWindow);

  // Ensure a chat window exists for this thread
  useEffect(() => {
    if (threadsHydrated && routeThreadExists) {
      ensureChatWindow(threadId);
    }
  }, [threadId, threadsHydrated, routeThreadExists, ensureChatWindow]);

  // Redirect if thread doesn't exist
  useEffect(() => {
    if (!threadsHydrated) return;
    if (!routeThreadExists) {
      void navigate({ to: "/", replace: true });
    }
  }, [navigate, routeThreadExists, threadsHydrated, threadId]);

  return (
    <SidebarInset className="z-[11] h-dvh min-h-0 overflow-hidden overscroll-y-none rounded-l-2xl bg-background text-foreground">
      <EditorPanel mode="sidebar" />
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/$threadId")({
  component: ChatThreadRouteView,
});
