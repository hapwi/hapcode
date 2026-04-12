import { XIcon } from "lucide-react";

import { Button } from "../ui/button";
import { Dialog, DialogBackdrop, DialogPortal, DialogViewport } from "../ui/dialog";
import { GeneralSettingsPanel, SettingsRestoreButton } from "./SettingsPanels";
import { SettingsSidebarNav } from "./SettingsSidebarNav";
import { useSettingsDialogStore } from "./settingsDialogStore";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";

export function SettingsDialog() {
  const open = useSettingsDialogStore((s) => s.open);
  const closeSettings = useSettingsDialogStore((s) => s.closeSettings);

  return (
    <Dialog open={open} onOpenChange={(open) => !open && closeSettings()}>
      <DialogPortal>
        <DialogBackdrop />
        <DialogViewport className="fixed inset-0 z-50 flex items-start justify-center p-8 pt-[5vh]">
          <DialogPrimitive.Popup
            className="relative flex h-[min(85vh,900px)] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border bg-popover text-popover-foreground shadow-lg/5 transition-[scale,opacity] duration-200 ease-in-out data-ending-style:scale-98 data-ending-style:opacity-0 data-starting-style:scale-98 data-starting-style:opacity-0"
            data-slot="dialog-popup"
          >
            {/* Header */}
            <div className="flex shrink-0 items-center justify-between border-b border-border px-6 py-4">
              <div>
                <h1 className="text-lg font-semibold tracking-tight text-foreground">Settings</h1>
                <p className="text-sm text-muted-foreground">
                  Configure app-level preferences for this device.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <SettingsRestoreButton />
                <DialogPrimitive.Close
                  aria-label="Close"
                  render={<Button size="icon" variant="ghost" />}
                >
                  <XIcon />
                </DialogPrimitive.Close>
              </div>
            </div>

            {/* Body */}
            <div className="flex min-h-0 flex-1">
              <aside className="hidden w-56 shrink-0 overflow-y-auto border-r border-border/80 bg-card/30 p-4 lg:block">
                <SettingsSidebarNav />
              </aside>
              <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                <div className="shrink-0 border-b border-border/60 px-4 py-3 lg:hidden">
                  <div className="overflow-x-auto">
                    <SettingsSidebarNav compact />
                  </div>
                </div>
                <GeneralSettingsPanel />
              </div>
            </div>
          </DialogPrimitive.Popup>
        </DialogViewport>
      </DialogPortal>
    </Dialog>
  );
}
