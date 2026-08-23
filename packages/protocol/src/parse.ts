import type { z } from "zod";
import { RpcOutboundSchema, type RpcOutbound } from "./commands.ts";

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "invalid_json" | "unknown_shape"; raw: string; error: string };

/**
 * Parses one JSONL record from pi.
 *
 * Returns a result instead of throwing, and reports an unrecognised shape
 * separately from malformed JSON. A newer pi emitting an event this build does
 * not know about must not tear down the stream: the caller logs
 * `unknown_shape` and keeps reading.
 */
export function parseRpcOutbound(record: string): ParseResult<RpcOutbound> {
  let json: unknown;
  try {
    json = JSON.parse(record);
  } catch (error) {
    return { ok: false, reason: "invalid_json", raw: record, error: String(error) };
  }
  return validate(RpcOutboundSchema, json, record);
}

export function parseWith<S extends z.ZodType>(
  schema: S,
  record: string,
): ParseResult<z.infer<S>> {
  let json: unknown;
  try {
    json = JSON.parse(record);
  } catch (error) {
    return { ok: false, reason: "invalid_json", raw: record, error: String(error) };
  }
  return validate(schema, json, record);
}

function validate<S extends z.ZodType>(
  schema: S,
  json: unknown,
  record: string,
): ParseResult<z.infer<S>> {
  const result = schema.safeParse(json);
  if (result.success) return { ok: true, value: result.data };
  return {
    ok: false,
    reason: "unknown_shape",
    raw: record,
    error: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
  };
}
