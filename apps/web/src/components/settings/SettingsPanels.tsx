import { RotateCcwIcon } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useCallback, useMemo, useState } from "react";
import { type ProviderKind, DEFAULT_GIT_TEXT_GENERATION_MODEL } from "@t3tools/contracts";
import { getModelOptions, normalizeModelSlug } from "@t3tools/shared/model";

import { APP_VERSION } from "../../branding";
import {
  getAppModelOptions,
  getCustomModelsForProvider,
  getDefaultCustomModelsForProvider,
  MAX_CUSTOM_MODEL_LENGTH,
  MODEL_PROVIDER_SETTINGS,
  patchCustomModels,
  useAppSettings,
} from "../../appSettings";
import { resolveAndPersistPreferredEditor } from "../../editorPreferences";
import { useTheme } from "../../hooks/useTheme";
import { serverConfigQueryOptions } from "../../lib/serverReactQuery";
import { ensureNativeApi } from "../../nativeApi";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";

const THEME_OPTIONS = [
  {
    value: "system",
    label: "System",
    description: "Match your OS appearance setting.",
  },
  {
    value: "light",
    label: "Light",
    description: "Always use the light theme.",
  },
  {
    value: "dark",
    label: "Dark",
    description: "Always use the dark theme.",
  },
] as const;

const TIMESTAMP_FORMAT_LABELS = {
  locale: "System default",
  "12-hour": "12-hour",
  "24-hour": "24-hour",
} as const;

function SettingsSection({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-24 space-y-3">
      <div className="space-y-1">
        <h2 className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
          {title}
        </h2>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      <div className="overflow-hidden rounded-2xl border bg-card text-card-foreground shadow-xs/5">
        {children}
      </div>
    </section>
  );
}

function SettingsRow({
  title,
  description,
  control,
  footer,
}: {
  title: string;
  description: ReactNode;
  control: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="border-t border-border px-4 py-4 first:border-t-0 sm:px-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 flex-1 space-y-1">
          <h3 className="text-sm font-medium text-foreground">{title}</h3>
          <div className="text-xs text-muted-foreground">{description}</div>
        </div>
        <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
          {control}
        </div>
      </div>
      {footer ? <div className="pt-3">{footer}</div> : null}
    </div>
  );
}

export function useSettingsRestore() {
  const { theme, setTheme } = useTheme();
  const { settings, resetSettings, defaults } = useAppSettings();

  const changedSettingLabels = useMemo(
    () => [
      ...(theme !== "system" ? ["Theme"] : []),
      ...(settings.timestampFormat !== defaults.timestampFormat ? ["Time format"] : []),
      ...(settings.codexBinaryPath !== defaults.codexBinaryPath ? ["Codex binary path"] : []),
      ...(settings.codexHomePath !== defaults.codexHomePath ? ["CODEX_HOME path"] : []),
      ...(settings.defaultThreadEnvMode !== defaults.defaultThreadEnvMode
        ? ["New thread mode"]
        : []),
      ...(settings.enableAssistantStreaming !== defaults.enableAssistantStreaming
        ? ["Assistant streaming"]
        : []),
      ...(settings.confirmThreadDelete !== defaults.confirmThreadDelete
        ? ["Delete confirmation"]
        : []),
      ...(settings.textGenerationModel !== defaults.textGenerationModel
        ? ["Git writing model"]
        : []),
      ...(settings.customCodexModels.join("\n") !== defaults.customCodexModels.join("\n")
        ? ["Codex custom models"]
        : []),
      ...(settings.customClaudeModels.join("\n") !== defaults.customClaudeModels.join("\n")
        ? ["Claude custom models"]
        : []),
    ],
    [defaults, settings, theme],
  );

  const restoreDefaults = useCallback(async () => {
    if (changedSettingLabels.length === 0) return;
    const confirmed = await ensureNativeApi().dialogs.confirm(
      ["Restore default settings?", `This will reset: ${changedSettingLabels.join(", ")}.`].join(
        "\n",
      ),
    );
    if (!confirmed) return;
    setTheme("system");
    resetSettings();
  }, [changedSettingLabels, resetSettings, setTheme]);

  return {
    changedSettingLabels,
    restoreDefaults,
  };
}

export function GeneralSettingsPanel() {
  const { theme, setTheme, resolvedTheme } = useTheme();
  const { settings, defaults, updateSettings } = useAppSettings();
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const [isOpeningKeybindings, setIsOpeningKeybindings] = useState(false);
  const [openKeybindingsError, setOpenKeybindingsError] = useState<string | null>(null);
  const [customModelInputByProvider, setCustomModelInputByProvider] = useState<
    Record<ProviderKind, string>
  >({
    codex: "",
    claudeAgent: "",
  });
  const [customModelErrorByProvider, setCustomModelErrorByProvider] = useState<
    Partial<Record<ProviderKind, string | null>>
  >({});

  const codexBinaryPath = settings.codexBinaryPath;
  const codexHomePath = settings.codexHomePath;
  const keybindingsConfigPath = serverConfigQuery.data?.keybindingsConfigPath ?? null;
  const availableEditors = serverConfigQuery.data?.availableEditors;

  const gitTextGenerationModelOptions = getAppModelOptions(
    "codex",
    settings.customCodexModels,
    settings.textGenerationModel,
  );
  const selectedGitTextGenerationModelLabel =
    gitTextGenerationModelOptions.find(
      (option) =>
        option.slug === (settings.textGenerationModel ?? DEFAULT_GIT_TEXT_GENERATION_MODEL),
    )?.name ?? settings.textGenerationModel;

  const openKeybindingsFile = useCallback(() => {
    if (!keybindingsConfigPath) return;
    setOpenKeybindingsError(null);
    setIsOpeningKeybindings(true);
    const editor = resolveAndPersistPreferredEditor(availableEditors ?? []);
    if (!editor) {
      setOpenKeybindingsError("No available editors found.");
      setIsOpeningKeybindings(false);
      return;
    }
    void ensureNativeApi()
      .shell.openInEditor(keybindingsConfigPath, editor)
      .catch((error) => {
        setOpenKeybindingsError(
          error instanceof Error ? error.message : "Unable to open keybindings file.",
        );
      })
      .finally(() => {
        setIsOpeningKeybindings(false);
      });
  }, [availableEditors, keybindingsConfigPath]);

  const addCustomModel = useCallback(
    (provider: ProviderKind) => {
      const customModelInput = customModelInputByProvider[provider];
      const customModels = getCustomModelsForProvider(settings, provider);
      const normalized = normalizeModelSlug(customModelInput, provider);
      if (!normalized) {
        setCustomModelErrorByProvider((existing) => ({
          ...existing,
          [provider]: "Enter a model slug.",
        }));
        return;
      }
      if (getModelOptions(provider).some((option) => option.slug === normalized)) {
        setCustomModelErrorByProvider((existing) => ({
          ...existing,
          [provider]: "That model is already built in.",
        }));
        return;
      }
      if (normalized.length > MAX_CUSTOM_MODEL_LENGTH) {
        setCustomModelErrorByProvider((existing) => ({
          ...existing,
          [provider]: `Model slugs must be ${MAX_CUSTOM_MODEL_LENGTH} characters or less.`,
        }));
        return;
      }
      if (customModels.includes(normalized)) {
        setCustomModelErrorByProvider((existing) => ({
          ...existing,
          [provider]: "That custom model is already saved.",
        }));
        return;
      }

      updateSettings(patchCustomModels(provider, [...customModels, normalized]));
      setCustomModelInputByProvider((existing) => ({
        ...existing,
        [provider]: "",
      }));
      setCustomModelErrorByProvider((existing) => ({
        ...existing,
        [provider]: null,
      }));
    },
    [customModelInputByProvider, settings, updateSettings],
  );

  const removeCustomModel = useCallback(
    (provider: ProviderKind, slug: string) => {
      const customModels = getCustomModelsForProvider(settings, provider);
      updateSettings(
        patchCustomModels(
          provider,
          customModels.filter((model) => model !== slug),
        ),
      );
      setCustomModelErrorByProvider((existing) => ({
        ...existing,
        [provider]: null,
      }));
    },
    [settings, updateSettings],
  );

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
        <SettingsSection
          id="appearance"
          title="General"
          description="Core look-and-feel preferences for this device."
        >
          <SettingsRow
            title="Theme"
            description={
              <>
                Choose how the app looks across the workspace.
                <div className="pt-1">
                  Active theme: <span className="font-medium text-foreground">{resolvedTheme}</span>
                </div>
              </>
            }
            control={
              <Select
                value={theme}
                onValueChange={(value) => {
                  if (value === "system" || value === "light" || value === "dark") {
                    setTheme(value);
                  }
                }}
              >
                <SelectTrigger className="w-full sm:w-40" aria-label="Theme preference">
                  <SelectValue>
                    {THEME_OPTIONS.find((option) => option.value === theme)?.label ?? "System"}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end">
                  {THEME_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
            footer={
              <div className="grid gap-2 sm:grid-cols-3">
                {THEME_OPTIONS.map((option) => {
                  const selected = theme === option.value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      className={`rounded-xl border px-3 py-3 text-left transition-colors ${
                        selected
                          ? "border-primary/60 bg-primary/8 text-foreground"
                          : "border-border bg-background text-muted-foreground hover:bg-accent"
                      }`}
                      onClick={() => setTheme(option.value)}
                    >
                      <div className="text-sm font-medium">{option.label}</div>
                      <div className="mt-1 text-xs">{option.description}</div>
                    </button>
                  );
                })}
              </div>
            }
          />

          <SettingsRow
            title="Timestamp format"
            description="System default follows your browser or OS time format. 12-hour and 24-hour force the hour cycle."
            control={
              <Select
                value={settings.timestampFormat}
                onValueChange={(value) => {
                  if (value !== "locale" && value !== "12-hour" && value !== "24-hour") return;
                  updateSettings({
                    timestampFormat: value,
                  });
                }}
              >
                <SelectTrigger className="w-full sm:w-40" aria-label="Timestamp format">
                  <SelectValue>{TIMESTAMP_FORMAT_LABELS[settings.timestampFormat]}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end">
                  <SelectItem value="locale">{TIMESTAMP_FORMAT_LABELS.locale}</SelectItem>
                  <SelectItem value="12-hour">{TIMESTAMP_FORMAT_LABELS["12-hour"]}</SelectItem>
                  <SelectItem value="24-hour">{TIMESTAMP_FORMAT_LABELS["24-hour"]}</SelectItem>
                </SelectPopup>
              </Select>
            }
          />
        </SettingsSection>

        <SettingsSection
          id="providers"
          title="Providers"
          description="Overrides for the local agent binaries this app should launch."
        >
          <SettingsRow
            title="Codex binary path"
            description={
              <>
                Leave blank to use <code>codex</code> from your PATH.
              </>
            }
            control={
              <Input
                value={codexBinaryPath}
                onChange={(event) => updateSettings({ codexBinaryPath: event.target.value })}
                placeholder="codex"
                spellCheck={false}
                className="sm:w-72"
              />
            }
          />
          <SettingsRow
            title="CODEX_HOME path"
            description="Optional custom Codex home/config directory."
            control={
              <Input
                value={codexHomePath}
                onChange={(event) => updateSettings({ codexHomePath: event.target.value })}
                placeholder="/Users/you/.codex"
                spellCheck={false}
                className="sm:w-72"
              />
            }
            footer={
              <div className="flex flex-col gap-3 rounded-xl border border-border bg-background/70 px-3 py-3 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0 flex-1">
                  <p>Binary source</p>
                  <p className="mt-1 break-all font-mono text-[11px] text-foreground">
                    {codexBinaryPath || "PATH"}
                  </p>
                </div>
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() =>
                    updateSettings({
                      codexBinaryPath: defaults.codexBinaryPath,
                      codexHomePath: defaults.codexHomePath,
                    })
                  }
                >
                  Reset codex overrides
                </Button>
              </div>
            }
          />
        </SettingsSection>

        <SettingsSection
          id="models"
          title="Models"
          description="Save additional provider model slugs so they appear in pickers and slash-command suggestions."
        >
          {MODEL_PROVIDER_SETTINGS.map((providerSettings) => {
            const provider = providerSettings.provider;
            const customModels = getCustomModelsForProvider(settings, provider);
            const customModelInput = customModelInputByProvider[provider];
            const customModelError = customModelErrorByProvider[provider] ?? null;
            return (
              <SettingsRow
                key={provider}
                title={`${providerSettings.title} custom models`}
                description={providerSettings.description}
                control={
                  <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
                    <Input
                      value={customModelInput}
                      onChange={(event) => {
                        const value = event.target.value;
                        setCustomModelInputByProvider((existing) => ({
                          ...existing,
                          [provider]: value,
                        }));
                        if (customModelError) {
                          setCustomModelErrorByProvider((existing) => ({
                            ...existing,
                            [provider]: null,
                          }));
                        }
                      }}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter") return;
                        event.preventDefault();
                        addCustomModel(provider);
                      }}
                      placeholder={providerSettings.placeholder}
                      spellCheck={false}
                      className="sm:w-72"
                    />
                    <Button type="button" onClick={() => addCustomModel(provider)}>
                      Add model
                    </Button>
                  </div>
                }
                footer={
                  <div className="space-y-3">
                    <p className="text-xs text-muted-foreground">
                      Example: <code>{providerSettings.example}</code>
                    </p>
                    {customModelError ? (
                      <p className="text-xs text-destructive">{customModelError}</p>
                    ) : null}
                    <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                      <p>Saved custom models: {customModels.length}</p>
                      {customModels.length > 0 ? (
                        <Button
                          size="xs"
                          variant="outline"
                          onClick={() =>
                            updateSettings(
                              patchCustomModels(provider, [
                                ...getDefaultCustomModelsForProvider(defaults, provider),
                              ]),
                            )
                          }
                        >
                          Reset custom models
                        </Button>
                      ) : null}
                    </div>
                    {customModels.length > 0 ? (
                      <div className="space-y-2">
                        {customModels.map((slug) => (
                          <div
                            key={`${provider}:${slug}`}
                            className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background px-3 py-2"
                          >
                            <code className="min-w-0 flex-1 truncate text-xs text-foreground">
                              {slug}
                            </code>
                            <Button
                              size="xs"
                              variant="ghost"
                              onClick={() => removeCustomModel(provider, slug)}
                            >
                              Remove
                            </Button>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="rounded-lg border border-dashed border-border bg-background px-3 py-4 text-xs text-muted-foreground">
                        No custom models saved yet.
                      </div>
                    )}
                  </div>
                }
              />
            );
          })}
        </SettingsSection>

        <SettingsSection
          id="git"
          title="Git"
          description="Configure the model used for commit messages, PR titles, and branch names."
        >
          <SettingsRow
            title="Text generation model"
            description="Model used for auto-generated git content."
            control={
              <Select
                value={settings.textGenerationModel ?? DEFAULT_GIT_TEXT_GENERATION_MODEL}
                onValueChange={(value) => {
                  if (value) {
                    updateSettings({
                      textGenerationModel: value,
                    });
                  }
                }}
              >
                <SelectTrigger className="w-full sm:w-56" aria-label="Git text generation model">
                  <SelectValue>{selectedGitTextGenerationModelLabel}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end">
                  {gitTextGenerationModelOptions.map((option) => (
                    <SelectItem key={option.slug} value={option.slug}>
                      {option.name}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
        </SettingsSection>

        <SettingsSection
          id="threads"
          title="Threads"
          description="Default workspace behavior for newly created draft threads."
        >
          <SettingsRow
            title="Default to New worktree"
            description="New threads start in New worktree mode instead of Local."
            control={
              <Switch
                checked={settings.defaultThreadEnvMode === "worktree"}
                onCheckedChange={(checked) =>
                  updateSettings({
                    defaultThreadEnvMode: checked ? "worktree" : "local",
                  })
                }
                aria-label="Default new threads to New worktree mode"
              />
            }
          />
        </SettingsSection>

        <SettingsSection
          id="responses"
          title="Responses"
          description="Control how assistant output is rendered during a turn."
        >
          <SettingsRow
            title="Stream assistant messages"
            description="Show token-by-token output while a response is in progress."
            control={
              <Switch
                checked={settings.enableAssistantStreaming}
                onCheckedChange={(checked) =>
                  updateSettings({
                    enableAssistantStreaming: Boolean(checked),
                  })
                }
                aria-label="Stream assistant messages"
              />
            }
          />
        </SettingsSection>

        <SettingsSection
          id="keybindings"
          title="Keybindings"
          description="Open the persisted keybindings file to edit advanced bindings directly."
        >
          <SettingsRow
            title="keybindings.json"
            description={
              <div className="space-y-1">
                <p>Opens in your preferred editor selection.</p>
                <p className="break-all font-mono text-[11px]">
                  {keybindingsConfigPath ?? "Resolving keybindings path..."}
                </p>
              </div>
            }
            control={
              <Button
                size="sm"
                variant="outline"
                disabled={!keybindingsConfigPath || isOpeningKeybindings}
                onClick={openKeybindingsFile}
              >
                {isOpeningKeybindings ? "Opening..." : "Open keybindings.json"}
              </Button>
            }
            footer={
              openKeybindingsError ? (
                <p className="text-xs text-destructive">{openKeybindingsError}</p>
              ) : undefined
            }
          />
        </SettingsSection>

        <SettingsSection
          id="safety"
          title="Safety"
          description="Additional guardrails for destructive local actions."
        >
          <SettingsRow
            title="Confirm thread deletion"
            description="Ask for confirmation before deleting a thread and its chat history."
            control={
              <Switch
                checked={settings.confirmThreadDelete}
                onCheckedChange={(checked) =>
                  updateSettings({
                    confirmThreadDelete: Boolean(checked),
                  })
                }
                aria-label="Confirm thread deletion"
              />
            }
          />
        </SettingsSection>

        <SettingsSection
          id="about"
          title="About"
          description="Application version and environment information."
        >
          <SettingsRow
            title="Version"
            description="Current version of the application."
            control={
              <code className="text-xs font-medium text-muted-foreground">{APP_VERSION}</code>
            }
          />
        </SettingsSection>
      </div>
    </div>
  );
}

export function SettingsRestoreButton() {
  const { changedSettingLabels, restoreDefaults } = useSettingsRestore();

  return (
    <Button
      size="xs"
      variant="outline"
      disabled={changedSettingLabels.length === 0}
      onClick={() => void restoreDefaults()}
    >
      <RotateCcwIcon className="size-3.5" />
      Restore defaults
    </Button>
  );
}
