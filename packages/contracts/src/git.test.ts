import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import {
  GitCreateWorktreeInput,
  GitDeleteBranchInput,
  GitDeleteBranchResult,
  GitMergePullRequestsInput,
  GitPreparePullRequestThreadInput,
  GitResolvePullRequestResult,
  GitSuggestBranchNameInput,
  GitSuggestBranchNameResult,
} from "./git";

const decodeCreateWorktreeInput = Schema.decodeUnknownSync(GitCreateWorktreeInput);
const decodeMergePullRequestsInput = Schema.decodeUnknownSync(GitMergePullRequestsInput);
const decodePreparePullRequestThreadInput = Schema.decodeUnknownSync(
  GitPreparePullRequestThreadInput,
);
const decodeResolvePullRequestResult = Schema.decodeUnknownSync(GitResolvePullRequestResult);
const decodeDeleteBranchInput = Schema.decodeUnknownSync(GitDeleteBranchInput);
const decodeDeleteBranchResult = Schema.decodeUnknownSync(GitDeleteBranchResult);
const decodeSuggestBranchNameInput = Schema.decodeUnknownSync(GitSuggestBranchNameInput);
const decodeSuggestBranchNameResult = Schema.decodeUnknownSync(GitSuggestBranchNameResult);

describe("GitCreateWorktreeInput", () => {
  it("accepts omitted newBranch for existing-branch worktrees", () => {
    const parsed = decodeCreateWorktreeInput({
      cwd: "/repo",
      branch: "feature/existing",
      path: "/tmp/worktree",
    });

    expect(parsed.newBranch).toBeUndefined();
    expect(parsed.branch).toBe("feature/existing");
  });
});

describe("GitPreparePullRequestThreadInput", () => {
  it("accepts pull request references and mode", () => {
    const parsed = decodePreparePullRequestThreadInput({
      cwd: "/repo",
      reference: "#42",
      mode: "worktree",
    });

    expect(parsed.reference).toBe("#42");
    expect(parsed.mode).toBe("worktree");
  });
});

describe("GitMergePullRequestsInput", () => {
  it("accepts stack merge options", () => {
    const parsed = decodeMergePullRequestsInput({
      cwd: "/repo",
      scope: "stack",
      method: "squash",
      deleteBranch: true,
    });

    expect(parsed.scope).toBe("stack");
    expect(parsed.method).toBe("squash");
    expect(parsed.deleteBranch).toBe(true);
  });
});

describe("GitResolvePullRequestResult", () => {
  it("decodes resolved pull request metadata", () => {
    const parsed = decodeResolvePullRequestResult({
      pullRequest: {
        number: 42,
        title: "PR threads",
        url: "https://github.com/pingdotgg/codething-mvp/pull/42",
        baseBranch: "main",
        headBranch: "feature/pr-threads",
        state: "open",
      },
    });

    expect(parsed.pullRequest.number).toBe(42);
    expect(parsed.pullRequest.headBranch).toBe("feature/pr-threads");
  });
});

describe("GitSuggestBranchName", () => {
  it("accepts optional model input and decodes branch result", () => {
    const input = decodeSuggestBranchNameInput({
      cwd: "/repo",
      textGenerationModel: "gpt-5.4-mini",
    });
    const result = decodeSuggestBranchNameResult({
      branch: "feature/refine-github-dropdown",
    });

    expect(input.textGenerationModel).toBe("gpt-5.4-mini");
    expect(result.branch).toBe("feature/refine-github-dropdown");
  });
});

describe("GitDeleteBranch", () => {
  it("accepts delete options and decodes delete result", () => {
    const input = decodeDeleteBranchInput({
      cwd: "/repo",
      branch: "feature/old",
      deleteLocal: true,
      deleteRemote: true,
      force: true,
    });
    const result = decodeDeleteBranchResult({
      branch: "feature/old",
      deletedLocal: true,
      deletedRemote: true,
    });

    expect(input.deleteLocal).toBe(true);
    expect(input.deleteRemote).toBe(true);
    expect(input.force).toBe(true);
    expect(result.deletedRemote).toBe(true);
  });
});
