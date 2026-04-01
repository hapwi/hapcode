import { create } from "zustand";

interface SettingsDialogState {
  open: boolean;
  openSettings: () => void;
  closeSettings: () => void;
  toggleSettings: () => void;
}

export const useSettingsDialogStore = create<SettingsDialogState>((set) => ({
  open: false,
  openSettings: () => set({ open: true }),
  closeSettings: () => set({ open: false }),
  toggleSettings: () => set((state) => ({ open: !state.open })),
}));
