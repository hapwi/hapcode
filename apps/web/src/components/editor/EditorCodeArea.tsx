import { DiffsHighlighter, getSharedHighlighter, SupportedLanguages } from "@pierre/diffs";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

import { useTheme } from "~/hooks/useTheme";
import { resolveDiffThemeName, type DiffThemeName } from "~/lib/diffRendering";
import { projectReadFileQueryOptions } from "~/lib/projectReactQuery";
import { cn } from "~/lib/utils";
import { Skeleton } from "../ui/skeleton";

const highlighterPromiseCache = new Map<string, Promise<DiffsHighlighter>>();
const highlightedFileHtmlCache = new Map<string, string>();

function resolveViewerLanguage(relativePath: string): string {
  const name = relativePath.split("/").pop()?.toLowerCase() ?? "";
  if (name === "dockerfile") return "dockerfile";
  if (name === "makefile") return "makefile";

  const extensionIndex = name.lastIndexOf(".");
  if (extensionIndex === -1) return "text";

  const extension = name.slice(extensionIndex + 1);
  const extensionLanguageMap: Record<string, string> = {
    bash: "bash",
    c: "c",
    cjs: "javascript",
    cpp: "cpp",
    css: "css",
    go: "go",
    gql: "graphql",
    graphql: "graphql",
    h: "c",
    hpp: "cpp",
    htm: "html",
    html: "html",
    ini: "ini",
    java: "java",
    js: "javascript",
    json: "json",
    jsonc: "jsonc",
    jsx: "jsx",
    kt: "kotlin",
    less: "less",
    md: "markdown",
    mdx: "mdx",
    mjs: "javascript",
    php: "php",
    py: "python",
    rb: "ruby",
    rs: "rust",
    scss: "scss",
    sh: "bash",
    sql: "sql",
    svg: "xml",
    svelte: "svelte",
    swift: "swift",
    toml: "toml",
    ts: "typescript",
    tsx: "tsx",
    vue: "vue",
    xml: "xml",
    yaml: "yaml",
    yml: "yaml",
    zsh: "bash",
  };

  return extensionLanguageMap[extension] ?? "text";
}

function getHighlighterPromise(language: string): Promise<DiffsHighlighter> {
  const cached = highlighterPromiseCache.get(language);
  if (cached) return cached;

  const promise = getSharedHighlighter({
    themes: [resolveDiffThemeName("dark"), resolveDiffThemeName("light")],
    langs: [language as SupportedLanguages],
    preferredHighlighter: "shiki-js",
  }).catch((error) => {
    highlighterPromiseCache.delete(language);
    if (language === "text") throw error;
    return getHighlighterPromise("text");
  });

  highlighterPromiseCache.set(language, promise);
  return promise;
}

function renderFileHtml(
  highlighter: DiffsHighlighter,
  code: string,
  language: string,
  themeName: DiffThemeName,
): string {
  try {
    return highlighter.codeToHtml(code, { lang: language, theme: themeName });
  } catch {
    return highlighter.codeToHtml(code, { lang: "text", theme: themeName });
  }
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderPlainFileHtml(code: string): string {
  const lines = code.split("\n");
  return [
    '<pre class="shiki"><code>',
    ...lines.map((line) => `<span class="line">${line.length > 0 ? escapeHtml(line) : " "}</span>`),
    "</code></pre>",
  ].join("");
}

function HighlightedReadonlyFile(props: {
  contents: string;
  relativePath: string;
  themeName: DiffThemeName;
}) {
  const language = resolveViewerLanguage(props.relativePath);
  const cacheKey = useMemo(
    () => `${props.themeName}:${language}:${props.relativePath}:${props.contents}`,
    [language, props.contents, props.relativePath, props.themeName],
  );
  const [html, setHtml] = useState<string>(() => highlightedFileHtmlCache.get(cacheKey) ?? "");

  useEffect(() => {
    const cachedHtml = highlightedFileHtmlCache.get(cacheKey);
    if (cachedHtml) {
      setHtml(cachedHtml);
      return;
    }

    let cancelled = false;
    setHtml(renderPlainFileHtml(props.contents));

    void getHighlighterPromise(language)
      .then((highlighter) => renderFileHtml(highlighter, props.contents, language, props.themeName))
      .then((nextHtml) => {
        if (cancelled) return;
        highlightedFileHtmlCache.set(cacheKey, nextHtml);
        setHtml(nextHtml);
      })
      .catch(() => {
        if (cancelled) return;
        const plainHtml = renderPlainFileHtml(props.contents);
        highlightedFileHtmlCache.set(cacheKey, plainHtml);
        setHtml(plainHtml);
      });

    return () => {
      cancelled = true;
    };
  }, [cacheKey, language, props.contents, props.themeName]);

  return <div className="editor-readonly-code" dangerouslySetInnerHTML={{ __html: html }} />;
}

interface EditorCodeAreaProps {
  cwd: string;
  relativePath: string;
}

export function EditorCodeArea(props: EditorCodeAreaProps) {
  const { cwd, relativePath } = props;
  const { resolvedTheme } = useTheme();
  const { data, isFetching, isLoading, error } = useQuery(
    projectReadFileQueryOptions({ cwd, relativePath }),
  );
  const themeName = resolveDiffThemeName(resolvedTheme === "dark" ? "dark" : "light");

  if (isLoading && !data) {
    return (
      <div className="flex flex-1 flex-col gap-2 p-4">
        <Skeleton className="h-4 w-48 rounded-full" />
        <Skeleton className="h-4 w-64 rounded-full" />
        <Skeleton className="h-4 w-40 rounded-full" />
        <Skeleton className="h-4 w-56 rounded-full" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-1 items-center justify-center p-4 text-xs text-destructive">
        {error.message}
      </div>
    );
  }

  if (!data) return null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-border/50 px-3 py-1">
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-muted-foreground/60">{relativePath}</span>
          <span
            className={cn(
              "text-[10px] text-muted-foreground/45 transition-opacity",
              isFetching ? "opacity-100" : "opacity-0",
            )}
          >
            Refreshing...
          </span>
        </div>
      </div>
      <div className="editor-scroll-container">
        <HighlightedReadonlyFile
          contents={data.contents}
          relativePath={relativePath}
          themeName={themeName}
        />
      </div>
    </div>
  );
}
