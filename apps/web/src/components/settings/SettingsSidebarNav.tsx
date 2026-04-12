import {
  BotIcon,
  Clock3Icon,
  FlaskConicalIcon,
  FolderCogIcon,
  GitBranchPlusIcon,
  KeyRoundIcon,
  PaletteIcon,
  ShieldIcon,
  SparklesIcon,
} from "lucide-react";

export const SETTINGS_SECTION_ITEMS = [
  { id: "appearance", label: "Appearance", icon: PaletteIcon },
  { id: "providers", label: "Providers", icon: BotIcon },
  { id: "models", label: "Models", icon: SparklesIcon },
  { id: "git", label: "Git", icon: GitBranchPlusIcon },
  { id: "threads", label: "Threads", icon: FolderCogIcon },
  { id: "responses", label: "Responses", icon: Clock3Icon },
  { id: "keybindings", label: "Keybindings", icon: KeyRoundIcon },
  { id: "safety", label: "Safety", icon: ShieldIcon },
  { id: "experimental", label: "Experimental", icon: FlaskConicalIcon },
  { id: "about", label: "About", icon: Clock3Icon },
] as const;

function scrollToSection(id: string) {
  const element = document.getElementById(id);
  if (element) {
    element.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

export function SettingsSidebarNav({ compact = false }: { compact?: boolean }) {
  if (compact) {
    return (
      <nav aria-label="Settings sections" className="flex min-w-max items-center gap-2">
        {SETTINGS_SECTION_ITEMS.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => scrollToSection(item.id)}
              className="inline-flex items-center gap-2 rounded-full border border-border bg-background px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <Icon className="size-3.5 shrink-0" />
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="space-y-3">
        <div className="px-1">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            Settings
          </p>
          <p className="mt-1 text-xs text-muted-foreground">App preferences for this device.</p>
        </div>

        <nav aria-label="Settings sections" className="space-y-1">
          {SETTINGS_SECTION_ITEMS.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => scrollToSection(item.id)}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <Icon className="size-4 shrink-0" />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>
      </div>
    </div>
  );
}
