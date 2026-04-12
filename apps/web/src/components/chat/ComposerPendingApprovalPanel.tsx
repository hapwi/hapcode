import { memo } from "react";
import { type PendingApproval } from "../../session-logic";
import { ShieldAlertIcon, TerminalIcon, FileIcon, FileEditIcon } from "lucide-react";
import { Badge } from "../ui/badge";

interface ComposerPendingApprovalPanelProps {
  approval: PendingApproval;
  pendingCount: number;
}

export const ComposerPendingApprovalPanel = memo(function ComposerPendingApprovalPanel({
  approval,
  pendingCount,
}: ComposerPendingApprovalPanelProps) {
  const approvalConfig =
    approval.requestKind === "command"
      ? {
          icon: TerminalIcon,
          label: "Command approval requested",
          description: "A command needs your permission to execute",
        }
      : approval.requestKind === "file-read"
        ? {
            icon: FileIcon,
            label: "File-read approval requested",
            description: "A file read needs your permission",
          }
        : {
            icon: FileEditIcon,
            label: "File-change approval requested",
            description: "A file change needs your permission",
          };

  const ApprovalIcon = approvalConfig.icon;

  return (
    <div className="px-4 py-3 sm:px-5 sm:py-3.5">
      <div className="flex items-center gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-amber-500/10 text-amber-600 dark:text-amber-400">
          <ShieldAlertIcon className="size-4" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{approvalConfig.label}</span>
            {pendingCount > 1 && (
              <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                1/{pendingCount}
              </Badge>
            )}
          </div>
          <span className="text-xs text-muted-foreground">{approvalConfig.description}</span>
        </div>
      </div>
    </div>
  );
});
