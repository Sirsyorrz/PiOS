import { z } from "zod";
import { AgentEventSchema, ExtensionUiRequestSchema } from "./events.ts";
import { AgentMessageSchema, ImageContentSchema, SessionEntrySchema } from "./messages.ts";

/** Required on `prompt` while the agent is streaming; otherwise the command errors. */
export const StreamingBehaviorSchema = z.enum(["steer", "followUp"]);
export type StreamingBehavior = z.infer<typeof StreamingBehaviorSchema>;

const withId = <T extends z.ZodRawShape>(shape: T) =>
  z.object({ id: z.string().optional(), ...shape });

export const RpcCommandSchema = z.discriminatedUnion("type", [
  withId({
    type: z.literal("prompt"),
    message: z.string(),
    images: z.array(ImageContentSchema).optional(),
    streamingBehavior: StreamingBehaviorSchema.optional(),
  }),
  withId({
    type: z.literal("steer"),
    message: z.string(),
    images: z.array(ImageContentSchema).optional(),
  }),
  withId({
    type: z.literal("follow_up"),
    message: z.string(),
    images: z.array(ImageContentSchema).optional(),
  }),
  withId({ type: z.literal("abort") }),
  withId({ type: z.literal("get_state") }),
  withId({ type: z.literal("get_messages") }),
  withId({ type: z.literal("get_entries"), since: z.string().optional() }),
  withId({ type: z.literal("get_tree") }),
  withId({ type: z.literal("get_session_stats") }),
  withId({ type: z.literal("export_html"), outputPath: z.string().optional() }),
  withId({ type: z.literal("get_commands") }),
  withId({ type: z.literal("set_session_name"), name: z.string() }),
  withId({ type: z.literal("set_model"), provider: z.string(), modelId: z.string() }),
  withId({ type: z.literal("get_available_models") }),
  withId({ type: z.literal("set_thinking_level"), level: z.string() }),
  withId({ type: z.literal("get_available_thinking_levels") }),
  withId({ type: z.literal("compact"), customInstructions: z.string().optional() }),
  withId({ type: z.literal("set_auto_compaction"), enabled: z.boolean() }),
  withId({ type: z.literal("set_auto_retry"), enabled: z.boolean() }),
  withId({ type: z.literal("abort_retry") }),
  withId({
    type: z.literal("bash"),
    command: z.string(),
    /** Runs the command but keeps its output out of the LLM context (`!!`). */
    excludeFromContext: z.boolean().optional(),
  }),
  withId({ type: z.literal("abort_bash") }),
  withId({ type: z.literal("new_session"), parentSession: z.string().optional() }),
  withId({ type: z.literal("switch_session"), sessionPath: z.string() }),
  withId({ type: z.literal("fork"), entryId: z.string() }),
  withId({ type: z.literal("clone") }),
]);
export type RpcCommand = z.infer<typeof RpcCommandSchema>;
export type RpcCommandType = RpcCommand["type"];

export const ExtensionUiResponseSchema = z
  .object({
    type: z.literal("extension_ui_response"),
    id: z.string(),
    value: z.string().optional(),
    confirmed: z.boolean().optional(),
    cancelled: z.boolean().optional(),
  })
  .refine(
    (r) => r.value !== undefined || r.confirmed !== undefined || r.cancelled === true,
    "extension_ui_response must carry value, confirmed, or cancelled: true",
  );
export type ExtensionUiResponse = z.infer<typeof ExtensionUiResponseSchema>;

export const RpcResponseSchema = z.looseObject({
  type: z.literal("response"),
  command: z.string(),
  id: z.string().optional(),
  success: z.boolean(),
  data: z.unknown().optional(),
  error: z.string().optional(),
});
export type RpcResponse = z.infer<typeof RpcResponseSchema>;

/** Everything pi can write to stdout. */
export const RpcOutboundSchema = z.union([
  RpcResponseSchema,
  ExtensionUiRequestSchema,
  AgentEventSchema,
]);
export type RpcOutbound = z.infer<typeof RpcOutboundSchema>;

/** Everything a client can write to pi's stdin. */
export const RpcInboundSchema = z.union([RpcCommandSchema, ExtensionUiResponseSchema]);
export type RpcInbound = z.infer<typeof RpcInboundSchema>;

// Typed payloads for the responses the client actually reads.

export const GetEntriesDataSchema = z.looseObject({
  entries: z.array(SessionEntrySchema),
  leafId: z.string().nullable(),
});
export type GetEntriesData = z.infer<typeof GetEntriesDataSchema>;

/**
 * Token, cost and context accounting for one session.
 *
 * `contextUsage` is absent until pi knows the model's window, and its numbers
 * are null right after a compaction until a fresh response reports usage.
 */
export const SessionStatsSchema = z.looseObject({
  sessionFile: z.string().optional(),
  sessionId: z.string().optional(),
  userMessages: z.number().optional(),
  assistantMessages: z.number().optional(),
  toolCalls: z.number().optional(),
  toolResults: z.number().optional(),
  totalMessages: z.number().optional(),
  tokens: z
    .looseObject({
      input: z.number().optional(),
      output: z.number().optional(),
      cacheRead: z.number().optional(),
      cacheWrite: z.number().optional(),
      total: z.number().optional(),
    })
    .optional(),
  cost: z.number().optional(),
  contextUsage: z
    .looseObject({
      tokens: z.number().nullable().optional(),
      contextWindow: z.number().optional(),
      percent: z.number().nullable().optional(),
    })
    .optional(),
});
export type SessionStats = z.infer<typeof SessionStatsSchema>;

/**
 * Outcome of one `bash` command.
 *
 * `exitCode` is absent when the process was killed rather than exiting, and
 * `fullOutputPath` appears only once pi has truncated the output.
 */
export const BashResultSchema = z.looseObject({
  output: z.string().default(""),
  exitCode: z.number().nullable().optional(),
  cancelled: z.boolean().default(false),
  truncated: z.boolean().default(false),
  fullOutputPath: z.string().nullable().optional(),
});
export type BashResult = z.infer<typeof BashResultSchema>;

export const ThinkingLevelsDataSchema = z.looseObject({
  levels: z.array(z.string()),
});

export const GetMessagesDataSchema = z.looseObject({
  messages: z.array(AgentMessageSchema),
});

export const SessionStateSchema = z.looseObject({
  model: z.unknown().nullable().optional(),
  thinkingLevel: z.string().optional(),
  isStreaming: z.boolean(),
  isCompacting: z.boolean().optional(),
  steeringMode: z.string().optional(),
  followUpMode: z.string().optional(),
  sessionFile: z.string().optional(),
  sessionId: z.string().optional(),
  sessionName: z.string().optional(),
  autoCompactionEnabled: z.boolean().optional(),
  messageCount: z.number().optional(),
  pendingMessageCount: z.number().optional(),
});
export type SessionState = z.infer<typeof SessionStateSchema>;

/**
 * A `get_entries` cursor that pi does not recognise fails the command outright
 * ("Entry not found: <id>") rather than returning an empty delta. That is the
 * signal to drop the cached transcript and refetch, not a transport error.
 */
export function isUnknownCursorError(response: RpcResponse): boolean {
  return (
    !response.success &&
    response.command === "get_entries" &&
    /entry not found/i.test(response.error ?? "")
  );
}
