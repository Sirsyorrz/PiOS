import type { SessionIndex, SessionInfo, SessionRecord, SessionRegistry } from "@pios/pi-host";
import type { SessionSummary } from "@pios/protocol";

/**
 * The session list: what is on disk, with what is running laid over it.
 *
 * Disk is the source of existence and a process is a cache in front of it, so
 * a row never depends on whether the daemon happens to have pi up for it. A
 * session the daemon just started has no file yet, which is the only reason
 * the registry contributes rows of its own.
 */

export interface SessionPage {
  sessions: SessionSummary[];
  offset: number;
  total: number;
  hasMore: boolean;
}

export interface ListQuery {
  cwd?: string;
  query?: string;
  limit?: number;
  offset?: number;
}

export async function listSessions(
  index: SessionIndex,
  registry: SessionRegistry,
  query: ListQuery = {},
): Promise<SessionPage> {
  const page = await index.list(query);
  const live = new Map(registry.list().map((info) => [info.id, info]));

  const rows = page.sessions.map((record) => {
    const info = live.get(record.id);
    live.delete(record.id);
    return info ? liveSummary(info, record) : coldSummary(record);
  });

  // Only on the first page: a session with no file yet is brand new, and
  // pushing it onto page three would put it where nobody is looking.
  const unseeded = (query.offset ?? 0) === 0 ? [...live.values()].map((info) => liveSummary(info)) : [];

  return {
    sessions: [...unseeded, ...rows],
    offset: page.offset ?? query.offset ?? 0,
    total: page.total + unseeded.length,
    hasMore: page.hasMore,
  };
}

/** One session, live or cold, for a reply about a single id. */
export function summaryFor(
  index: SessionIndex,
  registry: SessionRegistry,
  sessionId: string,
): SessionSummary | undefined {
  const info = registry.get(sessionId)?.info;
  const record = index.recordFor(sessionId);
  if (info) return liveSummary(info, record);
  return record ? coldSummary(record) : undefined;
}

export function liveSummary(info: SessionInfo, record?: SessionRecord): SessionSummary {
  return {
    sessionId: info.id,
    name: info.name ?? record?.name,
    cwd: info.cwd || (record?.cwd ?? ""),
    // `starting` is a process on its way up, which is nothing a client can act
    // on differently from a session that is simply not busy.
    status: info.status === "starting" ? "idle" : info.status === "disposed" ? "cold" : info.status,
    awaitingInput: info.awaitingInput,
    trusted: info.trusted,
    leafId: info.leafId,
    lastSeq: info.lastSeq,
    updatedAt: Math.max(info.updatedAt, record?.modifiedAt ?? 0),
    preview: info.preview ?? record?.preview,
    messageCount: record?.messageCount,
    model: info.model,
    thinkingLevel: info.thinkingLevel,
    thinkingLevels: info.thinkingLevels,
  };
}

function coldSummary(record: SessionRecord): SessionSummary {
  return {
    sessionId: record.id,
    name: record.name,
    cwd: record.cwd,
    status: "cold",
    awaitingInput: false,
    // Trust is answered when the session is woken, from the project's setting.
    trusted: false,
    // A cold session's cursor lives in its file; `get_entries` reads it there.
    leafId: null,
    lastSeq: 0,
    updatedAt: record.modifiedAt,
    preview: record.preview || undefined,
    messageCount: record.messageCount,
    thinkingLevels: [],
  };
}
