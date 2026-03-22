import { createFileRoute } from "@tanstack/react-router";

// EditorPanel (canvas workspace) is rendered by the persistent _chat layout so
// it doesn't unmount on route changes. Nothing extra needed here.
export const Route = createFileRoute("/_chat/")({
  component: () => null,
});
