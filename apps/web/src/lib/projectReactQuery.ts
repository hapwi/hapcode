import type { ProjectSearchEntriesResult } from "@t3tools/contracts";
import { mutationOptions, queryOptions, type QueryClient } from "@tanstack/react-query";
import { ensureNativeApi } from "~/nativeApi";

export const projectQueryKeys = {
  all: ["projects"] as const,
  searchEntries: (cwd: string | null, query: string, limit: number) =>
    ["projects", "search-entries", cwd, query, limit] as const,
  readFile: (cwd: string | null, relativePath: string) =>
    ["projects", "read-file", cwd, relativePath] as const,
  listDir: (cwd: string | null, relativePath: string) =>
    ["projects", "list-dir", cwd, relativePath] as const,
};

const DEFAULT_SEARCH_ENTRIES_LIMIT = 80;
const DEFAULT_SEARCH_ENTRIES_STALE_TIME = 15_000;
const EMPTY_SEARCH_ENTRIES_RESULT: ProjectSearchEntriesResult = {
  entries: [],
  truncated: false,
};

export function projectSearchEntriesQueryOptions(input: {
  cwd: string | null;
  query: string;
  enabled?: boolean;
  limit?: number;
  staleTime?: number;
}) {
  const limit = input.limit ?? DEFAULT_SEARCH_ENTRIES_LIMIT;
  return queryOptions({
    queryKey: projectQueryKeys.searchEntries(input.cwd, input.query, limit),
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!input.cwd) {
        throw new Error("Workspace entry search is unavailable.");
      }
      return api.projects.searchEntries({
        cwd: input.cwd,
        query: input.query,
        limit,
      });
    },
    enabled: (input.enabled ?? true) && input.cwd !== null && input.query.length > 0,
    staleTime: input.staleTime ?? DEFAULT_SEARCH_ENTRIES_STALE_TIME,
    placeholderData: (previous) => previous ?? EMPTY_SEARCH_ENTRIES_RESULT,
  });
}

// ── Read File ──────────────────────────────────────────────────────────

const READ_FILE_STALE_TIME_MS = 5_000;
const READ_FILE_GC_TIME_MS = 60_000;

export function projectReadFileQueryOptions(input: {
  cwd: string | null;
  relativePath: string;
  enabled?: boolean;
}) {
  return queryOptions({
    queryKey: projectQueryKeys.readFile(input.cwd, input.relativePath),
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!input.cwd) throw new Error("File read is unavailable.");
      return api.projects.readFile({
        cwd: input.cwd,
        relativePath: input.relativePath,
      });
    },
    enabled: (input.enabled ?? true) && input.cwd !== null && input.relativePath.length > 0,
    staleTime: READ_FILE_STALE_TIME_MS,
    gcTime: READ_FILE_GC_TIME_MS,
    placeholderData: (previous) => previous,
  });
}

// ── List Directory ─────────────────────────────────────────────────────

const LIST_DIR_STALE_TIME_MS = 10_000;

export function projectListDirQueryOptions(input: {
  cwd: string | null;
  relativePath: string;
  enabled?: boolean;
}) {
  return queryOptions({
    queryKey: projectQueryKeys.listDir(input.cwd, input.relativePath),
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!input.cwd) throw new Error("Directory listing is unavailable.");
      return api.projects.listDir({
        cwd: input.cwd,
        relativePath: input.relativePath,
      });
    },
    enabled: (input.enabled ?? true) && input.cwd !== null,
    staleTime: LIST_DIR_STALE_TIME_MS,
  });
}

// ── Write File Mutation ────────────────────────────────────────────────

export function projectWriteFileMutationOptions(input: {
  cwd: string | null;
  queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationFn: async (params: { relativePath: string; contents: string }) => {
      const api = ensureNativeApi();
      if (!input.cwd) throw new Error("File write is unavailable.");
      return api.projects.writeFile({
        cwd: input.cwd,
        relativePath: params.relativePath,
        contents: params.contents,
      });
    },
    onSuccess: async (_data, variables) => {
      await input.queryClient.invalidateQueries({
        queryKey: projectQueryKeys.readFile(input.cwd, variables.relativePath),
      });
    },
  });
}
