import type { SessionSummary } from "@pios/protocol";
import type { SessionView, SupervisorState } from "@pios/client-core";

/**
 * Everything the user has to know that is not a message.
 *
 * Nothing here is swallowed: an extension that failed, a retry in progress, or
 * a compaction that is rewriting history all change what the agent will do
 * next, so they are surfaced even when they are noisy.
 */
export function Banners({ state, view, session, onTrust, onDismissNotice }: {
  state: SupervisorState;
  view: SessionView | null;
  session: SessionSummary | null;
  onTrust: () => void;
  /** Extension messages are the only banners a user can clear by hand. */
  onDismissNotice: (id: string) => void;
}) {
  const banners = [] as { key: string; tone: string; text: string; action?: () => void; actionLabel?: string }[];

  if (state.transport !== "connected") {
    banners.push({
      key: "transport",
      tone: state.transport === "blocked" ? "error" : "warn",
      text: transportText(state),
    });
  } else if (state.sync === "error") {
    // A healthy socket with stale data. Saying "disconnected" here would be a
    // lie and would send the user looking at their wifi.
    banners.push({ key: "sync", tone: "warn", text: "Connected, but out of sync." });
  }

  if (session && !session.trusted) {
    banners.push({
      key: "trust",
      tone: "warn",
      text: "Untrusted directory: project extensions and settings are not loaded.",
      actionLabel: "Trust this directory",
      action: onTrust,
    });
  }
  if (session?.status === "crashed") {
    banners.push({ key: "crashed", tone: "error", text: "The pi process crashed and was restarted." });
  }

  if (view?.status.compaction) {
    banners.push({
      key: "compaction",
      tone: "info",
      text: `Compacting context (${view.status.compaction.reason})...`,
    });
  }
  if (view?.status.retry) {
    const retry = view.status.retry;
    banners.push({
      key: "retry",
      tone: "warn",
      text: `Retrying (attempt ${retry.attempt}${retry.maxAttempts ? `/${retry.maxAttempts}` : ""})${
        retry.error ? `: ${retry.error}` : ""
      }`,
    });
  }
  for (const [index, failure] of (view?.status.extensionErrors ?? []).entries()) {
    banners.push({
      key: `ext-${index}`,
      tone: "error",
      text: `Extension error${failure.extensionPath ? ` in ${failure.extensionPath}` : ""}: ${failure.error}`,
    });
  }

  for (const notice of view?.notices ?? []) {
    banners.push({
      key: `notice-${notice.id}`,
      tone: notice.type === "error" ? "error" : notice.type === "warning" ? "warn" : "info",
      text: notice.message,
      actionLabel: "Dismiss",
      action: () => onDismissNotice(notice.id),
    });
  }

  if (banners.length === 0) return null;
  return (
    <div className="banners">
      {banners.map((banner) => (
        <div key={banner.key} className={`banner ${banner.tone}`}>
          <span>{banner.text}</span>
          {banner.action ? (
            <button type="button" onClick={banner.action}>
              {banner.actionLabel}
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function transportText(state: SupervisorState): string {
  switch (state.transport) {
    case "offline":
      return "Offline. Showing cached transcript; prompts are queued.";
    case "connecting":
      return "Connecting...";
    case "waiting":
      // The relay is up but the machine behind it is not: asleep, rebooting,
      // or its daemon stopped. Nothing on the phone can fix that.
      if (state.blockedReason === "host offline") {
        return `Machine offline. Retrying (attempt ${state.attempts}); prompts are queued.`;
      }
      return `Reconnecting (attempt ${state.attempts})${state.blockedReason ? `: ${state.blockedReason}` : ""}`;
    case "blocked":
      return `Cannot connect: ${state.blockedReason ?? "check pairing"}`;
    default:
      return "Not connected.";
  }
}
