import { ChevronRightIcon, FolderIcon, FolderOpenIcon, SearchIcon } from "lucide-react";
import { memo, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import {
  projectListDirQueryOptions,
  projectSearchEntriesQueryOptions,
} from "~/lib/projectReactQuery";
import { gitStatusQueryOptions } from "~/lib/gitReactQuery";
import { useEditorStore } from "./editorStore";
import { VscodeEntryIcon } from "../chat/VscodeEntryIcon";
import { ScrollArea } from "../ui/scroll-area";
import { cn } from "~/lib/utils";

interface EditorFileTreeProps {
  cwd: string;
  resolvedTheme: "light" | "dark";
  /** Optional callback to override file selection (instead of editorStore.openFile) */
  onFileSelect?: (relativePath: string) => void;
  /** Optional active file path to override editorStore.activeTabPath for highlighting */
  activeFilePath?: string | null;
  /** Optional width override (defaults to editorStore.fileTreeWidth) */
  width?: number;
}

export const EditorFileTree = memo(function EditorFileTree(props: EditorFileTreeProps) {
  const { cwd, resolvedTheme, onFileSelect, activeFilePath, width } = props;
  const fileTreeWidth = useEditorStore((s) => s.fileTreeWidth);
  const effectiveWidth = width ?? fileTreeWidth;
  const [searchQuery, setSearchQuery] = useState("");
  const gitStatusQuery = useQuery(gitStatusQueryOptions(cwd));
  const changedFilePaths = useMemo(
    () => new Set((gitStatusQuery.data?.workingTree.files ?? []).map((file) => file.path)),
    [gitStatusQuery.data?.workingTree.files],
  );
  const changedDirectoryPaths = useMemo(() => {
    const paths = new Set<string>();
    changedFilePaths.forEach((filePath) => {
      const segments = filePath.split("/");
      for (let index = 1; index < segments.length; index += 1) {
        paths.add(segments.slice(0, index).join("/"));
      }
    });
    return paths;
  }, [changedFilePaths]);

  return (
    <div
      className="flex h-full shrink-0 flex-col border-r border-border bg-card/30"
      style={{ width: `${effectiveWidth}px` }}
    >
      <div className="flex items-center gap-1.5 border-b border-border/50 px-2 py-1.5">
        <SearchIcon className="size-3 shrink-0 text-muted-foreground/60" />
        <input
          type="text"
          placeholder="Search files..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="min-w-0 flex-1 bg-transparent text-[11px] text-foreground placeholder:text-muted-foreground/50 outline-none"
        />
      </div>
      <ScrollArea className="flex-1" scrollFade>
        <div className="py-1">
          {searchQuery.length > 0 ? (
            <SearchResults
              changedFilePaths={changedFilePaths}
              cwd={cwd}
              query={searchQuery}
              resolvedTheme={resolvedTheme}
              {...(onFileSelect ? { onFileSelect } : {})}
              {...(activeFilePath !== undefined ? { activeFilePath } : {})}
            />
          ) : (
            <DirectoryNode
              changedDirectoryPaths={changedDirectoryPaths}
              changedFilePaths={changedFilePaths}
              cwd={cwd}
              relativePath=""
              depth={0}
              resolvedTheme={resolvedTheme}
              {...(onFileSelect ? { onFileSelect } : {})}
              {...(activeFilePath !== undefined ? { activeFilePath } : {})}
            />
          )}
        </div>
      </ScrollArea>
    </div>
  );
});

function SearchResults(props: {
  changedFilePaths: ReadonlySet<string>;
  cwd: string;
  query: string;
  resolvedTheme: "light" | "dark";
  onFileSelect?: (relativePath: string) => void;
  activeFilePath?: string | null;
}) {
  const { changedFilePaths, cwd, query, resolvedTheme, onFileSelect, activeFilePath } = props;
  const storeOpenFile = useEditorStore((s) => s.openFile);
  const storeActiveTabPath = useEditorStore((s) => s.activeTabPath);
  const openFile = onFileSelect ?? storeOpenFile;
  const activeTabPath = activeFilePath !== undefined ? activeFilePath : storeActiveTabPath;
  const { data } = useQuery(projectSearchEntriesQueryOptions({ cwd, query, limit: 30 }));

  if (!data || data.entries.length === 0) {
    return (
      <div className="px-3 py-4 text-center text-[11px] text-muted-foreground/60">No results</div>
    );
  }

  return (
    <div className="space-y-0.5">
      {data.entries
        .filter((e) => e.kind === "file")
        .map((entry) => (
          <button
            key={entry.path}
            type="button"
            className={cn(
              "flex w-full items-center gap-1.5 rounded-sm px-2 py-1 text-left",
              activeTabPath === entry.path && "bg-accent/20",
            )}
            onClick={() => openFile(entry.path)}
          >
            <VscodeEntryIcon
              pathValue={entry.path}
              kind="file"
              theme={resolvedTheme}
              className="size-3.5 shrink-0"
            />
            <span className="truncate font-mono text-[11px] text-muted-foreground/80">
              {entry.path}
            </span>
            {changedFilePaths.has(entry.path) && (
              <span className="ml-auto size-1.5 shrink-0 rounded-full bg-warning" />
            )}
          </button>
        ))}
    </div>
  );
}

const DirectoryNode = memo(function DirectoryNode(props: {
  changedDirectoryPaths: ReadonlySet<string>;
  changedFilePaths: ReadonlySet<string>;
  cwd: string;
  relativePath: string;
  depth: number;
  resolvedTheme: "light" | "dark";
  onFileSelect?: (relativePath: string) => void;
  activeFilePath?: string | null;
}) {
  const {
    changedDirectoryPaths,
    changedFilePaths,
    cwd,
    relativePath,
    resolvedTheme,
    onFileSelect,
    activeFilePath,
  } = props;
  const expandedDirs = useEditorStore((s) => s.expandedDirs);
  const storeOpenFile = useEditorStore((s) => s.openFile);
  const storeActiveTabPath = useEditorStore((s) => s.activeTabPath);
  const openFile = onFileSelect ?? storeOpenFile;
  const activeTabPath = activeFilePath !== undefined ? activeFilePath : storeActiveTabPath;

  // Root is always expanded
  const isExpanded = relativePath === "" ? true : (expandedDirs[relativePath] ?? false);
  const { data } = useQuery(projectListDirQueryOptions({ cwd, relativePath, enabled: isExpanded }));

  if (relativePath === "") {
    // Root: render children directly
    if (!data) return null;
    return (
      <div className="space-y-0.5">
        {data.entries.map((entry) => {
          const entryPath = entry.name;
          if (entry.kind === "directory") {
            return (
              <DirectoryEntry
                key={`dir:${entryPath}`}
                cwd={cwd}
                changedDirectoryPaths={changedDirectoryPaths}
                changedFilePaths={changedFilePaths}
                relativePath={entryPath}
                name={entry.name}
                depth={0}
                resolvedTheme={resolvedTheme}
                {...(onFileSelect ? { onFileSelect } : {})}
                {...(activeFilePath !== undefined ? { activeFilePath } : {})}
              />
            );
          }
          return (
            <FileEntry
              key={`file:${entryPath}`}
              relativePath={entryPath}
              name={entry.name}
              depth={0}
              isChanged={changedFilePaths.has(entryPath)}
              resolvedTheme={resolvedTheme}
              isActive={activeTabPath === entryPath}
              onOpen={() => openFile(entryPath)}
            />
          );
        })}
      </div>
    );
  }

  return null;
});

const DirectoryEntry = memo(function DirectoryEntry(props: {
  changedDirectoryPaths: ReadonlySet<string>;
  changedFilePaths: ReadonlySet<string>;
  cwd: string;
  relativePath: string;
  name: string;
  depth: number;
  resolvedTheme: "light" | "dark";
  onFileSelect?: (relativePath: string) => void;
  activeFilePath?: string | null;
}) {
  const {
    changedDirectoryPaths,
    changedFilePaths,
    cwd,
    relativePath,
    name,
    depth,
    resolvedTheme,
    onFileSelect,
    activeFilePath,
  } = props;
  const expandedDirs = useEditorStore((s) => s.expandedDirs);
  const toggleDir = useEditorStore((s) => s.toggleDir);
  const storeOpenFile = useEditorStore((s) => s.openFile);
  const storeActiveTabPath = useEditorStore((s) => s.activeTabPath);
  const openFile = onFileSelect ?? storeOpenFile;
  const activeTabPath = activeFilePath !== undefined ? activeFilePath : storeActiveTabPath;
  const isExpanded = expandedDirs[relativePath] ?? false;

  const { data } = useQuery(projectListDirQueryOptions({ cwd, relativePath, enabled: isExpanded }));

  const leftPadding = 8 + depth * 14;
  const isChangedDirectory = changedDirectoryPaths.has(relativePath);

  return (
    <div>
      <button
        type="button"
        className={cn("group flex w-full items-center gap-1.5 rounded-sm py-1 pr-2 text-left")}
        style={{ paddingLeft: `${leftPadding}px` }}
        onClick={() => toggleDir(relativePath)}
      >
        <ChevronRightIcon
          aria-hidden="true"
          className={cn(
            "size-3 shrink-0 text-muted-foreground/70 transition-transform",
            isExpanded && "rotate-90",
          )}
        />
        {isExpanded ? (
          <FolderOpenIcon className="size-3.5 shrink-0 text-muted-foreground/75" />
        ) : (
          <FolderIcon className="size-3.5 shrink-0 text-muted-foreground/75" />
        )}
        <span className={cn("truncate font-mono text-[11px] text-muted-foreground/90")}>
          {name}
        </span>
        {isChangedDirectory && (
          <span className="ml-auto size-1.5 shrink-0 rounded-full bg-warning" />
        )}
      </button>
      {isExpanded && data && (
        <div className="space-y-0.5">
          {data.entries.map((entry) => {
            const entryPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
            if (entry.kind === "directory") {
              return (
                <DirectoryEntry
                  key={`dir:${entryPath}`}
                  cwd={cwd}
                  changedDirectoryPaths={changedDirectoryPaths}
                  changedFilePaths={changedFilePaths}
                  relativePath={entryPath}
                  name={entry.name}
                  depth={depth + 1}
                  resolvedTheme={resolvedTheme}
                  {...(onFileSelect ? { onFileSelect } : {})}
                  {...(activeFilePath !== undefined ? { activeFilePath } : {})}
                />
              );
            }
            return (
              <FileEntry
                key={`file:${entryPath}`}
                relativePath={entryPath}
                name={entry.name}
                depth={depth + 1}
                isChanged={changedFilePaths.has(entryPath)}
                resolvedTheme={resolvedTheme}
                isActive={activeTabPath === entryPath}
                onOpen={() => openFile(entryPath)}
              />
            );
          })}
        </div>
      )}
    </div>
  );
});

const FileEntry = memo(function FileEntry(props: {
  relativePath: string;
  name: string;
  depth: number;
  isChanged: boolean;
  resolvedTheme: "light" | "dark";
  isActive: boolean;
  onOpen: () => void;
}) {
  const { relativePath, name, depth, isChanged, resolvedTheme, isActive, onOpen } = props;
  const leftPadding = 8 + depth * 14;

  return (
    <button
      type="button"
      className={cn(
        "group flex w-full items-center gap-1.5 rounded-sm py-1 pr-2 text-left",
        isActive && "bg-accent/20",
      )}
      style={{ paddingLeft: `${leftPadding + 14}px` }}
      onClick={onOpen}
      title={relativePath}
    >
      <VscodeEntryIcon
        pathValue={relativePath}
        kind="file"
        theme={resolvedTheme}
        className="size-3.5 shrink-0 text-muted-foreground/70"
      />
      <span className={cn("truncate font-mono text-[11px] text-muted-foreground/80")}>{name}</span>
      {isChanged && <span className="ml-auto size-1.5 shrink-0 rounded-full bg-warning" />}
    </button>
  );
});
