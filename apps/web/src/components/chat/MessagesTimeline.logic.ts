export interface TimelineDurationMessage {
  id: string;
  role: "user" | "assistant" | "system";
  createdAt: string;
  completedAt?: string | undefined;
}

export function computeMessageDurationStart(
  messages: ReadonlyArray<TimelineDurationMessage>,
): Map<string, string> {
  const result = new Map<string, string>();
  let lastBoundary: string | null = null;

  for (const message of messages) {
    if (message.role === "user") {
      lastBoundary = message.createdAt;
    }
    result.set(message.id, lastBoundary ?? message.createdAt);
    if (message.role === "assistant" && message.completedAt) {
      lastBoundary = message.completedAt;
    }
  }

  return result;
}

export function normalizeCompactToolLabel(value: string): string {
  let label = value.replace(/\s+(?:complete|completed)\s*$/i, "").trim();
  // Strip raw JSON payloads from labels like "Read: {\"file_path\":...}" or "Grep:\n{...}"
  const jsonSuffix = label.search(/:\s*\{/);
  if (jsonSuffix !== -1) {
    label = label.slice(0, jsonSuffix).trim();
  }
  return label;
}
