import { createFileRoute, redirect } from "@tanstack/react-router";

// Settings is now rendered as a dialog overlay, not a route.
// Redirect any direct navigation to the root.
export const Route = createFileRoute("/_chat/settings")({
  beforeLoad: () => {
    throw redirect({ to: "/" });
  },
});
