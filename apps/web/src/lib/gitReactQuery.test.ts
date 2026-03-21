import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import {
  gitDeleteBranchMutationOptions,
  gitMutationKeys,
  gitPreparePullRequestThreadMutationOptions,
  gitPullMutationOptions,
  gitRunStackedActionMutationOptions,
} from "./gitReactQuery";

describe("gitMutationKeys", () => {
  it("scopes stacked action keys by cwd", () => {
    expect(gitMutationKeys.runStackedAction("/repo/a")).not.toEqual(
      gitMutationKeys.runStackedAction("/repo/b"),
    );
  });

  it("scopes pull keys by cwd", () => {
    expect(gitMutationKeys.pull("/repo/a")).not.toEqual(gitMutationKeys.pull("/repo/b"));
  });

  it("scopes pull request thread preparation keys by cwd", () => {
    expect(gitMutationKeys.preparePullRequestThread("/repo/a")).not.toEqual(
      gitMutationKeys.preparePullRequestThread("/repo/b"),
    );
  });
});

describe("git mutation options", () => {
  const queryClient = new QueryClient();

  it("attaches cwd-scoped mutation key for runStackedAction", () => {
    const options = gitRunStackedActionMutationOptions({ cwd: "/repo/a", queryClient });
    expect(options.mutationKey).toEqual(gitMutationKeys.runStackedAction("/repo/a"));
  });

  it("attaches cwd-scoped mutation key for pull", () => {
    const options = gitPullMutationOptions({ cwd: "/repo/a", queryClient });
    expect(options.mutationKey).toEqual(gitMutationKeys.pull("/repo/a"));
  });

  it("does not block delete branch completion on git query invalidation", () => {
    const deleteQueryClient = new QueryClient();
    const invalidateQueries = deleteQueryClient.invalidateQueries.bind(deleteQueryClient);
    let settled = false;

    deleteQueryClient.invalidateQueries = (() => {
      settled = true;
      return new Promise(() => undefined);
    }) as typeof deleteQueryClient.invalidateQueries;

    const options = gitDeleteBranchMutationOptions({
      cwd: "/repo/a",
      queryClient: deleteQueryClient,
    });
    const result = (options.onSettled as any)?.(
      { branch: "feature/test", deletedLocal: false, deletedRemote: true },
      null,
      {
        branch: "feature/test",
        deleteLocal: false,
        deleteRemote: true,
        force: true,
      },
      undefined,
      undefined,
    );

    expect(settled).toBe(true);
    expect(result).toBeUndefined();

    deleteQueryClient.invalidateQueries = invalidateQueries;
  });

  it("attaches cwd-scoped mutation key for preparePullRequestThread", () => {
    const options = gitPreparePullRequestThreadMutationOptions({
      cwd: "/repo/a",
      queryClient,
    });
    expect(options.mutationKey).toEqual(gitMutationKeys.preparePullRequestThread("/repo/a"));
  });
});
