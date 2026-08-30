import { useEffect } from "react";
import type { PiosClient } from "@pios/client-core";

// The daemon suppresses a notification for a session this client is visibly
// on, so the report has to stay fresh (under the daemon's 45s TTL).
const reportIntervalMs = 25_000;

/**
 * Tells the daemon which session this client is looking at, and whether it is.
 *
 * `transport` is a dependency so a reconnect re-reports at once: the daemon
 * remembers nothing about a socket that went away.
 */
export function useAttentionReport(
  client: PiosClient,
  sessionId: string | null,
  transport: string,
): void {
  useEffect(() => {
    const report = () => {
      const visible = document.visibilityState === "visible";
      client.reportActivity({
        visible,
        focused: visible && document.hasFocus(),
        appState: visible ? "active" : "background",
        sessionIds: sessionId ? [sessionId] : [],
      });
    };
    report();
    const timer = setInterval(report, reportIntervalMs);
    document.addEventListener("visibilitychange", report);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", report);
    };
  }, [client, sessionId, transport]);
}
