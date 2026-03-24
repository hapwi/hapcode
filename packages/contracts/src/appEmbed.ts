/**
 * App Embed Protocol — shared types for embedded app windows (VS Code, Cursor, etc.)
 *
 * Defines the WebSocket message shapes exchanged between client and server to
 * manage the lifecycle of embedded application processes (code-server, etc.).
 *
 * @module AppEmbed
 */
import { Schema } from "effect";
import { TrimmedNonEmptyString } from "./baseSchemas";

// ── App Status ────────────────────────────────────────────────────────

export const AppEmbedStatus = Schema.Literals(["starting", "running", "error", "stopped"]);
export type AppEmbedStatus = typeof AppEmbedStatus.Type;

export const AppEmbedType = Schema.Literals(["vscode", "cursor"]);
export type AppEmbedType = typeof AppEmbedType.Type;

// ── Client → Server messages ──────────────────────────────────────────

export const AppEmbedStartInput = Schema.Struct({
  windowId: TrimmedNonEmptyString,
  appType: AppEmbedType,
  cwd: TrimmedNonEmptyString,
});
export type AppEmbedStartInput = typeof AppEmbedStartInput.Type;

export const AppEmbedStopInput = Schema.Struct({
  windowId: TrimmedNonEmptyString,
});
export type AppEmbedStopInput = typeof AppEmbedStopInput.Type;

export const AppEmbedStatusInput = Schema.Struct({
  windowId: TrimmedNonEmptyString,
});
export type AppEmbedStatusInput = typeof AppEmbedStatusInput.Type;

// ── Server → Client push events ───────────────────────────────────────

export const AppEmbedEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("app.started"),
    windowId: TrimmedNonEmptyString,
    port: Schema.Number,
    url: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    type: Schema.Literal("app.error"),
    windowId: TrimmedNonEmptyString,
    message: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("app.stopped"),
    windowId: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    type: Schema.Literal("app.status"),
    windowId: TrimmedNonEmptyString,
    status: AppEmbedStatus,
    url: Schema.optional(Schema.String),
    port: Schema.optional(Schema.Number),
  }),
]);
export type AppEmbedEvent = typeof AppEmbedEvent.Type;

// ── WS Method & Channel Constants ─────────────────────────────────────

export const APP_EMBED_WS_METHODS = {
  appStart: "app.start",
  appStop: "app.stop",
  appStatus: "app.status",
} as const;

export const APP_EMBED_WS_CHANNELS = {
  appEvent: "app.event",
} as const;
