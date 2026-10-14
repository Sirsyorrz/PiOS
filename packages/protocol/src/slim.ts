import type { AgentEvent } from "./events.ts";

/**
 * An event with the copies no client reads taken out.
 *
 * pi repeats whole messages across events: a tool result rides on its
 * `tool_execution_end`, its `message_start`, its `message_end`, again in the
 * turn's `turn_end` and once more in the run's `agent_end`. A screenshot is a
 * megabyte of base64, so the same picture went out five times, and again to
 * every device that joined mid-turn. Clients build the transcript from
 * `message_end` and the tool card from `tool_execution_end`; everything here
 * is dropped only where a client never looks.
 */
export function slimEvent(event: AgentEvent): AgentEvent {
  switch (event.type) {
    case "agent_end":
      return event.messages ? { ...event, messages: [] } : event;
    case "turn_end": {
      if (!event.message && !event.toolResults) return event;
      const { message: _message, toolResults: _results, ...rest } = event;
      return rest as AgentEvent;
    }
    case "message_start":
      // An assistant message starts empty and streams; anything else arrives
      // whole on the `message_end` right behind it.
      if (event.message.role === "assistant" || !("content" in event.message)) return event;
      return { ...event, message: { ...event.message, content: [] } } as AgentEvent;
    case "message_update": {
      // RPC mode already sends bare deltas; the in-process host hands over the
      // whole partial message on each one, twice.
      const loose = event as AgentEvent & { message?: unknown };
      const delta = event.assistantMessageEvent as typeof event.assistantMessageEvent & { partial?: unknown };
      if (loose.message === undefined && delta.partial === undefined) return event;
      const { message: _message, ...rest } = loose;
      const { partial: _partial, ...bare } = delta;
      return { ...rest, assistantMessageEvent: bare } as AgentEvent;
    }
    default:
      return event;
  }
}
