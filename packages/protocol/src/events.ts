import { z } from "zod";
import {
  AgentMessageSchema,
  AssistantMessageSchema,
  ToolCallSchema,
  ToolResultMessageSchema,
  UsageSchema,
} from "./messages.ts";

/**
 * Streaming deltas inside `message_update`.
 *
 * `contentIndex` is the only correlation key. Tool call deltas carry no
 * `toolCallId`: the id only arrives with `toolcall_end.toolCall`, so argument
 * buffers must be keyed by `contentIndex`.
 */
export const AssistantMessageEventSchema = z.discriminatedUnion("type", [
  z.looseObject({ type: z.literal("start") }),
  z.looseObject({ type: z.literal("text_start"), contentIndex: z.number() }),
  z.looseObject({
    type: z.literal("text_delta"),
    contentIndex: z.number(),
    delta: z.string(),
  }),
  z.looseObject({
    type: z.literal("text_end"),
    contentIndex: z.number(),
    content: z.string(),
  }),
  z.looseObject({ type: z.literal("thinking_start"), contentIndex: z.number() }),
  z.looseObject({
    type: z.literal("thinking_delta"),
    contentIndex: z.number(),
    delta: z.string(),
  }),
  z.looseObject({
    type: z.literal("thinking_end"),
    contentIndex: z.number(),
    content: z.string(),
  }),
  z.looseObject({ type: z.literal("toolcall_start"), contentIndex: z.number() }),
  z.looseObject({
    type: z.literal("toolcall_delta"),
    contentIndex: z.number(),
    delta: z.string(),
  }),
  z.looseObject({
    type: z.literal("toolcall_end"),
    contentIndex: z.number(),
    toolCall: ToolCallSchema,
  }),
  z.looseObject({ type: z.literal("done"), reason: z.string() }),
  z.looseObject({ type: z.literal("error"), reason: z.string() }),
]);
export type AssistantMessageEvent = z.infer<typeof AssistantMessageEventSchema>;

const ToolResultPayloadSchema = z.looseObject({
  content: z.array(z.looseObject({ type: z.string() })).optional(),
  details: z.unknown().optional(),
});

const CompactionResultSchema = z.looseObject({
  summary: z.string(),
  firstKeptEntryId: z.string().optional(),
  tokensBefore: z.number().optional(),
  estimatedTokensAfter: z.number().optional(),
  usage: UsageSchema.optional(),
});

export const AgentEventSchema = z.discriminatedUnion("type", [
  z.looseObject({ type: z.literal("agent_start") }),
  z.looseObject({
    type: z.literal("agent_end"),
    messages: z.array(AgentMessageSchema).optional(),
    willRetry: z.boolean().optional(),
  }),
  // Terminal signal. `agent_end` may be followed by retry, compaction, or a
  // queued continuation; `agent_settled` may not.
  z.looseObject({ type: z.literal("agent_settled") }),
  z.looseObject({ type: z.literal("turn_start") }),
  z.looseObject({
    type: z.literal("turn_end"),
    message: AgentMessageSchema.optional(),
    toolResults: z.array(ToolResultMessageSchema).optional(),
  }),
  z.looseObject({ type: z.literal("message_start"), message: AgentMessageSchema }),
  z.looseObject({ type: z.literal("message_end"), message: AgentMessageSchema }),
  z.looseObject({
    type: z.literal("message_update"),
    usage: UsageSchema.optional(),
    assistantMessageEvent: AssistantMessageEventSchema,
  }),
  z.looseObject({
    type: z.literal("bash_execution_update"),
    id: z.string().optional(),
    delta: z.string(),
  }),
  z.looseObject({
    type: z.literal("tool_execution_start"),
    toolCallId: z.string(),
    toolName: z.string(),
    args: z.unknown().optional(),
    // Stamped by the daemon, not by pi, which emits no timings at all. Epoch
    // ms in the daemon's clock: a client has to correct it before display.
    startedAt: z.number().optional(),
  }),
  // Optional: a fast tool may go straight from start to end. `partialResult`
  // is cumulative, not a delta, so it replaces rather than appends.
  z.looseObject({
    type: z.literal("tool_execution_update"),
    toolCallId: z.string(),
    toolName: z.string(),
    args: z.unknown().optional(),
    partialResult: ToolResultPayloadSchema.optional(),
  }),
  z.looseObject({
    type: z.literal("tool_execution_end"),
    toolCallId: z.string(),
    toolName: z.string(),
    result: ToolResultPayloadSchema.optional(),
    isError: z.boolean().optional(),
    // Execution only: time spent waiting for a human to answer a confirmation
    // is excluded, because pi starts the call before it asks.
    durationMs: z.number().optional(),
  }),
  z.looseObject({
    type: z.literal("queue_update"),
    steering: z.array(z.string()).default([]),
    followUp: z.array(z.string()).default([]),
  }),
  z.looseObject({
    type: z.literal("compaction_start"),
    reason: z.enum(["manual", "threshold", "overflow"]).or(z.string()),
  }),
  z.looseObject({
    type: z.literal("compaction_end"),
    reason: z.string().optional(),
    result: CompactionResultSchema.nullable().optional(),
    aborted: z.boolean().optional(),
    willRetry: z.boolean().optional(),
    errorMessage: z.string().optional(),
  }),
  z.looseObject({
    type: z.literal("auto_retry_start"),
    attempt: z.number(),
    maxAttempts: z.number().optional(),
    delayMs: z.number().optional(),
    errorMessage: z.string().optional(),
  }),
  z.looseObject({
    type: z.literal("auto_retry_end"),
    success: z.boolean(),
    attempt: z.number().optional(),
    finalError: z.string().optional(),
  }),
  z.looseObject({
    type: z.literal("summarization_retry_scheduled"),
    attempt: z.number(),
    maxAttempts: z.number().optional(),
    delayMs: z.number().optional(),
    errorMessage: z.string().optional(),
  }),
  z.looseObject({
    type: z.literal("summarization_retry_attempt_start"),
    source: z.string().optional(),
    reason: z.string().optional(),
  }),
  z.looseObject({ type: z.literal("summarization_retry_finished") }),
  // Surface this. Swallowing it hides a silently broken extension.
  z.looseObject({
    type: z.literal("extension_error"),
    extensionPath: z.string().optional(),
    event: z.string().optional(),
    error: z.string(),
  }),
]);
export type AgentEvent = z.infer<typeof AgentEventSchema>;
export type AgentEventType = AgentEvent["type"];

export const ExtensionUiRequestSchema = z.looseObject({
  type: z.literal("extension_ui_request"),
  id: z.string(),
  method: z.enum([
    "select",
    "confirm",
    "input",
    "editor",
    "notify",
    "setStatus",
    "setWidget",
    "setTitle",
    "set_editor_text",
  ]),
  title: z.string().optional(),
  message: z.string().optional(),
  options: z.array(z.string()).optional(),
  placeholder: z.string().optional(),
  prefill: z.string().optional(),
  timeout: z.number().optional(),
  notifyType: z.enum(["info", "warning", "error"]).optional(),
  statusKey: z.string().optional(),
  statusText: z.string().optional(),
  widgetKey: z.string().optional(),
  widgetLines: z.array(z.string()).optional(),
  widgetPlacement: z.enum(["aboveEditor", "belowEditor"]).optional(),
  text: z.string().optional(),
});
export type ExtensionUiRequest = z.infer<typeof ExtensionUiRequestSchema>;

/** Only these four block the agent and require a response. */
const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

export function isDialogRequest(request: ExtensionUiRequest): boolean {
  return DIALOG_METHODS.has(request.method);
}
