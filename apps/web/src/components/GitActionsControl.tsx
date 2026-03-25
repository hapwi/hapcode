import type { ThreadId } from "@t3tools/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMutation } from "@tanstack/react-query";
import { GitHubIcon } from "./Icons";
import { Button } from "~/components/ui/button";
import {
  gitBranchesQueryOptions,
  gitInitMutationOptions,
  invalidateGitQueries,
} from "~/lib/gitReactQuery";
import { useCanvasStore } from "~/components/editor/canvasStore";
import { useScopeActive } from "~/components/editor/ScopeVisibilityContext";

interface GitActionsControlProps {
  gitCwd: string | null;
  activeThreadId: ThreadId | null;
}

export default function GitActionsControl({ gitCwd }: GitActionsControlProps) {
  const ensureGitHubWindow = useCanvasStore((s) => s.ensureGitHubWindow);
  const isScopeActive = useScopeActive();
  const queryClient = useQueryClient();

  const { data: branchList = null } = useQuery(gitBranchesQueryOptions(gitCwd, { active: isScopeActive }));
  // Default to true while loading so we don't flash init controls.
  const isRepo = branchList?.isRepo ?? true;

  const initMutation = useMutation(gitInitMutationOptions({ cwd: gitCwd, queryClient }));

  if (!gitCwd) return null;

  return !isRepo ? (
    <Button
      variant="outline"
      size="xs"
      disabled={initMutation.isPending}
      onClick={() => initMutation.mutate()}
    >
      {initMutation.isPending ? "Initializing..." : "Initialize Git"}
    </Button>
  ) : (
    <Button
      size="xs"
      variant="outline"
      aria-label="GitHub"
      onClick={() => {
        void invalidateGitQueries(queryClient);
        ensureGitHubWindow();
      }}
    >
      <GitHubIcon className="size-3.5" />
      <span className="hidden @sm/header-actions:inline">GitHub</span>
    </Button>
  );
}
