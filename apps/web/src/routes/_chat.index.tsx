import { createFileRoute } from "@tanstack/react-router";
import EditorPanel from "../components/editor/EditorPanel";

import { SidebarInset } from "~/components/ui/sidebar";

function ChatIndexRouteView() {
  return (
    <SidebarInset className="z-[11] h-dvh min-h-0 overflow-hidden overscroll-y-none rounded-l-2xl bg-background text-foreground">
      <EditorPanel mode="sidebar" />
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/")({
  component: ChatIndexRouteView,
});
