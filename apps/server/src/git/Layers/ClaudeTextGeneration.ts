/**
 * ClaudeTextGenerationLive - Claude (subscription) implementation of TextGeneration.
 *
 * Uses `@anthropic-ai/claude-agent-sdk`'s `query()` function — the same
 * mechanism used for all Claude chat in this app — so no separate API key is
 * needed.  Generation runs through the user's existing Claude subscription.
 *
 * @module ClaudeTextGenerationLive
 */
import { randomUUID } from "node:crypto";

import { Effect, FileSystem, Layer, Option, Path } from "effect";
import {
  query,
  type CanUseTool,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { TextGenerationError } from "../Errors.ts";
import {
  type BranchNameGenerationInput,
  type BranchNameGenerationResult,
  type CommitMessageGenerationResult,
  type PrContentGenerationResult,
  type TextGenerationShape,
  TextGeneration,
} from "../Services/TextGeneration.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default Claude model used when the caller doesn't specify one. */
const DEFAULT_CLAUDE_TEXT_GENERATION_MODEL = "claude-haiku-4-5";

/** Abort timeout for a single generation request. */
const CLAUDE_GENERATION_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function limitSection(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n\n[truncated]`;
}

function sanitizeCommitSubject(raw: string): string {
  const singleLine = raw.trim().split(/\r?\n/g)[0]?.trim() ?? "";
  const withoutPeriod = singleLine.replace(/[.]+$/g, "").trim();
  if (withoutPeriod.length === 0) return "Update project files";
  return withoutPeriod.length <= 72 ? withoutPeriod : withoutPeriod.slice(0, 72).trimEnd();
}

function sanitizePrTitle(raw: string): string {
  const singleLine = raw.trim().split(/\r?\n/g)[0]?.trim() ?? "";
  return singleLine.length > 0 ? singleLine : "Update project changes";
}

/** Maps a model slug to a valid Claude model ID, falling back to the default. */
function resolveClaudeModel(model: string | undefined): string {
  if (!model) return DEFAULT_CLAUDE_TEXT_GENERATION_MODEL;
  if (model.startsWith("claude-")) return model;
  // Codex/GPT model slugs are not valid for Claude — use the default
  return DEFAULT_CLAUDE_TEXT_GENERATION_MODEL;
}

// ---------------------------------------------------------------------------
// Minimal MessageParam-compatible types (avoids importing @anthropic-ai/sdk directly)
// ---------------------------------------------------------------------------

type ImageContentBlock = {
  type: "image";
  source: { type: "base64"; media_type: string; data: string };
};

type TextContentBlock = { type: "text"; text: string };

type UserMessageParam = {
  role: "user";
  content: Array<ImageContentBlock | TextContentBlock>;
};

// ---------------------------------------------------------------------------
// Core runner
// ---------------------------------------------------------------------------

/**
 * Runs a single-turn Claude query and returns the text result.
 *
 * Uses `query()` from `@anthropic-ai/claude-agent-sdk` so it authenticates
 * through the user's Claude subscription (same as the chat feature).
 * All tool use is denied so Claude just returns a plain text response.
 */
const runClaudeQuery = (
  operation: "generateCommitMessage" | "generatePrContent" | "generateBranchName",
  model: string,
  prompt: string | AsyncIterable<SDKUserMessage>,
): Effect.Effect<string, TextGenerationError> => {
  const abortController = new AbortController();

  // Deny every tool request — we only want a plain text response.
  const canUseTool: CanUseTool = () =>
    Promise.resolve({ behavior: "deny", message: "No tools needed for text generation." });

  const run = Effect.gen(function* () {
    const queryRun = query({
      prompt,
      options: {
        model,
        maxTurns: 1,
        effort: "low",
        persistSession: false,
        env: process.env,
        abortController,
        canUseTool,
      },
    });

    let resultText: string | undefined;

    yield* Effect.tryPromise({
      try: async () => {
        for await (const message of queryRun as AsyncIterable<SDKMessage>) {
          if (message.type === "result") {
            if (message.subtype === "success") {
              resultText = message.result;
            } else {
              const detail =
                message.errors?.[0] ??
                `Claude query ended with subtype: ${message.subtype}`;
              throw new TextGenerationError({ operation, detail });
            }
          }
        }
      },
      catch: (cause) => {
        if (cause instanceof TextGenerationError) return cause;
        return new TextGenerationError({
          operation,
          detail: `Claude generation error: ${cause instanceof Error ? cause.message : String(cause)}`,
          cause: cause instanceof Error ? cause : undefined,
        });
      },
    });

    if (resultText === undefined) {
      return yield* new TextGenerationError({
        operation,
        detail: "Claude returned no result message.",
      });
    }

    return resultText;
  });

  return run.pipe(
    Effect.scoped,
    Effect.timeoutOption(CLAUDE_GENERATION_TIMEOUT_MS),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.flatMap(Effect.sync(() => abortController.abort()), () =>
            Effect.fail(
              new TextGenerationError({ operation, detail: "Claude generation timed out." }),
            ),
          ),
        onSome: (result) => Effect.succeed(result),
      }),
    ),
  );
};

// ---------------------------------------------------------------------------
// JSON extraction
// ---------------------------------------------------------------------------

function extractJson<T>(
  operation: "generateCommitMessage" | "generatePrContent" | "generateBranchName",
  text: string,
): Effect.Effect<T, TextGenerationError> {
  return Effect.try({
    try: () => {
      // Strip optional markdown code fences (```json ... ``` or ``` ... ```)
      const stripped = text
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```\s*$/i, "")
        .trim();
      return JSON.parse(stripped) as T;
    },
    catch: (cause) =>
      new TextGenerationError({
        operation,
        detail: `Claude returned invalid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
        cause: cause instanceof Error ? cause : undefined,
      }),
  });
}

// ---------------------------------------------------------------------------
// Layer
// ---------------------------------------------------------------------------

const makeClaudeTextGeneration = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* Effect.service(ServerConfig);

  // -------------------------------------------------------------------------
  // generateCommitMessage
  // -------------------------------------------------------------------------

  const generateCommitMessage: TextGenerationShape["generateCommitMessage"] = (input) => {
    const wantsBranch = input.includeBranch === true;
    const model = resolveClaudeModel(input.model);
    const jsonShape = wantsBranch
      ? '{"subject":"...","body":"...","branch":"..."}'
      : '{"subject":"...","body":"..."}';

    const prompt = [
      "You write concise git commit messages.",
      `Respond with ONLY valid JSON matching: ${jsonShape}`,
      "Rules:",
      "- subject must be imperative, <= 72 chars, no trailing period",
      "- body can be an empty string or short bullet points",
      ...(wantsBranch
        ? ["- branch must be a short semantic git branch fragment for this change"]
        : []),
      "- capture the primary user-visible or developer-visible change",
      "",
      `Branch: ${input.branch ?? "(detached)"}`,
      "",
      "Staged files:",
      limitSection(input.stagedSummary, 6_000),
      "",
      "Staged patch:",
      limitSection(input.stagedPatch, 40_000),
    ].join("\n");

    return runClaudeQuery("generateCommitMessage", model, prompt).pipe(
      Effect.flatMap((text) =>
        extractJson<{ subject: string; body: string; branch?: string }>(
          "generateCommitMessage",
          text,
        ),
      ),
      Effect.map(
        (generated): CommitMessageGenerationResult => ({
          subject: sanitizeCommitSubject(generated.subject ?? ""),
          body: (generated.body ?? "").trim(),
          ...(wantsBranch && typeof generated.branch === "string"
            ? { branch: sanitizeFeatureBranchName(generated.branch) }
            : {}),
        }),
      ),
    );
  };

  // -------------------------------------------------------------------------
  // generatePrContent
  // -------------------------------------------------------------------------

  const generatePrContent: TextGenerationShape["generatePrContent"] = (input) => {
    const model = resolveClaudeModel(input.model);

    const prompt = [
      "You write GitHub pull request content.",
      'Respond with ONLY valid JSON matching: {"title":"...","body":"..."}',
      "Rules:",
      "- title should be concise and specific",
      "- body must be markdown with headings '## Summary' and '## Testing'",
      "- under Summary, provide short bullet points",
      "- under Testing, include bullet points with concrete checks or 'Not run' where appropriate",
      "",
      `Base branch: ${input.baseBranch}`,
      `Head branch: ${input.headBranch}`,
      "",
      "Commits:",
      limitSection(input.commitSummary, 12_000),
      "",
      "Diff stat:",
      limitSection(input.diffSummary, 12_000),
      "",
      "Diff patch:",
      limitSection(input.diffPatch, 40_000),
    ].join("\n");

    return runClaudeQuery("generatePrContent", model, prompt).pipe(
      Effect.flatMap((text) =>
        extractJson<{ title: string; body: string }>("generatePrContent", text),
      ),
      Effect.map(
        (generated): PrContentGenerationResult => ({
          title: sanitizePrTitle(generated.title ?? ""),
          body: (generated.body ?? "").trim(),
        }),
      ),
    );
  };

  // -------------------------------------------------------------------------
  // generateBranchName
  // -------------------------------------------------------------------------

  const generateBranchName: TextGenerationShape["generateBranchName"] = (input) =>
    Effect.gen(function* () {
      const model = resolveClaudeModel(input.model);

      // Collect image attachments as base64 for inclusion in the message.
      const imageContentBlocks: ImageContentBlock[] = [];

      if (input.attachments && input.attachments.length > 0) {
        for (const attachment of input.attachments) {
          if (attachment.type !== "image") continue;
          const resolvedPath = resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment,
          });
          if (!resolvedPath || !path.isAbsolute(resolvedPath)) continue;
          const fileInfo = yield* fileSystem
            .stat(resolvedPath)
            .pipe(Effect.catch(() => Effect.succeed(null)));
          if (!fileInfo || fileInfo.type !== "File") continue;
          const data = yield* fileSystem
            .readFile(resolvedPath)
            .pipe(Effect.catch(() => Effect.succeed(null)));
          if (!data) continue;
          imageContentBlocks.push({
            type: "image",
            source: {
              type: "base64",
              media_type: attachment.mimeType ?? "image/png",
              data: Buffer.from(data).toString("base64"),
            },
          });
        }
      }

      const attachmentMeta = (input.attachments ?? []).map(
        (a) => `- ${a.name} (${a.mimeType}, ${a.sizeBytes} bytes)`,
      );

      const textContent = [
        "You generate concise git branch names.",
        'Respond with ONLY valid JSON matching: {"branch":"..."}',
        "Rules:",
        "- Describe the requested work from the user message.",
        "- Keep it short and specific (2-6 words).",
        "- Use plain words only, no issue prefixes and no punctuation-heavy text.",
        ...(imageContentBlocks.length > 0
          ? ["- Images are attached — use them as primary context for visual/UI issues."]
          : []),
        "",
        "User message:",
        limitSection(input.message, 8_000),
        ...(attachmentMeta.length > 0
          ? ["", "Attachment metadata:", limitSection(attachmentMeta.join("\n"), 4_000)]
          : []),
      ].join("\n");

      // Build the prompt: use a multi-modal MessageParam with image blocks when
      // available, otherwise fall back to a plain string for the simpler path.
      let prompt: string | AsyncIterable<SDKUserMessage>;

      if (imageContentBlocks.length > 0) {
        const messageParam: UserMessageParam = {
          role: "user",
          content: [
            ...imageContentBlocks,
            { type: "text", text: textContent },
          ],
        };
        const sessionId = randomUUID();
        const userMessage: SDKUserMessage = {
          type: "user",
          // Cast to satisfy the SDK's MessageParam type which is imported from
          // @anthropic-ai/sdk — our local UserMessageParam is structurally identical.
          message: messageParam as SDKUserMessage["message"],
          parent_tool_use_id: null,
          session_id: sessionId,
        };
        prompt = (async function* () {
          yield userMessage;
        })();
      } else {
        prompt = textContent;
      }

      const text = yield* runClaudeQuery("generateBranchName", model, prompt);
      const generated = yield* extractJson<{ branch: string }>("generateBranchName", text);

      return {
        branch: sanitizeBranchFragment(generated.branch ?? ""),
      } satisfies BranchNameGenerationResult;
    });

  // -------------------------------------------------------------------------

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
  } satisfies TextGenerationShape;
});

export const ClaudeTextGenerationLive = Layer.effect(TextGeneration, makeClaudeTextGeneration);
