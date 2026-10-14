import { z } from "zod";

/**
 * Message and content shapes as they appear on the RPC wire.
 *
 * Every object schema is loose: pi adds fields between minor versions and a
 * client that rejects unknown keys would break on upgrade. Validation here is
 * for "can I safely read the fields I care about", not for exhaustiveness.
 */

export const UsageCostSchema = z.looseObject({
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  total: z.number(),
});

export const UsageSchema = z.looseObject({
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  totalTokens: z.number().optional(),
  cost: UsageCostSchema.optional(),
});
export type Usage = z.infer<typeof UsageSchema>;

export const TextContentSchema = z.looseObject({
  type: z.literal("text"),
  text: z.string(),
});

export const ThinkingContentSchema = z.looseObject({
  type: z.literal("thinking"),
  thinking: z.string(),
});

export const ImageContentSchema = z.looseObject({
  type: z.literal("image"),
  /** Empty when the daemon sent `ref` instead: the bytes are fetched apart. */
  data: z.string(),
  mimeType: z.string(),
  /** Name to fetch the bytes by from the daemon's `/image` route. */
  ref: z.string().optional(),
  /** Pixel size, so the space is reserved before the bytes arrive. */
  width: z.number().optional(),
  height: z.number().optional(),
});
export type ImageContent = z.infer<typeof ImageContentSchema>;

export const ToolCallSchema = z.looseObject({
  type: z.literal("toolCall").optional(),
  id: z.string(),
  name: z.string(),
  arguments: z.unknown(),
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

export const AssistantContentSchema = z.union([
  TextContentSchema,
  ThinkingContentSchema,
  ImageContentSchema,
  ToolCallSchema.extend({ type: z.literal("toolCall") }),
]);
export type AssistantContent = z.infer<typeof AssistantContentSchema>;

export const UserContentSchema = z.union([TextContentSchema, ImageContentSchema]);

export const UserMessageSchema = z.looseObject({
  role: z.literal("user"),
  content: z.union([z.string(), z.array(UserContentSchema)]),
  timestamp: z.number().optional(),
});

export const AssistantMessageSchema = z.looseObject({
  role: z.literal("assistant"),
  content: z.array(AssistantContentSchema),
  api: z.string().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  usage: UsageSchema.optional(),
  /** `stop`, `toolUse`, `length`, `error` or `aborted`; open-ended on the wire. */
  stopReason: z.string().optional(),
  /** Set with `stopReason: "error"`: the provider failure, verbatim. */
  errorMessage: z.string().optional(),
  timestamp: z.number().optional(),
});
export type AssistantMessage = z.infer<typeof AssistantMessageSchema>;

export const ToolResultMessageSchema = z.looseObject({
  role: z.literal("toolResult"),
  toolCallId: z.string(),
  toolName: z.string(),
  content: z.array(z.union([TextContentSchema, ImageContentSchema])),
  isError: z.boolean().optional(),
  usage: UsageSchema.optional(),
  timestamp: z.number().optional(),
});

export const BashExecutionMessageSchema = z.looseObject({
  role: z.literal("bashExecution"),
  command: z.string(),
  output: z.string(),
  exitCode: z.number().nullable(),
  cancelled: z.boolean().optional(),
  truncated: z.boolean().optional(),
  fullOutputPath: z.string().nullable().optional(),
  timestamp: z.number().optional(),
  /** Ran with `!!`: shown in the transcript, never sent to the model. */
  excludeFromContext: z.boolean().optional(),
});

/**
 * The prompt pi assembled for the turn. It is part of the transcript on the
 * wire but never part of the conversation: rejecting it would fail every
 * `get_entries` and drop every `message_start`.
 */
export const SystemMessageSchema = z.looseObject({
  role: z.literal("system"),
  content: z.string(),
  timestamp: z.number().optional(),
});

export const AgentMessageSchema = z.discriminatedUnion("role", [
  SystemMessageSchema,
  UserMessageSchema,
  AssistantMessageSchema,
  ToolResultMessageSchema,
  BashExecutionMessageSchema,
]);
export type AgentMessage = z.infer<typeof AgentMessageSchema>;

/**
 * A session entry: the append-only tree node whose `id` is the resume cursor.
 */
export const SessionEntrySchema = z.looseObject({
  id: z.string(),
  parentId: z.string().nullable().optional(),
  type: z.string(),
  timestamp: z.union([z.string(), z.number()]).optional(),
  message: AgentMessageSchema.optional(),
});
export type SessionEntry = z.infer<typeof SessionEntrySchema>;

/**
 * Blocks pi (or a client) injects into the user's first message. They are
 * long, machine-facing, and would otherwise become the session's name.
 */
const INJECTED_TAGS = [
  "skill",
  "available_skills",
  "system-reminder",
  "project_context",
  "project_instructions",
  "environment",
  "context",
];

const INJECTED_BLOCKS = new RegExp(
  `<(${INJECTED_TAGS.join("|")})(\\s[^>]*)?>[\\s\\S]*?</\\1>|<(${INJECTED_TAGS.join("|")})(\\s[^>]*)?/?>`,
  "gi",
);

/**
 * A pasted image reaches the agent as a temp file path, which is noise in a
 * session name.
 */
const PASTED_IMAGE_PATH =
  /(^|\s)\/tmp\/[\w.-]*\.(png|jpe?g|gif|webp|bmp)(?=\s|$)/gi;

/**
 * Message text as a human-facing one-liner. Injected blocks collapse to a
 * short tag so a skill-only message still says which skill it was.
 */
export function previewText(text: string): string {
  const collapsed = text
    .replace(
      INJECTED_BLOCKS,
      (
        _match,
        pairTag?: string,
        pairAttrs?: string,
        loneTag?: string,
        loneAttrs?: string,
      ) => {
        const label = (pairTag ?? loneTag ?? "").toLowerCase();
        const attrs = pairAttrs ?? loneAttrs ?? "";
        const name = /name\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1];
        return ` <${name ? `${label}:${name}` : label}> `;
      },
    )
    .replace(PASTED_IMAGE_PATH, " <image> ")
    .replace(/\s+/g, " ")
    .trim();
  return collapsed || text.trim().replace(/\s+/g, " ");
}

/**
 * A message as a one-line name: image parts keep their place as `<image>`,
 * so a screenshot-only message is not a blank row.
 */
export function messagePreview(message: AgentMessage): string {
  if (message.role !== "user" || typeof message.content === "string") {
    return previewText(messageText(message));
  }
  const parts = message.content.map((part) =>
    part.type === "image" ? "<image>" : part.text,
  );
  return previewText(parts.join(" "));
}

/**
 * A provider error as one readable line.
 *
 * pi reports HTTP failures as `<status>: <response body>`, and the body is the
 * provider's JSON envelope, which buries the one sentence a person needs.
 */
export function readableError(raw: string): string {
  const text = raw.trim();
  const match = /^(\d{3}):?\s*(\{[\s\S]*\})$/.exec(text);
  if (!match) return text;
  try {
    const body = JSON.parse(match[2]!);
    const message = body?.error?.message ?? body?.message;
    return typeof message === "string" && message.trim() ? `${match[1]}: ${message.trim()}` : text;
  } catch {
    return text;
  }
}

/** Why an assistant turn failed, or null when it did not. */
export function turnFailure(message: AgentMessage): string | null {
  if (message.role !== "assistant" || message.stopReason !== "error") return null;
  return readableError(message.errorMessage ?? "") || "The model request failed.";
}

/** Text of a message, ignoring thinking and tool calls. */
export function messageText(message: AgentMessage): string {
  if (message.role === "bashExecution") return message.output;
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((c): c is z.infer<typeof TextContentSchema> => c.type === "text")
    .map((c) => c.text)
    .join("");
}
