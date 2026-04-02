import { memo } from "react";
import { SystemMessage } from "../ui/system-message";
import { XIcon } from "lucide-react";

export const ThreadErrorBanner = memo(function ThreadErrorBanner({
  error,
  onDismiss,
}: {
  error: string | null;
  onDismiss?: () => void;
}) {
  if (!error) return null;
  return (
    <div className="pt-3 mx-auto max-w-3xl px-3 sm:px-5">
      <SystemMessage variant="error" fill>
        <div className="flex items-center justify-between gap-2">
          <span className="line-clamp-3" title={error}>
            {error}
          </span>
          {onDismiss && (
            <button
              type="button"
              aria-label="Dismiss error"
              className="inline-flex size-6 shrink-0 items-center justify-center rounded-md opacity-60 transition-opacity hover:opacity-100"
              onClick={onDismiss}
            >
              <XIcon className="size-3.5" />
            </button>
          )}
        </div>
      </SystemMessage>
    </div>
  );
});
