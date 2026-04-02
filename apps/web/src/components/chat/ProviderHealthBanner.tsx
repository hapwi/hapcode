import { type ServerProviderStatus } from "@t3tools/contracts";
import { memo } from "react";
import { SystemMessage } from "../ui/system-message";

export const ProviderHealthBanner = memo(function ProviderHealthBanner({
  status,
}: {
  status: ServerProviderStatus | null;
}) {
  if (!status || status.status === "ready") {
    return null;
  }

  const providerLabel =
    status.provider === "codex"
      ? "Codex"
      : status.provider === "claudeAgent"
        ? "Claude"
        : status.provider;
  const defaultMessage =
    status.status === "error"
      ? `${providerLabel} provider is unavailable.`
      : `${providerLabel} provider has limited availability.`;

  return (
    <div className="pt-3 mx-auto max-w-3xl px-3 sm:px-5">
      <SystemMessage
        variant={status.status === "error" ? "error" : "warning"}
        fill
      >
        <div className="flex flex-col gap-0.5">
          <span className="font-medium">{providerLabel} provider status</span>
          <span className="text-xs opacity-80">{status.message ?? defaultMessage}</span>
        </div>
      </SystemMessage>
    </div>
  );
});
