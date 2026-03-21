import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";

import { Effect, FileSystem, Layer, Path } from "effect";
import {
  resolveAutoFeatureBranchName,
  sanitizeBranchFragment,
  sanitizeFeatureBranchName,
} from "@t3tools/shared/git";

import { GitManagerError } from "../Errors.ts";
import { GitManager, type GitManagerShape } from "../Services/GitManager.ts";
import { GitCore } from "../Services/GitCore.ts";
import { GitHubCli } from "../Services/GitHubCli.ts";
import { TextGeneration } from "../Services/TextGeneration.ts";

interface OpenPrInfo {
  number: number;
  title: string;
  url: string;
  baseRefName: string;
  headRefName: string;
}

interface PullRequestInfo extends OpenPrInfo {
  state: "open" | "closed" | "merged";
  updatedAt: string | null;
}

interface ResolvedPullRequest {
  number: number;
  title: string;
  url: string;
  baseBranch: string;
  headBranch: string;
  state: "open" | "closed" | "merged";
}

interface PullRequestHeadRemoteInfo {
  isCrossRepository?: boolean;
  headRepositoryNameWithOwner?: string | null;
  headRepositoryOwnerLogin?: string | null;
}

interface BranchHeadContext {
  localBranch: string;
  headBranch: string;
  headSelectors: ReadonlyArray<string>;
  preferredHeadSelector: string;
  remoteName: string | null;
  headRepositoryNameWithOwner: string | null;
  headRepositoryOwnerLogin: string | null;
  isCrossRepository: boolean;
}

function parseRepositoryNameFromPullRequestUrl(url: string): string | null {
  const trimmed = url.trim();
  const match = /^https:\/\/github\.com\/[^/]+\/([^/]+)\/pull\/\d+(?:\/.*)?$/i.exec(trimmed);
  const repositoryName = match?.[1]?.trim() ?? "";
  return repositoryName.length > 0 ? repositoryName : null;
}

function resolveHeadRepositoryNameWithOwner(
  pullRequest: ResolvedPullRequest & PullRequestHeadRemoteInfo,
): string | null {
  const explicitRepository = pullRequest.headRepositoryNameWithOwner?.trim() ?? "";
  if (explicitRepository.length > 0) {
    return explicitRepository;
  }

  if (!pullRequest.isCrossRepository) {
    return null;
  }

  const ownerLogin = pullRequest.headRepositoryOwnerLogin?.trim() ?? "";
  const repositoryName = parseRepositoryNameFromPullRequestUrl(pullRequest.url);
  if (ownerLogin.length === 0 || !repositoryName) {
    return null;
  }

  return `${ownerLogin}/${repositoryName}`;
}

function resolvePullRequestWorktreeLocalBranchName(
  pullRequest: ResolvedPullRequest & PullRequestHeadRemoteInfo,
): string {
  if (!pullRequest.isCrossRepository) {
    return pullRequest.headBranch;
  }

  const sanitizedHeadBranch = sanitizeBranchFragment(pullRequest.headBranch).trim();
  const suffix = sanitizedHeadBranch.length > 0 ? sanitizedHeadBranch : "head";
  return `t3code/pr-${pullRequest.number}/${suffix}`;
}

function parseGitHubRepositoryNameWithOwnerFromRemoteUrl(url: string | null): string | null {
  const trimmed = url?.trim() ?? "";
  if (trimmed.length === 0) {
    return null;
  }

  const match =
    /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https:\/\/github\.com\/|git:\/\/github\.com\/)([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i.exec(
      trimmed,
    );
  const repositoryNameWithOwner = match?.[1]?.trim() ?? "";
  return repositoryNameWithOwner.length > 0 ? repositoryNameWithOwner : null;
}

function parseRepositoryOwnerLogin(nameWithOwner: string | null): string | null {
  const trimmed = nameWithOwner?.trim() ?? "";
  if (trimmed.length === 0) {
    return null;
  }
  const [ownerLogin] = trimmed.split("/");
  const normalizedOwnerLogin = ownerLogin?.trim() ?? "";
  return normalizedOwnerLogin.length > 0 ? normalizedOwnerLogin : null;
}

function parsePullRequestList(raw: unknown): PullRequestInfo[] {
  if (!Array.isArray(raw)) return [];

  const parsed: PullRequestInfo[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const number = record.number;
    const title = record.title;
    const url = record.url;
    const baseRefName = record.baseRefName;
    const headRefName = record.headRefName;
    const state = record.state;
    const mergedAt = record.mergedAt;
    const updatedAt = record.updatedAt;
    if (typeof number !== "number" || !Number.isInteger(number) || number <= 0) {
      continue;
    }
    if (
      typeof title !== "string" ||
      typeof url !== "string" ||
      typeof baseRefName !== "string" ||
      typeof headRefName !== "string"
    ) {
      continue;
    }

    let normalizedState: "open" | "closed" | "merged";
    if ((typeof mergedAt === "string" && mergedAt.trim().length > 0) || state === "MERGED") {
      normalizedState = "merged";
    } else if (state === "OPEN" || state === undefined || state === null) {
      normalizedState = "open";
    } else if (state === "CLOSED") {
      normalizedState = "closed";
    } else {
      continue;
    }

    parsed.push({
      number,
      title,
      url,
      baseRefName,
      headRefName,
      state: normalizedState,
      updatedAt: typeof updatedAt === "string" && updatedAt.trim().length > 0 ? updatedAt : null,
    });
  }
  return parsed;
}

function isProtectedBranchName(branchName: string): boolean {
  return branchName === "main" || branchName === "master" || branchName === "pre-release";
}

function gitManagerError(operation: string, detail: string, cause?: unknown): GitManagerError {
  return new GitManagerError({
    operation,
    detail,
    ...(cause !== undefined ? { cause } : {}),
  });
}

function limitContext(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n\n[truncated]`;
}

function sanitizeCommitMessage(generated: {
  subject: string;
  body: string;
  branch?: string | undefined;
}): {
  subject: string;
  body: string;
  branch?: string | undefined;
} {
  const rawSubject = generated.subject.trim().split(/\r?\n/g)[0]?.trim() ?? "";
  const subject = rawSubject.replace(/[.]+$/g, "").trim();
  const safeSubject = subject.length > 0 ? subject.slice(0, 72).trimEnd() : "Update project files";
  return {
    subject: safeSubject,
    body: generated.body.trim(),
    ...(generated.branch !== undefined ? { branch: generated.branch } : {}),
  };
}

interface CommitAndBranchSuggestion {
  subject: string;
  body: string;
  branch?: string | undefined;
  commitMessage: string;
}

function formatCommitMessage(subject: string, body: string): string {
  const trimmedBody = body.trim();
  if (trimmedBody.length === 0) {
    return subject;
  }
  return `${subject}\n\n${trimmedBody}`;
}

function parseCustomCommitMessage(raw: string): { subject: string; body: string } | null {
  const normalized = raw.replace(/\r\n/g, "\n").trim();
  if (normalized.length === 0) {
    return null;
  }

  const [firstLine, ...rest] = normalized.split("\n");
  const subject = firstLine?.trim() ?? "";
  if (subject.length === 0) {
    return null;
  }

  return {
    subject,
    body: rest.join("\n").trim(),
  };
}

function extractBranchFromRef(ref: string): string {
  const normalized = ref.trim();

  if (normalized.startsWith("refs/remotes/")) {
    const withoutPrefix = normalized.slice("refs/remotes/".length);
    const firstSlash = withoutPrefix.indexOf("/");
    if (firstSlash === -1) {
      return withoutPrefix.trim();
    }
    return withoutPrefix.slice(firstSlash + 1).trim();
  }

  const firstSlash = normalized.indexOf("/");
  if (firstSlash === -1) {
    return normalized;
  }
  return normalized.slice(firstSlash + 1).trim();
}

function appendUnique(values: string[], next: string | null | undefined): void {
  const trimmed = next?.trim() ?? "";
  if (trimmed.length === 0 || values.includes(trimmed)) {
    return;
  }
  values.push(trimmed);
}

function toStatusPr(pr: PullRequestInfo): {
  number: number;
  title: string;
  url: string;
  baseBranch: string;
  headBranch: string;
  state: "open" | "closed" | "merged";
} {
  return {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    baseBranch: pr.baseRefName,
    headBranch: pr.headRefName,
    state: pr.state,
  };
}

function pullRequestUpdatedAtMs(pr: Pick<PullRequestInfo, "updatedAt">): number {
  return pr.updatedAt ? Date.parse(pr.updatedAt) || 0 : 0;
}

function comparePullRequestPriority(a: PullRequestInfo, b: PullRequestInfo): number {
  if (a.state === "open" && b.state !== "open") return -1;
  if (a.state !== "open" && b.state === "open") return 1;
  return pullRequestUpdatedAtMs(b) - pullRequestUpdatedAtMs(a);
}

function selectBestRelatedPullRequest(
  pullRequests: ReadonlyArray<PullRequestInfo>,
  visited: ReadonlySet<number>,
): PullRequestInfo | null {
  const candidates = pullRequests.filter((pullRequest) => !visited.has(pullRequest.number));
  if (candidates.length === 0) {
    return null;
  }
  return candidates.toSorted(comparePullRequestPriority)[0] ?? null;
}

function buildPullRequestStack(
  current: PullRequestInfo,
  related: ReadonlyArray<PullRequestInfo>,
): ReadonlyArray<PullRequestInfo> {
  const pullRequestsByHeadBranch = new Map<string, PullRequestInfo[]>();
  const pullRequestsByBaseBranch = new Map<string, PullRequestInfo[]>();
  for (const pullRequest of related) {
    const headBranchList = pullRequestsByHeadBranch.get(pullRequest.headRefName) ?? [];
    headBranchList.push(pullRequest);
    pullRequestsByHeadBranch.set(pullRequest.headRefName, headBranchList);

    const baseBranchList = pullRequestsByBaseBranch.get(pullRequest.baseRefName) ?? [];
    baseBranchList.push(pullRequest);
    pullRequestsByBaseBranch.set(pullRequest.baseRefName, baseBranchList);
  }

  const visited = new Set<number>([current.number]);
  const parentStack: PullRequestInfo[] = [];
  let parentCursor: PullRequestInfo | null = current;
  while (parentCursor) {
    const parent = selectBestRelatedPullRequest(
      pullRequestsByHeadBranch.get(parentCursor.baseRefName) ?? [],
      visited,
    );
    if (!parent) {
      break;
    }
    parentStack.unshift(parent);
    visited.add(parent.number);
    parentCursor = parent;
  }

  const childStack: PullRequestInfo[] = [];
  let childCursor: PullRequestInfo | null = current;
  while (childCursor) {
    const child = selectBestRelatedPullRequest(
      pullRequestsByBaseBranch.get(childCursor.headRefName) ?? [],
      visited,
    );
    if (!child) {
      break;
    }
    childStack.push(child);
    visited.add(child.number);
    childCursor = child;
  }

  return [...parentStack, current, ...childStack];
}

function normalizePullRequestReference(reference: string): string {
  const trimmed = reference.trim();
  const hashNumber = /^#(\d+)$/.exec(trimmed);
  return hashNumber?.[1] ?? trimmed;
}

function canonicalizeExistingPath(value: string): string {
  try {
    return realpathSync.native(value);
  } catch {
    return value;
  }
}

function toResolvedPullRequest(pr: {
  number: number;
  title: string;
  url: string;
  baseRefName: string;
  headRefName: string;
  state?: "open" | "closed" | "merged";
}): ResolvedPullRequest {
  return {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    baseBranch: pr.baseRefName,
    headBranch: pr.headRefName,
    state: pr.state ?? "open",
  };
}

function shouldPreferSshRemote(url: string | null): boolean {
  if (!url) return false;
  const trimmed = url.trim();
  return trimmed.startsWith("git@") || trimmed.startsWith("ssh://");
}

function toPullRequestHeadRemoteInfo(pr: {
  isCrossRepository?: boolean;
  headRepositoryNameWithOwner?: string | null;
  headRepositoryOwnerLogin?: string | null;
}): PullRequestHeadRemoteInfo {
  return {
    ...(pr.isCrossRepository !== undefined ? { isCrossRepository: pr.isCrossRepository } : {}),
    ...(pr.headRepositoryNameWithOwner !== undefined
      ? { headRepositoryNameWithOwner: pr.headRepositoryNameWithOwner }
      : {}),
    ...(pr.headRepositoryOwnerLogin !== undefined
      ? { headRepositoryOwnerLogin: pr.headRepositoryOwnerLogin }
      : {}),
  };
}

export const makeGitManager = Effect.gen(function* () {
  const gitCore = yield* GitCore;
  const gitHubCli = yield* GitHubCli;
  const textGeneration = yield* TextGeneration;

  const configurePullRequestHeadUpstream = (
    cwd: string,
    pullRequest: ResolvedPullRequest & PullRequestHeadRemoteInfo,
    localBranch = pullRequest.headBranch,
  ) =>
    Effect.gen(function* () {
      const repositoryNameWithOwner = resolveHeadRepositoryNameWithOwner(pullRequest) ?? "";
      if (repositoryNameWithOwner.length === 0) {
        return;
      }

      const cloneUrls = yield* gitHubCli.getRepositoryCloneUrls({
        cwd,
        repository: repositoryNameWithOwner,
      });
      const originRemoteUrl = yield* gitCore.readConfigValue(cwd, "remote.origin.url");
      const remoteUrl = shouldPreferSshRemote(originRemoteUrl) ? cloneUrls.sshUrl : cloneUrls.url;
      const preferredRemoteName =
        pullRequest.headRepositoryOwnerLogin?.trim() ||
        repositoryNameWithOwner.split("/")[0]?.trim() ||
        "fork";
      const remoteName = yield* gitCore.ensureRemote({
        cwd,
        preferredName: preferredRemoteName,
        url: remoteUrl,
      });

      yield* gitCore.setBranchUpstream({
        cwd,
        branch: localBranch,
        remoteName,
        remoteBranch: pullRequest.headBranch,
      });
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning(
          `GitManager.configurePullRequestHeadUpstream: failed to configure upstream for ${localBranch} -> ${pullRequest.headBranch} in ${cwd}: ${error.message}`,
        ).pipe(Effect.asVoid),
      ),
    );

  const materializePullRequestHeadBranch = (
    cwd: string,
    pullRequest: ResolvedPullRequest & PullRequestHeadRemoteInfo,
    localBranch = pullRequest.headBranch,
  ) =>
    Effect.gen(function* () {
      const repositoryNameWithOwner = resolveHeadRepositoryNameWithOwner(pullRequest) ?? "";

      if (repositoryNameWithOwner.length === 0) {
        yield* gitCore.fetchPullRequestBranch({
          cwd,
          prNumber: pullRequest.number,
          branch: localBranch,
        });
        return;
      }

      const cloneUrls = yield* gitHubCli.getRepositoryCloneUrls({
        cwd,
        repository: repositoryNameWithOwner,
      });
      const originRemoteUrl = yield* gitCore.readConfigValue(cwd, "remote.origin.url");
      const remoteUrl = shouldPreferSshRemote(originRemoteUrl) ? cloneUrls.sshUrl : cloneUrls.url;
      const preferredRemoteName =
        pullRequest.headRepositoryOwnerLogin?.trim() ||
        repositoryNameWithOwner.split("/")[0]?.trim() ||
        "fork";
      const remoteName = yield* gitCore.ensureRemote({
        cwd,
        preferredName: preferredRemoteName,
        url: remoteUrl,
      });

      yield* gitCore.fetchRemoteBranch({
        cwd,
        remoteName,
        remoteBranch: pullRequest.headBranch,
        localBranch,
      });
      yield* gitCore.setBranchUpstream({
        cwd,
        branch: localBranch,
        remoteName,
        remoteBranch: pullRequest.headBranch,
      });
    }).pipe(
      Effect.catch(() =>
        gitCore.fetchPullRequestBranch({
          cwd,
          prNumber: pullRequest.number,
          branch: localBranch,
        }),
      ),
    );
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const tempDir = process.env.TMPDIR ?? process.env.TEMP ?? process.env.TMP ?? "/tmp";

  const readConfigValueNullable = (cwd: string, key: string) =>
    gitCore.readConfigValue(cwd, key).pipe(Effect.catch(() => Effect.succeed(null)));

  const resolveRemoteRepositoryContext = (cwd: string, remoteName: string | null) =>
    Effect.gen(function* () {
      if (!remoteName) {
        return {
          repositoryNameWithOwner: null,
          ownerLogin: null,
        };
      }

      const remoteUrl = yield* readConfigValueNullable(cwd, `remote.${remoteName}.url`);
      const repositoryNameWithOwner = parseGitHubRepositoryNameWithOwnerFromRemoteUrl(remoteUrl);
      return {
        repositoryNameWithOwner,
        ownerLogin: parseRepositoryOwnerLogin(repositoryNameWithOwner),
      };
    });

  const resolveOriginRepositoryNameWithOwner = (cwd: string) =>
    resolveRemoteRepositoryContext(cwd, "origin").pipe(
      Effect.map((remote) => remote.repositoryNameWithOwner),
    );

  const resolveBranchHeadContext = (
    cwd: string,
    details: { branch: string; upstreamRef: string | null },
  ) =>
    Effect.gen(function* () {
      const remoteName = yield* readConfigValueNullable(cwd, `branch.${details.branch}.remote`);
      const headBranchFromUpstream = details.upstreamRef
        ? extractBranchFromRef(details.upstreamRef)
        : "";
      const headBranch =
        headBranchFromUpstream.length > 0 ? headBranchFromUpstream : details.branch;

      const [remoteRepository, originRepository] = yield* Effect.all(
        [
          resolveRemoteRepositoryContext(cwd, remoteName),
          resolveRemoteRepositoryContext(cwd, "origin"),
        ],
        { concurrency: "unbounded" },
      );

      const isCrossRepository =
        remoteRepository.repositoryNameWithOwner !== null &&
        originRepository.repositoryNameWithOwner !== null
          ? remoteRepository.repositoryNameWithOwner.toLowerCase() !==
            originRepository.repositoryNameWithOwner.toLowerCase()
          : remoteName !== null &&
            remoteName !== "origin" &&
            remoteRepository.repositoryNameWithOwner !== null;

      const ownerHeadSelector =
        remoteRepository.ownerLogin && headBranch.length > 0
          ? `${remoteRepository.ownerLogin}:${headBranch}`
          : null;
      const remoteAliasHeadSelector =
        remoteName && headBranch.length > 0 ? `${remoteName}:${headBranch}` : null;
      const shouldProbeRemoteOwnedSelectors =
        isCrossRepository || (remoteName !== null && remoteName !== "origin");

      const headSelectors: string[] = [];
      if (isCrossRepository && shouldProbeRemoteOwnedSelectors) {
        appendUnique(headSelectors, ownerHeadSelector);
        appendUnique(
          headSelectors,
          remoteAliasHeadSelector !== ownerHeadSelector ? remoteAliasHeadSelector : null,
        );
      }
      appendUnique(headSelectors, details.branch);
      appendUnique(headSelectors, headBranch !== details.branch ? headBranch : null);
      if (!isCrossRepository && shouldProbeRemoteOwnedSelectors) {
        appendUnique(headSelectors, ownerHeadSelector);
        appendUnique(
          headSelectors,
          remoteAliasHeadSelector !== ownerHeadSelector ? remoteAliasHeadSelector : null,
        );
      }

      return {
        localBranch: details.branch,
        headBranch,
        headSelectors,
        preferredHeadSelector:
          ownerHeadSelector && isCrossRepository ? ownerHeadSelector : headBranch,
        remoteName,
        headRepositoryNameWithOwner: remoteRepository.repositoryNameWithOwner,
        headRepositoryOwnerLogin: remoteRepository.ownerLogin,
        isCrossRepository,
      } satisfies BranchHeadContext;
    });

  const findOpenPr = (
    cwd: string,
    headSelectors: ReadonlyArray<string>,
    repositoryNameWithOwner: string | null,
  ) =>
    Effect.gen(function* () {
      for (const headSelector of headSelectors) {
        const pullRequests = yield* gitHubCli.listOpenPullRequests({
          cwd,
          headSelector,
          limit: 1,
          ...(repositoryNameWithOwner ? { repository: repositoryNameWithOwner } : {}),
        });

        const [firstPullRequest] = pullRequests;
        if (firstPullRequest) {
          return {
            number: firstPullRequest.number,
            title: firstPullRequest.title,
            url: firstPullRequest.url,
            baseRefName: firstPullRequest.baseRefName,
            headRefName: firstPullRequest.headRefName,
            state: "open",
            updatedAt: null,
          } satisfies PullRequestInfo;
        }
      }

      return null;
    });

  const findLatestPr = (cwd: string, details: { branch: string; upstreamRef: string | null }) =>
    Effect.gen(function* () {
      const headContext = yield* resolveBranchHeadContext(cwd, details);
      const repositoryNameWithOwner = yield* resolveOriginRepositoryNameWithOwner(cwd);
      const parsedByNumber = new Map<number, PullRequestInfo>();

      for (const headSelector of headContext.headSelectors) {
        const stdout = yield* gitHubCli
          .execute({
            cwd,
            args: [
              "pr",
              "list",
              "--head",
              headSelector,
              "--state",
              "all",
              "--limit",
              "20",
              "--json",
              "number,title,url,baseRefName,headRefName,state,mergedAt,updatedAt",
              ...(repositoryNameWithOwner ? ["--repo", repositoryNameWithOwner] : []),
            ],
          })
          .pipe(Effect.map((result) => result.stdout));

        const raw = stdout.trim();
        if (raw.length === 0) {
          continue;
        }

        const parsedJson = yield* Effect.try({
          try: () => JSON.parse(raw) as unknown,
          catch: (cause) =>
            gitManagerError("findLatestPr", "GitHub CLI returned invalid PR list JSON.", cause),
        });

        for (const pr of parsePullRequestList(parsedJson)) {
          parsedByNumber.set(pr.number, pr);
        }
      }

      const parsed = Array.from(parsedByNumber.values()).toSorted((a, b) => {
        const left = a.updatedAt ? Date.parse(a.updatedAt) : 0;
        const right = b.updatedAt ? Date.parse(b.updatedAt) : 0;
        return right - left;
      });

      const latestOpenPr = parsed.find((pr) => pr.state === "open");
      if (latestOpenPr) {
        return latestOpenPr;
      }
      return parsed[0] ?? null;
    });

  const findPullRequestStack = (
    cwd: string,
    currentPullRequest: PullRequestInfo,
  ): Effect.Effect<ReadonlyArray<PullRequestInfo>, GitManagerError> =>
    resolveOriginRepositoryNameWithOwner(cwd)
      .pipe(
        Effect.flatMap((repositoryNameWithOwner) =>
          gitHubCli.execute({
            cwd,
            args: [
              "pr",
              "list",
              "--state",
              "all",
              "--limit",
              "100",
              "--json",
              "number,title,url,baseRefName,headRefName,state,mergedAt,updatedAt",
              ...(repositoryNameWithOwner ? ["--repo", repositoryNameWithOwner] : []),
            ],
          }),
        ),
      )
      .pipe(
        Effect.mapError((cause) =>
          gitManagerError(
            "findPullRequestStack",
            "GitHub CLI failed while loading the pull request stack.",
            cause,
          ),
        ),
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          raw.length === 0
            ? Effect.succeed<unknown>([])
            : Effect.try({
                try: () => JSON.parse(raw) as unknown,
                catch: (cause) =>
                  gitManagerError(
                    "findPullRequestStack",
                    "GitHub CLI returned invalid PR stack JSON.",
                    cause,
                  ),
              }),
        ),
        Effect.map((raw) => {
          const parsedByNumber = new Map<number, PullRequestInfo>();
          for (const pullRequest of parsePullRequestList(raw)) {
            parsedByNumber.set(pullRequest.number, pullRequest);
          }
          parsedByNumber.set(currentPullRequest.number, currentPullRequest);
          return buildPullRequestStack(currentPullRequest, Array.from(parsedByNumber.values()));
        }),
      );

  const resolveBaseBranch = (
    cwd: string,
    branch: string,
    upstreamRef: string | null,
    headContext: Pick<BranchHeadContext, "isCrossRepository">,
  ) =>
    Effect.gen(function* () {
      const configured = yield* gitCore.readConfigValue(cwd, `branch.${branch}.gh-merge-base`);
      if (configured) return configured;

      if (upstreamRef && !headContext.isCrossRepository) {
        const upstreamBranch = extractBranchFromRef(upstreamRef);
        if (upstreamBranch.length > 0 && upstreamBranch !== branch) {
          return upstreamBranch;
        }
      }

      const repositoryNameWithOwner = yield* resolveOriginRepositoryNameWithOwner(cwd);
      const defaultFromGh = yield* gitHubCli
        .getDefaultBranch({
          cwd,
          ...(repositoryNameWithOwner ? { repository: repositoryNameWithOwner } : {}),
        })
        .pipe(Effect.catch(() => Effect.succeed(null)));
      const inferredBaseBranch = yield* gitCore
        .resolveClosestBaseBranch({
          cwd,
          branch,
          candidates: Array.from(
            new Set(
              ["pre-release", defaultFromGh, "main", "master"].filter(
                (candidate): candidate is string => !!candidate && candidate !== branch,
              ),
            ),
          ),
        })
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (inferredBaseBranch) {
        return inferredBaseBranch;
      }

      if (defaultFromGh) {
        return defaultFromGh;
      }

      return "main";
    });

  const resolveCommitAndBranchSuggestion = (input: {
    cwd: string;
    branch: string | null;
    commitMessage?: string;
    /** When true, also produce a semantic feature branch name. */
    includeBranch?: boolean;
    filePaths?: readonly string[];
    model?: string;
  }) =>
    Effect.gen(function* () {
      const context = yield* gitCore.prepareCommitContext(input.cwd, input.filePaths);
      if (!context) {
        return null;
      }

      const customCommit = parseCustomCommitMessage(input.commitMessage ?? "");
      if (customCommit) {
        return {
          subject: customCommit.subject,
          body: customCommit.body,
          ...(input.includeBranch
            ? { branch: sanitizeFeatureBranchName(customCommit.subject) }
            : {}),
          commitMessage: formatCommitMessage(customCommit.subject, customCommit.body),
        };
      }

      const generated = yield* textGeneration
        .generateCommitMessage({
          cwd: input.cwd,
          branch: input.branch,
          stagedSummary: limitContext(context.stagedSummary, 8_000),
          stagedPatch: limitContext(context.stagedPatch, 50_000),
          ...(input.includeBranch ? { includeBranch: true } : {}),
          ...(input.model ? { model: input.model } : {}),
        })
        .pipe(Effect.map((result) => sanitizeCommitMessage(result)));

      return {
        subject: generated.subject,
        body: generated.body,
        ...(generated.branch !== undefined ? { branch: generated.branch } : {}),
        commitMessage: formatCommitMessage(generated.subject, generated.body),
      };
    });

  const runCommitStep = (
    cwd: string,
    branch: string | null,
    commitMessage?: string,
    preResolvedSuggestion?: CommitAndBranchSuggestion,
    filePaths?: readonly string[],
    model?: string,
  ) =>
    Effect.gen(function* () {
      const suggestion =
        preResolvedSuggestion ??
        (yield* resolveCommitAndBranchSuggestion({
          cwd,
          branch,
          ...(commitMessage ? { commitMessage } : {}),
          ...(filePaths ? { filePaths } : {}),
          ...(model ? { model } : {}),
        }));
      if (!suggestion) {
        return { status: "skipped_no_changes" as const };
      }

      const { commitSha } = yield* gitCore.commit(cwd, suggestion.subject, suggestion.body);
      return {
        status: "created" as const,
        commitSha,
        subject: suggestion.subject,
      };
    });

  const runPrStep = (cwd: string, fallbackBranch: string | null, model?: string) =>
    Effect.gen(function* () {
      const details = yield* gitCore.statusDetails(cwd);
      const branch = details.branch ?? fallbackBranch;
      if (!branch) {
        return yield* gitManagerError(
          "runPrStep",
          "Cannot create a pull request from detached HEAD.",
        );
      }
      if (!details.hasUpstream) {
        return yield* gitManagerError(
          "runPrStep",
          "Current branch has not been pushed. Push before creating a PR.",
        );
      }

      const headContext = yield* resolveBranchHeadContext(cwd, {
        branch,
        upstreamRef: details.upstreamRef,
      });
      const repositoryNameWithOwner = yield* resolveOriginRepositoryNameWithOwner(cwd);

      const existing = yield* findOpenPr(cwd, headContext.headSelectors, repositoryNameWithOwner);
      if (existing) {
        return {
          status: "opened_existing" as const,
          url: existing.url,
          number: existing.number,
          baseBranch: existing.baseRefName,
          headBranch: existing.headRefName,
          title: existing.title,
        };
      }

      const baseBranch = yield* resolveBaseBranch(cwd, branch, details.upstreamRef, headContext);
      const rangeContext = yield* gitCore.readRangeContext(cwd, baseBranch);

      const generated = yield* textGeneration.generatePrContent({
        cwd,
        baseBranch,
        headBranch: headContext.headBranch,
        commitSummary: limitContext(rangeContext.commitSummary, 20_000),
        diffSummary: limitContext(rangeContext.diffSummary, 20_000),
        diffPatch: limitContext(rangeContext.diffPatch, 60_000),
        ...(model ? { model } : {}),
      });

      const bodyFile = path.join(tempDir, `t3code-pr-body-${process.pid}-${randomUUID()}.md`);
      yield* fileSystem
        .writeFileString(bodyFile, generated.body)
        .pipe(
          Effect.mapError((cause) =>
            gitManagerError("runPrStep", "Failed to write pull request body temp file.", cause),
          ),
        );
      yield* gitHubCli
        .createPullRequest({
          cwd,
          baseBranch,
          headSelector: headContext.preferredHeadSelector,
          title: generated.title,
          bodyFile,
          ...(repositoryNameWithOwner ? { repository: repositoryNameWithOwner } : {}),
        })
        .pipe(Effect.ensuring(fileSystem.remove(bodyFile).pipe(Effect.catch(() => Effect.void))));

      const created = yield* findOpenPr(cwd, headContext.headSelectors, repositoryNameWithOwner);
      if (!created) {
        return {
          status: "created" as const,
          baseBranch,
          headBranch: headContext.headBranch,
          title: generated.title,
        };
      }

      return {
        status: "created" as const,
        url: created.url,
        number: created.number,
        baseBranch: created.baseRefName,
        headBranch: created.headRefName,
        title: created.title,
      };
    });

  const status: GitManagerShape["status"] = Effect.fnUntraced(function* (input) {
    const details = yield* gitCore.statusDetails(input.cwd);

    const latestPr =
      details.branch !== null
        ? yield* findLatestPr(input.cwd, {
            branch: details.branch,
            upstreamRef: details.upstreamRef,
          }).pipe(Effect.catch(() => Effect.succeed(null)))
        : null;

    const pr = latestPr ? toStatusPr(latestPr) : null;
    const prStack =
      latestPr !== null
        ? yield* findPullRequestStack(input.cwd, latestPr).pipe(
            Effect.map((stack) => stack.map(toStatusPr)),
            Effect.catch(() => Effect.void),
          )
        : undefined;

    return {
      branch: details.branch,
      hasWorkingTreeChanges: details.hasWorkingTreeChanges,
      workingTree: details.workingTree,
      hasUpstream: details.hasUpstream,
      aheadCount: details.aheadCount,
      behindCount: details.behindCount,
      pr,
      ...(prStack ? { prStack } : {}),
    };
  });

  const mergePullRequests: GitManagerShape["mergePullRequests"] = Effect.fnUntraced(
    function* (input) {
      const details = yield* gitCore.statusDetails(input.cwd);
      if (!details.branch) {
        return yield* gitManagerError(
          "mergePullRequests",
          "Cannot merge pull requests from detached HEAD.",
        );
      }

      const latestPr = yield* findLatestPr(input.cwd, {
        branch: details.branch,
        upstreamRef: details.upstreamRef,
      }).pipe(
        Effect.catch((cause) =>
          Effect.fail(
            gitManagerError(
              "mergePullRequests",
              "Failed to resolve the active pull request for this branch.",
              cause,
            ),
          ),
        ),
      );

      if (!latestPr || latestPr.state !== "open") {
        return yield* gitManagerError(
          "mergePullRequests",
          "No open pull request is available for this branch.",
        );
      }

      const pullRequests =
        input.scope === "current"
          ? [latestPr]
          : yield* findPullRequestStack(input.cwd, latestPr).pipe(
              Effect.catch((cause) =>
                Effect.fail(
                  gitManagerError(
                    "mergePullRequests",
                    "Failed to resolve the active pull request stack.",
                    cause,
                  ),
                ),
              ),
            );

      const openPullRequests = pullRequests.filter((pullRequest) => pullRequest.state === "open");
      if (openPullRequests.length === 0) {
        return yield* gitManagerError(
          "mergePullRequests",
          "No open pull requests are available to merge.",
        );
      }

      const repositoryNameWithOwner = yield* resolveOriginRepositoryNameWithOwner(input.cwd);
      const mergeBaseBranch = openPullRequests[0]?.baseRefName ?? latestPr.baseRefName;

      const merged: Array<{
        number: number;
        title: string;
        baseBranch: string;
        headBranch: string;
      }> = [];
      const deletedBranches: string[] = [];
      const syncedBranches: string[] = [];
      const readCurrentPullRequest = (reference: string) =>
        gitHubCli.getPullRequest({
          cwd: input.cwd,
          reference,
          ...(repositoryNameWithOwner ? { repository: repositoryNameWithOwner } : {}),
        });

      for (const pullRequest of openPullRequests) {
        // Re-fetch the PR's current state to check if GitHub already retargeted it
        // (e.g. after merging the previous PR and deleting its branch).
        const reference = String(pullRequest.number);
        let currentPr = yield* readCurrentPullRequest(reference).pipe(
          Effect.catch(() => Effect.succeed(pullRequest)),
        );

        if (currentPr.state !== "open") {
          // PR was closed or merged externally (e.g. by GitHub auto-close), skip it.
          continue;
        }

        const currentBase = currentPr.baseRefName ?? pullRequest.baseRefName;
        if (currentBase !== mergeBaseBranch) {
          currentPr = yield* gitHubCli
            .updatePullRequestBase({
              cwd: input.cwd,
              reference,
              baseBranch: mergeBaseBranch,
              ...(repositoryNameWithOwner ? { repository: repositoryNameWithOwner } : {}),
            })
            .pipe(
              Effect.flatMap(() => Effect.succeed(currentPr)),
              Effect.catch((cause) =>
                readCurrentPullRequest(reference).pipe(
                  Effect.catch(() => Effect.succeed(currentPr)),
                  Effect.flatMap((refreshedPr) => {
                    if (
                      refreshedPr.state !== "open" ||
                      refreshedPr.baseRefName === mergeBaseBranch
                    ) {
                      return Effect.succeed(refreshedPr);
                    }

                    return Effect.fail(
                      gitManagerError(
                        "mergePullRequests",
                        `Failed to retarget PR #${pullRequest.number} to ${mergeBaseBranch}.`,
                        cause,
                      ),
                    );
                  }),
                ),
              ),
            );
          if (currentPr.state !== "open") {
            continue;
          }
        }

        yield* gitHubCli
          .mergePullRequest({
            cwd: input.cwd,
            reference,
            method: input.method,
            ...(input.deleteBranch && !isProtectedBranchName(pullRequest.headRefName)
              ? { deleteBranch: true }
              : {}),
            ...(repositoryNameWithOwner ? { repository: repositoryNameWithOwner } : {}),
          })
          .pipe(
            Effect.catch((cause) =>
              Effect.fail(
                gitManagerError(
                  "mergePullRequests",
                  `Failed to merge PR #${pullRequest.number}.`,
                  cause,
                ),
              ),
            ),
          );

        merged.push({
          number: pullRequest.number,
          title: pullRequest.title,
          baseBranch: mergeBaseBranch,
          headBranch: pullRequest.headRefName,
        });
      }

      let checkedOutBranch: string | undefined;
      yield* Effect.scoped(gitCore.checkoutBranch({ cwd: input.cwd, branch: mergeBaseBranch }));
      checkedOutBranch = mergeBaseBranch;
      yield* gitCore
        .pullCurrentBranch(input.cwd)
        .pipe(
          Effect.catch((cause) =>
            Effect.fail(
              gitManagerError(
                "mergePullRequests",
                `Failed to sync ${mergeBaseBranch} after merge.`,
                cause,
              ),
            ),
          ),
        );

      if (input.deleteBranch) {
        for (const pullRequest of openPullRequests) {
          const headBranch = pullRequest.headRefName;
          if (isProtectedBranchName(headBranch)) {
            if (headBranch !== mergeBaseBranch) {
              yield* Effect.scoped(gitCore.checkoutBranch({ cwd: input.cwd, branch: headBranch }));
              checkedOutBranch = headBranch;
              yield* gitCore
                .mergeCurrentBranchFastForward(input.cwd, mergeBaseBranch)
                .pipe(
                  Effect.catch((cause) =>
                    Effect.fail(
                      gitManagerError(
                        "mergePullRequests",
                        `Failed to fast-forward ${headBranch} to ${mergeBaseBranch}.`,
                        cause,
                      ),
                    ),
                  ),
                );
              yield* gitCore
                .pushCurrentBranch(input.cwd, headBranch)
                .pipe(
                  Effect.catch((cause) =>
                    Effect.fail(
                      gitManagerError(
                        "mergePullRequests",
                        `Failed to push synced branch ${headBranch}.`,
                        cause,
                      ),
                    ),
                  ),
                );
              syncedBranches.push(headBranch);
            }
            continue;
          }

          yield* gitCore
            .deleteBranch({
              cwd: input.cwd,
              branch: headBranch,
              deleteLocal: true,
              deleteRemote: true,
              force: true,
            })
            .pipe(
              Effect.catch((cause) =>
                Effect.fail(
                  gitManagerError(
                    "mergePullRequests",
                    `Failed to delete merged branch ${headBranch}.`,
                    cause,
                  ),
                ),
              ),
            );
          deletedBranches.push(headBranch);
        }
      }

      return {
        scope: input.scope,
        method: input.method,
        merged,
        cleanup: {
          ...(checkedOutBranch ? { checkedOutBranch } : {}),
          deletedBranches,
          syncedBranches,
        },
      };
    },
  );

  const resolvePullRequest: GitManagerShape["resolvePullRequest"] = Effect.fnUntraced(
    function* (input) {
      const repositoryNameWithOwner = yield* resolveOriginRepositoryNameWithOwner(input.cwd);
      const pullRequest = yield* gitHubCli
        .getPullRequest({
          cwd: input.cwd,
          reference: normalizePullRequestReference(input.reference),
          ...(repositoryNameWithOwner ? { repository: repositoryNameWithOwner } : {}),
        })
        .pipe(Effect.map((resolved) => toResolvedPullRequest(resolved)));

      return { pullRequest };
    },
  );

  const preparePullRequestThread: GitManagerShape["preparePullRequestThread"] = Effect.fnUntraced(
    function* (input) {
      const normalizedReference = normalizePullRequestReference(input.reference);
      const rootWorktreePath = canonicalizeExistingPath(input.cwd);
      const repositoryNameWithOwner = yield* resolveOriginRepositoryNameWithOwner(input.cwd);
      const pullRequestSummary = yield* gitHubCli.getPullRequest({
        cwd: input.cwd,
        reference: normalizedReference,
        ...(repositoryNameWithOwner ? { repository: repositoryNameWithOwner } : {}),
      });
      const pullRequest = toResolvedPullRequest(pullRequestSummary);

      if (input.mode === "local") {
        yield* gitHubCli.checkoutPullRequest({
          cwd: input.cwd,
          reference: normalizedReference,
          force: true,
        });
        const details = yield* gitCore.statusDetails(input.cwd);
        yield* configurePullRequestHeadUpstream(
          input.cwd,
          {
            ...pullRequest,
            ...toPullRequestHeadRemoteInfo(pullRequestSummary),
          },
          details.branch ?? pullRequest.headBranch,
        );
        return {
          pullRequest,
          branch: details.branch ?? pullRequest.headBranch,
          worktreePath: null,
        };
      }

      const ensureExistingWorktreeUpstream = (worktreePath: string) =>
        Effect.gen(function* () {
          const details = yield* gitCore.statusDetails(worktreePath);
          yield* configurePullRequestHeadUpstream(
            worktreePath,
            {
              ...pullRequest,
              ...toPullRequestHeadRemoteInfo(pullRequestSummary),
            },
            details.branch ?? pullRequest.headBranch,
          );
        });

      const pullRequestWithRemoteInfo = {
        ...pullRequest,
        ...toPullRequestHeadRemoteInfo(pullRequestSummary),
      } as const;
      const localPullRequestBranch =
        resolvePullRequestWorktreeLocalBranchName(pullRequestWithRemoteInfo);

      const findLocalHeadBranch = (cwd: string) =>
        gitCore.listBranches({ cwd }).pipe(
          Effect.map((result) => {
            const localBranch = result.branches.find(
              (branch) => !branch.isRemote && branch.name === localPullRequestBranch,
            );
            if (localBranch) {
              return localBranch;
            }
            if (localPullRequestBranch === pullRequest.headBranch) {
              return null;
            }
            return (
              result.branches.find(
                (branch) =>
                  !branch.isRemote &&
                  branch.name === pullRequest.headBranch &&
                  branch.worktreePath !== null &&
                  canonicalizeExistingPath(branch.worktreePath) !== rootWorktreePath,
              ) ?? null
            );
          }),
        );

      const existingBranchBeforeFetch = yield* findLocalHeadBranch(input.cwd);
      const existingBranchBeforeFetchPath = existingBranchBeforeFetch?.worktreePath
        ? canonicalizeExistingPath(existingBranchBeforeFetch.worktreePath)
        : null;
      if (
        existingBranchBeforeFetch?.worktreePath &&
        existingBranchBeforeFetchPath !== rootWorktreePath
      ) {
        yield* ensureExistingWorktreeUpstream(existingBranchBeforeFetch.worktreePath);
        return {
          pullRequest,
          branch: localPullRequestBranch,
          worktreePath: existingBranchBeforeFetch.worktreePath,
        };
      }
      if (existingBranchBeforeFetchPath === rootWorktreePath) {
        return yield* gitManagerError(
          "preparePullRequestThread",
          "This PR branch is already checked out in the main repo. Use Local, or switch the main repo off that branch before creating a worktree thread.",
        );
      }

      yield* materializePullRequestHeadBranch(
        input.cwd,
        pullRequestWithRemoteInfo,
        localPullRequestBranch,
      );

      const existingBranchAfterFetch = yield* findLocalHeadBranch(input.cwd);
      const existingBranchAfterFetchPath = existingBranchAfterFetch?.worktreePath
        ? canonicalizeExistingPath(existingBranchAfterFetch.worktreePath)
        : null;
      if (
        existingBranchAfterFetch?.worktreePath &&
        existingBranchAfterFetchPath !== rootWorktreePath
      ) {
        yield* ensureExistingWorktreeUpstream(existingBranchAfterFetch.worktreePath);
        return {
          pullRequest,
          branch: localPullRequestBranch,
          worktreePath: existingBranchAfterFetch.worktreePath,
        };
      }
      if (existingBranchAfterFetchPath === rootWorktreePath) {
        return yield* gitManagerError(
          "preparePullRequestThread",
          "This PR branch is already checked out in the main repo. Use Local, or switch the main repo off that branch before creating a worktree thread.",
        );
      }

      const worktree = yield* gitCore.createWorktree({
        cwd: input.cwd,
        branch: localPullRequestBranch,
        path: null,
      });
      yield* ensureExistingWorktreeUpstream(worktree.worktree.path);

      return {
        pullRequest,
        branch: worktree.worktree.branch,
        worktreePath: worktree.worktree.path,
      };
    },
  );

  const suggestBranchName: GitManagerShape["suggestBranchName"] = Effect.fnUntraced(
    function* (input) {
      const details = yield* gitCore.statusDetails(input.cwd);
      if (!details.hasWorkingTreeChanges || details.workingTree.files.length === 0) {
        return yield* gitManagerError(
          "suggestBranchName",
          "No local changes available to generate a branch name.",
        );
      }

      const suggestion = yield* resolveCommitAndBranchSuggestion({
        cwd: input.cwd,
        branch: details.branch,
        includeBranch: true,
        ...(input.textGenerationModel ? { model: input.textGenerationModel } : {}),
      });
      const existingBranchNames = yield* gitCore.listLocalBranchNames(input.cwd);

      return {
        branch: resolveAutoFeatureBranchName(
          existingBranchNames,
          suggestion?.branch ?? sanitizeFeatureBranchName("update"),
        ),
      };
    },
  );

  const runFeatureBranchStep = (
    cwd: string,
    branch: string | null,
    commitMessage?: string,
    filePaths?: readonly string[],
    model?: string,
  ) =>
    Effect.gen(function* () {
      const suggestion = yield* resolveCommitAndBranchSuggestion({
        cwd,
        branch,
        ...(commitMessage ? { commitMessage } : {}),
        ...(filePaths ? { filePaths } : {}),
        includeBranch: true,
        ...(model ? { model } : {}),
      });
      if (!suggestion) {
        return yield* gitManagerError(
          "runFeatureBranchStep",
          "Cannot create a feature branch because there are no changes to commit.",
        );
      }

      const preferredBranch = suggestion.branch ?? sanitizeFeatureBranchName(suggestion.subject);
      const existingBranchNames = yield* gitCore.listLocalBranchNames(cwd);
      const resolvedBranch = resolveAutoFeatureBranchName(existingBranchNames, preferredBranch);

      yield* gitCore.createBranch({
        cwd,
        branch: resolvedBranch,
        ...(branch ? { mergeBaseBranch: branch } : {}),
      });
      yield* Effect.scoped(gitCore.checkoutBranch({ cwd, branch: resolvedBranch }));

      return {
        branchStep: { status: "created" as const, name: resolvedBranch },
        resolvedCommitMessage: suggestion.commitMessage,
        resolvedCommitSuggestion: suggestion,
      };
    });

  const runStackedAction: GitManagerShape["runStackedAction"] = Effect.fnUntraced(
    function* (input) {
      const wantsPush = input.action !== "commit";
      const wantsPr = input.action === "commit_push_pr";

      const initialStatus = yield* gitCore.statusDetails(input.cwd);
      if (!input.featureBranch && wantsPush && !initialStatus.branch) {
        return yield* gitManagerError("runStackedAction", "Cannot push from detached HEAD.");
      }
      if (!input.featureBranch && wantsPr && !initialStatus.branch) {
        return yield* gitManagerError(
          "runStackedAction",
          "Cannot create a pull request from detached HEAD.",
        );
      }

      let branchStep: { status: "created" | "skipped_not_requested"; name?: string };
      let commitMessageForStep = input.commitMessage;
      let preResolvedCommitSuggestion: CommitAndBranchSuggestion | undefined = undefined;

      if (input.featureBranch) {
        const result = yield* runFeatureBranchStep(
          input.cwd,
          initialStatus.branch,
          input.commitMessage,
          input.filePaths,
          input.textGenerationModel,
        );
        branchStep = result.branchStep;
        commitMessageForStep = result.resolvedCommitMessage;
        preResolvedCommitSuggestion = result.resolvedCommitSuggestion;
      } else {
        branchStep = { status: "skipped_not_requested" as const };
      }

      const currentBranch = branchStep.name ?? initialStatus.branch;

      const commit = yield* runCommitStep(
        input.cwd,
        currentBranch,
        commitMessageForStep,
        preResolvedCommitSuggestion,
        input.filePaths,
        input.textGenerationModel,
      );

      const push = wantsPush
        ? yield* gitCore.pushCurrentBranch(input.cwd, currentBranch)
        : { status: "skipped_not_requested" as const };

      const pr = wantsPr
        ? yield* runPrStep(input.cwd, currentBranch, input.textGenerationModel)
        : { status: "skipped_not_requested" as const };

      return {
        action: input.action,
        branch: branchStep,
        commit,
        push,
        pr,
      };
    },
  );

  return {
    status,
    mergePullRequests,
    suggestBranchName,
    resolvePullRequest,
    preparePullRequestThread,
    runStackedAction,
  } satisfies GitManagerShape;
});

export const GitManagerLive = Layer.effect(GitManager, makeGitManager);
