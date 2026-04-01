import { createFileRoute } from "@tanstack/react-router";

import { GeneralSettingsPanel, SettingsRestoreButton } from "../components/settings/SettingsPanels";
import { SettingsSidebarNav } from "../components/settings/SettingsSidebarNav";
import { isElectron } from "../env";
import { SidebarInset } from "~/components/ui/sidebar";

function SettingsRouteView() {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none rounded-l-2xl bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        {isElectron && (
          <div className="drag-region flex h-[52px] shrink-0 items-center border-b border-border px-5">
            <span className="text-xs font-medium tracking-wide text-muted-foreground/70">
              Settings
            </span>
            <div className="ms-auto">
              <SettingsRestoreButton />
            </div>
          </div>
        )}

        {!isElectron && (
          <header className="border-b border-border px-4 py-3 sm:px-6">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h1 className="text-lg font-semibold tracking-tight text-foreground">Settings</h1>
                <p className="text-sm text-muted-foreground">
                  Configure app-level preferences for this device.
                </p>
              </div>
              <SettingsRestoreButton />
            </div>
          </header>
        )}

        <div className="min-h-0 flex flex-1">
          <aside className="hidden w-64 shrink-0 border-r border-border/80 bg-card/30 p-4 lg:block">
            <div className="sticky top-4">
              <SettingsSidebarNav />
            </div>
          </aside>
          <div className="min-w-0 flex-1">
            {!isElectron && (
              <div className="border-b border-border/60 px-4 py-3 lg:hidden">
                <div className="overflow-x-auto">
                  <SettingsSidebarNav compact showBackButton={false} />
                </div>
              </div>
            )}
            <GeneralSettingsPanel />
          </div>
        </div>
      </div>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/settings")({
  component: SettingsRouteView,
});
